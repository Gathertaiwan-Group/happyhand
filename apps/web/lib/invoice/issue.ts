import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import {
  isAmegoConfigured,
  issueInvoice,
  queryByOrderId,
  voidInvoice,
  type InvoiceItem,
} from "@/lib/invoice/amego";
import { isCarrierType, type CarrierType } from "@/lib/invoice/validate";

/**
 * 開發票的編排層：claim → 反查 → 打 Amego → 記結果。
 *
 * ── 為什麼 claim 一定要在打 Amego 之前 ──────────────────────────────────────
 * 發票開出去撤不回來。財政部那邊多一張就是多一張，只能再開一張作廢單去沖銷，
 * 而客人的信箱裡已經躺著兩份稅務憑證。所以順序是硬性的：
 *
 *   1. claim_invoice_issue()  原子地宣告「這張由我開」
 *   2. 呼叫 Amego             只有拿到 claim 的人可以做這一步
 *   3. finish / fail          一定要走到其中一個
 *
 * 這個順序讓「已送出但還沒記錄」在資料庫裡**看得見**（status='issuing'）。
 * 少了它，從 Amego 回應到 UPDATE 落地之間行程被殺（Vercel 函式逾時就會這樣），
 * 資料庫裡這一列還是 pending，下一次重試就開出第二張真發票。
 *
 * ── 重試前先問「是不是已經開過了」──────────────────────────────────────────
 * 第 2 步與第 3 步之間如果行程被砍，狀態是「Amego 已經開了，我們沒記到」。
 * 這一種**一定**要反查認回，不能重開。判斷依據是 `issue_attempts > 1`
 * （claim 遞增、永不歸零）；刻意不用 retry_count，因為它成功時會歸零，
 * 正好在最需要反查的那一次選擇不反查。
 *
 * 兩道獨立的保險，互為 fallback：
 *   主動  invoice_query 查得到號碼 → 認回
 *   被動  c0401 回 3040171（OrderId 重複）→ 回頭查一次再認回
 * 任何一道掛掉，另一道還在。兩道都成立的前提是 OrderId = orders.order_no
 * （init.sql:246 是 unique），也就是把 Amego 的唯一性約束借來當我們的冪等鍵。
 */

const MAX_RETRIES = 8;

export type IssueOutcome =
  | { status: "issued"; invoiceNumber: string; adopted: boolean }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

type OrderForInvoice = {
  id: string;
  order_no: string;
  status: string;
  total: number;
  payment_paid_amount: number | null;
  contact_email: string | null;
  invoice_carrier_type: string | null;
  invoice_carrier_id: string | null;
  invoice_tax_id: string | null;
  invoice_title: string | null;
};

/**
 * 開票金額。
 *
 * 刷卡走 APN 的有 payment_paid_amount，而且 APN handler 已經驗證過它等於
 * order.total 才會把訂單改成 paid（apn/route.ts:209-228）；ATM 與 LINE 人工
 * 那兩種沒有實收欄位，只能用 total。
 */
function invoiceAmount(o: OrderForInvoice): number {
  return o.payment_paid_amount ?? o.total;
}

/* ------------------------------------------------------------ 建立待開立列 */

/**
 * 訂單付款後建立一列待開立的發票。
 *
 * 冪等靠 invoices.amego_order_id 的 unique（= order_no）。重複呼叫是安全的，
 * 所以 APN 與後台手動標記兩條路都可以無條件呼叫它 —— 那兩條路對同一張訂單
 * 都跑過是正常情況（客服先按、APN 後到）。
 *
 * ⚠️ 這支永不 throw。開票失敗不可以擋住付款流程 —— 錢已經收了，課程要開通，
 *    發票晚一點補開就好。回傳值只是給呼叫端記 log 用。
 */
