/**
 * MCP 課程工具的「整條流程」測試：用一個會記狀態的假資料庫，從手機建一門課走到上架，
 * 外加單元附件（新增／替換）與講師介紹、健康聲明。不碰正式站、不連網。
 *
 * 跑法（repo 根目錄）：
 *
 *   echo "" > /tmp/empty.js
 *   M=./apps/web/app/admin/products/test-mocks.ts
 *   node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     apps/web/lib/mcp/content-tools-flow.test.ts --bundle --platform=node --format=esm \
 *     --alias:@=./apps/web --alias:server-only=/tmp/empty.js --alias:sharp=/tmp/empty.js \
 *     --alias:next/navigation=$M --alias:next/cache=$M --alias:@/lib/admin/guard=$M \
 *     --alias:@/lib/admin/audit=$M --alias:@/lib/supabase/server=$M \
 *     --alias:@/lib/admin/remote-image=./apps/web/lib/mcp/test-remote-fetch.ts \
 *     --outfile=/tmp/content-tools-flow.test.mjs
 *   node --test /tmp/content-tools-flow.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerContentTools, directDownloadUrl, type RunAs } from "./content-tools";
import { togglePublish } from "@/app/admin/products/actions";
import { fakeDb, resetMocks, type Op } from "@/app/admin/products/test-mocks";
import { remote } from "./test-remote-fetch";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
type Schema = { parse: (v: unknown) => Record<string, unknown> };

const tools = new Map<string, { schema: Schema; handler: Handler }>();
const server = {
  registerTool(name: string, meta: { inputSchema: Schema }, handler: Handler) {
    tools.set(name, { schema: meta.inputSchema, handler });
  },
};
const run: RunAs = async (fallbackOk, fn) => {
  const out = await fn();
  if (out && out.error) return { content: [{ type: "text", text: out.error }], isError: true };
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, message: (out && out.ok) || fallbackOk }) }] };
};
registerContentTools(server as never, run);

async function call(name: string, args: Record<string, unknown>) {
  const t = tools.get(name);
  assert.ok(t, name);
  const res = await t.handler(t.schema.parse(args));
  const text = res.content[0].text;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { isError: res.isError === true, text, json: res.isError ? null : (JSON.parse(text) as Record<string, any>) };
}

/* ======================================================= 會記狀態的假資料庫 */

type Row = Record<string, unknown>;
type Audit = { input: { action: string; entityId?: string | null; diff?: Record<string, unknown> | null } };

/**
 * 夠用的 PostgREST 模擬：eq／in（含 diff->>key）、order、limit、單列／多列、
 * insert（補 id）、update、upsert（site_settings 以 key）、巢狀 count 與 lesson_materials。
 * audit_log 直接讀 test-mocks 收到的稽核（writeAudit 被換成記憶體版本）。
 */
