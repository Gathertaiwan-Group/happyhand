import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import type { Capability } from "@/lib/admin/roles";
import { loadOrderDetail } from "@/app/admin/orders/queries";
import { checkTransition, money, ORDER_STATUS_LABELS, paymentMethodLabel, isOrderStatus } from "@/app/admin/orders/shared";
import {
  checkProductDeletable,
  checkSessionDeletable,
  type CountClient,
} from "@/app/admin/products/guards";
import { SESSION_STATUS_LABEL, toSessionStatus } from "@/app/admin/sessions/queries";
import { formatTaipei } from "@/components/admin/datetime-field";
import { markOrderPaid, refundOrder, markRefundedManually } from "@/app/admin/orders/actions";
import {
  forceGrantEntitlements,
  revokeCourseAccess,
} from "@/app/admin/orders/account-actions";
import { reissueInvoice, voidInvoiceAction } from "@/app/admin/orders/invoice-actions";
import { deleteProduct, deleteSession } from "@/app/admin/products/actions";
import type { TokenArgs } from "@/lib/admin/mcp-token";

/**
 * 「本人在後台確認」與「兩步確認」工具的共用定義。
 *
 * MCP 那一側（app/api/mcp/route.ts）用 snapshot() 決定能不能提出請求、
 * 把當下狀態簽進 token；確認頁（app/admin/mcp/confirm）用同一支 snapshot()
 * 重新讀資料庫、比對狀態，再用 execute() 呼叫原本的 server action。
 * 兩邊共用同一份定義，「提出時檢查的」與「確認時檢查的」才不會分岔。
 *
 * 🔴 snapshot() 只讀資料庫，**不讀 token 裡的任何文字**。token 裡的參數只有
 *    id（以及作廢原因），而且 id 也要先查得到才算數。
 */

export type Db = ReturnType<typeof createServiceClient>;

export type Snapshot =
  | {
      ok: true;
      /** 狀態指紋，簽進 token；確認時必須逐字相同 */
      state: string;
      entity: "order" | "product" | "session";
      entityId: string;
      /** 從資料庫讀出來的識別（訂單編號、課程名稱…），給稽核摘要用 */
      ref: string;
      /** 執行時需要、但不該讓 AI 指定的值（例如訂單綁定的帳號 id） */
      ctx: Record<string, string>;
    }
  | { ok: false; error: string };

export type ActionOutcome = { error?: string | null; ok?: string | null } | undefined | void;

export type SummaryRow = { label: string; value: string; strong?: boolean };

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

type OrderFacts = {
  id: string;
  order_no: string;
  status: string;
  total: number;
  price_unverified: boolean | null;
  user_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  payment_method: string | null;
  payment_provider: string | null;
  payment_paid_amount: number | null;
  paid_at: string | null;
  created_at: string;
};

async function readOrder(db: Db, orderId: unknown): Promise<OrderFacts | null> {
  if (!isUuid(orderId)) return null;
  const { data, error } = await db
    .from("orders")
    .select(
      "id, order_no, status, total, price_unverified, user_id, contact_name, contact_phone, contact_email," +
        " payment_method, payment_provider, payment_paid_amount, paid_at, created_at",
    )
    .eq("id", orderId)
    .maybeSingle();
  if (error) {
    console.error("[mcp-requests] 讀取訂單失敗", orderId, error.message);
    return null;
  }
  return (data as unknown as OrderFacts | null) ?? null;
}

async function readInvoice(
  db: Db,
  orderId: string,
): Promise<{ status: string; invoice_number: string | null } | null> {
  const { data } = await db
    .from("invoices")
    .select("status, invoice_number")
    .eq("order_id", orderId)
    .maybeSingle();
  return (data as unknown as { status: string; invoice_number: string | null } | null) ?? null;
}

type ProductFacts = {
  id: string;
  title: string;
  slug: string;
  type: string;
  is_published: boolean;
  updated_at: string;
};

