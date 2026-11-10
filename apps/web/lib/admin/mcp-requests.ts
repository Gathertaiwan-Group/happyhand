import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { loadOrderDetail } from "@/app/admin/orders/queries";
import {
  checkTransition,
  money,
  ORDER_STATUS_LABELS,
  paymentMethodLabel,
  isOrderStatus,
} from "@/app/admin/orders/shared";
import {
  SESSION_STATUS_LABEL,
  toSessionStatus,
  WAITLIST_STATUS_LABEL,
  toWaitlistStatus,
  type SessionStatus,
  type WaitlistStatus,
} from "@/app/admin/sessions/queries";
import { canTransitionSession, canTransitionWaitlist } from "@/app/admin/sessions/transitions";
import { formatTaipei } from "@/components/admin/datetime-field";
import { cancelOrder, markOrderPaid } from "@/app/admin/orders/actions";
import { regrantEntitlements, revokeCourseAccess } from "@/app/admin/orders/account-actions";
import { reissueInvoice } from "@/app/admin/orders/invoice-actions";
import { togglePublish } from "@/app/admin/products/actions";
import { adjustSeats, setSessionStatus, setWaitlistStatus } from "@/app/admin/sessions/actions";
import { isAmegoConfigured } from "@/lib/invoice/amego";
import { manualPaymentAllowed } from "@/lib/admin/mcp-pending";
import type { TokenArgs } from "@/lib/admin/mcp-token";

/**
 * MCP 寫入工具的預檢與預覽（app/api/mcp/route.ts 用）。
 *
 * ## 先預覽、再執行（dry_run，比照小時光書店）
 *
 * 每支「預覽制」工具在這裡有一支 preview 函式：只讀資料庫，回「目前狀態、
 * 會改什麼、此刻會不會執行」，外加一個 run()。route 在 dry_run=true（預設）時
 * 只把預覽交給 AI、記一筆 mcp.preview.<工具名> 稽核；dry_run=false 時**重新**
 * 預檢一次（不信任上一次預覽的結果，狀態可能已經變了），條件成立才在
 * runAsMachine() 裡呼叫 run()。
 *
 * 🔴 run() 一律呼叫後台原本的 server action，不重寫業務邏輯；action 自己的
 *    requireCapability()、冪等條件式 update 與 writeAudit() 全部照舊。
 * 🔴 run() 需要的 id（例如 revoke 的帳號 id、候補所屬的場次）從資料庫讀，不讓 AI 指定。
 *
 * ## 兩步確認只剩 resend_setup_email
 *
 * 那支會真的寄信給客人，維持原本的 confirm_token ＋ 冷卻（twoStepSnapshot）。
 */

export type Db = ReturnType<typeof createServiceClient>;

export type ActionOutcome = { error?: string | null; ok?: string | null } | undefined | void;

/* ================================================================ 讀取 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** 訂單編號或 UUID → 訂單 id。查不到回 null。 */
export async function resolveOrderId(db: Db, orderNoOrId: string): Promise<string | null> {
  const row = await loadOrderDetail(db, orderNoOrId);
  return row?.id ?? null;
}

export type OrderFacts = {
  id: string;
  order_no: string;
  status: string;
  total: number;
  price_unverified: boolean | null;
  user_id: string | null;
  contact_email: string | null;
  payment_method: string | null;
  payment_provider: string | null;
};

export async function readOrder(db: Db, orderId: unknown): Promise<OrderFacts | null> {
  if (!isUuid(orderId)) return null;
  const { data, error } = await db
    .from("orders")
    .select(
      "id, order_no, status, total, price_unverified, user_id, contact_email, payment_method, payment_provider",
    )
    .eq("id", orderId)
    .maybeSingle();
  if (error) {
    // 讀失敗不能當成「找不到」—— 丟出去讓呼叫端回「讀取失敗」
    throw new Error(`[mcp-requests] 讀取訂單失敗：${error.message}`);
  }
  return (data as unknown as OrderFacts | null) ?? null;
}

