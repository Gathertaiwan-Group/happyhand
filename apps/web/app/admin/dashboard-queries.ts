import "server-only";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * 後台總覽（app/admin/page.tsx）的查詢。
 *
 * 2026-11-18 從 page.tsx 原封不動搬出來，讓 MCP 的 get_dashboard 用**同一份**查詢
 * （數字只能有一個定義：總覽顯示幾筆，AI 回報的就是幾筆）。頁面改成 import，畫面不變。
 *
 * 讀取一律走 service role，**授權是呼叫端的責任**（頁面用 can()，MCP 用 requireCapability）。
 * 異常的明細清單在 ./problem-orders.ts，條件逐條對照這裡用的 count_* RPC。
 */

export type Db = ReturnType<typeof createServiceClient>;

export type UpcomingSessionRow = {
  id: string;
  starts_at: string;
  location: string | null;
  capacity: number;
  seats_taken: number;
  status: string;
  products: { title: string | null } | { title: string | null }[] | null;
};

/* ------------------------------------------------------------------ 查詢 */

export async function loadOrderStats(db: Db | null) {
  const empty = { pending: 0, recentCount: 0, recentPaidTotal: 0, error: "" };
  if (!db) return { ...empty, error: "資料庫連線未設定，請檢查伺服器環境變數。" };

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [pending, recent] = await Promise.all([
      db.from("orders").select("id", { count: "exact", head: true }).eq("status", "pending"),
      db.from("orders").select("total, status").gte("created_at", sevenDaysAgo),
    ]);

    // Supabase 查詢失敗不會 throw，錯誤在回傳值的 error 欄位。
    // 不顯式檢查的話數字會永遠是 0 而沒人發現。
    if (pending.error) throw new Error(pending.error.message);
    if (recent.error) throw new Error(recent.error.message);

    const rows = (recent.data ?? []) as { total: number; status: string }[];
    return {
      pending: pending.count ?? 0,
      recentCount: rows.length,
      recentPaidTotal: rows
        .filter((row) => row.status === "paid")
        .reduce((sum, row) => sum + (row.total ?? 0), 0),
      error: "",
    };
  } catch (err) {
    console.error("[admin] 訂單統計查詢失敗", err);
    return { ...empty, error: "訂單統計讀取失敗。" };
  }
}

/**
 * 兩個「有沒有人付了錢卻沒拿到東西」的指標。
 *
 * 查失敗時回 0 而不是顯示錯誤：這一區只在數字 > 0 時渲染，
 * 查不到就當作沒事，總覽的其他部分照常運作。失敗會進 log。
 */
export async function loadHealthStats(db: Db | null) {
  const empty = {
    unfulfilled: 0,
    failedEmails: 0,
    stuckInvoices: 0,
    paymentAlerts: 0,
    paymentUnverified: 0,
  };
  if (!db) return empty;

  try {
    const [unfulfilled, failed, invoices, payments, unverified] = await Promise.all([
      db.rpc("count_unfulfilled_paid_orders"),
      db
        .from("email_outbox")
        .select("id", { count: "exact", head: true })
        .eq("status", "failed"),
      db.rpc("count_invoice_alerts"),
      /*
        付款異常。
        ⚠️ count_payment_alerts() 從 20260817 就寫好了，但**沒有任何畫面呼叫它**，
           所以「收到付款通知卻沒能把課開出去」這件事一直沒有人看得到 ——
           而那正好是 APN 那幾個 bug 掉單時會留下的痕跡。這一行就是補上這個缺口。
      */
      db.rpc("count_payment_alerts"),
      db.rpc("count_payment_unverified"),
    ]);

    if (unfulfilled.error) {
      console.error("[admin] 未開通訂單查詢失敗", unfulfilled.error.message);
    }
    if (failed.error) {
      console.error("[admin] 寄信失敗數查詢失敗", failed.error.message);
    }

    if (invoices.error) {
      console.error("[admin] 發票異常查詢失敗", invoices.error.message);
    }
    if (payments.error) {
      console.error("[admin] 付款異常查詢失敗", payments.error.message);
    }
    if (unverified.error) {
      console.error("[admin] 未核對金額查詢失敗", unverified.error.message);
    }

    // RPC 回的是一列三個計數。三種都是「客人拿不到發票」，加總成一個數字就好 ——
    // 客服要的是「有幾筆要看」，細節在訂單頁上。
    const invRow = (Array.isArray(invoices.data) ? invoices.data[0] : invoices.data) as
      | { pending_overdue?: number; stuck_issuing?: number; exhausted?: number }
      | null;

    return {
      unfulfilled: typeof unfulfilled.data === "number" ? unfulfilled.data : 0,
      failedEmails: failed.count ?? 0,
      stuckInvoices:
        Number(invRow?.pending_overdue ?? 0) +
        Number(invRow?.stuck_issuing ?? 0) +
        Number(invRow?.exhausted ?? 0),
      paymentAlerts: typeof payments.data === "number" ? payments.data : 0,
      paymentUnverified: typeof unverified.data === "number" ? unverified.data : 0,
    };
  } catch (err) {
    console.error("[admin] 健康度統計查詢失敗", err);
    return empty;
  }
}

