/**
 * POST /api/orders 的單元測試：未上架（草稿）商品與它底下的場次不能被下單。
 *
 * 業主規定 AI 不可以在正式站建立訂單、也不可以對正式站呼叫 /api/orders，
 * 所以整條下單流程在本機用假資料庫跑：假的 supabase、假的黑貓 PAY，
 * 沒有任何網路請求。被拒的請求要證明「連 orders 都沒有 insert、
 * 也沒有跟黑貓要付款網址」。
 *
 * 跑法（repo 根目錄；server-only 換成空模組，其餘換成 test-mocks.ts）：
 *
 *   echo "" > /tmp/empty.js
 *   M=./apps/web/app/api/orders/test-mocks.ts
 *   node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     apps/web/app/api/orders/route.test.ts --bundle --platform=node --format=esm \
 *     --alias:@=./apps/web --alias:server-only=/tmp/empty.js \
 *     --alias:next/server=$M --alias:next/cache=$M --alias:@/lib/supabase/server=$M \
 *     --alias:@/lib/account/provision=$M --alias:@/lib/email/outbox=$M \
 *     --alias:@/lib/payment/blackcat=$M \
 *     --outfile=/tmp/orders-route.test.mjs
 *   node --test /tmp/orders-route.test.mjs
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetFake, type FakeRow, type FakeState } from "./test-mocks";
import { POST } from "./route";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";

const PUB = "11111111-1111-4111-8111-111111111111";
const DRAFT = "22222222-2222-4222-8222-222222222222";
const PUB_COURSE = "33333333-3333-4333-8333-333333333333";
const S_PUB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S_DRAFT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString();

function tables(): Record<string, FakeRow[]> {
  return {
    products: [
      { id: PUB, slug: "reading-pulse", price: 3000, is_published: true, type: "workshop" },
      { id: PUB_COURSE, slug: "online-basic", price: 1800, is_published: true, type: "course" },
      // MCP 新建的草稿：自動產生、很好猜的代稱，價格還沒定（業主隨手填的 100）
      { id: DRAFT, slug: "workshop-20261115", price: 100, is_published: false, type: "workshop" },
    ],
    workshop_sessions: [
      { id: S_PUB, product_id: PUB, price: 2500, capacity: 10, seats_taken: 0, status: "open", starts_at: FUTURE },
      // 草稿商品底下的場次：商品是草稿時 create_session 預設「開放報名」
      { id: S_DRAFT, product_id: DRAFT, price: 50, capacity: 10, seats_taken: 0, status: "open", starts_at: FUTURE },
    ],
  };
}

let fake: FakeState;
let ipSeq = 0;
beforeEach(() => {
  fake = resetFake(tables());
});

type Item = { slug: string; title?: string; sessionId?: string | null; priceSnapshot?: number; qty?: number };

async function order(items: Item[], payment: "credit" | "atm" | "manual" = "atm") {
  const res = await POST(
    new Request("http://localhost/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.0.${ipSeq >> 8}.${ipSeq++ & 255}` },
      body: JSON.stringify({
        name: "測試",
        phone: "0912345678",
        email: "t@example.com",
        payment,
        invoice: { carrierType: "cloud", carrierId: "", taxId: "", title: "" },
        items: items.map((i) => ({
          productId: i.slug,
          slug: i.slug,
          title: i.title ?? i.slug,
          type: "workshop",
          qty: i.qty ?? 1,
          priceSnapshot: i.priceSnapshot ?? 0,
          sessionId: i.sessionId ?? null,
          sessionLabel: null,
        })),
      }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function assertNothingWritten() {
  assert.deepEqual(fake.inserts, [], "被拒的請求不可以寫入任何資料");
  assert.deepEqual(fake.credit, [], "被拒的請求不可以跟黑貓 PAY 要付款網址");
}

/* ------------------------------------------------------------ 草稿要被擋 */

for (const payment of ["credit", "atm", "manual"] as const) {
  test(`草稿商品的 slug（${payment}）→ 400，不建單、不叫黑貓`, async () => {
    const r = await order([{ slug: "workshop-20261115", title: "草稿工作坊" }], payment);
    assert.equal(r.status, 400);
    assert.match(String(r.body.message), /這門課目前沒有開放購買/);
    assertNothingWritten();
  });
}

test("草稿商品 + 它自己的場次（場次是開放報名）→ 400", async () => {
  const r = await order([{ slug: "workshop-20261115", sessionId: S_DRAFT }], "credit");
  assert.equal(r.status, 400);
  assert.match(String(r.body.message), /這門課目前沒有開放購買/);
  assertNothingWritten();
});

