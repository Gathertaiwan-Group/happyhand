/**
 * MCP 寫入的身分與預覽測試（本機，不碰任何真實資料）：
 *   - 機器身分（runAsMachine(MCP_ACTOR)）拿不到 mcp:requests：AI 不能看或關閉申請
 *   - dismissMcpRequest() 在碰資料庫之前就拒絕機器身分、客服、編輯、沒有 id 的身分
 *   - 預覽制的 preview 函式只讀不寫：餵一個「任何寫入就爆」的假資料庫，
 *     而且 run() 在預覽階段不會被呼叫
 *
 * 跑法（repo 根目錄；server-only 換成空模組）。這支會連帶打包 next/cache，
 * 所以要用 cjs（next 內部用 __dirname）並把 @opentelemetry/api 標成 external：
 *
 *   echo "" > /tmp/empty.js
 *   node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     apps/web/lib/admin/mcp-requests.test.ts --bundle --platform=node --format=cjs \
 *     --external:@opentelemetry/api \
 *     --alias:@=./apps/web --alias:server-only=/tmp/empty.js --outfile=/tmp/mcp-requests.test.cjs
 *   node --test /tmp/mcp-requests.test.cjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCapability, type Staff } from "@/lib/admin/guard";
import { MCP_ACTOR, runAsMachine } from "@/lib/admin/machine";
import { dismissMcpRequest } from "@/lib/admin/mcp-pending-repo";
import {
  previewCancelOrder,
  previewMarkOrderPaid,
  previewReissueInvoice,
  type Db,
} from "@/lib/admin/mcp-requests";

const ORDER = "11111111-2222-4333-8444-555555555555";

/* ------------------------------------------------------------ 身分 */

test("🔴 機器身分在 runAsMachine 裡拿不到 mcp:requests（看不到也關不了申請）", async () => {
  const got = await runAsMachine(MCP_ACTOR, () => checkCapability("mcp:requests"));
  assert.equal(got, null);
  // 對照：同一個機器身分拿得到它白名單內的能力
  const ok = await runAsMachine(MCP_ACTOR, () => checkCapability("orders:read"));
  assert.ok(ok);
});

test("🔴 dismissMcpRequest 只接受有 mcp:requests 的真人身分（在碰資料庫前就擋）", async () => {
  const denied: Staff[] = [
    MCP_ACTOR,
    { ...MCP_ACTOR, caps: [...(MCP_ACTOR.caps ?? []), "mcp:requests"] }, // 就算白名單被加了也不行（via=mcp）
    { id: "u-support", email: "s@x", role: "support" },
    { id: "u-editor", email: "e@x", role: "editor" },
    { id: "", email: "o@x", role: "owner" }, // 沒有 id
    { id: "u-owner", email: "o@x", role: "owner", caps: ["mcp:requests"] }, // 帶 caps 的不是 cookie 身分
  ];
  for (const s of denied) {
    const r = await dismissMcpRequest(s, ORDER, "refund");
    assert.deepEqual(r, { error: "只有負責人可以關閉 AI 的申請。" }, JSON.stringify(s));
  }
});

/* ------------------------------------------------------------ 預覽不寫入 */

type Row = Record<string, unknown>;

