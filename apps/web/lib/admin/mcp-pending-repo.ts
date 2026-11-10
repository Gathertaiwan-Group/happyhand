import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { writeAuditStrict } from "@/lib/admin/audit";
import { MCP_ACTOR } from "@/lib/admin/machine";
import type { Staff } from "@/lib/admin/guard";
import { can } from "@/lib/admin/roles";
import { checkTransition, money, paymentMethodLabel } from "@/app/admin/orders/shared";
import {
  DISMISS_COOLDOWN_MS,
  findPending,
  inDismissCooldown,
  lastDismissedAt,
  MCP_REQUEST_ACTION,
  MCP_REQUEST_DISMISSED_ACTION,
  MCP_REQUEST_KIND_LABEL,
  MCP_REQUEST_LOG_ACTIONS,
  normalizeRequestReason,
  pendingMcpRequests,
  type McpRequestKind,
  type McpRequestLogRow,
  type McpRequestOrderFacts,
  type PendingMcpRequest,
} from "@/lib/admin/mcp-pending";
import { findOrder, readInvoice, type Db } from "@/lib/admin/mcp-requests";

/**
 * AI（MCP）申請的讀寫。「待處理」的定義在 lib/admin/mcp-pending.ts（純函式），
 * 這裡只負責撈資料、建立申請、寫「關閉申請」。
 *
 * 呼叫端：
 *   - app/api/mcp/route.ts 的 request_refund / request_invoice_void → createMcpRequest()
 *   - 後台首頁與訂單內頁（負責人限定）→ loadPendingMcpRequests()
 *   - app/admin/orders/mcp-request-actions.ts 的「不處理，關閉申請」→ dismissMcpRequest()
 */

/** 一次最多讀多少筆申請／關閉紀錄。關閉列的 id 一定比它關的申請大，截斷只會丟掉最舊的申請。 */
const LOG_LIMIT = 1000;

/**
 * 讀目前待處理的申請。讀取失敗一律 throw —— 呼叫端決定顯示「讀取失敗」還是回錯誤，
 * 絕不把「讀不到」當成「沒有待處理」（那會讓 MCP 重複建立、或讓負責人以為沒事）。
 */
export async function loadPendingMcpRequests(
  db: Db,
  opts: { orderId?: string } = {},
): Promise<PendingMcpRequest[]> {
  let q = db
    .from("audit_log")
    .select("id, created_at, entity, entity_id, action, actor_id, actor_role, diff")
    .eq("entity", "order")
    .in("action", MCP_REQUEST_LOG_ACTIONS as string[]);
  if (opts.orderId) q = q.eq("entity_id", opts.orderId);
  const { data, error } = await q.order("id", { ascending: false }).limit(LOG_LIMIT);
  if (error) throw new Error(`[mcp-pending] 讀申請失敗：${error.message}`);

  const rows = (data ?? []) as unknown as McpRequestLogRow[];
  const orderIds = [
    ...new Set(
      rows
        .filter((r) => r.action !== MCP_REQUEST_DISMISSED_ACTION && typeof r.entity_id === "string")
        .map((r) => r.entity_id as string),
    ),
  ].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (orderIds.length === 0) return [];

  const { data: orders, error: e2 } = await db
    .from("orders")
    .select("id, order_no, status, total, payment_method, invoices(status, invoice_number)")
    .in("id", orderIds);
  if (e2) throw new Error(`[mcp-pending] 讀訂單失敗：${e2.message}`);

  const facts: McpRequestOrderFacts[] = ((orders ?? []) as unknown as Record<string, unknown>[]).map((o) => {
    const raw = o.invoices as
      | { status: string; invoice_number: string | null }
      | { status: string; invoice_number: string | null }[]
      | null;
    const inv = Array.isArray(raw) ? raw[0] : raw;
    return {
      order_id: String(o.id),
      order_no: String(o.order_no ?? ""),
      status: String(o.status ?? ""),
      total: Number(o.total ?? 0),
      payment_method: (o.payment_method as string | null) ?? null,
      invoice_status: inv?.status ?? null,
      invoice_number: inv?.invoice_number ?? null,
    };
  });

  return pendingMcpRequests(rows, facts);
}

/* ------------------------------------------------------------ 建立申請 */

export type CreateRequestResult =
  | { status: "created"; message: string }
  | { status: "already_pending"; message: string }
  | { status: "error"; message: string };

/**
 * MCP 的 request_refund / request_invoice_void。
 *
 * 🔴 這裡**不退款、不作廢、不呼叫任何金流或 Amego**。只寫一筆 audit_log 申請。
 * 🔴 回給 AI 的只有文字，沒有任何連結或網址。
 */