function memDb(audits: () => Audit[], opts: { writesThrow?: boolean } = {}) {
  const t: Record<string, Row[]> = {
    products: [],
    workshop_sessions: [],
    course_lessons: [],
    product_blocks: [],
    lesson_materials: [],
    site_settings: [],
  };
  let seq = 0;
  const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

  const get = (row: Row, col: string) => {
    const m = /^(\w+)->>(\w+)$/.exec(col);
    if (m) {
      const v = (row[m[1]] as Record<string, unknown> | null)?.[m[2]];
      return v == null ? null : String(v);
    }
    return row[col];
  };
  const match = (row: Row, op: Op) =>
    op.filters.every(([k, c, v]) =>
      k === "eq" ? get(row, c) === v : k === "in" ? (v as unknown[]).includes(get(row, c)) : true,
    );

  const db = fakeDb((op) => {
    const rows: Row[] =
      op.table === "audit_log"
        ? audits().map((a, i) => ({
            action: a.input.action,
            entity_id: a.input.entityId ?? null,
            diff: a.input.diff ?? null,
            created_at: i,
          }))
        : (t[op.table] ??= []);

    if (op.kind === "insert") {
      const list = (Array.isArray(op.values) ? op.values : [op.values]) as Row[];
      if (list.some((v) => v.id && rows.some((x) => x.id === v.id))) {
        return { error: { code: "23505", message: "duplicate key" } };
      }
      const added = list.map((v) => {
        const r: Row = { id: newId(), ...v };
        if (op.table === "workshop_sessions") r.seats_taken ??= 0;
        if (op.table === "lesson_materials") r.caption ??= null;
        rows.push(r);
        return r;
      });
      return { data: op.single ? added[0] : added };
    }
    if (op.kind === "update") {
      const hit = rows.filter((x) => match(x, op));
      for (const r of hit) Object.assign(r, op.values as Row);
      return { data: hit.map((r) => ({ id: r.id })) };
    }
    if (op.kind === "upsert") {
      const v = op.values as Row;
      const cur = rows.find((x) => x.key === v.key);
      if (cur) Object.assign(cur, v);
      else rows.push({ ...v });
      return { data: null };
    }
    if (op.kind === "delete") {
      throw new Error(`流程中不該有刪除：${op.table}`);
    }

    let out = rows.filter((r) => match(r, op)).map((r) => ({ ...r }));
    for (const [col, asc] of [...(op.order ?? [])].reverse()) {
      out.sort((a, b) => {
        const x = a[col] as number | string;
        const y = b[col] as number | string;
        return (x > y ? 1 : x < y ? -1 : 0) * (asc ? 1 : -1);
      });
    }
    if (op.limit !== undefined) out = out.slice(0, op.limit);
    const cols = op.columns ?? "";
    out = out.map((r) => {
      const o: Row = { ...r };
      if (cols.includes("lesson_materials(")) o.lesson_materials = t.lesson_materials.filter((m) => m.lesson_id === r.id);
      if (cols.includes("course_lessons(count)")) {
        o.course_lessons = [{ count: t.course_lessons.filter((l) => l.product_id === r.id).length }];
      }
      if (cols.includes("workshop_sessions(count)")) {
        o.workshop_sessions = [{ count: t.workshop_sessions.filter((s) => s.product_id === r.id).length }];
      }
      return o;
    });
    return { data: op.single ? (out[0] ?? null) : out };
  }, opts);
  return Object.assign(db, { t });
}

function setup(opts: { writesThrow?: boolean } = {}) {
  let h: { audits: Audit[]; revalidated: string[] } | null = null;
  const db = memDb(() => (h ? h.audits : []), opts);
  h = resetMocks(db) as unknown as { audits: Audit[]; revalidated: string[] };
  return { db, h };
}

/** 預覽 → 檢查沒有寫入 → 帶 confirm_args 正式送出 */
async function previewThenConfirm(db: ReturnType<typeof memDb>, name: string, args: Record<string, unknown>) {
  const writesBefore = db.log.filter((o) => o.kind !== "select").length;
  const storageBefore = db.storageLog.length;
  const p = await call(name, args);
  assert.equal(p.isError, false, `${name} 預覽：${p.text}`);
  assert.equal(p.json!.dry_run, true, name);
  assert.equal(p.json!.executed, false, name);
  assert.equal(db.log.filter((o) => o.kind !== "select").length, writesBefore, `${name} 預覽不該寫資料庫`);
  assert.equal(db.storageLog.length, storageBefore, `${name} 預覽不該存檔`);
  const c = await call(name, p.json!.confirm_args);
  assert.equal(c.isError, false, `${name} 送出：${c.text}`);
  assert.equal(c.json!.executed, true, name);
  return { preview: p.json!, done: c.json! };
}

/* =============================================================== 測試 */