/** 訂單編號或 UUID → 訂單現況。查不到回 null；讀取失敗 throw。 */
export async function findOrder(db: Db, ref: string): Promise<OrderFacts | null> {
  const id = await resolveOrderId(db, ref);
  return id ? readOrder(db, id) : null;
}

export async function readInvoice(
  db: Db,
  orderId: string,
): Promise<{ status: string; invoice_number: string | null } | null> {
  const { data, error } = await db
    .from("invoices")
    .select("status, invoice_number")
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) throw new Error(`[mcp-requests] 讀取發票失敗：${error.message}`);
  return (data as unknown as { status: string; invoice_number: string | null } | null) ?? null;
}

type ProductFacts = { id: string; title: string; is_published: boolean };

async function readProduct(db: Db, productId: unknown): Promise<ProductFacts | null> {
  if (!isUuid(productId)) return null;
  const { data, error } = await db
    .from("products")
    .select("id, title, is_published")
    .eq("id", productId)
    .maybeSingle();
  if (error) throw new Error(`[mcp-requests] 讀取課程失敗：${error.message}`);
  return (data as unknown as ProductFacts | null) ?? null;
}

type SessionFacts = {
  id: string;
  starts_at: string;
  capacity: number;
  seats_taken: number;
  status: string;
  products: { title: string } | { title: string }[] | null;
};

async function readSession(db: Db, sessionId: unknown): Promise<SessionFacts | null> {
  if (!isUuid(sessionId)) return null;
  const { data, error } = await db
    .from("workshop_sessions")
    .select("id, starts_at, capacity, seats_taken, status, products(title)")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw new Error(`[mcp-requests] 讀取場次失敗：${error.message}`);
  return (data as unknown as SessionFacts | null) ?? null;
}

function sessionRef(s: SessionFacts): string {
  const p = Array.isArray(s.products) ? s.products[0] : s.products;
  return `「${p?.title ?? "（未知課程）"}」${formatTaipei(s.starts_at)} 場`;
}

function statusLabel(status: string): string {
  return isOrderStatus(status) ? ORDER_STATUS_LABELS[status] : status;
}

export const NOT_FOUND_ORDER = "找不到這筆訂單。";

/* ============================================================== 預覽制 */

export type Preview =
  | { ok: false; error: string }
  | {
      ok: true;
      entity: "order" | "product" | "session" | "waitlist";
      entityId: string;
      /** 從資料庫讀出來的識別（訂單編號、課程名稱…） */
      ref: string;
      /** 目前狀態（給 AI 看，全部從資料庫讀） */
      current: Record<string, unknown>;
      /** 此刻用 dry_run=false 呼叫會不會執行 */
      willExecute: boolean;
      /** willExecute 時：會發生什麼；否則：為什麼不會執行 */
      message: string;
      /** 執行成功、action 沒回訊息時用的一句話 */
      okMessage: string;
      run: () => Promise<ActionOutcome>;
    };

function blocked(
  base: { entity: "order" | "product" | "session" | "waitlist"; entityId: string; ref: string; current: Record<string, unknown> },
  message: string,
): Preview {
  return { ok: true, ...base, willExecute: false, message, okMessage: "", run: async () => ({ error: message }) };
}

function orderBase(o: OrderFacts): {
  entity: "order";
  entityId: string;
  ref: string;
  current: Record<string, unknown>;
} {
  return {
    entity: "order" as const,
    entityId: o.id,
    ref: `訂單 ${o.order_no}`,
    current: {
      order_no: o.order_no,
      status: o.status,
      status_label: statusLabel(o.status),
      total: o.total,
      payment_method: o.payment_method,
      payment_method_label: paymentMethodLabel(o.payment_method),
    },
  };
}

