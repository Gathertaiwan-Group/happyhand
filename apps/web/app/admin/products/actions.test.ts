/**
 * 後台表單（app/admin/products/actions.ts）重構後行為不變的測試。
 *
 * 2026-11-15 把 upsertProduct／upsertSession／saveLessons／saveBlocks 的本體抽到
 * mutations.ts（MCP 共用）。這裡用同一組 FormData 打 server action，檢查
 * redirect 目的地（含 ?msg= 代碼、?type= 保留、#sessions）、回傳訊息、
 * 打到資料庫的每一個操作、稽核內容、清快取的路徑。
 *
 * 重構當下另外把 origin/main 的舊 actions.ts 換進來跑過同一份測試，比對兩邊的完整輸出
 * （HH_DUMP：redirect、回傳值、每一個資料庫操作、稽核、清快取）。唯一刻意的差異是
 * session.update 的稽核 diff 多記梯次名稱／摘要／形式／價格／補充說明（只增不減）。
 *
 * 跑法（repo 根目錄）：
 *
 *   echo "" > /tmp/empty.js
 *   M=./apps/web/app/admin/products/test-mocks.ts
 *   node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     apps/web/app/admin/products/actions.test.ts --bundle --platform=node --format=esm \
 *     --alias:@=./apps/web --alias:server-only=/tmp/empty.js \
 *     --alias:next/navigation=$M --alias:next/cache=$M --alias:@/lib/admin/guard=$M \
 *     --alias:@/lib/admin/audit=$M --alias:@/lib/supabase/server=$M \
 *     --outfile=/tmp/actions.test.mjs
 *   node --test /tmp/actions.test.mjs
 *   # 想看完整輸出：HH_DUMP=/tmp/out.json node --test /tmp/actions.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { saveBlocks, saveLessons, upsertProduct, upsertSession } from "./actions";
import { fakeDb, resetMocks, RedirectSignal, type Op, type Responder } from "./test-mocks";

const PID = "11111111-2222-4333-8444-555555555555";
const dump: Record<string, unknown> = {};

after(() => {
  if (process.env.HH_DUMP) writeFileSync(process.env.HH_DUMP, JSON.stringify(dump, null, 2));
});

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

const VALID_PRODUCT = {
  type: "workshop",
  slug: "renshen-intro",
  title: "  仁神術入門  ",
  subtitle: "一句話",
  description: "",
  cover_url: "",
  hero_lead: "",
  price: "3600",
  compare_at_price: "4000",
  sort_order: "0",
  tags: "近期新課\n\n入門",
  benefits: "",
  suitable_for: "第一次接觸",
  not_suitable_for: "",
  outcomes: "",
  curriculum_online: "",
  curriculum_onsite: "",
  includes: "",
  notes: "",
  is_featured: "on",
};

const BEFORE = {
  id: PID,
  type: "workshop",
  slug: "old-slug",
  title: "舊名",
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

async function runRedirect(name: string, responder: Responder, fn: () => Promise<unknown>, staff = true) {
  const db = fakeDb(responder);
  const h = resetMocks(db, staff ? { id: "u1", email: "a@b", role: "owner" } : null);
  let dest = "(沒有 redirect)";
  try {
    await fn();
  } catch (err) {
    if (err instanceof RedirectSignal) dest = err.destination;
    else throw err;
  }
  const out = { dest, ops: db.log, audits: h.audits.map((a) => a.input), revalidated: h.revalidated };
  dump[name] = out;
  return out;
}

async function runState(name: string, responder: Responder, fn: () => Promise<unknown>) {
  const db = fakeDb(responder);
  const h = resetMocks(db);
  const result = await fn();
  const out = { result, ops: db.log, audits: h.audits.map((a) => a.input), revalidated: h.revalidated };
  dump[name] = out;
  return out;
}

const none: Responder = () => ({ data: null });
const tables =
  (map: Record<string, (op: Op) => ReturnType<Responder>>): Responder =>
  (op) =>
    map[op.table] ? map[op.table](op) : { data: null };

/* ============================================================ upsertProduct */

test("新增：代稱格式錯 → 回新增頁並保留 ?type=workshop", async () => {
  const o = await runRedirect("p.slug_format", none, () => upsertProduct(form({ ...VALID_PRODUCT, slug: "中文" })));
  assert.equal(o.dest, "/admin/products/new?msg=slug_format&type=workshop");
  assert.equal(o.ops.length, 0);
});

