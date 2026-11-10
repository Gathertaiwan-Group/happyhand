/**
 * AI（MCP）申請制的單元測試：lib/admin/mcp-pending.ts（待處理的唯一定義）、
 * 負責人限定（roles.ts 的 mcp:requests、MCP_ACTOR、dismissMcpRequest 的身分檢查），
 * 以及預覽制的 preview 函式真的不寫入（lib/admin/mcp-requests.ts）。
 *
 * 業主規定 AI 不可以寫正式站的金流資料，申請也會在負責人後台留下真的待處理項目，
 * 所以這些全部用本機假資料跑。
 *
 * 跑法（repo 根目錄；server-only 換成空模組）：
 *
 *   echo "" > /tmp/empty.js
 *   node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     apps/web/lib/admin/mcp-pending.test.ts --bundle --platform=node --format=esm \
 *     --alias:@=./apps/web --alias:server-only=/tmp/empty.js --outfile=/tmp/mcp-pending.test.mjs
 *   node --test /tmp/mcp-pending.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISMISS_COOLDOWN_MS,
  findPending,
  inDismissCooldown,
  lastDismissedAt,
  manualPaymentAllowed,
  MCP_REQUEST_ACTION,
  MCP_REQUEST_DISMISSED_ACTION,
  normalizeRequestReason,
  pendingMcpRequests,
  type McpRequestLogRow,
  type McpRequestOrderFacts,
} from "@/lib/admin/mcp-pending";
import { can, ROLES } from "@/lib/admin/roles";
import { MCP_ACTOR } from "@/lib/admin/machine";

const A = "11111111-2222-4333-8444-555555555555";
const B = "22222222-2222-4333-8444-555555555555";
const OWNER_ID = "99999999-0000-4000-8000-000000000001";
const SUPPORT_ID = "99999999-0000-4000-8000-000000000002";

let seq = 0;
function req(
  orderId: string,
  kind: "refund" | "invoice_void",
  extra: Partial<McpRequestLogRow> & { diff?: Record<string, unknown> } = {},
): McpRequestLogRow {
  seq += 1;
  return {
    id: extra.id ?? seq,
    created_at: `2026-11-10T00:00:${String(seq).padStart(2, "0")}Z`,
    entity: "order",
    entity_id: orderId,
    action: MCP_REQUEST_ACTION[kind],
    actor_id: null,
    actor_role: "mcp",
    ...extra,
    diff: extra.diff ?? (kind === "refund" ? { kind, reason: "客人要求退款" } : { kind, invoice_number: "AB12345678", reason: "開錯載具" }),
  };
}

function dismiss(
  orderId: string,
  kind: "refund" | "invoice_void",
  extra: Partial<McpRequestLogRow> = {},
): McpRequestLogRow {
  seq += 1;
  return {
    id: extra.id ?? seq,
    created_at: "2026-11-10T01:00:00Z",
    entity: "order",
    entity_id: orderId,
    action: MCP_REQUEST_DISMISSED_ACTION,
    actor_id: OWNER_ID,
    actor_role: "owner",
    diff: { kind },
    ...extra,
  };
}

function order(id: string, over: Partial<McpRequestOrderFacts> = {}): McpRequestOrderFacts {
  return {
    order_id: id,
    order_no: id === A ? "HH-A" : "HH-B",
    status: "paid",
    total: 3600,
    payment_method: "credit",
    invoice_status: "issued",
    invoice_number: "AB12345678",
    ...over,
  };
}

/* ------------------------------------------------------------ 推導 */

test("申請之後、狀態仍成立 → 待處理；兩種申請各自獨立", () => {
  const rows = [req(A, "refund"), req(A, "invoice_void")];
  const p = pendingMcpRequests(rows, [order(A)]);
  assert.equal(p.length, 2);
  assert.ok(findPending(p, A, "refund"));
  assert.ok(findPending(p, A, "invoice_void"));
  const r = findPending(p, A, "refund")!;
  assert.equal(r.orderNo, "HH-A");
  assert.equal(r.amount, 3600);
  assert.equal(r.reason, "客人要求退款");
});

test("每張訂單每種申請只取最新一筆（id 最大，不看陣列順序）", () => {
  const older = req(A, "refund", { id: 10, diff: { kind: "refund", reason: "舊的" } });
  const newer = req(A, "refund", { id: 20, diff: { kind: "refund", reason: "新的" } });
  const p = pendingMcpRequests([newer, older], [order(A)]);
  assert.equal(p.length, 1);
  assert.equal(p[0].reason, "新的");
  assert.equal(p[0].requestId, 20);
});