/** mark_order_paid：只限 ATM／人工收款的待收款訂單。金額由資料庫決定。 */
export async function previewMarkOrderPaid(db: Db, order: string): Promise<Preview> {
  const o = await findOrder(db, order);
  if (!o) return { ok: false, error: `找不到訂單 ${order}。（提醒：mark_order_paid 只限 ATM 轉帳／人工收款的訂單）` };
  const base = orderBase(o);
  if (!manualPaymentAllowed(o.payment_method, o.payment_provider)) {
    return blocked(
      base,
      `訂單 ${o.order_no} 的付款方式是「${paymentMethodLabel(o.payment_method)}」，不是 ATM 轉帳或人工收款。` +
        "線上刷卡的訂單請到黑貓 PAY 後台核對，金流商沒通知收款不能手動標記。",
    );
  }
  const check = checkTransition(o.status, "paid");
  if (!check.ok) return blocked(base, check.message);
  return {
    ok: true,
    ...base,
    willExecute: true,
    message:
      `將把訂單 ${o.order_no}（${paymentMethodLabel(o.payment_method)}，金額 ${money(o.total)}，金額以資料庫為準）` +
      "從「待收款」改成「已收款」：佔用工作坊名額、開通線上課程、寄開通通知信給客人。之後只能走退款，不能改回待收款。" +
      (o.price_unverified ? "⚠️ 這筆訂單標記為「金額未核對」，線上課程不會自動開通，需負責人在後台核對。" : "") +
      "請先確認款項確實已經入帳。",
    okMessage: "已標記為已收款。",
    run: () => markOrderPaid(o.id),
  };
}

/** reissue_invoice：只有後台「補開發票」按鈕此刻會出現的訂單才執行。 */
export async function previewReissueInvoice(db: Db, order: string): Promise<Preview> {
  const o = await findOrder(db, order);
  if (!o) return { ok: false, error: `找不到訂單 ${order}。` };
  const inv = await readInvoice(db, o.id);
  const base = orderBase(o);
  base.current = {
    ...base.current,
    invoice_status: inv?.status ?? "（沒有發票紀錄）",
    invoice_number: inv?.invoice_number ?? null,
  };
  if (o.status !== "paid") {
    return blocked(base, `訂單目前是「${statusLabel(o.status)}」，只有「已收款」的訂單可以補開發票。`);
  }
  // 後台面板：發票作廢後「補開發票」按鈕不出現；已開立時那顆變成「重新檢查」，不是補開。
  if (inv?.status === "issued") {
    return blocked(base, `這張訂單已經開過發票 ${inv.invoice_number ?? ""}，不需要補開。`);
  }
  if (inv?.status === "voided") {
    return blocked(base, "這張訂單的發票已經作廢，不能用同一張訂單重開（Amego 訂單編號唯一），請到 Amego 後台手動處理。");
  }
  if (!isAmegoConfigured()) {
    return blocked(base, "系統還沒設定 Amego 憑證，現在開不了發票。");
  }
  return {
    ok: true,
    ...base,
    willExecute: true,
    message:
      `將透過 Amego 為訂單 ${o.order_no}（${money(o.total)}）開立電子發票` +
      `（目前發票狀態：${inv?.status ?? "尚未建立"}）。發票是稅務憑證，開出後只能由負責人在後台作廢。` +
      "若 Amego 上其實已經開過，系統會認回而不會重複開立。",
    okMessage: "已處理。",
    run: () => reissueInvoice(o.id),
  };
}

/** cancel_order：只限待收款訂單。 */
export async function previewCancelOrder(db: Db, order: string): Promise<Preview> {
  const o = await findOrder(db, order);
  if (!o) return { ok: false, error: `找不到訂單 ${order}。` };
  const base = orderBase(o);
  const check = checkTransition(o.status, "cancelled");
  if (!check.ok) return blocked(base, check.message);
  return {
    ok: true,
    ...base,
    willExecute: true,
    message: `將取消訂單 ${o.order_no}（${money(o.total)}，目前「${statusLabel(o.status)}」）。取消是最終狀態，不能再改回。`,
    okMessage: "已取消訂單。",
    run: () => cancelOrder(o.id),
  };
}

