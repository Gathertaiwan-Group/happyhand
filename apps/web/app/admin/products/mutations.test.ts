/**
 * app/admin/products/mutations.ts 的單元測試（MCP 新增／編輯課程用的同一支寫入函式）。
 *
 * 業主規定正式站不能有測試資料，所以下面這幾件事全部用假資料庫在本機證明：
 *   1. 預覽（dryRun）真的不寫入：假資料庫一出現 insert／update／delete 就 throw，
 *      稽核與清快取也換成「一被呼叫就 throw」
 *   2. idempotency_key 防重複：同一個 key 第二次不會再 insert；並行時撞唯一約束也能認回
 *   3. 網址代稱自動產生與撞名加尾碼
 *   4. 刪除單元／區塊必須 allowDelete
 *
 * 跑法（repo 根目錄；server-only 換成空模組，next/*、guard、audit、supabase 換成 test-mocks.ts）：
 *
 *   echo "" > /tmp/empty.js
 *   M=./apps/web/app/admin/products/test-mocks.ts
 *   node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     apps/web/app/admin/products/mutations.test.ts --bundle --platform=node --format=esm \
 *     --alias:@=./apps/web --alias:server-only=/tmp/empty.js \
 *     --alias:next/navigation=$M --alias:next/cache=$M --alias:@/lib/admin/guard=$M \
 *     --alias:@/lib/admin/audit=$M --alias:@/lib/supabase/server=$M \
 *     --outfile=/tmp/mutations.test.mjs
 *   node --test /tmp/mutations.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProduct,
  createSession,
  pickAvailableSlug,
  saveBlocksCore,
  saveLessonsCore,
  slugBaseFor,
  updateProduct,
  updateSession,
  type MutationCtx,
  type ProductFields,
  type SessionFields,
} from "./mutations";
import { isValidSlug } from "./shared";
import { fakeDb, type Op, type Responder } from "./test-mocks";

const STAFF = { id: "", email: "mcp", role: "owner" as const, via: "mcp" as const };
const PID = "11111111-2222-4333-8444-555555555555";

function fields(over: Partial<ProductFields> = {}): ProductFields {
  return {
    type: "workshop",
    slug: "renshen-intro",
    title: "仁神術入門",
    subtitle: "",
    description: "",
    cover_url: "",
    hero_lead: "",
    price: "3600",
    compare_at_price: "",
    sort_order: "0",
    tags: "近期新課",
    benefits: "",
    suitable_for: "",
    not_suitable_for: "",
    outcomes: "",
    curriculum_online: "",
    curriculum_onsite: "",
    includes: "",
    notes: "",
    is_published: false,
    is_featured: false,
    asks_intake: false,
    ...over,
  };
}

function session(over: Partial<SessionFields> = {}): SessionFields {
  return {
    starts_at: "2026-12-06T14:00",
    ends_at: "2026-12-06T17:00",
    capacity: "12",
    status: "open",
    location: "台北教室",
    address: "",
    title: "",
    summary: "",
    notes: "",
    price: "",
    format: "onsite",
    ...over,
  };
}

/** 稽核與清快取一被呼叫就 throw —— 預覽不能留下任何副作用。 */
function strictCtx(db: unknown): MutationCtx {
  return {
    db: db as MutationCtx["db"],
    staff: STAFF,
    audit: async () => {
      throw new Error("預覽不該寫稽核");
    },
    revalidate: () => {
      throw new Error("預覽不該清快取");
    },
  };
}

function recordingCtx(db: unknown) {
  const audits: { action: string; diff: unknown; summary: string }[] = [];
  const revalidated: (string | undefined)[] = [];
  const ctx: MutationCtx = {
    db: db as MutationCtx["db"],
    staff: STAFF,
    audit: async (_s, input) => {
      audits.push({ action: input.action, diff: input.diff, summary: input.summary });
    },
    revalidate: (id) => revalidated.push(id),
  };
  return { ctx, audits, revalidated };
}