test("整條流程：建工作坊 → 改價加標籤 → 加線上場次 → 改成實體 → 上架；建預錄課 → 加單元 → 加講義 → 替換講義", async () => {
  const { db, h } = setup();

  // 1. 建工作坊（全中文標題 → 自動代稱）
  const created = await previewThenConfirm(db, "create_product", {
    type: "workshop",
    title: "仁神術週末體驗",
    price: 3000,
    is_published: true, // 會被剝掉：新建一律草稿
  });
  const pid = created.done.product_id as string;
  assert.equal(db.t.products[0].is_published, false);
  assert.match(String(db.t.products[0].slug), /^workshop-\d{8}$/);

  // 2. 業主口吻：「把那堂課的價格改成 2000，放進近期新課」→ list_products 用 keyword 找得到
  const found = await call("list_products", { keyword: "週末" });
  assert.equal(found.json!.total, 1);
  assert.equal(found.json!.products[0].id, pid);
  const upd = await previewThenConfirm(db, "update_product", { product: pid, price: 2000, tags: ["近期新課"] });
  assert.deepEqual(upd.preview.price_change, ["售價：NT$ 3,000 → NT$ 2,000（左邊是目前售價，右邊是改完的新售價）"]);
  assert.equal(db.t.products[0].price, 2000);
  assert.deepEqual(db.t.products[0].tags, ["近期新課"]);
  assert.equal(db.t.products[0].is_published, false, "改價不能順便改到上架狀態");

  // 3. 加一場線上場次（草稿時開放報名、跟著上架生效）
  const s = await previewThenConfirm(db, "create_session", {
    product: pid,
    starts_at: "2099-12-06 14:00",
    ends_at: "2099-12-06 17:00",
    capacity: 12,
    format: "online",
    location: "線上（Google Meet）",
  });
  const sid = s.done.session_id as string;
  assert.equal(db.t.workshop_sessions[0].format, "online");
  let detail = await call("get_product", { product: pid });
  assert.deepEqual(detail.json!.front_categories, ["線上直播"]);

  // 4. 「這場改成實體的」
  const fmt = await previewThenConfirm(db, "update_session", { session_id: sid, format: "onsite", address: "台北市某路 1 號" });
  assert.ok(fmt.preview.changes.format, "預覽要列出上課形式的變化");
  assert.equal(db.t.workshop_sessions[0].format, "onsite");
  detail = await call("get_product", { product: pid });
  assert.deepEqual(detail.json!.front_categories, ["線下工作坊"]);

  // 5. 上架（MCP 的 publish_product 以 asMachine 呼叫的就是這支 action）
  assert.equal(await togglePublish(pid, true), undefined);
  assert.equal(db.t.products[0].is_published, true);
  assert.ok(h.audits.some((a) => a.input.action === "product.publish"));

  // 6. 預錄課程 → 單元
  const course = await previewThenConfirm(db, "create_product", { type: "course", title: "JSJ 讀脈入門", price: 3600 });
  const cid = course.done.product_id as string;
  await previewThenConfirm(db, "set_lessons", {
    product: cid,
    lessons: [
      { title: "第一堂 認識讀脈", youtube: "https://youtu.be/dQw4w9WgXcQ", duration: "12:30", free_preview: true },
      { title: "第二堂 實作", youtube: "dQw4w9WgXcQ" },
    ],
  });
  assert.equal(db.t.course_lessons.length, 2);
  const lessonId = String(db.t.course_lessons.find((l) => l.sort_order === 2)!.id);

  // 7. 從 Google 雲端硬碟分享連結加講義（會自動轉成下載網址）
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2048, 0x20)]);
  remote().files["https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMn"] = {
    bytes: pdf,
    finalUrl: "https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMn",
  };
  const mat = await previewThenConfirm(db, "add_lesson_material_from_url", {
    lesson_id: lessonId,
    url: "https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view?usp=sharing",
    file_name: "第二堂講義.pdf",
  });
  assert.equal(mat.preview.preview.kind, "課程文件");
  assert.equal(db.t.lesson_materials.length, 1);
  assert.equal(db.t.lesson_materials[0].mime_type, "application/pdf");
  assert.equal(db.t.lesson_materials[0].file_name, "第二堂講義.pdf");
  // 同一份 confirm_args 重送：不會多一份，也不會再下載
  const calls = remote().calls.length;
  const again = await call("add_lesson_material_from_url", mat.preview.confirm_args);
  assert.equal(again.json!.already_created, true);
  assert.equal(db.t.lesson_materials.length, 1);
  assert.equal(remote().calls.length, calls);
  // 稽核沒寫進去（writeAudit 失敗只印 log）也一樣不會重建：靠固定的資料列 id
  const savedAudits = h.audits.splice(0);
  const again2 = await call("add_lesson_material_from_url", mat.preview.confirm_args);
  assert.equal(again2.json!.already_created, true);
  assert.equal(db.t.lesson_materials.length, 1);
  h.audits.push(...savedAudits);
  // 同一個 key 換成別的網址 → 擋下
  const conflict = await call("add_lesson_material_from_url", { ...mat.preview.confirm_args, url: "https://example.com/other.pdf" });
  assert.equal(conflict.isError, true);
  assert.match(conflict.text, /已經用來建立過另一筆/);

  // 刪除底下有附件的單元：手機上擋下
  const blocked = await call("set_lessons", {
    product: cid,
    lessons: [{ id: String(db.t.course_lessons.find((l) => l.sort_order === 1)!.id) }],
    allow_delete: true,
  });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /連附件一起刪除/);
  assert.equal(db.t.course_lessons.length, 2);

  // get_product 看得到附件 id
  detail = await call("get_product", { product: cid });
  const mid = detail.json!.lessons[1].materials[0].id as string;
  assert.equal(mid, db.t.lesson_materials[0].id);

  // 8. 替換：資料列指向新檔，舊檔不刪
  const oldPath = db.t.lesson_materials[0].storage_path;
  remote().files["https://example.com/v2.pdf"] = { bytes: Buffer.concat([pdf, pdf]) };
  await previewThenConfirm(db, "replace_lesson_material_from_url", { material_id: mid, url: "https://example.com/v2.pdf" });
  assert.notEqual(db.t.lesson_materials[0].storage_path, oldPath);
  assert.equal(db.t.lesson_materials[0].id, mid);
  assert.equal(db.t.lesson_materials[0].file_name, "第二堂講義.pdf", "沒給檔名就沿用");

  // 全程沒有任何刪除
  assert.equal(db.log.some((o) => o.kind === "delete"), false);
  assert.equal(db.storageLog.some((o) => o.kind === "remove"), false);
  assert.deepEqual(
    db.storageLog.map((o) => o.kind),
    ["upload", "upload"],
  );
});