/** regrant_entitlements：依訂單補開通線上課程。 */
export async function previewRegrant(db: Db, order: string): Promise<Preview> {
  const o = await findOrder(db, order);
  if (!o) return { ok: false, error: `找不到訂單 ${order}。` };
  const base = orderBase(o);
  if (o.status !== "paid") return blocked(base, `訂單目前是「${statusLabel(o.status)}」，只有「已收款」的訂單可以開通課程。`);
  if (!o.user_id) return blocked(base, "這筆訂單還沒有綁定會員帳號，請先到後台按「綁定並開通」。");
  if (o.price_unverified) {
    return blocked(base, "這筆訂單標記為「金額未核對」，不能透過 MCP 開通，請負責人到後台核對金額後處理。");
  }
  const { count, error } = await db
    .from("entitlements")
    .select("product_id", { count: "exact", head: true })
    .eq("user_id", o.user_id)
    .eq("order_id", o.id);
  if (error) throw new Error(`[mcp-requests] 讀取開通紀錄失敗：${error.message}`);
  base.current = { ...base.current, entitlements_from_this_order: count ?? 0 };
  return {
    ok: true,
    ...base,
    willExecute: true,
    message:
      `將依訂單 ${o.order_no} 的品項補開通線上課程（目前這張訂單已開通 ${count ?? 0} 門，已開通的不會重複）。` +
      "有新開通時會寄一封開通通知信給客人（同一筆訂單只寄一次）。",
    okMessage: "已處理。",
    run: () => regrantEntitlements(o.id),
  };
}

/** revoke_course_access：關閉「這張訂單帶來的」某門課。帳號由訂單決定。 */
export async function previewRevoke(db: Db, order: string, productId: string): Promise<Preview> {
  const o = await findOrder(db, order);
  if (!o) return { ok: false, error: `找不到訂單 ${order}。` };
  const p = await readProduct(db, productId);
  if (!p) return { ok: false, error: `找不到課程 ${productId}。` };
  const base = orderBase(o);
  base.current = { ...base.current, product_title: p.title };
  if (!o.user_id) return blocked(base, "這筆訂單沒有綁定會員帳號，沒有權限可以關閉。");
  const { data: entRaw, error } = await db
    .from("entitlements")
    .select("order_id")
    .eq("user_id", o.user_id)
    .eq("product_id", p.id)
    .maybeSingle();
  if (error) throw new Error(`[mcp-requests] 讀取開通紀錄失敗：${error.message}`);
  const ent = entRaw as { order_id: string | null } | null;
  if (!ent) return blocked(base, "這個帳號沒有這門課的觀看權限（可能已經被關掉了）。");
  // 只能關「這張訂單」帶來的課，關到別張訂單或訂閱開的課很容易看漏。
  if (ent.order_id !== o.id) {
    const { count, error: cErr } = await db
      .from("order_items")
      .select("id", { count: "exact", head: true })
      .eq("order_id", o.id)
      .eq("product_id", p.id);
    if (cErr) throw new Error(`[mcp-requests] 讀取品項失敗：${cErr.message}`);
    if (!count) return blocked(base, "這門課不是這張訂單買的，不能用這張訂單關閉。請改用開通那門課的訂單。");
  }
  // 🔴 帳號 id 從訂單讀，不讓 AI 指定 —— 否則可以拿 A 訂單去關 B 的課。
  const userId = o.user_id;
  return {
    ok: true,
    ...base,
    willExecute: true,
    message: `將關閉訂單 ${o.order_no} 綁定的會員帳號對「${p.title}」的觀看權限，客人會立刻看不到課。要恢復得用 regrant_entitlements。`,
    okMessage: "已關閉觀看權限。",
    run: () => revokeCourseAccess(o.id, userId, p.id),
  };
}

/** adjust_seats：名額 ±1。 */
export async function previewAdjustSeats(db: Db, sessionId: string, delta: number): Promise<Preview> {
  const s = await readSession(db, sessionId);
  if (!s) return { ok: false, error: `找不到場次 ${sessionId}。` };
  const base = {
    entity: "session" as const,
    entityId: s.id,
    ref: sessionRef(s),
    current: { seats_taken: s.seats_taken, capacity: s.capacity, status: s.status },
  };
  if (delta !== 1 && delta !== -1) return blocked(base, "名額一次只能加減 1。");
  if (delta > 0 && s.seats_taken >= s.capacity) return blocked(base, `已經達到名額上限 ${s.capacity} 人，不能再加。`);
  if (delta < 0 && s.seats_taken <= 0) return blocked(base, "已經是 0 人，不能再減。");
  return {
    ok: true,
    ...base,
    willExecute: true,
    message: `將把${sessionRef(s)}的已報名人數 ${s.seats_taken} → ${s.seats_taken + delta}（上限 ${s.capacity}）。`,
    okMessage: "名額已調整。",
    run: () => adjustSeats(s.id, delta),
  };
}