const BEFORE_PRODUCT = {
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

/** 依表名回資料的 responder。 */
function byTable(map: Record<string, (op: Op) => ReturnType<Responder>>): Responder {
  return (op) => (map[op.table] ? map[op.table](op) : { data: null });
}

/* ================================================================ 1. 預覽不寫入 */

test("createProduct dryRun：只讀、不寫、不記稽核、不清快取", async () => {
  const db = fakeDb(byTable({ products: () => ({ data: [] }), audit_log: () => ({ data: null }) }), { writesThrow: true });
  const r = await createProduct(strictCtx(db), fields(), { dryRun: true, idempotencyKey: "mcp-test-key-1" });
  assert.equal(r.error, undefined);
  assert.ok(!r.error && r.dryRun && r.id === "");
  assert.ok(db.log.every((op) => op.kind === "select"));
});

test("createProduct dryRun：代稱已被用 → 預覽就回 slug_taken", async () => {
  const db = fakeDb(byTable({ products: () => ({ data: [{ id: "x" }] }) }), { writesThrow: true });
  const r = await createProduct(strictCtx(db), fields(), { dryRun: true });
  assert.equal(r.error, "slug_taken");
});

test("updateProduct dryRun：回 diff 與改價，但不寫", async () => {
  const db = fakeDb(byTable({ products: () => ({ data: BEFORE_PRODUCT }) }), { writesThrow: true });
  const r = await updateProduct(strictCtx(db), PID, fields({ price: "2500" }), { dryRun: true, onlyKeys: ["price"] });
  assert.ok(!r.error);
  assert.deepEqual(r.write, { price: 2500 });
  assert.deepEqual(r.diff, { price: { from: 3000, to: 2500 } });
  // onlyKeys：沒給的欄位（例如 is_published）不在寫入內容裡
  assert.equal("is_published" in r.write, false);
});

test("saveLessonsCore dryRun：算出計畫但不寫", async () => {
  const db = fakeDb(
    byTable({ course_lessons: () => ({ data: [{ id: "L1", sort_order: 1 }, { id: "L2", sort_order: 2 }] }) }),
    { writesThrow: true },
  );
  const lesson = (id: string, title: string) => ({ id, title, duration_sec: null, youtube_id: null, free_preview: false, body: null });
  const r = await saveLessonsCore(strictCtx(db), PID, [lesson("L2", "二"), lesson("L1", "一"), lesson("", "三")], { dryRun: true });
  if (r.error !== undefined) throw new Error(r.error);
  assert.equal(r.plan.insert.length, 1);
  assert.deepEqual(r.plan.update.map((u) => [u.id, u.sort_order]), [["L2", 1], ["L1", 2]]);
});

test("createSession／updateSession／saveBlocksCore dryRun 都不寫", async () => {
  const db = fakeDb(
    byTable({
      workshop_sessions: (op) =>
        op.columns?.includes("seats_taken")
          ? { data: { id: "S1", starts_at: "2026-12-06T06:00:00.000Z", ends_at: "2026-12-06T09:00:00.000Z", location: null, address: null, capacity: 12, status: "open", seats_taken: 3 } }
          : { data: [] },
      product_blocks: () => ({ data: [{ id: "B1", sort_order: 1 }] }),
      audit_log: () => ({ data: null }),
    }),
    { writesThrow: true },
  );
  const c = await createSession(strictCtx(db), PID, session(), { dryRun: true, idempotencyKey: "mcp-test-key-2" });
  assert.ok(!c.error && c.dryRun);
  assert.equal(c.payload.starts_at, "2026-12-06T06:00:00.000Z"); // 台北 14:00 = UTC 06:00
  const u = await updateSession(strictCtx(db), PID, "S1", session({ capacity: "20" }), { dryRun: true, onlyKeys: ["capacity"] });
  assert.ok(!u.error);
  assert.deepEqual(u.write, { capacity: 20 });
  const b = await saveBlocksCore(strictCtx(db), PID, "faq", [{ id: "B1", title: "Q", body: "A", meta: {} }], { dryRun: true });
  assert.ok(!b.error);
});

test("updateSession：名額低於已報名人數 → session_capacity_invalid（預覽也擋）", async () => {
  const db = fakeDb(
    byTable({ workshop_sessions: () => ({ data: { id: "S1", seats_taken: 5, status: "open" } }) }),
    { writesThrow: true },
  );
  const u = await updateSession(strictCtx(db), PID, "S1", session({ capacity: "4" }), { dryRun: true, onlyKeys: ["capacity"] });
  assert.equal(u.error, "session_capacity_invalid");
});

/* ================================================================ 2. 冪等 */

test("idempotency：第一次建立把 key 寫進 product.create 稽核", async () => {
  const db = fakeDb(
    byTable({
      audit_log: () => ({ data: null }),
      products: (op) => (op.kind === "insert" ? { data: { id: "NEW1" } } : { data: [] }),
    }),
  );
  const { ctx, audits, revalidated } = recordingCtx(db);
  const r = await createProduct(ctx, fields(), { idempotencyKey: "mcp-key-aaaa" });
  assert.ok(!r.error && r.id === "NEW1" && !r.replayed);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "product.create");
  assert.equal((audits[0].diff as { idempotency_key: string }).idempotency_key, "mcp-key-aaaa");
  assert.deepEqual(revalidated, ["NEW1"]);
  // 稽核查詢是用 key 找的
  const lookup = db.log.find((op) => op.table === "audit_log");
  assert.ok(lookup?.filters.some(([, c, v]) => c === "diff->>idempotency_key" && v === "mcp-key-aaaa"));
});