test("新增：類型不合法 → 不反射到網址", async () => {
  const o = await runRedirect("p.type_invalid", none, () => upsertProduct(form({ ...VALID_PRODUCT, type: "<x>" })));
  assert.equal(o.dest, "/admin/products/new?msg=type_invalid");
});

test("新增：各種驗證錯誤的代碼", async () => {
  const cases: [Record<string, string>, string][] = [
    [{ title: "   " }, "title_required"],
    [{ price: "abc" }, "price_invalid"],
    [{ price: "-1" }, "price_invalid"],
    [{ compare_at_price: "x" }, "compare_invalid"],
    [{ compare_at_price: "100" }, "compare_invalid"],
    [{ sort_order: "" }, "sort_invalid"],
  ];
  for (const [over, code] of cases) {
    const o = await runRedirect(`p.${code}.${JSON.stringify(over)}`, none, () =>
      upsertProduct(form({ ...VALID_PRODUCT, ...over })),
    );
    assert.equal(o.dest, `/admin/products/new?msg=${code}&type=workshop`);
  }
});

test("新增成功 → 編輯頁 ?msg=created，稽核與清快取", async () => {
  const o = await runRedirect(
    "p.create_ok",
    tables({ products: (op) => (op.kind === "insert" ? { data: { id: "NEW1" } } : { data: null }) }),
    () => upsertProduct(form(VALID_PRODUCT)),
  );
  assert.equal(o.dest, "/admin/products/NEW1?msg=created");
  assert.equal(o.audits.length, 1);
  assert.equal(o.audits[0].action, "product.create");
  assert.equal(o.audits[0].summary, "新增工作坊「仁神術入門」（renshen-intro）");
  assert.deepEqual(o.revalidated, [
    "/admin/courses",
    "/admin/workshops",
    "/admin/products/NEW1",
    "/admin",
    "/",
    "/courses",
    "/courses/[slug]|page",
    "/workshops",
    "/workshops/[slug]|page",
  ]);
});

test("新增：代稱撞名（23505）→ slug_taken；其他錯誤 → failed", async () => {
  const dup = await runRedirect(
    "p.create_dup",
    tables({ products: () => ({ error: { code: "23505", message: "dup" } }) }),
    () => upsertProduct(form({ ...VALID_PRODUCT, type: "course" })),
  );
  assert.equal(dup.dest, "/admin/products/new?msg=slug_taken&type=course");
  const fail = await runRedirect(
    "p.create_fail",
    tables({ products: () => ({ error: { code: "XX000", message: "boom" } }) }),
    () => upsertProduct(form(VALID_PRODUCT)),
  );
  assert.equal(fail.dest, "/admin/products/new?msg=failed&type=workshop");
});

test("新增：沒有權限 → denied 並保留 type", async () => {
  const o = await runRedirect("p.denied", none, () => upsertProduct(form(VALID_PRODUCT)), false);
  assert.equal(o.dest, "/admin/products/new?msg=denied&type=workshop");
});

test("編輯：找不到 → 依 type 回清單 ?msg=notfound", async () => {
  const o = await runRedirect("p.edit_notfound", none, () => upsertProduct(form({ ...VALID_PRODUCT, id: PID })));
  assert.equal(o.dest, "/admin/workshops?msg=notfound");
});

test("編輯：驗證錯誤不帶 type、留在編輯頁", async () => {
  const o = await runRedirect("p.edit_invalid", none, () =>
    upsertProduct(form({ ...VALID_PRODUCT, id: PID, compare_at_price: "1" })),
  );
  assert.equal(o.dest, `/admin/products/${PID}?msg=compare_invalid`);
});

test("編輯成功：?msg=saved，稽核寫出代稱變更", async () => {
  const o = await runRedirect(
    "p.edit_ok",
    tables({ products: (op) => (op.kind === "select" ? { data: BEFORE } : { data: null }) }),
    () => upsertProduct(form({ ...VALID_PRODUCT, id: PID })),
  );
  assert.equal(o.dest, `/admin/products/${PID}?msg=saved`);
  assert.equal(o.audits[0].summary, "更新「仁神術入門」，網址代稱 old-slug → renshen-intro（舊網址將失效）");
  const upd = o.ops.find((op) => op.kind === "update");
  assert.equal((upd?.values as { is_published: boolean }).is_published, false); // 表單沒勾 = 下架，跟以前一樣
});

