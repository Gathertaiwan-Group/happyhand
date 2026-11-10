/**
 * AI（MCP）提出的「退款申請」「作廢發票申請」—— 什麼叫「待處理」的唯一定義。
 *
 * 純函式、零 IO：讀寫在 lib/admin/mcp-pending-repo.ts，測試在 mcp-pending.test.ts。
 *
 * ## 為什麼是申請制（2026-11-10 業主拍板，比照小時光書店）
 *
 * AI 可以被 prompt injection。以前的「本人確認連結」讓 AI 拿到一條可以點的網址，
 * 能操作瀏覽器的 AI 有機會自己點開按下確認。現在 MCP 的 request_refund /
 * request_invoice_void **不退款、不作廢、不給任何連結**：只在 audit_log 留一筆申請，
 * 負責人在後台首頁看到，進訂單頁用**原本的按鈕**（「退款」「已在後台退過款」
 * 「作廢發票」）處理。錢與發票只會因為負責人親手按下原本的按鈕而移動。
 *
 * ## 存在哪裡（不新增表或欄位：合併資料庫沒有 DDL 權限）
 *
 * audit_log 的一列：entity='order'、entity_id=訂單 id、
 *   申請：action = mcp.refund_request / mcp.invoice_void_request，actor_role='mcp'
 *   關閉：action = mcp.request_dismissed，actor_role='owner'、actor_id=按下去的那位負責人，
 *         diff.kind 指出關的是哪一種申請
 * audit_log.id 是 identity，單調遞增，用它判斷先後（不用 created_at）。
 *
 * ## 什麼叫「待處理」
 *
 * 對每一張訂單、每一種申請，取**最新一筆**申請（id 最大）。它待處理若且唯若：
 *   (a) 沒有任何一筆同訂單、同種類、id 比它大的「關閉」紀錄；而且
 *   (b) 狀態仍成立 ——
 *         退款：訂單現在仍是 paid
 *         作廢：發票現在仍是 issued，而且號碼等於申請當時的號碼
 * 處理完（退款成功、作廢成功）不必另外寫任何東西：狀態一變，(b) 就不成立。
 * paid → refunded、issued → voided 都是終點，所以舊申請不會因為狀態「變回來」而復活。
 *
 * ## 只信任該信任的列（防偽造）
 *
 * - 申請列必須 actor_role='mcp' 且 actor_id 為 null（機器身分寫出來的樣子）。
 * - 關閉列必須是有 mcp:requests 能力的角色（目前只有 owner）寫的、actor_id 不是 null
 *   （真人負責人的 cookie 身分）。
 *   MCP 寫不出這種列：機器身分的 actor_role 一律是 'mcp'、actor_id 一律是 null。
 * audit_log 只有 service role 寫得進去（RLS 開著、沒有任何 grant）。
 */

import { can, toRole } from "@/lib/admin/roles";

export type McpRequestKind = "refund" | "invoice_void";

export const MCP_REQUEST_KINDS: readonly McpRequestKind[] = ["refund", "invoice_void"];

export const MCP_REQUEST_ACTION: Record<McpRequestKind, string> = {
  refund: "mcp.refund_request",
  invoice_void: "mcp.invoice_void_request",
};

export const MCP_REQUEST_DISMISSED_ACTION = "mcp.request_dismissed";

/** 讀取時要撈的全部 action */
export const MCP_REQUEST_LOG_ACTIONS: readonly string[] = [
  MCP_REQUEST_ACTION.refund,
  MCP_REQUEST_ACTION.invoice_void,
  MCP_REQUEST_DISMISSED_ACTION,
];

export const MCP_REQUEST_KIND_LABEL: Record<McpRequestKind, string> = {
  refund: "退款申請",
  invoice_void: "作廢發票申請",
};

/** 預覽稽核的 action 前綴：mcp.preview.<工具名>。稽核頁用這個前綴分得出來／篩得掉。 */
export const MCP_PREVIEW_ACTION_PREFIX = "mcp.preview.";

/** audit_log 的一列（只取需要的欄位） */
export type McpRequestLogRow = {
  id: number;
  created_at: string;
  entity: string;
  entity_id: string | null;
  action: string;
  actor_id: string | null;
  actor_role: string | null;
  diff: unknown;
};

/** 訂單與發票「現在」的狀態，從資料庫讀 */
export type McpRequestOrderFacts = {
  order_id: string;
  order_no: string;
  status: string;
  total: number;
  payment_method: string | null;
  invoice_status: string | null;
  invoice_number: string | null;
};