async function readProduct(db: Db, productId: unknown): Promise<ProductFacts | null> {
  if (!isUuid(productId)) return null;
  const { data } = await db
    .from("products")
    .select("id, title, slug, type, is_published, updated_at")
    .eq("id", productId)
    .maybeSingle();
  return (data as unknown as ProductFacts | null) ?? null;
}

type SessionFacts = {
  id: string;
  product_id: string;
  starts_at: string;
  location: string | null;
  capacity: number;
  seats_taken: number;
  status: string;
  updated_at: string;
  products: { title: string } | { title: string }[] | null;
};

async function readSession(db: Db, sessionId: unknown): Promise<SessionFacts | null> {
  if (!isUuid(sessionId)) return null;
  const { data } = await db
    .from("workshop_sessions")
    .select("id, product_id, starts_at, location, capacity, seats_taken, status, updated_at, products(title)")
    .eq("id", sessionId)
    .maybeSingle();
  return (data as unknown as SessionFacts | null) ?? null;
}

function sessionTitle(s: SessionFacts): string {
  const p = Array.isArray(s.products) ? s.products[0] : s.products;
  return p?.title ?? "（未知課程）";
}

function sessionRef(s: SessionFacts): string {
  return `「${sessionTitle(s)}」${formatTaipei(s.starts_at)} 場`;
}

const NOT_FOUND_ORDER = "找不到這筆訂單。";

/* ============================================================ 兩步確認 */

/** 透過 MCP 重寄設定密碼信的冷卻時間 */
const RESEND_COOLDOWN_MS = 10 * 60 * 1000;

export type TwoStepTool = "cancel_order" | "adjust_seats" | "resend_setup_email";

/** 兩步確認的狀態指紋與預檢。args 已經是正規化過的（order_id / session_id）。 */
export async function twoStepSnapshot(
  db: Db,
  tool: TwoStepTool,
  args: TokenArgs,
): Promise<Snapshot & { preview?: string }> {
  if (tool === "cancel_order") {
    const o = await readOrder(db, args.order_id);
    if (!o) return { ok: false, error: NOT_FOUND_ORDER };
    const check = checkTransition(o.status, "cancelled");
    if (!check.ok) return { ok: false, error: check.message };
    return {
      ok: true,
      state: `status=${o.status}`,
      entity: "order",
      entityId: o.id,
      ref: o.order_no,
      ctx: {},
      preview: `將取消訂單 ${o.order_no}（${money(o.total)}，目前「${isOrderStatus(o.status) ? ORDER_STATUS_LABELS[o.status] : o.status}」）。取消後是最終狀態，不能再改回。`,
    };
  }

  if (tool === "adjust_seats") {
    const s = await readSession(db, args.session_id);
    if (!s) return { ok: false, error: "找不到這個場次。" };
    const delta = args.delta;
    if (delta !== 1 && delta !== -1) return { ok: false, error: "名額一次只能加減 1。" };
    if (delta > 0 && s.seats_taken >= s.capacity) {
      return { ok: false, error: `已經達到名額上限 ${s.capacity} 人，不能再加。` };
    }
    if (delta < 0 && s.seats_taken <= 0) {
      return { ok: false, error: "已經是 0 人，不能再減。" };
    }
    return {
      ok: true,
      state: `seats=${s.seats_taken};cap=${s.capacity}`,
      entity: "session",
      entityId: s.id,
      ref: sessionRef(s),
      ctx: {},
      preview: `將把${sessionRef(s)}的已報名人數 ${s.seats_taken} → ${s.seats_taken + delta}（上限 ${s.capacity}）。`,
    };
  }

  // resend_setup_email
  const o = await readOrder(db, args.order_id);
  if (!o) return { ok: false, error: NOT_FOUND_ORDER };
  if (!o.user_id || !o.contact_email) {
    return { ok: false, error: "這筆訂單還沒有綁定帳號，請先到後台按「綁定並開通」。" };
  }
  // 重放防線：上一次重寄的稽核時間。寄出去之後會多一筆，指紋就變了，
  // 同一個 confirm_token 不能拿來連寄。
  const { data: last } = await db
    .from("audit_log")
    .select("created_at")
    .eq("entity_id", o.id)
    .eq("action", "order.resend_setup_email")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
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
    entity: "order",
    entityId: o.id,
    ref: o.order_no,
    ctx: {},
    preview: `將重寄設定密碼信給訂單 ${o.order_no} 的聯絡信箱（客人會收到一封新信，連結一小時內有效）。`,
  };
}