export async function ensureInvoiceRow(orderId: string): Promise<boolean> {
  try {
    const db = createServiceClient();

    const { data: order } = await db
      .from("orders")
      .select(
        "id, order_no, status, total, payment_paid_amount, contact_email, " +
          "invoice_carrier_type, invoice_carrier_id, invoice_tax_id, invoice_title",
      )
      .eq("id", orderId)
      .maybeSingle();

    if (!order) return false;
    const o = order as unknown as OrderForInvoice;
    if (o.status !== "paid") return false;
    /*
      0 元訂單不開發票。工作坊梯次價可以是 0（免費場），這種訂單付款狀態照樣是 paid，
      但沒有交易額就沒有發票可開 —— 送 TotalAmount=0 給 Amego 只會變成一列永遠
      失敗的紀錄佔著警示。小時光的 invoice_backlog 也是用 total > 0 濾掉。
    */
    if (invoiceAmount(o) <= 0) return false;

    const { error } = await db.from("invoices").insert({
      order_id: o.id,
      amego_order_id: o.order_no,
      total_amount: invoiceAmount(o),
      buyer_tax_id: o.invoice_tax_id,
      buyer_name: o.invoice_title,
      carrier_type: o.invoice_carrier_type ?? "cloud",
      carrier_id: o.invoice_carrier_id,
    });

    // 23505 = 已經有這一列了，正是我們要的冪等
    if (error && error.code !== "23505") {
      console.error("[invoice] 建立待開立列失敗", o.order_no, error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[invoice] ensureInvoiceRow 例外", orderId, err);
    return false;
  }
}

/* ------------------------------------------------------------------ 開立 */

async function loadOrder(
  db: ReturnType<typeof createServiceClient>,
  orderId: string,
): Promise<{ order: OrderForInvoice; items: InvoiceItem[] } | null> {
  const { data: order } = await db
    .from("orders")
    .select(
      "id, order_no, status, total, payment_paid_amount, contact_email, " +
        "invoice_carrier_type, invoice_carrier_id, invoice_tax_id, invoice_title",
    )
    .eq("id", orderId)
    .maybeSingle();
  if (!order) return null;

  /*
    品名一定要 join products —— order_items 只有 product_id / unit_price / qty，
    沒有存品名（init.sql:265-277）。
    ⚠️ product_id 是 nullable（下單時查不到商品會寫 null），join 不到要有 fallback，
       不能讓一個孤兒品項害整張發票開不出來。
  */
  const { data: rows } = await db
    .from("order_items")
    .select("qty, unit_price, products(title)")
    .eq("order_id", orderId);

  const items: InvoiceItem[] = (rows ?? []).map((r) => {
    const p = r.products as unknown;
    const title =
      (Array.isArray(p) ? (p[0] as { title?: string } | undefined)?.title : (p as { title?: string } | null)?.title) ??
      "";
    return {
      name: title || "快樂手課程",
      qty: Number(r.qty),
      unitPrice: Number(r.unit_price),
    };
  });

  return { order: order as unknown as OrderForInvoice, items };
}

/**
 * 開一張發票。整支流程的入口。
 *
 * 呼叫端不需要先判斷「該不該開」—— claim 會回絕已開過、開立中、重試用完的情況。
 */
export async function issueForOrder(orderId: string): Promise<IssueOutcome> {
  if (!isAmegoConfigured()) {
    return { status: "skipped", reason: "amego_not_configured" };
  }

  const db = createServiceClient();

  // ── 1. claim ──────────────────────────────────────────────────────────
  const { data: claimRows, error: claimErr } = await db.rpc("claim_invoice_issue", {
    p_order_id: orderId,
    p_max_retries: MAX_RETRIES,
  });

  if (claimErr) {
    // PGRST202 = 函式不存在，也就是 migration 20260831000001 還沒套用到這個
    // 資料庫。🔴 fail closed 並且說清楚：拒絕開票永遠救得回來（列還在 pending，
    // 之後再驅動一次就好），而退回舊的「不 claim 就開」路徑會重新打開這整支
    // 模組存在的理由 —— 重複開票。絕對不要加那種 fallback。
    console.error("[invoice] claim 失敗", orderId, claimErr.code, claimErr.message);
    return { status: "failed", reason: `claim_failed:${claimErr.code ?? "unknown"}` };
  }

  const claim = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as
    | {
        ok: boolean;
        reason: string;
        invoice_id: string | null;
        amego_order_id: string | null;
        issue_attempts: number | null;
      }
    | undefined;

  if (!claim?.ok || !claim.invoice_id || !claim.amego_order_id) {
    return { status: "skipped", reason: claim?.reason ?? "claim_no_result" };
  }

  const invoiceId = claim.invoice_id;
  const orderNo = claim.amego_order_id;
  const attempts = claim.issue_attempts ?? 1;

  // 從這裡開始，**每一條 return 路徑都必須走過 finish 或 fail**。
  try {
    const loaded = await loadOrder(db, orderId);
    if (!loaded) {
      await failIssue(db, invoiceId, "找不到訂單", true);
      return { status: "failed", reason: "order_not_found" };
    }
    const { order, items } = loaded;

    // ── 2. 送出過就先反查（見檔頭）────────────────────────────────────
    if (attempts > 1) {
      const q = await queryByOrderId(orderNo);
      if (q.ok && q.hit) {
        await finishIssue(db, invoiceId, q.hit.invoiceNumber, q.hit.randomCode);
        return { status: "issued", invoiceNumber: q.hit.invoiceNumber, adopted: true };
      }
      // q.ok && !q.hit → 確定沒開過，往下開。
      // !q.ok          → **不知道**。仍然往下開，靠 Amego 的 OrderId 唯一性
      //                  擋（3040171），下面會接住它再反查一次。
      if (!q.ok) {
        console.warn("[invoice] 反查無法確認，改靠 Amego 唯一性", orderNo, q.reason);
      }
    }

    // ── 3. 開立 ──────────────────────────────────────────────────────
    const carrierType: CarrierType = isCarrierType(order.invoice_carrier_type)
      ? order.invoice_carrier_type
      : "cloud";

    const res = await issueInvoice({
      orderNo,
      totalAmount: invoiceAmount(order),
      items,
      buyerEmail: order.contact_email ?? "",
      taxId: carrierType === "b2b" ? order.invoice_tax_id : null,
      title: carrierType === "b2b" ? order.invoice_title : null,
      carrierType,
      carrierId: order.invoice_carrier_id,
    });

    if (res.ok) {
      await finishIssue(db, invoiceId, res.invoiceNumber, res.randomCode);
      return { status: "issued", invoiceNumber: res.invoiceNumber, adopted: false };
    }

    // ── 4. OrderId 重複 = 已經開過了，回頭認回 ───────────────────────
    if (res.duplicate) {
      const q = await queryByOrderId(orderNo);
      if (q.ok && q.hit) {
        await finishIssue(db, invoiceId, q.hit.invoiceNumber, q.hit.randomCode);
        return { status: "issued", invoiceNumber: q.hit.invoiceNumber, adopted: true };
      }
      // Amego 說重複、但我們查不出號碼。這是**不能自動處理**的狀態：
      // 直接開一張新的會變成真的重複開票。留給人處理。
      await failIssue(db, invoiceId, `Amego 說 OrderId 重複但反查不到號碼：${res.reason}`, true);
      return { status: "failed", reason: "duplicate_but_unresolvable" };
    }

    await failIssue(db, invoiceId, res.reason, res.permanent);
    return { status: "failed", reason: res.reason };
  } catch (err) {
    // 🔴 這裡不可以吞掉。沒有走到 finish/fail 的話這一列會卡在 issuing，
    //    等 stale 窗過期才會被撿回來 —— 而那時 issue_attempts > 1 會觸發反查，
    //    所以不會重開，只是慢。至少要留下錯誤訊息。
    const message = err instanceof Error ? err.message : String(err);
    console.error("[invoice] 開立過程例外", orderNo, message);
    await failIssue(db, invoiceId, `例外：${message}`, false);
    return { status: "failed", reason: message };
  }
}

async function finishIssue(
  db: ReturnType<typeof createServiceClient>,
  invoiceId: string,
  invoiceNumber: string,
  randomCode: string,
): Promise<void> {
  const { error } = await db.rpc("finish_invoice_issue", {
    p_invoice_id: invoiceId,
    p_invoice_number: invoiceNumber,
    p_random_code: randomCode,
  });
  if (error) {
    // DOUBLE_ISSUE 會走到這裡。這是「一張訂單開出兩張真發票」的絆線，
    // 不是可以 log 一行帶過的事。
    console.error("[invoice] 🔴 finish 失敗", invoiceId, invoiceNumber, error.message);
  }
}

async function failIssue(
  db: ReturnType<typeof createServiceClient>,
  invoiceId: string,
  reason: string,
  permanent: boolean,
): Promise<void> {
  const { error } = await db.rpc("fail_invoice_issue", {
    p_invoice_id: invoiceId,
    p_error: reason,
    p_permanent: permanent,
    p_max_retries: MAX_RETRIES,
  });
  if (error) {
    console.error("[invoice] fail 記錄失敗", invoiceId, error.message);
  }
}

/* ------------------------------------------------------------------ 批次 */

/**
 * 把到期的待開立發票跑一輪。給 /api/cron/daily 用。
 *
 * ⚠️ 這個站的 Vercel 是 Hobby 方案，cron 一天只跑一次（01:00）。所以真正讓
 *    客人準時拿到發票的是付款當下那次 after() 立即嘗試，這支是補網 ——
 *    專門接住「當下失敗、或 Amego 剛好在維護」的那些。
 */
export async function flushInvoices(limit = 20): Promise<{
  attempted: number;
  issued: number;
  failed: number;
}> {
  const tally = { attempted: 0, issued: 0, failed: 0 };
  if (!isAmegoConfigured()) return tally;

  try {
    const db = createServiceClient();

    // 先把卡在 issuing 的撿回來，它們才會出現在下面的查詢裡
    await db.rpc("reclaim_stale_invoices", { p_stale_after: "10 minutes" });

    const { data: rows, error } = await db
      .from("invoices")
      .select("order_id")
      .eq("status", "pending")
      .lte("next_attempt_at", new Date().toISOString())
      .lt("retry_count", MAX_RETRIES)
      .order("next_attempt_at", { ascending: true })
      .limit(limit);

    if (error) {
      console.error("[invoice] 讀取待開立清單失敗", error.message);
      return tally;
    }

    for (const row of rows ?? []) {
      tally.attempted += 1;
      const out = await issueForOrder(row.order_id as string);
      if (out.status === "issued") tally.issued += 1;
      else if (out.status === "failed") tally.failed += 1;
    }
  } catch (err) {
    console.error("[invoice] flush 例外", err);
  }

  return tally;
}

/* ------------------------------------------------------------------ 作廢 */

/**
 * 作廢一張已開立的發票。退款時用。
 *
 * ⚠️ 作廢**不重試**。跨月不能作廢（要改開折讓）、發票不存在、已經作廢過，
 *    這些重試一百次都是同一個答案。失敗就回錯讓客服看到。
 */
export async function voidForOrder(
  orderId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isAmegoConfigured()) return { ok: false, reason: "Amego 未設定" };

  const db = createServiceClient();

  const { data: inv } = await db
    .from("invoices")
    .select("id, status, invoice_number")
    .eq("order_id", orderId)
    .maybeSingle();

  if (!inv) return { ok: false, reason: "這張訂單沒有發票紀錄。" };
  if (inv.status === "voided") return { ok: false, reason: "這張發票已經作廢過了。" };
  if (inv.status !== "issued" || !inv.invoice_number) {
    return { ok: false, reason: "這張發票還沒開立成功，沒有東西可以作廢。" };
  }

  const res = await voidInvoice(inv.invoice_number as string, reason);
  if (!res.ok) return res;

  await db
    .from("invoices")
    .update({ status: "voided", voided_at: new Date().toISOString(), void_reason: reason })
    .eq("id", inv.id);

  // 客人端的顯示副本也要清掉，不然他在 /account 還看得到一張已作廢的發票號碼
  await db
    .from("orders")
    .update({ invoice_number: null, invoice_random_code: null, invoice_issued_at: null })
    .eq("id", orderId);

  return { ok: true };
}