test("之後有關閉紀錄 → 不算；關閉在申請之前 → 不影響；關閉後再申請 → 又是待處理", () => {
  const r1 = req(A, "refund", { id: 100 });
  const d1 = dismiss(A, "refund", { id: 101 });
  assert.equal(pendingMcpRequests([r1, d1], [order(A)]).length, 0);

  const dEarlier = dismiss(A, "refund", { id: 99 });
  assert.equal(pendingMcpRequests([r1, dEarlier], [order(A)]).length, 1);

  const r2 = req(A, "refund", { id: 102 });
  const p = pendingMcpRequests([r1, d1, r2], [order(A)]);
  assert.equal(p.length, 1);
  assert.equal(p[0].requestId, 102);
});

test("關閉只關同種類、同一張訂單", () => {
  const rows = [req(A, "refund", { id: 200 }), req(A, "invoice_void", { id: 201 }), req(B, "refund", { id: 202 }), dismiss(A, "refund", { id: 203 })];
  const p = pendingMcpRequests(rows, [order(A), order(B)]);
  assert.equal(findPending(p, A, "refund"), null);
  assert.ok(findPending(p, A, "invoice_void"));
  assert.ok(findPending(p, B, "refund"));
});

test("退款：訂單狀態一變（退款成功）就自動不算待處理", () => {
  const rows = [req(A, "refund")];
  for (const status of ["refunded", "cancelled", "pending"]) {
    assert.equal(pendingMcpRequests(rows, [order(A, { status })]).length, 0, status);
  }
});

test("作廢：發票作廢、號碼換了、或不存在 → 自動不算待處理", () => {
  const rows = [req(A, "invoice_void")];
  assert.equal(pendingMcpRequests(rows, [order(A, { invoice_status: "voided" })]).length, 0);
  assert.equal(pendingMcpRequests(rows, [order(A, { invoice_number: "ZZ00000000" })]).length, 0);
  assert.equal(pendingMcpRequests(rows, [order(A, { invoice_status: null, invoice_number: null })]).length, 0);
  // 申請列沒有號碼 → 不認
  const noNumber = req(A, "invoice_void", { diff: { kind: "invoice_void", reason: "x" } });
  assert.equal(pendingMcpRequests([noNumber], [order(A)]).length, 0);
});

test("讀不到訂單現況 → 不宣稱待處理", () => {
  assert.equal(pendingMcpRequests([req(A, "refund")], []).length, 0);
});

test("舊申請不會復活：最新一筆失效後，較舊的那筆也不會冒出來", () => {
  // 舊申請號碼 = 目前號碼，但最新一筆申請的號碼已過時 → 只看最新一筆，整組不算待處理
  const old = req(A, "invoice_void", { id: 300, diff: { kind: "invoice_void", invoice_number: "AB12345678", reason: "舊" } });
  const latest = req(A, "invoice_void", { id: 301, diff: { kind: "invoice_void", invoice_number: "XX99999999", reason: "新" } });
  assert.equal(pendingMcpRequests([old, latest], [order(A)]).length, 0);
});

/* ------------------------------------------------------------ 防偽造 */

test("🔴 申請列只認機器身分寫的樣子（actor_role=mcp、actor_id=null）", () => {
  const fakes = [
    req(A, "refund", { actor_role: "owner", actor_id: OWNER_ID }),
    req(A, "refund", { actor_role: "mcp", actor_id: OWNER_ID }),
    req(A, "refund", { actor_role: "support", actor_id: null }),
    req(A, "refund", { actor_role: null }),
    req(A, "refund", { entity: "product" }),
    req("not-a-uuid", "refund"),
  ];
  for (const f of fakes) assert.equal(pendingMcpRequests([f], [order(A)]).length, 0, JSON.stringify(f));
});

test("🔴 關閉列只認負責人真人寫的樣子：MCP、客服、編輯、沒帶 actor_id、種類不明一律不算", () => {
  const r = req(A, "refund", { id: 400 });
  const fakes = [
    dismiss(A, "refund", { id: 401, actor_role: "mcp", actor_id: null }),
    dismiss(A, "refund", { id: 402, actor_role: "mcp", actor_id: OWNER_ID }),
    dismiss(A, "refund", { id: 403, actor_role: "support", actor_id: SUPPORT_ID }),
    dismiss(A, "refund", { id: 404, actor_role: "editor", actor_id: SUPPORT_ID }),
    dismiss(A, "refund", { id: 405, actor_role: "owner", actor_id: null }),
    dismiss(A, "refund", { id: 406, actor_role: "owner", actor_id: "" }),
    dismiss(A, "refund", { id: 407, diff: { kind: "something_else" } }),
    dismiss(A, "refund", { id: 408, diff: null }),
  ];
  for (const f of fakes) {
    assert.equal(pendingMcpRequests([r, f], [order(A)]).length, 1, JSON.stringify(f));
  }
});