test("idempotency：同一個 key 再送一次 → 不 insert，回當初那一筆（實際內容）", async () => {
  const db = fakeDb(
    byTable({
      audit_log: () => ({ data: { entity_id: "NEW1" } }),
      products: () => ({ data: { ...BEFORE_PRODUCT, id: "NEW1", slug: "renshen-intro", title: "當初的名稱" } }),
    }),
    { writesThrow: true },
  );
  const r = await createProduct(strictCtx(db), fields(), { idempotencyKey: "mcp-key-aaaa" });
  assert.ok(!r.error && r.replayed && r.id === "NEW1");
  assert.equal(r.existing?.title, "當初的名稱");
});

test("idempotency：同一個 key 被拿去建另一門課（代稱不同）→ idempotency_conflict，不建立", async () => {
  const db = fakeDb(
    byTable({
      audit_log: () => ({ data: { entity_id: "NEW1" } }),
      products: () => ({ data: { ...BEFORE_PRODUCT, id: "NEW1", slug: "another-course" } }),
    }),
    { writesThrow: true },
  );
  const r = await createProduct(strictCtx(db), fields(), { idempotencyKey: "mcp-key-aaaa" });
  assert.equal(r.error, "idempotency_conflict");
});

test("idempotency：並行時撞 products_slug_key 也認得回來", async () => {
  let lookups = 0;
  const db = fakeDb(
    byTable({
      audit_log: () => {
        lookups += 1;
        return { data: lookups === 1 ? null : { entity_id: "NEW1" } };
      },
      products: (op) =>
        op.kind === "insert"
          ? { error: { code: "23505", message: "dup" } }
          : op.filters.some(([, c, v]) => c === "id" && v === "NEW1")
            ? { data: { ...BEFORE_PRODUCT, id: "NEW1", slug: "renshen-intro" } }
            : { data: [] },
    }),
  );
  const { ctx, audits } = recordingCtx(db);
  const r = await createProduct(ctx, fields(), { idempotencyKey: "mcp-key-aaaa" });
  assert.ok(!r.error && r.replayed && r.id === "NEW1");
  assert.equal(audits.length, 0); // 沒有新建，就不記第二筆 product.create
});

test("沒帶 key（後台表單）：不查稽核、稽核 diff 跟以前一樣只有 created", async () => {
  const db = fakeDb(byTable({ products: (op) => (op.kind === "insert" ? { data: { id: "NEW2" } } : { data: [] }) }));
  const { ctx, audits } = recordingCtx(db);
  const r = await createProduct(ctx, fields());
  assert.ok(!r.error);
  assert.equal(db.log.some((op) => op.table === "audit_log"), false);
  assert.deepEqual(Object.keys(audits[0].diff as object), ["created"]);
});