export async function loadCatalogStats(db: Db | null) {
  const empty = { published: 0, draft: 0, error: "" };
  if (!db) return { ...empty, error: "資料庫連線未設定，請檢查伺服器環境變數。" };

  try {
    const [published, draft] = await Promise.all([
      db.from("products").select("id", { count: "exact", head: true }).eq("is_published", true),
      db.from("products").select("id", { count: "exact", head: true }).eq("is_published", false),
    ]);
    if (published.error) throw new Error(published.error.message);
    if (draft.error) throw new Error(draft.error.message);

    return { published: published.count ?? 0, draft: draft.count ?? 0, error: "" };
  } catch (err) {
    console.error("[admin] 課程統計查詢失敗", err);
    return { ...empty, error: "課程統計讀取失敗。" };
  }
}

export async function loadUpcomingSessions(db: Db | null) {
  const empty = { rows: [] as UpcomingSessionRow[], error: "" };
  if (!db) return { ...empty, error: "資料庫連線未設定，請檢查伺服器環境變數。" };

  try {
    const { data, error } = await db
      .from("workshop_sessions")
      .select("id, starts_at, location, capacity, seats_taken, status, products(title)")
      .gt("starts_at", new Date().toISOString())
      .in("status", ["open", "full"])
      .order("starts_at", { ascending: true })
      .limit(8);
    if (error) throw new Error(error.message);

    return { rows: (data ?? []) as UpcomingSessionRow[], error: "" };
  } catch (err) {
    console.error("[admin] 場次查詢失敗", err);
    return { ...empty, error: "場次讀取失敗。" };
  }
}

/** 本月訂單一次最多撈幾列（撈滿就標「可能不完整」）。 */
const MONTH_ROW_CAP = 5000;

/**
 * 本月（台北時間）營收。只給 MCP 的 get_dashboard 用（總覽頁沒有這個數字）。
 *
 * 口徑刻意跟 loadOrderStats 的「近 7 天已收款」一樣：以訂單**成立時間**落在區間內、
 * **目前狀態**是已付款的訂單金額加總（後來退款的不算）。兩個數字並列時才不會互相矛盾。
 */
export async function loadMonthRevenue(db: Db | null, now: Date = new Date()) {
  const empty = { since: "", paidTotal: 0, paidCount: 0, orderCount: 0, maybeIncomplete: false, error: "" };
  if (!db) return { ...empty, error: "資料庫連線未設定，請檢查伺服器環境變數。" };

  // 台北沒有日光節約，固定 UTC+8。
  const taipei = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const since = new Date(
    Date.UTC(taipei.getUTCFullYear(), taipei.getUTCMonth(), 1) - 8 * 60 * 60 * 1000,
  ).toISOString();

  try {
    const { data, error } = await db
      .from("orders")
      .select("total, status")
      .gte("created_at", since)
      .limit(MONTH_ROW_CAP);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { total: number; status: string }[];
    const paid = rows.filter((row) => row.status === "paid");
    return {
      since,
      paidTotal: paid.reduce((sum, row) => sum + (row.total ?? 0), 0),
      paidCount: paid.length,
      orderCount: rows.length,
      // PostgREST 的單次上限（預設 1000）可能比 MONTH_ROW_CAP 小；撈滿任何一個整數上限都當成可能不完整。
      maybeIncomplete: rows.length >= 1000,
      error: "",
    };
  } catch (err) {
    console.error("[admin] 本月營收查詢失敗", err);
    return { ...empty, since, error: "本月營收讀取失敗。" };
  }
}