/** 只支援讀的假 PostgREST client。任何寫入（insert/update/upsert/delete/rpc）直接 throw。 */
function readOnlyDb(tables: Record<string, Row[]>, writes: string[]): Db {
  function builder(table: string) {
    let rows = [...(tables[table] ?? [])];
    let head = false;
    const b: Record<string, unknown> = {
      select(_cols?: string, opts?: { head?: boolean }) {
        head = !!opts?.head;
        return b;
      },
      eq(col: string, val: unknown) {
        rows = rows.filter((r) => r[col] === val);
        return b;
      },
      in(col: string, vals: unknown[]) {
        rows = rows.filter((r) => vals.includes(r[col]));
        return b;
      },
      like() {
        return b;
      },
      order() {
        return b;
      },
      limit() {
        return b;
      },
      maybeSingle() {
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      single() {
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(resolve: (v: unknown) => void) {
        resolve(head ? { count: rows.length, data: null, error: null } : { data: rows, error: null });
      },
    };
    for (const w of ["insert", "update", "upsert", "delete"]) {
      b[w] = () => {
        writes.push(`${table}.${w}`);
        throw new Error(`預覽不應該寫入：${table}.${w}`);
      };
    }
    return b;
  }
  return {
    from: (t: string) => builder(t),
    rpc: (fn: string) => {
      writes.push(`rpc.${fn}`);
      throw new Error(`預覽不應該呼叫 rpc：${fn}`);
    },
  } as unknown as Db;
}

function orderRow(over: Row = {}): Row {
  return {
    id: ORDER,
    order_no: "HH-TEST-0001",
    status: "pending",
    total: 3600,
    price_unverified: false,
    user_id: null,
    contact_email: null,
    contact_name: null,
    contact_phone: null,
    payment_method: "atm",
    payment_provider: null,
    paid_at: null,
    created_at: "2026-11-10T00:00:00Z",
    order_items: [],
    invoices: null,
    ...over,
  };
}

test("mark_order_paid 預覽：ATM 待收款 → 會執行；只讀不寫、run 沒被呼叫", async () => {
  const writes: string[] = [];
  const p = await previewMarkOrderPaid(readOnlyDb({ orders: [orderRow()] }, writes), "HH-TEST-0001");
  assert.equal(p.ok, true);
  if (!p.ok) return;
  assert.equal(p.willExecute, true);
  assert.match(p.message, /待收款/);
  assert.deepEqual(writes, []);
});

test("🔴 mark_order_paid 預覽：線上刷卡一律不執行，說明要到黑貓 PAY 後台核對", async () => {
  for (const over of [{ payment_method: "credit" }, { payment_method: "atm", payment_provider: "blackcat" }, { payment_method: null }]) {
    const writes: string[] = [];
    const p = await previewMarkOrderPaid(readOnlyDb({ orders: [orderRow(over)] }, writes), ORDER);
    assert.equal(p.ok, true);
    if (!p.ok) return;
    assert.equal(p.willExecute, false, JSON.stringify(over));
    assert.match(p.message, /黑貓 PAY 後台核對/);
    // 不執行的預覽，run() 只會回錯誤、不會碰任何 action
    assert.deepEqual(await p.run(), { error: p.message });
    assert.deepEqual(writes, []);
  }
});

test("mark_order_paid 預覽：不存在的訂單 → 錯誤，並提醒只限 ATM／人工", async () => {
  const p = await previewMarkOrderPaid(readOnlyDb({ orders: [] }, []), "HH-00000000-NONE");
  assert.equal(p.ok, false);
  if (p.ok) return;
  assert.match(p.error, /找不到訂單/);
  assert.match(p.error, /ATM/);
});

test("mark_order_paid 預覽：已收款的訂單不會再執行", async () => {
  const p = await previewMarkOrderPaid(readOnlyDb({ orders: [orderRow({ status: "paid" })] }, []), ORDER);
  assert.equal(p.ok && p.willExecute, false);
});

test("reissue_invoice 預覽：照後台補開發票的條件；已開立／已作廢／未收款不執行", async () => {
  const cases: [Row, Row | null, boolean][] = [
    [{ status: "pending" }, null, false],
    [{ status: "paid" }, { order_id: ORDER, status: "issued", invoice_number: "AB12345678" }, false],
    [{ status: "paid" }, { order_id: ORDER, status: "voided", invoice_number: null }, false],
  ];
  for (const [o, inv, expected] of cases) {
    const writes: string[] = [];
    const db = readOnlyDb({ orders: [orderRow(o)], invoices: inv ? [inv] : [] }, writes);
    const p = await previewReissueInvoice(db, ORDER);
    assert.equal(p.ok, true);
    if (!p.ok) return;
    assert.equal(p.willExecute, expected, JSON.stringify([o, inv]));
    assert.ok("invoice_status" in p.current);
    assert.deepEqual(writes, []);
  }
});

test("cancel_order 預覽：只限待收款", async () => {
  const pending = await previewCancelOrder(readOnlyDb({ orders: [orderRow()] }, []), ORDER);
  assert.equal(pending.ok && pending.willExecute, true);
  const paid = await previewCancelOrder(readOnlyDb({ orders: [orderRow({ status: "paid" })] }, []), ORDER);
  assert.equal(paid.ok && paid.willExecute, false);
});