/** set_session_status：照後台的場次狀態白名單。 */
export async function previewSetSessionStatus(db: Db, sessionId: string, next: SessionStatus): Promise<Preview> {
  const s = await readSession(db, sessionId);
  if (!s) return { ok: false, error: `找不到場次 ${sessionId}。` };
  const current = toSessionStatus(s.status);
  const target = toSessionStatus(next);
  const base = {
    entity: "session" as const,
    entityId: s.id,
    ref: sessionRef(s),
    current: { status: current, status_label: SESSION_STATUS_LABEL[current], seats_taken: s.seats_taken, capacity: s.capacity },
  };
  if (target === "full") return blocked(base, "「已額滿」由系統依名額自動判定，不能手動設定。");
  if (current === target) return blocked(base, `這個場次已經是「${SESSION_STATUS_LABEL[target]}」了。`);
  if (!canTransitionSession(current, target)) {
    return blocked(base, `不能從「${SESSION_STATUS_LABEL[current]}」改成「${SESSION_STATUS_LABEL[target]}」。`);
  }
  return {
    ok: true,
    ...base,
    willExecute: true,
    message: `將把${sessionRef(s)}從「${SESSION_STATUS_LABEL[current]}」改成「${SESSION_STATUS_LABEL[target]}」。`,
    okMessage: "場次狀態已更新。",
    run: () => setSessionStatus(s.id, target),
  };
}

/** publish_product / unpublish_product */
export async function previewTogglePublish(db: Db, productId: string, next: boolean): Promise<Preview> {
  const p = await readProduct(db, productId);
  if (!p) return { ok: false, error: `找不到課程 ${productId}。` };
  const base = {
    entity: "product" as const,
    entityId: p.id,
    ref: `「${p.title}」`,
    current: { title: p.title, is_published: p.is_published },
  };
  if (p.is_published === next) return blocked(base, next ? "這門課已經是發布中了。" : "這門課已經是草稿了。");
  return {
    ok: true,
    ...base,
    willExecute: true,
    message: next
      ? `將發布「${p.title}」，前台會看得到。之後可以用 unpublish_product 下架。`
      : `將把「${p.title}」下架改回草稿，前台看不到（已購買的學員不受影響）。之後可以用 publish_product 再發布。`,
    okMessage: next ? "已發布。" : "已下架。",
    run: () => togglePublish(p.id, next),
  };
}

/** set_waitlist_status：照後台的候補狀態白名單。場次 id 從資料庫讀。 */
export async function previewSetWaitlistStatus(db: Db, waitlistId: string, next: WaitlistStatus): Promise<Preview> {
  if (!isUuid(waitlistId)) return { ok: false, error: `找不到候補紀錄 ${waitlistId}。` };
  const { data, error } = await db
    .from("workshop_waitlist")
    .select("id, session_id, status")
    .eq("id", waitlistId)
    .maybeSingle();
  if (error) throw new Error(`[mcp-requests] 讀取候補失敗：${error.message}`);
  const row = data as { id: string; session_id: string; status: string } | null;
  if (!row) return { ok: false, error: `找不到候補紀錄 ${waitlistId}。` };
  const current = toWaitlistStatus(row.status);
  const target = toWaitlistStatus(next);
  const base = {
    entity: "waitlist" as const,
    entityId: row.id,
    ref: `候補紀錄 ${row.id}`,
    current: { status: current, status_label: WAITLIST_STATUS_LABEL[current], session_id: row.session_id },
  };
  if (current === target) return blocked(base, `這筆已經是「${WAITLIST_STATUS_LABEL[target]}」了。`);
  if (!canTransitionWaitlist(current, target)) {
    return blocked(base, `不能從「${WAITLIST_STATUS_LABEL[current]}」改成「${WAITLIST_STATUS_LABEL[target]}」。`);
  }
  return {
    ok: true,
    ...base,
    willExecute: true,
    message:
      `將把這筆候補從「${WAITLIST_STATUS_LABEL[current]}」改成「${WAITLIST_STATUS_LABEL[target]}」。` +
      (target === "cancelled" ? "⚠️「已取消」是終點，改了就不能復原。" : ""),
    okMessage: "候補狀態已更新。",
    run: () => setWaitlistStatus(row.id, row.session_id, target),
  };
}