test("編輯：讀取失敗 → failed；更新撞代稱 → slug_taken", async () => {
  const readFail = await runRedirect(
    "p.edit_readfail",
    tables({ products: () => ({ error: { message: "x" } }) }),
    () => upsertProduct(form({ ...VALID_PRODUCT, id: PID })),
  );
  assert.equal(readFail.dest, `/admin/products/${PID}?msg=failed`);
  const dup = await runRedirect(
    "p.edit_dup",
    tables({ products: (op) => (op.kind === "select" ? { data: BEFORE } : { error: { code: "23505", message: "d" } }) }),
    () => upsertProduct(form({ ...VALID_PRODUCT, id: PID })),
  );
  assert.equal(dup.dest, `/admin/products/${PID}?msg=slug_taken`);
});

/* ============================================================ upsertSession */

const VALID_SESSION = {
  starts_at: "2026-12-06T14:00",
  ends_at: "2026-12-06T17:00",
  capacity: "12",
  status: "open",
  location: " 台北教室 ",
  address: "",
  title: "",
  summary: "",
  notes: "",
  price: "",
  format: "onsite",
};

test("場次：各種驗證錯誤都回 #sessions", async () => {
  const cases: [Record<string, string>, string][] = [
    [{ ends_at: "2026-12-06T13:00" }, "session_time_invalid"],
    [{ starts_at: "2026-02-30T10:00" }, "session_time_invalid"],
    [{ capacity: "-1" }, "session_capacity_invalid"],
    [{ capacity: "" }, "session_capacity_invalid"],
    [{ price: "x" }, "session_price_invalid"],
  ];
  for (const [over, code] of cases) {
    const o = await runRedirect(`s.${code}.${JSON.stringify(over)}`, none, () =>
      upsertSession(PID, form({ ...VALID_SESSION, ...over })),
    );
    assert.equal(o.dest, `/admin/products/${PID}?msg=${code}#sessions`);
  }
});

test("場次：新增成功／撞時間／失敗", async () => {
  const ok = await runRedirect(
    "s.create_ok",
    tables({ workshop_sessions: () => ({ data: { id: "S1", status: "open" } }) }),
    () => upsertSession(PID, form({ ...VALID_SESSION, status: "weird" })),
  );
  assert.equal(ok.dest, `/admin/products/${PID}?msg=session_saved#sessions`);
  assert.equal(ok.audits[0].summary, "新增場次 2026/12/06 14:00（台北教室，名額 12）");
  const dup = await runRedirect(
    "s.create_dup",
    tables({ workshop_sessions: () => ({ error: { code: "23505", message: "d" } }) }),
    () => upsertSession(PID, form(VALID_SESSION)),
  );
  assert.equal(dup.dest, `/admin/products/${PID}?msg=session_duplicate#sessions`);
  const fail = await runRedirect(
    "s.create_fail",
    tables({ workshop_sessions: () => ({ error: { code: "XX", message: "d" } }) }),
    () => upsertSession(PID, form(VALID_SESSION)),
  );
  assert.equal(fail.dest, `/admin/products/${PID}?msg=failed#sessions`);
});

test("場次：編輯找不到／名額低於報名數／成功（記落地狀態）", async () => {
  const nf = await runRedirect("s.edit_nf", none, () => upsertSession(PID, form({ ...VALID_SESSION, session_id: "S1" })));
  assert.equal(nf.dest, `/admin/products/${PID}?msg=session_notfound#sessions`);

  const before = { id: "S1", starts_at: "2026-12-06T06:00:00.000Z", ends_at: "2026-12-06T09:00:00.000Z", location: null, address: null, capacity: 10, status: "open", seats_taken: 8, title: null, summary: null, format: "onsite", price: null, notes: null };
  const low = await runRedirect(
    "s.edit_low",
    tables({ workshop_sessions: () => ({ data: before }) }),
    () => upsertSession(PID, form({ ...VALID_SESSION, session_id: "S1", capacity: "5" })),
  );
  assert.equal(low.dest, `/admin/products/${PID}?msg=session_capacity_invalid#sessions`);

  const ok = await runRedirect(
    "s.edit_ok",
    tables({ workshop_sessions: (op) => (op.kind === "select" ? { data: before } : { data: { status: "full" } }) }),
    () => upsertSession(PID, form({ ...VALID_SESSION, session_id: "S1", capacity: "8" })),
  );
  assert.equal(ok.dest, `/admin/products/${PID}?msg=session_saved#sessions`);
  assert.equal(ok.audits[0].summary, "更新場次 2026/12/06 14:00（已額滿，名額 8）");
});

test("場次：沒有權限 → denied#sessions", async () => {
  const o = await runRedirect("s.denied", none, () => upsertSession(PID, form(VALID_SESSION)), false);
  assert.equal(o.dest, `/admin/products/${PID}?msg=denied#sessions`);
});

