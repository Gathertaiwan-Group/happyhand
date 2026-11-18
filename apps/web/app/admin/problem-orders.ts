import "server-only";
import { maskEmail } from "@/lib/email/resend";
import type { Db } from "./dashboard-queries";

/**
 * 後台總覽「需要處理」那幾個數字的**明細**（給 MCP 的 list_problem_orders）。
 *
 * 🔴 條件一律照總覽背後的 RPC，不自己發明：
 *   - unfulfilled         count_unfulfilled_paid_orders()／明細用 list_unfulfilled_paid_orders()，
 *                         再補上 list 版刻意不列的「沒綁帳號／金額未核對」（loadUnfulfilledHeld）
 *   - failed_email        email_outbox.status = 'failed'（總覽 loadHealthStats 同一條件）
 *   - stuck_invoice       count_invoice_alerts() 的三個子查詢（20260831000001_invoice_amego.sql）
 *   - payment_alert       count_payment_alerts()（20260901000001_payment_alerts.sql 的最新版）
 *   - payment_unverified  count_payment_unverified()
 *   沒有清單 RPC 的那幾類（後三者），這裡用 PostgREST 逐條照抄 SQL 的 where；
 *   每一類都**同時**呼叫總覽用的 count RPC，兩邊數字對不上就在 note 講出來，
 *   SQL 之後改了條件、這裡沒跟上時看得出來，不會靜默給出一份錯的清單。
 *
 * 個資：只回訂單編號、金額、日期、異常原因。寄信失敗的收件人只給遮罩後的 Email
 * （總覽頁本來就只有數字，沒有一頁列出失敗信的收件人）。payment_events.raw 有卡號與
 * 授權碼，**絕對不 select**。
 *
 * 授權是呼叫端的責任（MCP 在 requireCapability("orders:read") 裡呼叫）。
 */

export const PROBLEM_KINDS = [
  "unfulfilled",
  "failed_email",
  "stuck_invoice",
  "payment_alert",
  "payment_unverified",
] as const;

export type ProblemKind = (typeof PROBLEM_KINDS)[number];

export const PROBLEM_LABEL: Record<ProblemKind, string> = {
  unfulfilled: "付了錢、線上課還沒開通",
  failed_email: "寄信失敗",
  stuck_invoice: "電子發票卡住",
  payment_alert: "付款異常（刷卡通知沒處理完）",
  payment_unverified: "金額未核對（已開通，但沒有獨立金額可比對）",
};

export type ProblemRow = {
  order_no: string | null;
  order_id: string | null;
  /** 訂單金額（新台幣）。查不到訂單時是 null。 */
  total: number | null;
  /** ISO 時間：這個異常的時間點（付款、寄信失敗、通知收到的時間） */
  at: string | null;
  reason: string;
  /** 建議的下一步（可以用哪一支工具處理） */
  next_step: string;
};

export type ProblemGroup = {
  kind: ProblemKind;
  label: string;
  /** 總覽頁顯示的同一個數字（count RPC）。null＝讀不到。 */
  dashboard_count: number | null;
  rows: ProblemRow[];
  /** 清單被 limit 截掉、或跟總覽數字對不上時的說明 */
  note: string | null;
  error: string | null;
};

const DAY = 24 * 60 * 60 * 1000;

type OrderBrief = { id: string; order_no: string; total: number; paid_at: string | null; created_at: string };

async function ordersById(db: Db, ids: string[]): Promise<Map<string, OrderBrief>> {
  const out = new Map<string, OrderBrief>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;
  const { data, error } = await db
    .from("orders")
    .select("id, order_no, total, paid_at, created_at")
    .in("id", unique);
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as OrderBrief[]) out.set(row.id, row);
  return out;
}

function countNote(dashboard: number | null, listed: number, matched: number, limit: number): string | null {
  const notes: string[] = [];
  if (matched > listed) notes.push(`符合條件共 ${matched} 筆，只列出 ${listed} 筆（上限 ${limit}），請加大 limit 或先處理這些。`);
  if (dashboard !== null && dashboard !== matched) {
    notes.push(`⚠️ 清單筆數（${matched}）與總覽數字（${dashboard}）對不上，請以後台總覽為準並通知工程師核對條件。`);
  }
  return notes.length ? notes.join(" ") : null;
}