test("idempotency：場次同一個 key 重送不再新增；查詢限定同一門課", async () => {
  const db = fakeDb(
    byTable({
      audit_log: () => ({ data: { entity_id: "S9" } }),
      workshop_sessions: () => ({ data: { id: "S9", product_id: PID, starts_at: "2026-12-06T06:00:00+00:00" } }),
    }),
    { writesThrow: true },
  );
  const r = await createSession(strictCtx(db), PID, session(), { idempotencyKey: "mcp-key-bbbb" });
  assert.ok(!r.error && r.replayed && r.id === "S9");
  const lookup = db.log.find((op) => op.table === "audit_log");
  assert.ok(lookup?.filters.some(([, c, v]) => c === "diff->>product_id" && v === PID));
});

test("idempotency：場次 key 重用在不同開始時間 → idempotency_conflict", async () => {
  const db = fakeDb(
    byTable({
      audit_log: () => ({ data: { entity_id: "S9" } }),
      workshop_sessions: () => ({ data: { id: "S9", product_id: PID, starts_at: "2026-12-13T06:00:00+00:00" } }),
    }),
    { writesThrow: true },
  );
  const r = await createSession(strictCtx(db), PID, session(), { idempotencyKey: "mcp-key-bbbb" });
  assert.equal(r.error, "idempotency_conflict");
});

/* ================================================================ 3. 代稱 */

test("slugBaseFor：有英數字用英數字，全中文用 類型-台北日期", () => {
  const now = new Date("2026-11-15T17:30:00.000Z"); // 台北已經是 11/16 01:30
  assert.equal(slugBaseFor("JSJ 讀脈入門課", "course", now), "jsj");
  assert.equal(slugBaseFor("Jin Shin Jyutsu 自我療癒", "course", now), "jin-shin-jyutsu");
  assert.equal(slugBaseFor("仁神術入門工作坊", "workshop", now), "workshop-20261116");
  assert.equal(slugBaseFor("AB 課", "course", now), "course-20261116"); // 少於 3 個英數字
  for (const t of ["JSJ 讀脈", "仁神術", "  ---  ", "Ｆｕｌｌｗｉｄｔｈ 全形", "a".repeat(200)]) {
    assert.ok(isValidSlug(slugBaseFor(t, "workshop", now)), t);
  }
});

test("pickAvailableSlug：撞名依序加 -2、-3", async () => {
  const taken = (slugs: string[]) => fakeDb(() => ({ data: slugs.map((slug) => ({ slug })) }), { writesThrow: true });
  assert.equal(await pickAvailableSlug(taken([]) as never, "jsj"), "jsj");
  assert.equal(await pickAvailableSlug(taken(["jsj"]) as never, "jsj"), "jsj-2");
  assert.equal(await pickAvailableSlug(taken(["jsj", "jsj-2", "jsj-intro"]) as never, "jsj"), "jsj-3");
  const v = await pickAvailableSlug(taken(["workshop-20261116"]) as never, "workshop-20261116");
  assert.equal(v, "workshop-20261116-2");
  assert.ok(isValidSlug(v));
});

/* ================================================================ 4. 刪除要明講 */

test("saveLessonsCore allowDelete=false：清單漏掉既有單元 → 擋下，不寫", async () => {
  const db = fakeDb(
    byTable({ course_lessons: () => ({ data: [{ id: "L1", sort_order: 1 }, { id: "L2", sort_order: 2 }] }) }),
    { writesThrow: true },
  );
  const r = await saveLessonsCore(
    strictCtx(db),
    PID,
    [{ id: "", title: "新的一堂", duration_sec: null, youtube_id: null, free_preview: false, body: null }],
    { dryRun: false, allowDelete: false },
  );
  assert.match(r.error ?? "", /少了 2 個既有單元/);
});

test("saveBlocksCore allowDelete=false：清單漏掉既有項目 → 擋下，不寫", async () => {
  const db = fakeDb(byTable({ product_blocks: () => ({ data: [{ id: "B1", sort_order: 1 }] }) }), { writesThrow: true });
  const r = await saveBlocksCore(strictCtx(db), PID, "faq", [], { dryRun: false, allowDelete: false });
  assert.match(r.error ?? "", /少了 1 筆/);
});

test("新建一律草稿由呼叫端決定：fields.is_published=false 時 payload 也是 false", async () => {
  const db = fakeDb(byTable({ products: () => ({ data: [] }) }), { writesThrow: true });
  const r = await createProduct(strictCtx(db), fields({ is_published: false }), { dryRun: true });
  assert.ok(!r.error && r.payload.is_published === false);
});