test("update_product 可以改型態，預覽警告網址會變", async () => {
  const { db } = setup();
  const c = await previewThenConfirm(db, "create_product", { type: "course", title: "Live Class", price: 100 });
  const r = await call("update_product", { product: c.done.product_id, type: "workshop" });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.json!.warnings.some((w: string) => w.includes("/courses/live-class") && w.includes("/workshops/live-class")));
});

test("add_lesson_material_from_url：不是 PDF／圖片（例如 Drive 權限沒開回 HTML）→ 中文錯誤，不存", async () => {
  const { db } = setup({ writesThrow: true });
  db.t.course_lessons.push({ id: "aaaaaaaa-0000-4000-8000-000000000009", title: "x", product_id: null, sort_order: 1 });
  remote().files["https://example.com/page"] = { bytes: Buffer.from("<!doctype html><html>登入</html>") };
  const r = await call("add_lesson_material_from_url", {
    lesson_id: "aaaaaaaa-0000-4000-8000-000000000009",
    url: "https://example.com/page",
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /知道連結的人都能查看/);
  assert.equal(/[a-z_]{6,}/.test(r.text.replace(/https?:\S+/g, "")), false, "錯誤訊息不要露出欄位名");
});

test("add_lesson_material_from_url：單元不存在 → 中文錯誤；正式送出沒帶 key → 拒絕", async () => {
  const { } = setup({ writesThrow: true });
  remote().files["https://example.com/a.pdf"] = { bytes: Buffer.from("%PDF-1.4 xxx") };
  const r = await call("add_lesson_material_from_url", {
    lesson_id: "aaaaaaaa-0000-4000-8000-00000000ffff",
    url: "https://example.com/a.pdf",
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /找不到這個單元/);
  assert.equal(remote().calls.includes("https://example.com/a.pdf"), false, "id 錯就不先下載");
  const r2 = await call("add_lesson_material_from_url", {
    lesson_id: "aaaaaaaa-0000-4000-8000-00000000ffff",
    url: "https://example.com/a.pdf",
    dry_run: false,
  });
  assert.equal(r2.isError, true);
  assert.match(r2.text, /confirm_args/);
});

test("replace_lesson_material_from_url：PDF 不能換成圖片", async () => {
  const { db } = setup({ writesThrow: true });
  db.t.lesson_materials.push({
    id: "bbbbbbbb-0000-4000-8000-000000000001",
    lesson_id: "L1",
    kind: "file",
    file_name: "a.pdf",
    mime_type: "application/pdf",
    size_bytes: 10,
    caption: null,
    sort_order: 1,
    storage_path: "lessons/L1/x.pdf",
  });
  const missing = await call("replace_lesson_material_from_url", {
    material_id: "bbbbbbbb-0000-4000-8000-00000000ffff",
    url: "https://example.com/p.png",
  });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /找不到這份附件/);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  remote().files["https://example.com/p.png"] = { bytes: png };
  const r = await call("replace_lesson_material_from_url", {
    material_id: "bbbbbbbb-0000-4000-8000-000000000001",
    url: "https://example.com/p.png",
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /只能換成另一份 PDF/);
});

test("講師介紹：只改有給的欄位、預覽不寫入、送出後清前台快取；外部照片網址擋下", async () => {
  const { db, h } = setup();
  db.t.site_settings.push({
    key: "teacher",
    value: { name: "王老師", title: "講師", paragraphs: ["第一段"], credentials: ["證照 A"], links: [], photo_url: null },
  });
  const got = await call("get_site_settings", {});
  assert.equal(got.json!.teacher.name, "王老師");

  const r = await previewThenConfirm(db, "update_teacher_profile", {
    credentials: ["證照 A", "證照 B"],
    links: [{ label: "MOMOTV 專訪", url: "https://example.com/v" }],
  });
  assert.deepEqual(Object.keys(r.preview.changes).sort(), ["credentials", "links"]);
  const v = db.t.site_settings[0].value as Record<string, unknown>;
  assert.equal(v.name, "王老師");
  assert.deepEqual(v.paragraphs, ["第一段"]);
  assert.deepEqual(v.credentials, ["證照 A", "證照 B"]);
  assert.deepEqual(v.links, [{ label: "MOMOTV 專訪", href: "https://example.com/v" }]);
  assert.ok(h.audits.some((a) => a.input.action === "settings.teacher"));
  assert.ok(h.revalidated.includes("/teachers"));

  const bad = await call("update_teacher_profile", { photo_url: "https://evil.example/x.jpg" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /先用 upload_image_from_url/);
});

test("健康聲明：預覽列出改前改後全文，不寫入；送出後寫入", async () => {
  const { db } = setup();
  db.t.site_settings.push({ key: "health_notice", value: { title: "健康聲明", body: "舊內容" } });
  const r = await previewThenConfirm(db, "update_health_notice", { body: "新內容" });
  assert.deepEqual(r.preview.before, { title: "健康聲明", body: "舊內容" });
  assert.deepEqual(r.preview.after, { title: "健康聲明", body: "新內容" });
  assert.deepEqual(db.t.site_settings[0].value, { title: "健康聲明", body: "新內容" });
});

test("directDownloadUrl：Drive／Dropbox 分享連結轉成下載網址，其他不動", () => {
  assert.equal(
    directDownloadUrl("https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view?usp=sharing"),
    "https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMn",
  );
  assert.equal(
    directDownloadUrl("https://drive.google.com/open?id=1AbCdEfGhIjKlMn"),
    "https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMn",
  );
  assert.equal(directDownloadUrl("https://www.dropbox.com/s/abc/a.pdf?dl=0"), "https://www.dropbox.com/s/abc/a.pdf?dl=1");
  assert.equal(directDownloadUrl("https://example.com/a.pdf"), "https://example.com/a.pdf");
  assert.equal(directDownloadUrl("http://169.254.169.254/x"), "http://169.254.169.254/x");
});
