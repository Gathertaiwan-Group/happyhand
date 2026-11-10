/**
 * app/admin/orders/refund-lease.ts 的單元測試。
 *
 * 業主規定 AI 不可以寫正式站的金流資料，所以「兩個同時退款只有一個拿到鎖」
 * 在這裡用一個模擬 Postgres 列鎖語意的假資料庫證明（同一列的 UPDATE 排隊執行、
 * 每個 UPDATE 在輪到它時才評估 where）。
 *
 * 跑法（repo 根目錄；server-only 換成空模組）：
 *
 *   echo "" > /tmp/empty.js
 *   node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     apps/web/app/admin/orders/refund-lease.test.ts --bundle --platform=node --format=esm \
 *     --alias:@=./apps/web --alias:server-only=/tmp/empty.js --outfile=/tmp/refund-lease.test.mjs
 *   node --test /tmp/refund-lease.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimRefundLease, leaseAvailable, REFUND_LEASE_MS, type LeaseDb } from "./refund-lease";

const ORDER = "11111111-2222-4333-8444-555555555555";
const T0 = Date.parse("2026-11-10T00:00:00.000Z");
/** 訂單上次被改是 1 小時前 —— 可以退 */
const OLD = "2026-11-09T23:00:00.123456+00:00";

/**
 * 假的 orders 表：一列。UPDATE 用一條 promise 鏈排隊（= Postgres 的 row lock），
 * 每一個 UPDATE 在拿到列鎖之後才讀「目前的值」評估 where（= EvalPlanQual）。
 */
function fakeDb(row: { id: string; status: string; updated_at: string }) {
  let queue: Promise<unknown> = Promise.resolve();
  let updates = 0;
  const db: LeaseDb = {
    from: () => ({
      update: (patch) => ({
        eq: (_c1, id) => ({
          eq: (_c2, status) => ({
            eq: (_c3, updatedAt) => ({
              select: () => ({
                maybeSingle: () => {
                  const run = queue.then(async () => {
                    // 讓出事件迴圈，模擬網路往返，確保兩個請求真的交錯
                    await new Promise((r) => setTimeout(r, 5));
                    if (row.id === id && row.status === status && row.updated_at === updatedAt) {
                      row.updated_at = patch.updated_at;
                      updates += 1;
                      return { data: { id }, error: null };
                    }
                    return { data: null, error: null };
                  });
                  queue = run;
                  return run;
                },
              }),
            }),
          }),
        }),
      }),
    }),
  };
  return { db, row, updates: () => updates };
}

test("🔴 兩個同時進來的退款（讀到同一個版本）只有一個拿到鎖", async () => {
  const f = fakeDb({ id: ORDER, status: "paid", updated_at: OLD });
  // 兩個請求都在任何寫入之前讀到 OLD
  const [a, b] = await Promise.all([
    claimRefundLease(f.db, ORDER, OLD, T0),
    claimRefundLease(f.db, ORDER, OLD, T0 + 3),
  ]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal(f.updates(), 1);
});

test("🔴 十個同時進來也只有一個", async () => {
  const f = fakeDb({ id: ORDER, status: "paid", updated_at: OLD });
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => claimRefundLease(f.db, ORDER, OLD, T0 + i)),
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test("🔴 鎖被拿走之後才讀到新版本的請求，也被擋（租約），而且不送出任何寫入", async () => {
  const f = fakeDb({ id: ORDER, status: "paid", updated_at: OLD });
  assert.equal((await claimRefundLease(f.db, ORDER, OLD, T0)).ok, true);
  const fresh = f.row.updated_at; // 晚到的請求讀到的是搶鎖後的值
  const late = await claimRefundLease(f.db, ORDER, fresh, T0 + 30_000);
  assert.equal(late.ok, false);
  assert.equal(f.updates(), 1);
});

test("退刷失敗（狀態仍是 paid）→ 租約到期後可以再試，不會永久卡住", async () => {
  const f = fakeDb({ id: ORDER, status: "paid", updated_at: OLD });
  assert.equal((await claimRefundLease(f.db, ORDER, OLD, T0)).ok, true);
  const afterClaim = f.row.updated_at;
  assert.equal((await claimRefundLease(f.db, ORDER, afterClaim, T0 + REFUND_LEASE_MS - 1)).ok, false);
  assert.equal((await claimRefundLease(f.db, ORDER, afterClaim, T0 + REFUND_LEASE_MS)).ok, true);
});

test("狀態已經不是 paid（例如已退款）→ 搶不到", async () => {
  const f = fakeDb({ id: ORDER, status: "refunded", updated_at: OLD });
  assert.equal((await claimRefundLease(f.db, ORDER, OLD, T0)).ok, false);
  assert.equal(f.updates(), 0);
});

test("leaseAvailable：太新、未來時間、解析不出來一律拒絕", () => {
  assert.equal(leaseAvailable(OLD, T0).ok, true);
  assert.equal(leaseAvailable(new Date(T0 - 1000).toISOString(), T0).ok, false);
  assert.equal(leaseAvailable(new Date(T0 + 60_000).toISOString(), T0).ok, false); // 時鐘誤差
  assert.equal(leaseAvailable("not a date", T0).ok, false);
  assert.equal(leaseAvailable(null, T0).ok, false);
  // PostgREST 回的微秒格式要解析得出來
  assert.equal(Number.isFinite(Date.parse("2026-11-09T23:00:00.123456+00:00")), true);
});