export type PendingMcpRequest = {
  requestId: number;
  kind: McpRequestKind;
  orderId: string;
  orderNo: string;
  requestedAt: string;
  /** AI 寫的原因 —— 只能當一般文字渲染，畫面上要標明「AI 提供的原因」 */
  reason: string;
  /** 退款：訂單金額（資料庫現值） */
  amount: number | null;
  paymentMethod: string | null;
  /** 作廢：申請時的發票號碼（＝目前號碼，否則不會是待處理） */
  invoiceNumber: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function diffField(diff: unknown, key: string): string {
  if (!diff || typeof diff !== "object" || Array.isArray(diff)) return "";
  const v = (diff as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

function requestKindOf(action: string): McpRequestKind | null {
  if (action === MCP_REQUEST_ACTION.refund) return "refund";
  if (action === MCP_REQUEST_ACTION.invoice_void) return "invoice_void";
  return null;
}

function isKind(value: string): value is McpRequestKind {
  return (MCP_REQUEST_KINDS as readonly string[]).includes(value);
}

/** 機器身分（MCP）寫出來的申請列長這樣；其他樣子一律不認。 */
function isTrustedRequest(r: McpRequestLogRow): boolean {
  return (
    r.entity === "order" &&
    typeof r.entity_id === "string" &&
    UUID_RE.test(r.entity_id) &&
    r.actor_role === "mcp" &&
    r.actor_id === null
  );
}

/** 真人負責人按「不處理，關閉申請」寫出來的列長這樣；其他樣子一律不認。
 *  角色用能力表判斷（roles.ts 的 mcp:requests），不散落 "owner" 字串比對。 */
function isTrustedDismiss(r: McpRequestLogRow): boolean {
  return (
    r.entity === "order" &&
    typeof r.entity_id === "string" &&
    r.actor_role !== "mcp" &&
    can(toRole(r.actor_role), "mcp:requests") &&
    typeof r.actor_id === "string" &&
    r.actor_id.length > 0
  );
}

function key(orderId: string, kind: McpRequestKind): string {
  return `${orderId.toLowerCase()}|${kind}`;
}

/**
 * 推導目前所有待處理的申請（新到舊）。
 *
 * `rows` 可以混著不相干的 action，會被忽略；`orders` 缺某張訂單時，那張的申請不算
 * 待處理（讀不到現況就不能宣稱它仍成立）。
 */
export function pendingMcpRequests(
  rows: readonly McpRequestLogRow[],
  orders: readonly McpRequestOrderFacts[],
): PendingMcpRequest[] {
  const latestRequest = new Map<string, { row: McpRequestLogRow; kind: McpRequestKind }>();
  const latestDismiss = new Map<string, number>();

  for (const r of rows) {
    const id = Number(r.id);
    if (!Number.isFinite(id)) continue;
    const kind = requestKindOf(r.action);
    if (kind) {
      if (!isTrustedRequest(r)) continue;
      const k = key(r.entity_id as string, kind);
      const cur = latestRequest.get(k);
      if (!cur || id > Number(cur.row.id)) latestRequest.set(k, { row: r, kind });
    } else if (r.action === MCP_REQUEST_DISMISSED_ACTION) {
      if (!isTrustedDismiss(r)) continue;
      const dk = diffField(r.diff, "kind");
      if (!isKind(dk)) continue;
      const k = key(r.entity_id as string, dk);
      latestDismiss.set(k, Math.max(latestDismiss.get(k) ?? 0, id));
    }
  }

  const byOrder = new Map(orders.map((o) => [o.order_id.toLowerCase(), o]));
  const out: PendingMcpRequest[] = [];

  for (const [k, { row, kind }] of latestRequest) {
    const reqId = Number(row.id);
    // (a) 之後有對應的關閉紀錄 → 不算
    if ((latestDismiss.get(k) ?? 0) > reqId) continue;

    const orderId = (row.entity_id as string).toLowerCase();
    const o = byOrder.get(orderId);
    if (!o) continue;

    // (b) 狀態仍成立
    let invoiceNumber: string | null = null;
    if (kind === "refund") {
      if (o.status !== "paid") continue;
    } else {
      const number = diffField(row.diff, "invoice_number");
      if (o.invoice_status !== "issued" || !number || o.invoice_number !== number) continue;
      invoiceNumber = number;
    }

    out.push({
      requestId: reqId,
      kind,
      orderId: o.order_id,
      orderNo: o.order_no,
      requestedAt: row.created_at,
      reason: diffField(row.diff, "reason"),
      amount: kind === "refund" ? o.total : null,
      paymentMethod: o.payment_method,
      invoiceNumber,
    });
  }

  return out.sort((a, b) => b.requestId - a.requestId);
}

/**
 * 負責人關閉申請後的冷卻：同一張訂單、同一種申請在這段時間內不再接受新申請。
 * 不然被注入的 AI 可以從稽核紀錄看到「被關了」，立刻再申請一次，反覆施壓負責人。
 */
export const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/** 這張訂單、這種申請最近一次「負責人關閉」的時間（只認可信的關閉列）；沒有就 null。 */
export function lastDismissedAt(
  rows: readonly McpRequestLogRow[],
  orderId: string,
  kind: McpRequestKind,
): string | null {
  const id = orderId.toLowerCase();
  let best: McpRequestLogRow | null = null;
  for (const r of rows) {
    if (r.action !== MCP_REQUEST_DISMISSED_ACTION || !isTrustedDismiss(r)) continue;
    if ((r.entity_id as string).toLowerCase() !== id || diffField(r.diff, "kind") !== kind) continue;
    if (!best || Number(r.id) > Number(best.id)) best = r;
  }
  return best?.created_at ?? null;
}

/** 現在是否還在關閉後的冷卻期內。時間解析不出來一律當作在冷卻中（保守）。 */
export function inDismissCooldown(dismissedAt: string | null, now: number = Date.now()): boolean {
  if (!dismissedAt) return false;
  const t = Date.parse(dismissedAt);
  if (!Number.isFinite(t)) return true;
  return now - t < DISMISS_COOLDOWN_MS;
}

/** 某張訂單、某種申請目前待處理的那一筆；沒有就 null。 */
export function findPending(
  pending: readonly PendingMcpRequest[],
  orderId: string,
  kind: McpRequestKind,
): PendingMcpRequest | null {
  const id = orderId.toLowerCase();
  return pending.find((p) => p.kind === kind && p.orderId.toLowerCase() === id) ?? null;
}

/* ------------------------------------------------------------ 申請原因 */

/** 後台「作廢發票」的原因輸入框是 maxLength=20（order-invoice-panel.tsx），送到 Amego。 */
export const VOID_REASON_MAX = 20;
export const REFUND_REASON_MAX = 200;

export type ReasonCheck = { ok: true; reason: string } | { ok: false; message: string };

/**
 * 正規化 AI 給的申請原因：控制字元換成空白、前後去空白、不能空、長度上限。
 * 作廢原因的長度規則跟後台「作廢發票」一樣（20 字，JS 字串長度，同 input maxLength）。
 */
export function normalizeRequestReason(kind: McpRequestKind, raw: unknown): ReasonCheck {
  if (typeof raw !== "string") return { ok: false, message: "請提供申請原因。" };
  const reason = raw
    // 控制字元 → 空白
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    // 零寬字元與雙向控制字元直接拿掉：React 會跳脫所以沒有 XSS，但 U+202E 之類
    // 能讓負責人看到的文字順序被翻轉，拿來誤導（2026-11-10 資安審查）。
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .trim();
  if (!reason) return { ok: false, message: "請提供申請原因。" };
  const max = kind === "invoice_void" ? VOID_REASON_MAX : REFUND_REASON_MAX;
  if (reason.length > max) {
    return {
      ok: false,
      message:
        kind === "invoice_void"
          ? `作廢原因最多 ${max} 字（跟後台「作廢發票」一樣，會送到 Amego），目前 ${reason.length} 字。`
          : `退款原因最多 ${max} 字，目前 ${reason.length} 字。`,
    };
  }
  return { ok: true, reason };
}

/* --------------------------------------------------------- mark_order_paid */

/**
 * MCP 的 mark_order_paid 只接受人工收款的訂單（ATM 轉帳、人工／臨櫃）。
 * 線上刷卡（credit／黑貓 PAY）的收款只能由金流商的通知確立 —— 金流商沒通知收款，
 * 就不能讓 AI 手動標記。
 */
export function manualPaymentAllowed(paymentMethod: string | null, paymentProvider: string | null): boolean {
  if (paymentProvider === "blackcat") return false;
  return paymentMethod === "atm" || paymentMethod === "manual";
}