/* ======================================================== 本人在後台確認 */

export type ApprovalTool =
  | "mark_order_paid"
  | "refund_order"
  | "mark_refunded_manually"
  | "reissue_invoice"
  | "void_invoice"
  | "force_grant_entitlements"
  | "revoke_course_access"
  | "delete_product"
  | "delete_session";

type ApprovalDef = {
  /** 固定文案。確認頁的標題 —— 不是 AI 寫的 */
  title: string;
  /** 固定文案：按下確認會發生什麼 */
  effect: string;
  capability: Capability;
  snapshot: (db: Db, args: TokenArgs) => Promise<Snapshot>;
  /** 確認頁要顯示的事實，全部從資料庫讀 */
  summary: (db: Db, args: TokenArgs) => Promise<SummaryRow[] | null>;
  /**
   * 呼叫原本的 server action。在確認頁的 server action 裡執行，
   * 此時 getStaff() 讀的是真人的 cookie。
   * `input` 是確認頁表單上由本人填寫／確認的值（目前只有作廢原因）。
   */
  execute: (args: TokenArgs, snap: Extract<Snapshot, { ok: true }>, input: { reason?: string }) => Promise<ActionOutcome>;
};

/** 訂單類共用的摘要：從資料庫讀，絕不用 token 裡的文字。 */
async function orderSummary(db: Db, orderId: unknown): Promise<SummaryRow[] | null> {
  const o = await readOrder(db, orderId);
  if (!o) return null;
  const detail = await loadOrderDetail(db, o.id);
  const items = (detail?.items ?? [])
    .map((it) => `${it.productTitle ?? "（已刪除的商品）"}（單價 ${money(it.unitPrice)}）× ${it.qty}`)
    .join("、");
  const inv = await readInvoice(db, o.id);
  const status = isOrderStatus(o.status) ? ORDER_STATUS_LABELS[o.status] : o.status;
  return [
    { label: "訂單編號", value: o.order_no, strong: true },
    { label: "金額", value: money(o.total), strong: true },
    ...(o.price_unverified
      ? [{ label: "金額核對", value: "⚠️ 金額未核對（下單金額與商品定價不符，請逐項核對單價）", strong: true }]
      : []),
    { label: "目前狀態", value: status, strong: true },
    { label: "付款方式", value: paymentMethodLabel(o.payment_method) },
    {
      label: "收款管道",
      value:
        o.payment_provider === "blackcat"
          ? `黑貓 PAY 線上刷卡${o.payment_paid_amount != null ? `（實收 ${money(o.payment_paid_amount)}）` : ""}`
          : "人工收款（非線上金流）",
    },
    { label: "聯絡人", value: [o.contact_name, o.contact_phone].filter(Boolean).join("　") || "—" },
    { label: "Email", value: o.contact_email ?? "—" },
    { label: "品項", value: items || "—" },
    { label: "成立時間", value: formatTaipei(o.created_at) || "—" },
    { label: "付款時間", value: formatTaipei(o.paid_at) || "—" },
    {
      label: "發票",
      value: inv
        ? `${inv.invoice_number ?? "（尚無號碼）"}（${inv.status}）`
        : "尚未建立",
    },
  ];
}