/* ============================================================== saveLessons */

test("單元：標題空白、YouTube 看不懂、數量不對", async () => {
  const noTitle = await runState("l.no_title", none, () =>
    saveLessons(PID, null, form({ lesson_count: "1", "lessons.0.title": " " })),
  );
  assert.deepEqual(noTitle.result, { error: "第 1 個單元沒有填標題。" });
  const badYt = await runState("l.bad_yt", none, () =>
    saveLessons(PID, null, form({ lesson_count: "1", "lessons.0.title": "一", "lessons.0.youtube_url": "https://vimeo.com/1" })),
  );
  assert.match((badYt.result as { error: string }).error, /^第 1 個單元的 YouTube 網址看不懂/);
  const badCount = await runState("l.bad_count", none, () => saveLessons(PID, null, form({ lesson_count: "201" })));
  assert.deepEqual(badCount.result, { error: "單元數量不正確，請重新整理後再試。" });
});

test("單元：重排 + 新增 + 刪除，兩階段寫入與稽核", async () => {
  const o = await runState(
    "l.save_ok",
    tables({
      course_lessons: (op) =>
        op.kind === "select"
          ? { data: [{ id: "L1", sort_order: 1 }, { id: "L2", sort_order: 2 }, { id: "L3", sort_order: 3 }] }
          : { data: null },
    }),
    () =>
      saveLessons(
        PID,
        null,
        form({
          lesson_count: "3",
          "lessons.0.id": "L2",
          "lessons.0.title": "二",
          "lessons.0.youtube_url": "https://youtu.be/dQw4w9WgXcQ",
          "lessons.0.min": "12",
          "lessons.0.sec": "30",
          "lessons.0.free_preview": "on",
          "lessons.0.body": "第一段\r\n\r\n第二段",
          "lessons.1.id": "L1",
          "lessons.1.title": "一",
          "lessons.2.title": "四（新）",
        }),
      ),
  );
  assert.deepEqual(o.result, { ok: "已儲存 3 個單元。" });
  assert.deepEqual(
    o.ops.map((op) => op.kind),
    ["select", "delete", "update", "update", "update", "update", "insert"],
  );
  assert.equal(o.audits[0].summary, "更新單元清單：共 3 個單元（新增 1、刪除 1）");
});

test("單元：過期的 id → 擋下整批", async () => {
  const o = await runState(
    "l.unknown",
    tables({ course_lessons: () => ({ data: [] }) }),
    () => saveLessons(PID, null, form({ lesson_count: "1", "lessons.0.id": "GONE", "lessons.0.title": "x" })),
  );
  assert.deepEqual(o.result, { error: "這份單元清單已經過期（有單元被其他同事刪掉了），請重新整理後再存一次。" });
});

/* =============================================================== saveBlocks */

test("區塊：類型不對、數量不對、金額不對、空列跳過", async () => {
  const kind = await runState("b.kind", none, () => saveBlocks(PID, "nope", null, form({ block_count: "0" })));
  assert.deepEqual(kind.result, { error: "區塊類型不正確，請重新整理後再試。" });
  const count = await runState("b.count", none, () => saveBlocks(PID, "faq", null, form({ block_count: "101" })));
  assert.deepEqual(count.result, { error: "常見問題的數量不正確，請重新整理後再試。" });
  const amount = await runState("b.amount", none, () =>
    saveBlocks(PID, "pricing", null, form({ block_count: "1", "blocks.0.title": "新生", "blocks.0.amount": "1.5" })),
  );
  assert.deepEqual(amount.result, { error: "第 1 個費用方案的金額請填 0 或正整數。" });
  const ok = await runState(
    "b.ok",
    tables({ product_blocks: (op) => (op.kind === "select" ? { data: [{ id: "B1", sort_order: 1 }] } : { data: null }) }),
    () =>
      saveBlocks(
        PID,
        "pricing",
        null,
        form({
          block_count: "3",
          "blocks.0.id": "B1",
          "blocks.0.title": " 新生價 ",
          "blocks.0.amount": "3600",
          "blocks.0.note": "含講義",
          "blocks.1.title": "",
          "blocks.1.body": "",
          "blocks.2.title": "複訓",
          "blocks.2.body": "舊生",
        }),
      ),
  );
  assert.deepEqual(ok.result, { ok: "已儲存 2 筆費用方案。" });
  assert.equal(ok.audits[0].summary, "更新費用方案（共 2 筆）");
});