/* ============================================================ 兩步確認 */

/** 透過 MCP 重寄設定密碼信的冷卻時間 */
const RESEND_COOLDOWN_MS = 10 * 60 * 1000;

export type TwoStepTool = "resend_setup_email";

export type Snapshot =
  | { ok: true; state: string; preview: string }
  | { ok: false; error: string };

/** 兩步確認（目前只有 resend_setup_email）的狀態指紋與預檢。 */
export async function twoStepSnapshot(db: Db, _tool: TwoStepTool, args: TokenArgs): Promise<Snapshot> {
  const o = await readOrder(db, args.order_id);
  if (!o) return { ok: false, error: NOT_FOUND_ORDER };
  if (!o.user_id || !o.contact_email) {
    return { ok: false, error: "這筆訂單還沒有綁定帳號，請先到後台按「綁定並開通」。" };
  }
  /*
    重放防線與冷卻的依據：這個帳號**上一封手動重寄信排進 email_outbox 的時間**。

    🔴 原本讀的是 audit_log 的 order.resend_setup_email。但 writeAudit() 刻意
       永不 throw —— 稽核寫失敗時信照樣寄出、卻沒有留下紀錄，下一次預檢讀到
       的還是舊時間（或 none），冷卻與「同一個 confirm_token 不能連寄」兩道
       防線同時失效，AI 就能對客人連環寄信（2026-11-10 資安審查）。
       outbox 那一列是信「會被寄出」的前提：排不進去就不會寄，排進去了就一定
       讀得到。所以改讀它，冷卻不再依賴一筆可能靜默失敗的稽核。
       讀取失敗 → 拒絕（以前讀失敗會被當成「沒寄過」放行）。

    dedupe_key 格式見 resendSetupEmail()：account_setup_manual:<user_id>:<epoch 秒>。
    LIKE 的 "_" 是單字元萬用字元，只會讓比對更寬（多算到不存在的鍵），不會漏算。
  */
  const { data: last, error: lastErr } = await db
    .from("email_outbox")
    .select("created_at")
    .like("dedupe_key", `account_setup_manual:${o.user_id}:%`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastErr) {
    console.error("[mcp-requests] 讀取重寄紀錄失敗", o.id, lastErr.message);
    return { ok: false, error: "讀取上次重寄紀錄失敗，為避免重複寄信，這次不提供重寄。請稍後再試。" };
  }
  const lastAt = (last as { created_at?: string } | null)?.created_at ?? "none";
  // 冷卻：AI 可以一直重跑「第一步→第二步」拿新 token，沒有冷卻就能對客人連環寄信
  // （每寄一次還會讓上一封的連結失效）。後台按鈕不受這個限制。
  if (lastAt !== "none" && Date.now() - Date.parse(lastAt) < RESEND_COOLDOWN_MS) {
    return {
      ok: false,
      error: `這筆訂單在 ${RESEND_COOLDOWN_MS / 60000} 分鐘內已經重寄過設定密碼信，請稍後再試，或請客人先檢查垃圾郵件匣。`,
    };
  }
  return {
    ok: true,
    state: `user=${o.user_id};last=${lastAt}`,
    preview: `將重寄設定密碼信給訂單 ${o.order_no} 的聯絡信箱（客人會收到一封新信，連結一小時內有效）。`,
  };
}
