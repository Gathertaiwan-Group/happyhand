"use server";

import { revalidatePath } from "next/cache";
import { requireCapability, adminErrorMessage } from "@/lib/admin/guard";
import { writeAudit } from "@/lib/admin/audit";
import { createServiceClient } from "@/lib/supabase/server";
import { ensureInvoiceRow, issueForOrder, voidForOrder } from "@/lib/invoice/issue";

/**
 * 發票的人工補救動作。
 *
 * 為什麼需要這些按鈕：開票是付款之後的附帶動作，而且刻意設計成「失敗不擋付款」。
 * 所以一定會有一批訂單處於「錢收了、課開了、發票沒開出來」的狀態 ——
 * Amego 連不上、載具被打回、統編是對的但公司已經歇業。
 * 沒有補救 UI 的話，客服只能請工程師下 SQL。
 *
 * 🔴 作廢在這套系統裡是**終點**。Amego 對 OrderId（= orders.order_no）做唯一性
 *    檢查，而那正是我們整套冪等的地基。作廢之後用同一個 order_no 重開會拿到
 *    3040171，而反查又會查到那張已作廢的 —— 沒有乾淨的自動路徑。
 *    要支援「作廢後重開」得讓 amego_order_id 可以帶尾碼（HH-…-R2），那會動到
 *    invoices 的 unique 與整條認回邏輯，不是這一版的範圍。
 *
 * ⚠️ 每一支都自己 requireCapability("orders:write")：
 *    admin/layout.tsx 的守衛只在 render 時跑，server action 的 POST 不經過它。
 * ⚠️ 每一支都寫 audit：發票是稅務憑證，誰在什麼時候補開／作廢必須查得到。
 */

export type InvoiceActionResult = { error?: string | null; ok?: string | null };

async function orderNoOf(orderId: string): Promise<string> {
  try {
    const db = createServiceClient();
    const { data } = await db
      .from("orders")
      .select("order_no")
      .eq("id", orderId)
      .maybeSingle();
    return (data?.order_no as string | undefined) ?? orderId;
  } catch {
    return orderId;
  }
}

/**
 * 補開發票。
 *
 * 🔴 2026-10-15 自動開票移除之後，**這是站上唯一會開出發票的路**（另一條是
 *    退款時的作廢）。付款、後台標記付款、每日排程都不再開票了。
 *
 * 🔴 這支**不會**直接呼叫 Amego —— 它走 issueForOrder()，所以同樣要先拿
 *    claim、同樣會在 issue_attempts > 1 時先反查。客服連按兩下不會開出兩張，
 *    這是靠 DB 的 claim 保證的，不是靠按鈕 disabled。
 */
export async function reissueInvoice(orderId: string): Promise<InvoiceActionResult> {
  let staff;
  try {
    staff = await requireCapability("orders:write");
  } catch (err) {
    return { error: adminErrorMessage(err) };
  }

  try {
    // 訂單可能根本還沒有 invoices 列（舊訂單、或建立那一步失敗過）
    await ensureInvoiceRow(orderId);

    const out = await issueForOrder(orderId);
    const orderNo = await orderNoOf(orderId);

    revalidatePath(`/admin/orders/${orderId}`);

    if (out.status === "issued") {
      await writeAudit(staff, {
        action: "invoice.issued",
        entity: "order",
        entityId: orderId,
        summary:
          `訂單 ${orderNo} ${out.adopted ? "認回" : "補開"}發票 ${out.invoiceNumber}` +
          (out.adopted ? "（Amego 上本來就有，不是新開的）" : ""),
      });
      return {
        ok: out.adopted
          ? `這張訂單在 Amego 上本來就有發票 ${out.invoiceNumber}，已經認回來了（沒有重複開立）。`
          : `發票 ${out.invoiceNumber} 已開立。`,
      };
    }

    if (out.status === "skipped") {
      // claim 拒發。這些都是正常狀況，講清楚是哪一種。
      const why: Record<string, string> = {
        already_issued: "這張訂單已經開過發票了。",
        already_voided:
          "這張發票已經作廢。作廢之後不能用同一張訂單重開 —— Amego 對訂單編號做唯一性檢查，"
          + "同一個編號只能開一次。真的需要重開請在 Amego 後台手動處理。",
        in_flight: "正在開立中，請等 10 秒後重新整理看看。",
        retries_exhausted:
          "重試次數已用完。請先看下面的錯誤訊息把資料修正（例如統編或載具），再按一次。",
        not_due: "還在等下一次重試的時間，稍後會自動再試一次。",
        no_invoice_row: "這張訂單沒有待開立的發票紀錄，可能還沒付款。",
        amego_not_configured: "系統還沒設定 Amego 憑證，開不了發票。",
      };
      return { error: why[out.reason] ?? `暫時不能開立（${out.reason}）。` };
    }

    return { error: `開立失敗：${out.reason}` };
  } catch (err) {
    console.error("[invoice-actions] reissue 例外", orderId, err);
    return { error: "開立過程發生錯誤，請稍後再試一次。" };
  }
}

/**
 * 作廢發票。
 *
 * ⚠️ 作廢**不重試**，失敗就是失敗。跨月不能作廢（要改開折讓）、發票不存在、
 *    已經作廢過 —— 這些重試一百次都是同一個答案，重試只會讓客服以為系統壞了。
 *
 * ⚠️ 這支不會改訂單狀態。作廢發票與退款是兩件事：有可能只是開錯載具要重開，
 *    訂單本身沒有要退。要退款請另外按「標記為已退款」（那顆會自己作廢發票）。
 */
export async function voidInvoiceAction(
  orderId: string,
  reason: string,
): Promise<InvoiceActionResult> {
  let staff;
  try {
    staff = await requireCapability("orders:write");
  } catch (err) {
    return { error: adminErrorMessage(err) };
  }

  try {
    const db = createServiceClient();
    const { data: inv } = await db
      .from("invoices")
      .select("invoice_number")
      .eq("order_id", orderId)
      .maybeSingle();

    const res = await voidForOrder(orderId, reason || "後台手動作廢");
    const orderNo = await orderNoOf(orderId);

    revalidatePath(`/admin/orders/${orderId}`);

    if (!res.ok) return { error: `作廢失敗：${res.reason}` };

    await writeAudit(staff, {
      action: "invoice.voided",
      entity: "order",
      entityId: orderId,
      summary: `訂單 ${orderNo} 的發票 ${inv?.invoice_number ?? "(未知號碼)"} 已作廢：${reason || "後台手動作廢"}`,
    });

    return {
      ok:
        "發票已作廢，客人那邊看到的發票號碼也已經清掉。"
        + "⚠️ 同一張訂單不能再用「補開發票」重開 —— Amego 對訂單編號做唯一性檢查，"
        + "這個編號已經用掉了。若要補一張新的，請在 Amego 後台手動開立。",
    };
  } catch (err) {
    console.error("[invoice-actions] void 例外", orderId, err);
    return { error: "作廢過程發生錯誤，請稍後再試一次。" };
  }
}
