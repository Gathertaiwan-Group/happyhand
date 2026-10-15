import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { flushOutbox } from "@/lib/email/outbox";
import { grantEntitlementsForOrder } from "@/lib/admin/entitlements";
import { sendWorkshopReminders } from "@/lib/email/workshop-reminders";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * 每日維護排程。由 Vercel Cron 觸發（設定在 vercel.json）。
 *
 * 為什麼是「每日一次」而不是 apps/worker 的分鐘級排程：這個 Vercel 專案是
 * Hobby 方案，Cron 每天只能觸發一次。worker 原本的 `flush-email-outbox`
 * 是每 2 分鐘、`reclaim-seat-holds` 是每分鐘，那個頻率在 Hobby 上做不到。
 *
 * 這個取捨可行的原因：
 * ・寄信本來就在 /api/orders 的 after() 裡即時寄過一次，這裡只負責**失敗重試**，
 *   延遲一天可以接受（本來就是寄失敗的信）。
 * ・名額回收已經不需要排程了 —— 改用 seat_hold_window()（30 分鐘）在查詢時
 *   即時判斷，見 migration 20260827000001。worker 的 reclaim-seat-holds
 *   本來就是空轉的（seat_holds 表從來沒被寫入過）。
 *
 * 之後如果升級 Vercel Pro 或把 worker 部署到 Railway，這支可以直接退役。
 */

/**
 * 一次 flush 幾封。預設的 5 封是給 after() 那種「順手寄一下」用的，
 * 每日排程要能一次把當天的提醒送完，所以放大。
 */
const REMINDER_FLUSH_BATCH = 100;

/** Vercel Cron 會帶 Authorization: Bearer <CRON_SECRET>。 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  // 沒設 secret 就只信任 Vercel 自己帶的標頭。這是降級而不是全開：
  // x-vercel-cron 是平台注入的，外部請求偽造不了。
  if (!secret) return request.headers.get("x-vercel-cron") !== null;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ message: "unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const result: Record<string, unknown> = {};

  /*
    0) 開課提醒（前 3 天／前 1 天）。

    ⚠️ 排在 flushOutbox **之前**：這裡只把信排進 outbox，真正送出是下一步。
       順序顛倒的話今天排的提醒要等明天才寄，前一天的提醒就變成當天早上才到。

    這支的去重靠 email_outbox.dedupe_key 的 unique 約束，重跑安全。
    ?dry=1 可以只看「會寄給誰」而不真的排進去（驗證用）。
  */
  const dryRun = new URL(request.url).searchParams.get("dry") === "1";
  try {
    result.reminders = await sendWorkshopReminders({ dryRun });
  } catch (error) {
    console.error("[cron/daily] sendWorkshopReminders 失敗", error);
    result.reminders = { error: (error as Error).message };
  }

  // 1) 把排進 outbox 的信送出去（含上一步的提醒，以及先前寄失敗的重試）
  try {
    const flushed = await flushOutbox(dryRun ? 0 : REMINDER_FLUSH_BATCH);
    result.email = flushed;
  } catch (error) {
    console.error("[cron/daily] flushOutbox 失敗", error);
    result.email = { error: (error as Error).message };
  }

  /*
    1b) 發票重試已移除（2026-10-15 指示：先不開發票）。

    這裡原本是 flushInvoices()，把開失敗的發票每天重試一次。既然付款當下
    已經不開票了，待開立的列也不會再產生，這支留著只會去撈歷史殘留。
    恢復方式見 api/payments/blackcat/apn/route.ts 的註解。
  */

  const db = createServiceClient();
  if (!db) {
    result.note = "沒有 service role key，略過資料庫工作";
    return NextResponse.json(result);
  }

  // 2) 把還沒綁到帳號的訂單綁回去（客人事後才註冊、或下單當下 Admin API 逾時）
  try {
    const { data, error } = await db.rpc("backfill_order_user_ids", {
      p_limit: 500,
    });
    result.backfilled = error ? { error: error.message } : data;
  } catch (error) {
    result.backfilled = { error: (error as Error).message };
  }

  // 3) 補開通：已收款、金額已核、也綁了帳號，但沒有 entitlement 的訂單。
  //    正常情況下 APN 或後台標記付款時就開通了，這裡是防漏網（例如當時
  //    grant 失敗、或訂單是先綁帳號後付款的）。
  //
  //    ⚠️ 一定要用 list_unfulfilled_paid_orders() 而不是自己抓 paid 訂單
  //    limit N —— 後者抓到的永遠是同樣的前 N 筆（早就開通過的），訂單累積
  //    超過 N 之後，真正漏開通的那筆就永遠輪不到，補救機制會靜默失效。
  try {
    const { data: pending, error } = await db.rpc(
      "list_unfulfilled_paid_orders",
      { p_limit: 100 },
    );

    if (error) {
      result.regrant = { error: error.message };
    } else {
      let granted = 0;
      let checked = 0;
      for (const o of (pending ?? []) as { id: string; order_no: string }[]) {
        const r = await grantEntitlementsForOrder(o.id);
        checked += 1;
        granted += r.granted;
        if (!r.ok) {
          console.error("[cron/daily] 補開通失敗", o.order_no, r.reason);
        }
      }
      result.regrant = { checked, granted };
    }
  } catch (error) {
    result.regrant = { error: (error as Error).message };
  }

  result.ms = Date.now() - started;
  console.info("[cron/daily] 完成", JSON.stringify(result));
  return NextResponse.json(result);
}