async function rpcCount(db: Db, fn: string): Promise<number | null> {
  const { data, error } = await db.rpc(fn);
  if (error) {
    console.error("[admin/problems] 計數失敗", fn, error.message);
    return null;
  }
  return typeof data === "number" ? data : null;
}

/** 錯誤訊息裡可能夾著收件人信箱：遮掉，再截短。 */
function cleanError(text: string | null | undefined): string | null {
  if (!text) return null;
  return text
    .replace(/[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[A-Za-z]{2,}/g, (m) => maskEmail(m))
    .slice(0, 200);
}

/* ------------------------------------------------------------ 各類明細 */

/**
 * count_unfulfilled_paid_orders() 算進去、但 list_unfulfilled_paid_orders() 刻意不列的那些：
 * 「訂單還沒綁會員帳號」或「金額未核對」。這兩種系統自動補救不了，正是要人處理的。
 *
 * 條件逐條照 count_unfulfilled_paid_orders()（20260810000006_member_portal.sql）：
 *   status='paid' 且有 course／subscription 品項 且沒有任何 entitlements(order_id)
 * 再限定 user_id is null 或 price_unverified = true（＝ list 版多出來的兩個條件的反面）。
 * PostgREST 寫不出 exists，所以後兩條在記憶體裡判斷。
 */
async function loadUnfulfilledHeld(db: Db): Promise<{ order: OrderBrief & { user_id: string | null; price_unverified: boolean }; why: string; next: string }[]> {
  const cols = "id, order_no, total, paid_at, created_at, user_id, price_unverified";
  const [noUser, unverified] = await Promise.all([
    db.from("orders").select(cols).eq("status", "paid").is("user_id", null).limit(HELD_CAP),
    db.from("orders").select(cols).eq("status", "paid").eq("price_unverified", true).limit(HELD_CAP),
  ]);
  if (noUser.error) throw new Error(noUser.error.message);
  if (unverified.error) throw new Error(unverified.error.message);
  type HeldOrder = OrderBrief & { user_id: string | null; price_unverified: boolean };
  const byId = new Map<string, HeldOrder>();
  for (const o of [...((noUser.data ?? []) as HeldOrder[]), ...((unverified.data ?? []) as HeldOrder[])]) byId.set(o.id, o);
  const ids = [...byId.keys()];
  if (ids.length === 0) return [];

  const [items, ents] = await Promise.all([
    db.from("order_items").select("order_id, products(type)").in("order_id", ids),
    db.from("entitlements").select("order_id").in("order_id", ids),
  ]);
  if (items.error) throw new Error(items.error.message);
  if (ents.error) throw new Error(ents.error.message);

  type ItemRow = { order_id: string; products: { type: string | null } | { type: string | null }[] | null };
  const hasCourse = new Set(
    ((items.data ?? []) as ItemRow[])
      .filter((it) => {
        const p = Array.isArray(it.products) ? it.products[0] : it.products;
        return p?.type === "course" || p?.type === "subscription";
      })
      .map((it) => it.order_id),
  );
  const entitled = new Set(((ents.data ?? []) as { order_id: string }[]).map((e) => e.order_id));

  return [...byId.values()]
    .filter((o) => hasCourse.has(o.id) && !entitled.has(o.id))
    .sort((a, b) => String(a.paid_at ?? "").localeCompare(String(b.paid_at ?? "")))
    .map((o) =>
      !o.user_id
        ? {
            order: o,
            why: "已收款，但訂單還沒綁會員帳號，所以課開不出去（常見原因：客人 Email 打錯、下單當下建帳號失敗）。",
            next: "先用 get_order 看客人的 Email；跟客人確認正確信箱後用 rebind_order_account 綁定（會順便開通）。",
          }
        : {
            order: o,
            why: "已收款，但這筆訂單成立時有品項查不到價格（金額未核對），系統不會自動開課。",
            next: "要由負責人到後台訂單頁核對金額後按「我已核對金額無誤」開通；regrant_entitlements 不會處理這種單。",
          },
    );
}

/** 「沒綁帳號／金額未核對」的已付款訂單一次最多看幾筆（正常情況是個位數） */
const HELD_CAP = 500;

async function loadUnfulfilled(db: Db, limit: number): Promise<ProblemGroup> {
  const base = { kind: "unfulfilled" as const, label: PROBLEM_LABEL.unfulfilled };
  const [count, list, held] = await Promise.all([
    rpcCount(db, "count_unfulfilled_paid_orders"),
    db.rpc("list_unfulfilled_paid_orders", { p_limit: 500 }),
    loadUnfulfilledHeld(db),
  ]);
  if (list.error) throw new Error(list.error.message);
  const ids = ((list.data ?? []) as { id: string; order_no: string }[]).map((r) => r.id);
  const orders = await ordersById(db, ids.slice(0, limit));

  // 要人處理的（沒綁帳號／金額未核對）排前面：系統每天的補救 cron 只處理清單 RPC 那一種。
  const all: ProblemRow[] = [
    ...held.map((h) => ({
      order_no: h.order.order_no,
      order_id: h.order.id,
      total: h.order.total,
      at: h.order.paid_at ?? h.order.created_at,
      reason: h.why,
      next_step: h.next,
    })),
    ...ids.map((id) => {
      const o = orders.get(id);
      return {
        order_no: o?.order_no ?? null,
        order_id: id,
        total: o?.total ?? null,
        at: o?.paid_at ?? o?.created_at ?? null,
        reason: "已收款，但線上課還沒開通 —— 客人現在登入看不到課。",
        next_step: "用 regrant_entitlements 重新開通（先預覽）。",
      };
    }),
  ];
  const matched = held.length + ids.length;
  const rows = all.slice(0, limit);
  // list RPC 上限 500：真的撈滿時 matched 只是下限，不跟總覽比對（避免假警報）
  const note = ids.length >= 500 ? `符合條件超過 ${matched} 筆，只列出 ${rows.length} 筆。` : countNote(count, rows.length, matched, limit);
  return { ...base, dashboard_count: count, rows, note, error: null };
}

const EMAIL_KIND_LABEL: Record<string, string> = {
  order_created: "訂單成立通知",
  order_paid: "開通／付款完成通知",
  account_setup: "設定密碼信",
  account_setup_manual: "設定密碼信（手動重寄）",
  workshop_reminder: "工作坊行前提醒",
};

async function loadFailedEmails(db: Db, limit: number): Promise<ProblemGroup> {
  const base = { kind: "failed_email" as const, label: PROBLEM_LABEL.failed_email };
  const { data, error, count } = await db
    .from("email_outbox")
    .select("id, dedupe_key, attempts, last_error, updated_at", { count: "exact" })
    .eq("status", "failed")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  const raw = (data ?? []) as {
    id: string;
    dedupe_key: string;
    attempts: number;
    last_error: string | null;
    updated_at: string;
  }[];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const orderIdOf = (key: string) => {
    const [kind, id] = key.split(":");
    return (kind === "order_created" || kind === "order_paid") && UUID.test(id ?? "") ? id : null;
  };
  const orders = await ordersById(db, raw.map((r) => orderIdOf(r.dedupe_key) ?? ""));

  const rows: ProblemRow[] = raw.map((r) => {
    const kind = r.dedupe_key.split(":")[0];
    const orderId = orderIdOf(r.dedupe_key);
    const o = orderId ? orders.get(orderId) : undefined;
    const err = cleanError(r.last_error);
    return {
      order_no: o?.order_no ?? null,
      order_id: orderId,
      total: o?.total ?? null,
      at: r.updated_at,
      reason: `${EMAIL_KIND_LABEL[kind] ?? "系統信"}重試 ${r.attempts} 次仍寄不出去` + (err ? `：${err}` : ""),
      next_step: orderId
        ? "先用 get_order 確認客人的 Email 有沒有打錯；打錯就用 rebind_order_account 改信箱，或改用 LINE／電話通知。"
        : "請確認客人的 Email 是否打錯，或改用 LINE／電話通知。",
    };
  });
  const matched = typeof count === "number" ? count : rows.length;
  // 總覽用的就是這一條 count（loadHealthStats），所以 dashboard_count 等於 matched。
  return { ...base, dashboard_count: matched, rows, note: countNote(matched, rows.length, matched, limit), error: null };
}

type InvoiceAlertRow = {
  order_id: string;
  status: string;
  retry_count: number | null;
  last_error: string | null;
  orders: { order_no: string; total: number; paid_at: string | null } | { order_no: string; total: number; paid_at: string | null }[] | null;
};

async function loadStuckInvoices(db: Db, limit: number, now: number): Promise<ProblemGroup> {
  const base = { kind: "stuck_invoice" as const, label: PROBLEM_LABEL.stuck_invoice };
  const cols = "order_id, status, retry_count, last_error, orders!inner(order_no, total, paid_at)";

  // count_invoice_alerts() 的三個子查詢，逐條照抄：
  const [overdue, issuing, exhausted, rpc] = await Promise.all([
    // 1. pending 且訂單付款超過 30 分鐘（paid_at is not null 由 lt 隱含）
    db
      .from("invoices")
      .select(cols, { count: "exact" })
      .eq("status", "pending")
      .lt("orders.paid_at", new Date(now - 30 * 60 * 1000).toISOString())
      .order("created_at", { ascending: true })
      .limit(limit),
    // 2. 卡在 issuing 超過 10 分鐘
    db
      .from("invoices")
      .select(cols, { count: "exact" })
      .eq("status", "issuing")
      .lt("claimed_at", new Date(now - 10 * 60 * 1000).toISOString())
      .order("created_at", { ascending: true })
      .limit(limit),
    // 3. pending 且重試用完（>= 8 次）
    db
      .from("invoices")
      .select(cols, { count: "exact" })
      .eq("status", "pending")
      .gte("retry_count", 8)
      .order("created_at", { ascending: true })
      .limit(limit),
    db.rpc("count_invoice_alerts"),
  ]);
  for (const r of [overdue, issuing, exhausted]) if (r.error) throw new Error(r.error.message);

  const reasons = new Map<string, { row: InvoiceAlertRow; why: string[] }>();
  const add = (list: unknown, why: string) => {
    for (const row of (list ?? []) as InvoiceAlertRow[]) {
      const cur = reasons.get(row.order_id) ?? { row, why: [] };
      cur.why.push(why);
      reasons.set(row.order_id, cur);
    }
  };
  add(overdue.data, "付款超過 30 分鐘還沒開出發票");
  add(issuing.data, "開立中超過 10 分鐘（不確定 Amego 有沒有收到）");
  add(exhausted.data, "自動重試已用完（8 次）");

  const rows: ProblemRow[] = [...reasons.values()].slice(0, limit).map(({ row, why }) => {
    const o = Array.isArray(row.orders) ? row.orders[0] : row.orders;
    const err = cleanError(row.last_error);
    return {
      order_no: o?.order_no ?? null,
      order_id: row.order_id,
      total: o?.total ?? null,
      at: o?.paid_at ?? null,
      reason: why.join("；") + (err ? `。最後的錯誤：${err}` : ""),
      next_step: "用 reissue_invoice 補開（先預覽，會說明現在能不能補開）。",
    };
  });

  // 總覽把三個計數相加（同一張發票可能同時符合兩條，例如逾時又重試用完）。
  const invRow = (Array.isArray(rpc.data) ? rpc.data[0] : rpc.data) as
    | { pending_overdue?: number; stuck_issuing?: number; exhausted?: number }
    | null;
  const dashboard = rpc.error
    ? null
    : Number(invRow?.pending_overdue ?? 0) + Number(invRow?.stuck_issuing ?? 0) + Number(invRow?.exhausted ?? 0);
  if (rpc.error) console.error("[admin/problems] count_invoice_alerts 失敗", rpc.error.message);
  const matched = (overdue.count ?? 0) + (issuing.count ?? 0) + (exhausted.count ?? 0);
  const notes: string[] = [];
  if (dashboard !== null && dashboard !== matched) {
    notes.push(`⚠️ 清單條件算出 ${matched} 筆、總覽顯示 ${dashboard} 筆，對不上，請以後台總覽為準並通知工程師核對條件。`);
  }
  const truncated =
    [overdue, issuing, exhausted].some((r) => (r.count ?? 0) > (r.data?.length ?? 0)) || reasons.size > rows.length;
  if (truncated) notes.push(`還有更多筆，只列出前 ${limit} 筆，請加大 limit 看其餘的。`);
  else if (matched > reasons.size) {
    notes.push(`同一張發票可能同時符合兩種狀況，所以總覽的數字（${matched}）比這裡的訂單筆數（${reasons.size}）多。`);
  }
  return { ...base, dashboard_count: dashboard, rows, note: notes.length ? notes.join(" ") : null, error: null };
}

const PAYMENT_OUTCOME_REASON: Record<string, string> = {
  amount_mismatch: "實收金額與應收不符，沒有開通",
  not_authorized: "回查黑貓 PAY 說這筆沒有授權，沒有開通",
  verify_failed: "回查黑貓 PAY 打不通，沒有開通",
  reversal_notice: "授權被取消或請款失敗，但訂單還是「已收款」（錢可能已退回，席次與課程還佔著）",
  order_not_found: "收到付款通知，卻找不到對應的訂單",
  pending: "付款通知處理到一半中斷（超過一小時沒有結果）",
  applied_unverified: "已開通，但黑貓 PAY 的回應裡沒有可核對的實收金額",
};

type PaymentEventRow = {
  id: string;
  order_id: string | null;
  order_no: string | null;
  status_code: string;
  amount: number | null;
  outcome: string;
  note: string | null;
  created_at: string;
};

/** 🔴 不可以加 raw：那一欄有卡號與授權碼。 */
const PAYMENT_COLS = "id, order_id, order_no, status_code, amount, outcome, note, created_at";

function paymentRows(list: PaymentEventRow[], orders: Map<string, OrderBrief>, next: string): ProblemRow[] {
  return list.map((e) => {
    const o = e.order_id ? orders.get(e.order_id) : undefined;
    const note = cleanError(e.note);
    return {
      order_no: o?.order_no ?? e.order_no ?? null,
      order_id: e.order_id,
      total: o?.total ?? e.amount ?? null,
      at: e.created_at,
      reason:
        (PAYMENT_OUTCOME_REASON[e.outcome] ?? e.outcome) +
        `（黑貓 PAY 狀態碼 ${e.status_code}${e.amount !== null ? `，通知金額 ${e.amount} 元` : ""}）` +
        (note ? `。${note}` : ""),
      next_step: next,
    };
  });
}

async function loadPaymentAlerts(db: Db, limit: number, now: number): Promise<ProblemGroup> {
  const base = { kind: "payment_alert" as const, label: PROBLEM_LABEL.payment_alert };
  const since = new Date(now - 30 * DAY).toISOString();
  // count_payment_alerts() 的 where，拆成三條 OR 分支各查一次：
  const [a, b, c, dashboard] = await Promise.all([
    db
      .from("payment_events")
      .select(PAYMENT_COLS, { count: "exact" })
      .gt("created_at", since)
      .in("outcome", ["amount_mismatch", "not_authorized", "verify_failed", "reversal_notice"])
      .order("created_at", { ascending: false })
      .limit(limit),
    db
      .from("payment_events")
      .select(PAYMENT_COLS, { count: "exact" })
      .gt("created_at", since)
      .eq("outcome", "order_not_found")
      .not("status_code", "in", "(D,F,N,R)")
      .order("created_at", { ascending: false })
      .limit(limit),
    db
      .from("payment_events")
      .select(PAYMENT_COLS, { count: "exact" })
      .gt("created_at", since)
      .eq("outcome", "pending")
      .lt("created_at", new Date(now - 60 * 60 * 1000).toISOString())
      .order("created_at", { ascending: false })
      .limit(limit),
    rpcCount(db, "count_payment_alerts"),
  ]);
  for (const r of [a, b, c]) if (r.error) throw new Error(r.error.message);

  const all = [...((a.data ?? []) as PaymentEventRow[]), ...((b.data ?? []) as PaymentEventRow[]), ...((c.data ?? []) as PaymentEventRow[])]
    .sort((x, y) => (x.created_at < y.created_at ? 1 : -1))
    .slice(0, limit);
  const orders = await ordersById(db, all.map((e) => e.order_id ?? ""));
  const rows = paymentRows(
    all,
    orders,
    "請開黑貓 PAY 後台的交易明細比對訂單編號。確認客人有付款卻沒拿到課：請負責人在後台訂單頁處理（線上刷卡不能用 mark_order_paid）；錢已退回的：用 request_refund 留申請給負責人。",
  );
  const matched = (a.count ?? 0) + (b.count ?? 0) + (c.count ?? 0);
  return { ...base, dashboard_count: dashboard, rows, note: countNote(dashboard, rows.length, matched, limit), error: null };
}

async function loadPaymentUnverified(db: Db, limit: number, now: number): Promise<ProblemGroup> {
  const base = { kind: "payment_unverified" as const, label: PROBLEM_LABEL.payment_unverified };
  const [list, dashboard] = await Promise.all([
    db
      .from("payment_events")
      .select(PAYMENT_COLS, { count: "exact" })
      .eq("outcome", "applied_unverified")
      .gt("created_at", new Date(now - 30 * DAY).toISOString())
      .order("created_at", { ascending: false })
      .limit(limit),
    rpcCount(db, "count_payment_unverified"),
  ]);
  if (list.error) throw new Error(list.error.message);
  const raw = (list.data ?? []) as PaymentEventRow[];
  const orders = await ordersById(db, raw.map((e) => e.order_id ?? ""));
  const rows = paymentRows(
    raw,
    orders,
    "客人沒有受影響（課與席次都正常）。對帳時用黑貓 PAY 後台的交易明細比對一次金額即可，不需要用工具處理。",
  );
  const matched = typeof list.count === "number" ? list.count : rows.length;
  return { ...base, dashboard_count: dashboard, rows, note: countNote(dashboard, rows.length, matched, limit), error: null };
}

/* ------------------------------------------------------------------ 入口 */

/**
 * 依類別撈明細。每一類各自 try/catch：一類查壞了只有那一類回 error，其他照常
 * （跟總覽「每一塊各自 try/catch」同一個原則）。
 */
export async function loadProblemOrders(
  db: Db,
  kinds: readonly ProblemKind[],
  limit: number,
  now: number = Date.now(),
): Promise<ProblemGroup[]> {
  const loaders: Record<ProblemKind, () => Promise<ProblemGroup>> = {
    unfulfilled: () => loadUnfulfilled(db, limit),
    failed_email: () => loadFailedEmails(db, limit),
    stuck_invoice: () => loadStuckInvoices(db, limit, now),
    payment_alert: () => loadPaymentAlerts(db, limit, now),
    payment_unverified: () => loadPaymentUnverified(db, limit, now),
  };
  return Promise.all(
    kinds.map(async (kind) => {
      try {
        return await loaders[kind]();
      } catch (err) {
        console.error("[admin/problems] 明細查詢失敗", kind, err instanceof Error ? err.message : err);
        return {
          kind,
          label: PROBLEM_LABEL[kind],
          dashboard_count: null,
          rows: [],
          note: null,
          error: "這一類讀取失敗，請稍後再試或到後台總覽查看。",
        };
      }
    }),
  );
}
