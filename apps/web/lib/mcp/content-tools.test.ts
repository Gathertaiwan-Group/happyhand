/**
 * lib/mcp/content-tools.ts 的單元測試（MCP 層：預覽 → confirm_args → 正式送出）。
 *
 * 不碰正式站：假 server 收集 registerTool 的 handler，`run` 換成「直接執行 fn」，
 * 資料庫、稽核、清快取全部換成 test-mocks.ts 的替身。
 *
 * 跑法（repo 根目錄）：
 *
 *   echo "" > /tmp/empty.js
 *   M=./apps/web/app/admin/products/test-mocks.ts
 *   node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     apps/web/lib/mcp/content-tools.test.ts --bundle --platform=node --format=esm \
 *     --alias:@=./apps/web --alias:server-only=/tmp/empty.js --alias:sharp=/tmp/empty.js \
 *     --alias:next/navigation=$M --alias:next/cache=$M --alias:@/lib/admin/guard=$M \
 *     --alias:@/lib/admin/audit=$M --alias:@/lib/supabase/server=$M \
 *     --outfile=/tmp/content-tools.test.mjs
 *   node --test /tmp/content-tools.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerContentTools, type RunAs } from "./content-tools";
import { fakeDb, resetMocks, type Op, type Responder } from "@/app/admin/products/test-mocks";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
type Schema = { parse: (v: unknown) => Record<string, unknown> };

const tools = new Map<string, { schema: Schema; handler: Handler }>();
const server = {
  registerTool(name: string, meta: { inputSchema: Schema }, handler: Handler) {
    tools.set(name, { schema: meta.inputSchema, handler });
  },
};

/** route.ts 的 asMachine 的替身：在「身分範圍」裡跑 fn，把 {error}/{ok} 轉成結果。 */
const run: RunAs = async (fallbackOk, fn) => {
  const out = await fn();
  if (out && out.error) return { content: [{ type: "text", text: out.error }], isError: true };
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, message: (out && out.ok) || fallbackOk }) }] };
};

registerContentTools(server as never, run);

/** 跟 SDK 一樣先用 inputSchema 驗證／剝掉未知欄位，再交給 handler。 */
async function call(name: string, args: Record<string, unknown>) {
  const t = tools.get(name);
  assert.ok(t, name);
  const parsed = t.schema.parse(args);
  const res = await t.handler(parsed);
  const text = res.content[0].text;
  // 測試裡要往下鑽 JSON，用 any 比較好讀
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { isError: res.isError === true, text, json: res.isError ? null : (JSON.parse(text) as Record<string, any>) };
}

const PID = "11111111-2222-4333-8444-555555555555";
const ROW = {
  id: PID,
  type: "workshop",
  slug: "renshen-intro",
  title: "仁神術入門",
  subtitle: null,
  description: null,
  price: 3000,
  compare_at_price: null,
  cover_url: null,
  is_published: true,
  is_featured: false,
  tags: [],
  benefits: [],
  sort_order: 0,
  hero_lead: null,
  suitable_for: [],
  not_suitable_for: [],
  outcomes: [],
  curriculum_online: [],
  curriculum_onsite: [],
  includes: [],
  notes: [],
  asks_intake: false,
};

const tables =
  (map: Record<string, (op: Op) => ReturnType<Responder>>): Responder =>
  (op) =>
    map[op.table] ? map[op.table](op) : { data: null };

test("工具清單：有新增／編輯，沒有任何刪除工具", () => {
  const names = [...tools.keys()].sort();
  assert.deepEqual(names, [
    "add_lesson_material_from_url",
    "create_product",
    "create_session",
    "get_product",
    "get_site_settings",
    "list_products",
    "replace_lesson_material_from_url",
    "set_content_blocks",
    "set_lessons",
    "update_health_notice",
    "update_product",
    "update_session",
    "update_teacher_profile",
    "upload_image_base64",
    "upload_image_from_url",
  ]);
  assert.equal(names.some((n) => /delete|remove/.test(n)), false);
});