function orderStatusSnapshot(to: "paid" | "refunded") {
  return async (db: Db, args: TokenArgs): Promise<Snapshot> => {
    const o = await readOrder(db, args.order_id);
    if (!o) return { ok: false, error: NOT_FOUND_ORDER };
    const check = checkTransition(o.status, to);
    if (!check.ok) return { ok: false, error: check.message };
    return { ok: true, state: `status=${o.status}`, entity: "order", entityId: o.id, ref: o.order_no, ctx: {} };
  };
}

export const APPROVAL_TOOLS: Record<ApprovalTool, ApprovalDef> = {
  mark_order_paid: {
    title: "標記訂單為已收款",
    effect:
      "訂單改成「已收款」，佔用工作坊名額、開通線上課程，並寄出開通通知信給客人。之後只能走退款，不能改回待收款。",
    capability: "orders:write",
    snapshot: orderStatusSnapshot("paid"),
    summary: (db, args) => orderSummary(db, args.order_id),
    execute: (args) => markOrderPaid(String(args.order_id)),
  },

  refund_order: {
    title: "退款（線上刷卡會真的呼叫黑貓 PAY 退刷）",
    effect:
      "若這筆是黑貓 PAY 線上刷卡，系統會立刻向黑貓 PAY 送出退款，成功後訂單改成「已退款」、釋出工作坊名額、作廢已開的發票。人工收款的訂單只改狀態，錢要另外匯回給客人。這個動作不能復原。",
    capability: "orders:write",
    snapshot: orderStatusSnapshot("refunded"),
    summary: (db, args) => orderSummary(db, args.order_id),
    execute: (args) => refundOrder(String(args.order_id)),
  },

  mark_refunded_manually: {
    title: "標記為已退款（人工，已在別處退過錢）",
    effect:
      "系統不會呼叫金流，只把訂單改成「已退款」、釋出名額、作廢已開的發票。請確定錢已經在黑貓 PAY 後台或其他管道退給客人了。這個動作不能復原。",
    capability: "orders:write",
    snapshot: orderStatusSnapshot("refunded"),
    summary: (db, args) => orderSummary(db, args.order_id),
    execute: (args) => markRefundedManually(String(args.order_id)),
  },

  reissue_invoice: {
    title: "補開電子發票",
    effect: "透過 Amego 為這筆訂單開立電子發票。發票是稅務憑證，開出後只能作廢，且同一張訂單作廢後不能再用系統重開。",
    capability: "orders:write",
    snapshot: async (db, args) => {
      const o = await readOrder(db, args.order_id);
      if (!o) return { ok: false, error: NOT_FOUND_ORDER };
      if (o.status !== "paid") {
        return { ok: false, error: "只有「已收款」的訂單可以補開發票。" };
      }
      const inv = await readInvoice(db, o.id);
      if (inv?.status === "issued") return { ok: false, error: `這張訂單已經開過發票 ${inv.invoice_number ?? ""}。` };
      if (inv?.status === "voided") {
        return { ok: false, error: "這張訂單的發票已經作廢，不能用同一張訂單重開，請到 Amego 後台手動處理。" };
      }
      return {
        ok: true,
        state: `status=${o.status};inv=${inv?.status ?? "none"}`,
        entity: "order",
        entityId: o.id,
        ref: o.order_no,
        ctx: {},
      };
    },
    summary: (db, args) => orderSummary(db, args.order_id),
    execute: (args) => reissueInvoice(String(args.order_id)),
  },

  void_invoice: {
    title: "作廢電子發票",
    effect:
      "透過 Amego 作廢這張訂單的發票。作廢是終點：同一張訂單之後不能再用系統重開。這個動作不會改訂單狀態，也不會退款。",
    capability: "orders:write",
    snapshot: async (db, args) => {
      const o = await readOrder(db, args.order_id);
      if (!o) return { ok: false, error: NOT_FOUND_ORDER };
      const inv = await readInvoice(db, o.id);
      if (!inv) return { ok: false, error: "這張訂單沒有發票紀錄，沒有東西可以作廢。" };
      if (inv.status !== "issued") {
        return { ok: false, error: `這張訂單的發票目前是「${inv.status}」，只有已開立的發票可以作廢。` };
      }
      return {
        ok: true,
        state: `inv=${inv.status}:${inv.invoice_number ?? ""}`,
        entity: "order",
        entityId: o.id,
        ref: o.order_no,
        ctx: {},
      };
    },
    summary: (db, args) => orderSummary(db, args.order_id),
    execute: (args, _snap, input) =>
      voidInvoiceAction(String(args.order_id), (input.reason ?? "").trim() || "後台手動作廢"),
  },

  force_grant_entitlements: {
    title: "核對金額無誤並強制開通課程",
    effect:
      "解除這筆訂單的「金額未核對」旗標，並開通線上課程。按下確認等於由你本人聲明「我已核對金額無誤」，稽核會記在你名下。",
    capability: "orders:write",
    snapshot: async (db, args) => {
      const o = await readOrder(db, args.order_id);
      if (!o) return { ok: false, error: NOT_FOUND_ORDER };
      if (o.status !== "paid") {
        // 待收款就先強制開通的話，action 會先清掉旗標、再在開通那一步失敗 ——
        // 旗標回不來，狀態指紋也變了，這張確認連結就再也用不了。
        return { ok: false, error: "只有「已收款」的訂單可以強制開通。" };
      }
      if (o.price_unverified !== true) {
        return { ok: false, error: "這筆訂單的金額旗標已經解除過了，不需要強制開通；要補開通請用 regrant_entitlements。" };
      }
      return {
        ok: true,
        state: `status=${o.status};pu=true`,
        entity: "order",
        entityId: o.id,
        ref: o.order_no,
        ctx: {},
      };
    },
    summary: (db, args) => orderSummary(db, args.order_id),
    execute: (args) => forceGrantEntitlements(String(args.order_id)),
  },

  revoke_course_access: {
    title: "關閉課程觀看權限",
    effect: "關閉這個會員帳號對下列課程的觀看權限，客人會立刻看不到課。",
    capability: "orders:write",
    snapshot: async (db, args) => {
      const o = await readOrder(db, args.order_id);
      if (!o) return { ok: false, error: NOT_FOUND_ORDER };
      if (!o.user_id) return { ok: false, error: "這筆訂單沒有綁定會員帳號，沒有權限可以關閉。" };
      if (!isUuid(args.product_id)) return { ok: false, error: "product_id 格式不對。" };
      const { data: entRaw } = await db
        .from("entitlements")
        .select("product_id, order_id, granted_at")
        .eq("user_id", o.user_id)
        .eq("product_id", args.product_id)
        .maybeSingle();
      const ent = entRaw as { order_id: string | null; granted_at: string } | null;
      if (!ent) return { ok: false, error: "這個帳號沒有這門課的觀看權限（可能已經被關掉了）。" };
      // 只能關「這張訂單」帶來的課：確認頁列的是這張訂單的品項，
      // 關到別張訂單或訂閱開的課，管理員很容易看漏。
      if (ent.order_id !== o.id) {
        const { count } = await db
          .from("order_items")
          .select("id", { count: "exact", head: true })
          .eq("order_id", o.id)
          .eq("product_id", args.product_id);
        if (!count) {
          return { ok: false, error: "這門課不是這張訂單買的，不能用這張訂單關閉。請改用開通那門課的訂單。" };
        }
      }
      return {
        ok: true,
        // granted_at：關掉之後又被重新開通的話指紋不同，舊連結不會復活
        state: `user=${o.user_id};ent=${ent.granted_at}`,
        entity: "order",
        entityId: o.id,
        ref: o.order_no,
        // 🔴 帳號 id 從訂單讀，不讓 AI 指定 —— 否則可以拿 A 訂單去關 B 的課。
        ctx: { userId: o.user_id },
      };
    },
    summary: async (db, args) => {
      const rows = await orderSummary(db, args.order_id);
      if (!rows) return null;
      const p = await readProduct(db, args.product_id);
      return [{ label: "要關閉的課程", value: p?.title ?? "（找不到這門課）", strong: true }, ...rows];
    },
    execute: (args, snap) =>
      revokeCourseAccess(String(args.order_id), snap.ctx.userId, String(args.product_id)),
  },

  delete_product: {
    title: "刪除課程／工作坊",
    effect: "永久刪除這門課（含底下的場次與單元）。有人買過的課會被系統擋下，請改用下架。這個動作不能復原。",
    capability: "catalog:write",
    snapshot: async (db, args) => {
      const p = await readProduct(db, args.product_id);
      if (!p) return { ok: false, error: "找不到這門課。" };
      const block = await checkProductDeletable(db as unknown as CountClient, p.id, async (id) => {
        const { data, error } = await db.from("workshop_sessions").select("id").eq("product_id", id);
        if (error) throw new Error(error.message);
        return (data ?? []).map((row) => (row as unknown as { id: string }).id);
      });
      if (block.blocked) return { ok: false, error: block.reason };
      return {
        ok: true,
        state: `upd=${p.updated_at};pub=${p.is_published}`,
        entity: "product",
        entityId: p.id,
        ref: `「${p.title}」`,
        ctx: {},
      };
    },
    summary: async (db, args) => {
      const p = await readProduct(db, args.product_id);
      if (!p) return null;
      const { count } = await db
        .from("workshop_sessions")
        .select("id", { count: "exact", head: true })
        .eq("product_id", p.id);
      return [
        { label: "課程名稱", value: p.title, strong: true },
        { label: "網址代稱", value: p.slug },
        { label: "類型", value: p.type === "workshop" ? "實體工作坊" : p.type === "subscription" ? "訂閱" : "線上課程" },
        { label: "目前狀態", value: p.is_published ? "發布中" : "草稿", strong: true },
        { label: "底下的場次", value: `${count ?? "?"} 場（會一起刪除）` },
      ];
    },
    execute: (args) => deleteProduct(String(args.product_id)),
  },

  delete_session: {
    title: "刪除工作坊場次",
    effect: "永久刪除這個場次。已有訂單指向這一場時系統會擋下，請改成「已取消」。這個動作不能復原。",
    capability: "catalog:write",
    snapshot: async (db, args) => {
      const s = await readSession(db, args.session_id);
      if (!s) return { ok: false, error: "找不到這個場次。" };
      const block = await checkSessionDeletable(db as unknown as CountClient, s.id);
      if (block.blocked) return { ok: false, error: block.reason };
      return {
        ok: true,
        state: `upd=${s.updated_at};seats=${s.seats_taken};status=${s.status}`,
        entity: "session",
        entityId: s.id,
        ref: sessionRef(s),
        // 所屬課程從資料庫讀，deleteSession 會再用 product_id 比對一次
        ctx: { productId: s.product_id },
      };
    },
    summary: async (db, args) => {
      const s = await readSession(db, args.session_id);
      if (!s) return null;
      return [
        { label: "課程", value: sessionTitle(s), strong: true },
        { label: "場次時間", value: formatTaipei(s.starts_at) || "—", strong: true },
        { label: "地點", value: s.location ?? "—" },
        { label: "名額", value: `${s.seats_taken} / ${s.capacity}` },
        { label: "目前狀態", value: SESSION_STATUS_LABEL[toSessionStatus(s.status)] },
      ];
    },
    execute: (_args, snap) => deleteSession(snap.entityId, snap.ctx.productId),
  },
};

export function isApprovalTool(value: unknown): value is ApprovalTool {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(APPROVAL_TOOLS, value);
}

/** 確認網址。 */
export function confirmUrl(siteUrl: string, token: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/admin/mcp/confirm?t=${encodeURIComponent(token)}`;
}