test("已上架商品的 slug 配上草稿商品的場次 id（拼裝請求）→ 400，不會用草稿場次的價格成交", async () => {
  const r = await order([{ slug: "reading-pulse", sessionId: S_DRAFT }], "credit");
  assert.equal(r.status, 400);
  assert.match(String(r.body.message), /這門課目前沒有開放購買/);
  assertNothingWritten();
});

test("購物車裡原本上架、後來被下架的商品 → 400", async () => {
  fake.tables.products.find((p) => p.id === PUB)!.is_published = false;
  const r = await order([{ slug: "reading-pulse", sessionId: S_PUB, priceSnapshot: 2500 }], "atm");
  assert.equal(r.status, 400);
  assert.match(String(r.body.message), /這門課目前沒有開放購買/);
  assertNothingWritten();
});

test("一筆已上架 + 一筆草稿混在同一張單 → 整張拒絕", async () => {
  const r = await order([{ slug: "online-basic" }, { slug: "workshop-20261115" }], "manual");
  assert.equal(r.status, 400);
  assertNothingWritten();
});

test("is_published 是 null（不是明確的 true）→ 當作未上架", async () => {
  fake.tables.products.find((p) => p.id === PUB_COURSE)!.is_published = null;
  const r = await order([{ slug: "online-basic" }]);
  assert.equal(r.status, 400);
  assertNothingWritten();
});

test("讀 products 失敗 → 拒單（fail closed），不退回前端價格", async () => {
  fake.failSelect.add("products");
  const r = await order([{ slug: "online-basic", priceSnapshot: 1 }]);
  assert.equal(r.status, 400);
  assertNothingWritten();
});

test("讀場次失敗 → 拒單（無法確認場次歸屬）", async () => {
  fake.failSelect.add("workshop_sessions");
  const r = await order([{ slug: "reading-pulse", sessionId: S_PUB }]);
  assert.equal(r.status, 400);
  assertNothingWritten();
});

test("不存在的 slug → 沿用原本「已經下架」訊息", async () => {
  const r = await order([{ slug: "no-such-thing", title: "不存在" }]);
  assert.equal(r.status, 400);
  assert.match(String(r.body.message), /已經下架/);
  assertNothingWritten();
});

test("伺服器端真的有撈 is_published（不是靠假資料庫多給欄位）", async () => {
  await order([{ slug: "online-basic" }]);
  const q = fake.selects.find((s) => s.table === "products");
  assert.ok(q && /\bis_published\b/.test(q.columns), `products select 沒有 is_published：${q?.columns}`);
});

/* ------------------------------------------------- 已上架商品的正常下單不變 */

test("已上架工作坊 + 自己的場次（ATM）→ 200，用梯次價、寫入正確的商品與場次", async () => {
  const r = await order([{ slug: "reading-pulse", sessionId: S_PUB, priceSnapshot: 1 }], "atm");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total, 2500);
  assert.equal(r.body.persisted, true);
  assert.equal(r.body.price_unverified, false);
  const items = fake.inserts.find((i) => i.table === "order_items")!.rows;
  assert.deepEqual(items.map((i) => [i.product_id, i.session_id, i.unit_price, i.qty]), [[PUB, S_PUB, 2500, 1]]);
  assert.deepEqual(fake.credit, []);
});

test("已上架線上課（刷卡）→ 200，黑貓收到的金額是資料庫價格", async () => {
  const r = await order([{ slug: "online-basic", priceSnapshot: 1, qty: 2 }], "credit");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total, 3600);
  assert.equal(r.body.payment_url, "https://pay.invalid/fake");
  assert.equal(fake.credit.length, 1);
  assert.equal(fake.credit[0].amount, 3600);
});

test("已上架商品混搭（人工）→ 200", async () => {
  const r = await order([{ slug: "online-basic" }, { slug: "reading-pulse", sessionId: S_PUB }], "manual");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total, 1800 + 2500);
});

test("場次沒有自訂價（null）→ 回退商品價；0 元場次照樣是 0", async () => {
  fake.tables.workshop_sessions.find((s) => s.id === S_PUB)!.price = null;
  const a = await order([{ slug: "reading-pulse", sessionId: S_PUB }]);
  assert.equal(a.body.total, 3000);
  fake.tables.workshop_sessions.find((s) => s.id === S_PUB)!.price = 0;
  const b = await order([{ slug: "reading-pulse", sessionId: S_PUB }]);
  assert.equal(b.body.total, 0);
});