test("create_product 預覽：自動代稱、產生 key、不寫入、記 mcp.preview 稽核", async () => {
  const db = fakeDb(
    tables({
      audit_log: () => ({ data: null }),
      // pickAvailableSlug 與 slugInUse：已經有 workshop-xxxx 與 jsj，下一個要加 -2
      products: (op) => (op.filters.some(([k]) => k === "or") ? { data: [{ slug: "jsj" }] } : { data: [] }),
    }),
    { writesThrow: true },
  );
  const h = resetMocks(db);
  const r = await call("create_product", { type: "course", title: "JSJ 讀脈入門", price: 3600, is_published: true });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json!.dry_run, true);
  assert.equal(r.json!.confirm_args.slug, "jsj-2");
  assert.match(r.json!.confirm_args.idempotency_key, /^mcp-/);
  assert.equal(r.json!.confirm_args.dry_run, false);
  assert.equal("is_published" in r.json!.confirm_args, false); // 未知欄位被 schema 剝掉
  assert.equal(h.audits.length, 1);
  assert.equal(h.audits[0].input.action, "mcp.preview.create_product");
  assert.equal(h.revalidated.length, 0);
});

test("create_product 正式送出：一律草稿；同一份 confirm_args 重送不會建第二筆", async () => {
  let created: string | null = null;
  const inserts: unknown[] = [];
  const db = fakeDb(
    tables({
      audit_log: () => ({ data: created ? { entity_id: created } : null }),
      products: (op) => {
        if (op.kind === "insert") {
          inserts.push(op.values);
          created = "NEW1";
          return { data: { id: "NEW1" } };
        }
        if (op.filters.some(([, c, v]) => c === "id" && v === "NEW1")) {
          return { data: { ...ROW, id: "NEW1", is_published: false, price: 3600, ...(inserts[0] as object) } };
        }
        return { data: [] };
      },
    }),
  );
  const h = resetMocks(db);
  const confirm = { type: "workshop", title: "仁神術入門", price: 3600, slug: "renshen-intro", idempotency_key: "mcp-abcdefgh", dry_run: false };
  const r1 = await call("create_product", confirm);
  assert.equal(r1.isError, false, r1.text);
  assert.equal(r1.json!.product_id, "NEW1");
  assert.equal((inserts[0] as { is_published: boolean }).is_published, false);
  assert.equal(h.audits.find((a) => a.input.action === "product.create")?.input.diff && true, true);

  const r2 = await call("create_product", confirm);
  assert.equal(r2.json!.already_created, true);
  assert.equal(r2.json!.product.title, "仁神術入門");
  assert.equal(inserts.length, 1);

  // 同一個 key 拿去建另一門課（不同代稱）→ 擋下，不會說「已建立」
  const r3 = await call("create_product", { ...confirm, title: "別的課", slug: "another-course" });
  assert.equal(r3.isError, true);
  assert.match(r3.text, /已經用來建立過另一筆/);
  assert.equal(inserts.length, 1);
});

test("create_product 正式送出沒帶 confirm_args 的 slug／key → 拒絕", async () => {
  resetMocks(fakeDb(() => ({ data: null }), { writesThrow: true }));
  const r = await call("create_product", { type: "course", title: "x", price: 1, dry_run: false });
  assert.equal(r.isError, true);
  assert.match(r.text, /confirm_args/);
});

test("create_product：外部網址不能直接當封面", async () => {
  resetMocks(fakeDb(tables({ products: () => ({ data: [] }), audit_log: () => ({ data: null }) }), { writesThrow: true }));
  const r = await call("create_product", { type: "course", title: "JSJ", price: 1, cover_url: "https://evil.example/x.jpg" });
  assert.equal(r.isError, true);
  assert.match(r.text, /upload_image_from_url/);
});

test("update_product 改價：預覽明講「目前售價 → 新售價」，只寫有給的欄位", async () => {
  const futureSessions = [
    { id: "S1", starts_at: "2099-12-06T06:00:00Z", ends_at: "2099-12-06T09:00:00Z", price: null, status: "open", capacity: 10, seats_taken: 0 },
    { id: "S2", starts_at: "2099-12-13T06:00:00Z", ends_at: "2099-12-13T09:00:00Z", price: 3200, status: "open", capacity: 10, seats_taken: 0 },
  ];
  const db = fakeDb(
    tables({ products: () => ({ data: ROW }), workshop_sessions: () => ({ data: futureSessions }), course_lessons: () => ({ data: [] }), product_blocks: () => ({ data: [] }) }),
    { writesThrow: true },
  );
  resetMocks(db);
  const r = await call("update_product", { product: PID, price: 2500 });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json!.price_change, ["售價：NT$ 3,000 → NT$ 2,500（左邊是目前售價，右邊是改完的新售價）"]);
  assert.deepEqual(r.json!.changes, { price: { from: 3000, to: 2500 } });
  assert.deepEqual(r.json!.confirm_args, { product: PID, price: 2500, dry_run: false });
  // 場次價格留空的那一場會跟著變，要逐場講出來（fake 的場次在未來）
  assert.deepEqual(r.json!.session_prices, [
    "2099/12/06 14:00 場：NT$ 3,000 → NT$ 2,500（這一場用課程售價，會跟著變）",
    "2099/12/13 14:00 場：維持 NT$ 3,200（這一場有自己的價格，不受影響）",
  ]);

  const writes: unknown[] = [];
  resetMocks(
    fakeDb(
      tables({
        products: (op) => {
          if (op.kind === "update") writes.push(op.values);
          return { data: op.kind === "select" ? ROW : null };
        },
        workshop_sessions: () => ({ data: futureSessions }),
      }),
    ),
  );
  const done = await call("update_product", r.json!.confirm_args);
  assert.equal(done.isError, false, done.text);
  assert.deepEqual(writes, [{ price: 2500 }]); // is_published 等沒給的欄位不寫回去
});