export async function createMcpRequest(
  kind: McpRequestKind,
  orderRef: string,
  rawReason: unknown,
): Promise<CreateRequestResult> {
  const reason = normalizeRequestReason(kind, rawReason);
  if (!reason.ok) return { status: "error", message: reason.message };

  const db = createServiceClient();
  const o = await findOrder(db, orderRef);
  if (!o) return { status: "error", message: `找不到訂單 ${orderRef}。` };

  // 前置檢查跟後台按鈕一致
  let diff: Record<string, unknown>;
  let summary: string;
  if (kind === "refund") {
    const check = checkTransition(o.status, "refunded");
    if (!check.ok) {
      return { status: "error", message: `訂單 ${o.order_no} 不能申請退款：${check.message}` };
    }
    diff = {
      kind,
      order_no: o.order_no,
      amount: o.total,
      payment_method: o.payment_method,
      payment_provider: o.payment_provider,
      reason: reason.reason,
    };
    summary = `AI 透過 MCP 提出退款申請：訂單 ${o.order_no}（${money(o.total)}，${paymentMethodLabel(o.payment_method)}），等待負責人到後台處理（尚未退款）`;
  } else {
    const inv = await readInvoice(db, o.id);
    if (!inv || inv.status !== "issued" || !inv.invoice_number) {
      return {
        status: "error",
        message: `訂單 ${o.order_no} 的發票不是「已開立且有號碼」（目前：${inv?.status ?? "沒有發票"}），不能申請作廢。`,
      };
    }
    diff = { kind, order_no: o.order_no, invoice_number: inv.invoice_number, reason: reason.reason };
    summary = `AI 透過 MCP 提出作廢發票申請：訂單 ${o.order_no} 發票 ${inv.invoice_number}，等待負責人到後台處理（尚未作廢）`;
  }

  // 同一張訂單已有待處理的同種申請 → 不重複建立
  const existing = findPending(await loadPendingMcpRequests(db, { orderId: o.id }), o.id, kind);
  if (!existing) {
    // 負責人剛關閉過 → 冷卻期內不再接受（防被注入的 AI 反覆申請施壓）
    const { data: dRows, error: dErr } = await db
      .from("audit_log")
      .select("id, created_at, entity, entity_id, action, actor_id, actor_role, diff")
      .eq("entity", "order")
      .eq("entity_id", o.id)
      .eq("action", MCP_REQUEST_DISMISSED_ACTION)
      .order("id", { ascending: false })
      .limit(50);
    if (dErr) throw new Error(`[mcp-pending] 讀關閉紀錄失敗：${dErr.message}`);
    const dismissedAt = lastDismissedAt((dRows ?? []) as unknown as McpRequestLogRow[], o.id, kind);
    if (inDismissCooldown(dismissedAt)) {
      return {
        status: "error",
        message:
          `負責人已經在 ${DISMISS_COOLDOWN_MS / 86400000} 天內關閉過訂單 ${o.order_no} 的${MCP_REQUEST_KIND_LABEL[kind]}，` +
          "冷卻期內不再接受同樣的申請。需要處理請直接聯絡負責人。",
      };
    }
  }
  if (existing) {
    return {
      status: "already_pending",
      message: `訂單 ${o.order_no} 已經有一筆待處理的${MCP_REQUEST_KIND_LABEL[kind]}，沒有重複建立。請通知負責人到後台處理。`,
    };
  }

  const written = await writeAuditStrict(MCP_ACTOR, {
    action: MCP_REQUEST_ACTION[kind],
    entity: "order",
    entityId: o.id,
    summary,
    diff,
  });
  if (!written.ok) {
    return { status: "error", message: "申請沒有寫進資料庫，後台看不到這筆申請。請稍後再試，或直接通知負責人。" };
  }

  return {
    status: "created",
    message:
      kind === "refund"
        ? `已建立退款申請（訂單 ${o.order_no}）。這個工具不會退款，錢沒有任何移動；請通知負責人到後台處理。`
        : `已建立作廢發票申請（訂單 ${o.order_no}，發票 ${diff.invoice_number}）。這個工具不會作廢發票；請通知負責人到後台處理。`,
  };
}

/* ------------------------------------------------------------ 關閉申請 */

/**
 * 後台「不處理，關閉申請」。
 *
 * 🔴 staff 必須是呼叫端用 requireCapability("mcp:requests") 拿到的**真人 cookie 身分**
 *    （不要包 runAsMachine）。這裡再擋一次：機器身分、沒有 id 的身分、角色沒有
 *    mcp:requests 的身分一律拒絕 —— 推導那邊也只認這種樣子的關閉列。
 */
export async function dismissMcpRequest(
  staff: Staff,
  orderId: string,
  kind: McpRequestKind,
): Promise<{ ok: string } | { error: string }> {
  if (staff.via || staff.caps || !staff.id || !can(staff.role, "mcp:requests")) {
    return { error: "只有負責人可以關閉 AI 的申請。" };
  }
  const db = createServiceClient();
  let pending: PendingMcpRequest | null;
  try {
    pending = findPending(await loadPendingMcpRequests(db, { orderId }), orderId, kind);
  } catch (err) {
    console.error("[mcp-pending] 關閉前讀取失敗", orderId, err);
    return { error: "讀取申請失敗，請重新整理後再試。" };
  }
  if (!pending) return { error: "這筆申請已經不是待處理了（可能已經處理或關閉過），請重新整理。" };

  const written = await writeAuditStrict(staff, {
    action: MCP_REQUEST_DISMISSED_ACTION,
    entity: "order",
    entityId: pending.orderId,
    summary: `關閉 AI 的${MCP_REQUEST_KIND_LABEL[kind]}（訂單 ${pending.orderNo}），不處理`,
    diff: { kind, request_id: pending.requestId, order_no: pending.orderNo },
  });
  if (!written.ok) return { error: "關閉申請沒有寫進資料庫，請再試一次。" };
  return { ok: "已關閉這筆申請。" };
}