test("不相干的 action（例如預覽稽核 mcp.preview.*）一律忽略", () => {
  const preview = { ...req(A, "refund"), action: "mcp.preview.mark_order_paid" };
  assert.equal(pendingMcpRequests([preview], [order(A)]).length, 0);
});

/* ------------------------------------------------------------ 去重 */

test("去重：findPending 找得到同訂單同種類的待處理申請，大小寫不影響", () => {
  const p = pendingMcpRequests([req(A, "refund")], [order(A)]);
  assert.ok(findPending(p, A.toUpperCase(), "refund"));
  assert.equal(findPending(p, A, "invoice_void"), null);
  assert.equal(findPending(p, B, "refund"), null);
});

/* ------------------------------------------------------------ 原因 */

test("作廢原因長度規則跟後台一樣（20 字），退款原因 200 字；空白與非字串拒絕", () => {
  assert.deepEqual(normalizeRequestReason("invoice_void", "  開錯載具  "), { ok: true, reason: "開錯載具" });
  assert.equal(normalizeRequestReason("invoice_void", "一".repeat(20)).ok, true);
  assert.equal(normalizeRequestReason("invoice_void", "一".repeat(21)).ok, false);
  assert.equal(normalizeRequestReason("refund", "一".repeat(200)).ok, true);
  assert.equal(normalizeRequestReason("refund", "一".repeat(201)).ok, false);
  assert.equal(normalizeRequestReason("refund", "   ").ok, false);
  assert.equal(normalizeRequestReason("refund", undefined).ok, false);
  assert.equal(normalizeRequestReason("refund", 123).ok, false);
  // 控制字元換成空白
  assert.deepEqual(normalizeRequestReason("refund", "a\nb\u0000c"), { ok: true, reason: "a b c" });
  // 零寬與雙向控制字元拿掉（防止顯示順序被翻轉誤導負責人）
  assert.deepEqual(normalizeRequestReason("refund", "退\u202e款\u200b原\u2066因\ufeff"), { ok: true, reason: "退款原因" });
  assert.equal(normalizeRequestReason("refund", "\u202e\u200b").ok, false);
});

/* ------------------------------------------------------------ 關閉後冷卻 */

test("負責人關閉後 7 天內不再接受同訂單同種類的申請；只認可信的關閉列", () => {
  const now = Date.parse("2026-11-10T01:00:00Z");
  const d = dismiss(A, "refund", { id: 500, created_at: "2026-11-10T01:00:00Z" });
  assert.equal(lastDismissedAt([d], A, "refund"), "2026-11-10T01:00:00Z");
  assert.equal(lastDismissedAt([d], A, "invoice_void"), null);
  assert.equal(lastDismissedAt([d], B, "refund"), null);
  // MCP 或客服寫的「關閉」不算 → 不會被拿來擋掉別人的申請，也不會被當成負責人的決定
  assert.equal(lastDismissedAt([dismiss(A, "refund", { actor_role: "mcp", actor_id: null })], A, "refund"), null);
  assert.equal(lastDismissedAt([dismiss(A, "refund", { actor_role: "support", actor_id: SUPPORT_ID })], A, "refund"), null);

  assert.equal(inDismissCooldown(null, now), false);
  assert.equal(inDismissCooldown("2026-11-10T01:00:00Z", now + DISMISS_COOLDOWN_MS - 1), true);
  assert.equal(inDismissCooldown("2026-11-10T01:00:00Z", now + DISMISS_COOLDOWN_MS), false);
  assert.equal(inDismissCooldown("not-a-date", now), true);
});

/* ------------------------------------------------------- mark_order_paid */

test("mark_order_paid 只限 ATM／人工；credit、黑貓 PAY、null 一律不行", () => {
  assert.equal(manualPaymentAllowed("atm", null), true);
  assert.equal(manualPaymentAllowed("manual", null), true);
  assert.equal(manualPaymentAllowed("credit", null), false);
  assert.equal(manualPaymentAllowed("credit", "blackcat"), false);
  assert.equal(manualPaymentAllowed("atm", "blackcat"), false);
  assert.equal(manualPaymentAllowed(null, null), false);
  assert.equal(manualPaymentAllowed("", null), false);
});

/* ------------------------------------------------------------ 負責人限定 */

test("🔴 mcp:requests 只有 owner 有；MCP 機器身分沒有", () => {
  for (const role of ROLES) assert.equal(can(role, "mcp:requests"), role === "owner", role);
  assert.equal((MCP_ACTOR.caps ?? []).includes("mcp:requests"), false);
  assert.equal((MCP_ACTOR.caps ?? []).includes("staff:manage"), false);
});