test("update_product 不能用來上架（is_published 會被剝掉，沒有其他欄位就拒絕）", async () => {
  resetMocks(fakeDb(tables({ products: () => ({ data: { ...ROW, is_published: false } }) }), { writesThrow: true }));
  const r = await call("update_product", { product: PID, is_published: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /沒有要改的欄位/);
});

test("set_lessons 預覽：列出新增／修改／刪除，漏列既有單元時預設擋下", async () => {
  const lessons = [
    { id: "aaaaaaaa-0000-4000-8000-000000000001", title: "第一堂", duration_sec: 600, youtube_id: "dQw4w9WgXcQ", free_preview: true, body: null, sort_order: 1 },
    { id: "aaaaaaaa-0000-4000-8000-000000000002", title: "第二堂", duration_sec: null, youtube_id: null, free_preview: false, body: null, sort_order: 2 },
  ];
  const responder = tables({
    products: () => ({ data: { ...ROW, type: "course" } }),
    course_lessons: (op) => ({ data: op.columns?.includes("title") ? lessons : lessons.map(({ id, sort_order }) => ({ id, sort_order })) }),
    workshop_sessions: () => ({ data: [] }),
    product_blocks: () => ({ data: [] }),
  });
  resetMocks(fakeDb(responder, { writesThrow: true }));
  const blocked = await call("set_lessons", { product: PID, lessons: [{ title: "新的一堂" }] });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /allow_delete/);

  resetMocks(fakeDb(responder, { writesThrow: true }));
  const r = await call("set_lessons", {
    product: PID,
    lessons: [{ id: lessons[0].id, title: "第一堂（改）" }, { id: lessons[1].id }, { title: "第三堂", youtube: "https://youtu.be/dQw4w9WgXcQ", duration: "12:30" }],
  });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(r.json!.summary.added, ["第 3 堂（新）「第三堂」"]);
  assert.deepEqual(r.json!.summary.modified, ["「第一堂（改）」：標題「第一堂」→「第一堂（改）」"]);
  assert.deepEqual(r.json!.summary.removed, []);
});

test("create_session：已上架商品的新場次先停止報名；時間用台北時間", async () => {
  const responder = tables({
    products: () => ({ data: ROW }),
    audit_log: () => ({ data: null }),
    workshop_sessions: () => ({ data: [] }),
  });
  resetMocks(fakeDb(responder, { writesThrow: true }));
  const r = await call("create_session", {
    product: PID,
    starts_at: "2026-12-06 14:00",
    ends_at: "2026-12-06 17:00",
    capacity: 12,
    status: "open", // create 不收 status
  });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json!.preview.status, "停止報名");
  assert.equal(r.json!.preview.starts_at, "2026/12/06 14:00");
  assert.equal("status" in r.json!.confirm_args, false);
});

test("upload_image_base64：不是圖片（SVG）→ 拒絕，不存", async () => {
  resetMocks(fakeDb(() => ({ data: null }), { writesThrow: true }));
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64");
  const r = await call("upload_image_base64", { data: svg });
  assert.equal(r.isError, true);
  assert.match(r.text, /不是 JPEG／PNG／WebP/);
});

test("upload_image_from_url：內網網址 → 拒絕", async () => {
  resetMocks(fakeDb(() => ({ data: null }), { writesThrow: true }));
  const r = await call("upload_image_from_url", { url: "https://169.254.169.254/latest/meta-data/" });
  assert.equal(r.isError, true);
  assert.match(r.text, /內網或本機/);
});
