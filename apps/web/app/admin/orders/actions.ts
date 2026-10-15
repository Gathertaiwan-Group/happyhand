"use server";

import { revalidatePath } from "next/cache";
import { requireCapability, adminErrorMessage, type Staff } from "@/lib/admin/guard";
import { writeAudit, diffOf } from "@/lib/admin/audit";
import {
  grantEntitlementsForOrder,
  type GrantResult,
} from "@/lib/admin/entitlements";
import { enqueueEmail, flushOutbox } from "@/lib/email/outbox";
import { voidForOrder } from "@/lib/invoice/issue";
import { canReverseCharge, reverseCharge } from "@/lib/payment/blackcat";
import { orderPaidEmail } from "@/lib/email/templates";
import { createServiceClient } from "@/lib/supabase/server";
import {
  ORDER_STATUS_LABELS,
  checkTransition,
  money,
  seatSignFor,
  type OrderStatus,
} from "./shared";

/**
 * 訂單狀態的 server action。
 *
 * ⚠️ 每一支都自己呼叫 requireCapability("orders:write")。
 *    admin/layout.tsx 的守衛只在 render 時跑，server action 的 POST 不經過它——
 *    少了這行，任何登入中的一般會員都能直接 POST 到這個 endpoint 把訂單標成已收款。
 *
 * 🔴 冪等性是這支檔案的核心。
 *    情境：兩個客服同時看到同一筆待收款訂單、同時按下「標記已收款」，
 *    或同一個人網路慢連按兩下。若寫成「先讀狀態、判斷、再無條件 update」，
 *    兩邊都會讀到 pending、都會通過判斷、都會 update 成功，
 *    然後各自呼叫一次 admin_adjust_seats(+qty) —— 工作坊名額被扣兩次。
 *
 *    解法是把判斷與寫入合併成一個原子操作：
 *      update ... where id = ? AND status = <讀到的舊狀態>
 *    Postgres 對同一列的 UPDATE 會排隊，第二個交易重新評估 where 時
 *    status 已經不是舊值，於是影響 0 列。用 returning（PostgREST 的 .select()）
 *    把「真的改到了嗎」變成可判斷的回傳值，而不是靠再讀一次。
 *    只有拿到那一列的那一次才會去動名額。
 */

export type OrderActionResult = { error?: string | null; ok?: string | null };

/** audit 的動詞。四個狀態都列出來，之後加轉移不會漏。 */
const AUDIT_ACTION: Record<OrderStatus, string> = {
  pending: "order.reopen",
  paid: "order.mark_paid",
  cancelled: "order.cancel",
  refunded: "order.refund",
};

type OrderRow = {
  id: string;
  order_no: string;
  status: string;
  total: number;
  paid_at: string | null;
};

const ORDER_COLUMNS = "id, order_no, status, total, paid_at";

/* ------------------------------------------------------------------ 對外 */

export async function markOrderPaid(orderId: string): Promise<OrderActionResult> {
  return transitionOrder(orderId, "paid");
}

export async function cancelOrder(orderId: string): Promise<OrderActionResult> {
  return transitionOrder(orderId, "cancelled");
}

/**
 * 退款：**先把錢退回去，成功了才改狀態**。
 *
 * 🔴 順序不能反。先改狀態的話，一旦金流那邊失敗，資料庫會說「已退款」但錢
 *    還在我們這裡 —— 而那是客服最不會回頭去查的狀態（畫面顯示成功了）。
 *    反過來（先退錢、後改狀態失敗）至少錢是往客人的方向走，客服重按一次就好。
 *
 * 只有「透過黑貓 PAY 收的款」才會真的去呼叫金流。ATM 匯款與 LINE 代訂本來就
 * 是人工收的，也只能人工退。
 */
export async function refundOrder(orderId: string): Promise<OrderActionResult> {
  let staff;
  try {
    staff = await requireCapability("orders:write");
  } catch (err) {
    return { error: adminErrorMessage(err) };
  }

  const db = createServiceClient();
  const { data: order } = await db
    .from("orders")
    .select("order_no, status, total, payment_provider, payment_trade_no, payment_paid_amount")
    .eq("id", orderId)
    .maybeSingle();

  if (!order) return { error: "找不到這筆訂單。" };
  if (order.status !== "paid") {
    return { error: `這筆訂單目前是「${ORDER_STATUS_LABELS[order.status as OrderStatus] ?? order.status}」，不能退款。` };
  }

  /*
    這筆該不該呼叫金流退款。

    🔴 這裡原本還多要求 `Boolean(order.payment_trade_no)`，那是個會靜默吃掉錢的條件：
       payment_trade_no 只有 APN 進來時才會寫。線上刷卡但 APN 沒收到（掉封包、
       或當初就卡在下面幾個 bug 上），客服手動把訂單標成已收款之後，
       這筆的 payment_trade_no 是 null —— 於是 viaGateway 是 false，
       流程直接掉到最下面那行 transitionOrder(refunded)：
       訂單顯示「已退款」、稽核也寫了、但**系統從頭到尾沒有向黑貓 PAY 送出任何指令**，
       客人的錢一毛都沒回去，而且畫面上沒有任何地方看得出來。

       而且 reverseCharge() 根本用不到 trans_id —— 它是用 cust_order_no（= order_no）
       去查、去退的。這個條件沒有帶來任何保護，只有壞處。

    payment_provider 是建單拿到付款網址時就寫的，所以「有沒有走過線上刷卡」
    看它才對。真的沒授權成功的話，reverseCharge() 內部回查會擋下來並回一個
    看得懂的錯誤，不會亂退。
  */
  const viaGateway = order.payment_provider === "blackcat";

  if (viaGateway) {
    if (!canReverseCharge()) {
      return {
        error:
          "這筆是線上刷卡，但系統沒有設定退刷密碼（BLACKCAT_REFUND_PASSWORD），沒辦法自動退款。" +
          "請到黑貓 PAY 後台手動退款，再用下面的「已在後台退過款」按鈕標記。",
      };
    }

    const amount = (order.payment_paid_amount as number | null) ?? (order.total as number);
    const res = await reverseCharge(order.order_no as string, amount);

    if (!res.ok) {
      // 🔴 狀態刻意不動。錢沒退成功就不該顯示成已退款。
      await writeAudit(staff, {
        action: "order.refund_failed",
        entity: "order",
        entityId: orderId,
        summary: `訂單 ${order.order_no} 退款失敗（狀態未變更）：${res.reason}`,
      });
      return {
        error:
          res.reason +
          (res.canRetryLater ? "" : " 若已經在黑貓 PAY 後台手動退過，請改用「已在後台退過款」。"),
      };
    }

    // 錢退掉了，接著改狀態。這一段失敗的話錢已經在路上，客服重按一次就好。
    const out = await transitionOrder(orderId, "refunded");
    await writeAudit(staff, {
      action: res.action === "cancelled" ? "order.auth_cancelled" : "order.refunded_gateway",
      entity: "order",
      entityId: orderId,
      summary: `訂單 ${order.order_no}（${money(amount)}）${res.note}`,
    });
    return out.error ? out : { error: null, ok: res.note };
  }

  // 人工收款的訂單（ATM、LINE 代訂）：本來就沒有金流可以呼叫，
  // 錢要客服自己匯回去。這裡只負責改狀態、放掉工作坊席次。
  return transitionOrder(orderId, "refunded");
}

/**
 * 逃生門：已經在黑貓 PAY 後台手動退過款，只要把訂單標起來。
 *
 * 為什麼一定要有這一顆：跨月不能退（要改開折讓）、部分退款、金流 API 掛掉、
 * 或客服當下就用後台退了 —— 這些情況下上面那顆會一直失敗，沒有這顆的話
 * 訂單就永遠卡在「已付款」，工作坊席次也放不出來。
 *
 * ⚠️ 它的 audit 摘要刻意寫明「系統沒有呼叫金流」，事後對帳才分得出來
 *    哪些是系統退的、哪些是人手動退的。
 */
export async function markRefundedManually(orderId: string): Promise<OrderActionResult> {
  let staff;
  try {
    staff = await requireCapability("orders:write");
  } catch (err) {
    return { error: adminErrorMessage(err) };
  }

  const out = await transitionOrder(orderId, "refunded");
  if (!out.error) {
    await writeAudit(staff, {
      action: "order.refunded_manual",
      entity: "order",
      entityId: orderId,
      summary: "標記為已退款（人工）—— 系統沒有呼叫金流，錢是在黑貓 PAY 後台或其他管道退的。",
    });
  }
  return out;
}

/* ------------------------------------------------------------------ 實作 */

async function transitionOrder(
  orderId: string,
  to: OrderStatus,
): Promise<OrderActionResult> {
  // 1) 授權。放在最前面，讓沒權限的請求連訂單編號都問不到。
  let staff: Staff;
  try {
    staff = await requireCapability("orders:write");
  } catch (err) {
    return { error: adminErrorMessage(err) };
  }

  if (typeof orderId !== "string" || orderId.length === 0) {
    return { error: "缺少訂單編號，請重新整理後再試一次。" };
  }

  let supabase: ReturnType<typeof createServiceClient>;
  try {
    supabase = createServiceClient();
  } catch (err) {
    console.error("[admin/orders] service client 建立失敗", err);
    return { error: "資料庫連線未設定，請聯絡工程師檢查伺服器環境變數。" };
  }

  // 2) 讀現況。這一步只是為了拿到「舊狀態」當作下面的樂觀鎖條件，
  //    以及產生給人看的 audit 訊息；真正的判斷不靠這次讀取的結果。
  const { data: beforeRaw, error: readError } = await supabase
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("id", orderId)
    .maybeSingle();

  if (readError) {
    console.error("[admin/orders] 讀取訂單失敗", orderId, readError.message);
    return { error: "讀取訂單失敗，請重新整理後再試一次。" };
  }
  const before = beforeRaw as OrderRow | null;
  if (!before) {
    return { error: "找不到這筆訂單，可能已經被刪除。請回訂單列表重新整理。" };
  }

  // 3) 白名單。非法轉移在這裡就擋下，不會送出任何寫入。
  const check = checkTransition(before.status, to);
  if (!check.ok) return { error: check.message };

  const from = before.status as OrderStatus;
  const now = new Date().toISOString();

  // paid_at 只在轉成 paid 時寫入——DB 有 orders_paid_at_required_when_paid
  // （status <> 'paid' or paid_at is not null），不寫會被 constraint 擋下。
  // 轉成 cancelled / refunded 時刻意保留原本的 paid_at：
  // 那是「曾經在什麼時候收過錢」的歷史，退款不該把它抹掉。
  const patch: Record<string, unknown> = { status: to, updated_at: now };
  if (to === "paid") patch.paid_at = now;

  // 4) 🔴 條件式 update + returning。冪等就在這一行的 .eq("status", from)。
  const { data: updatedRaw, error: updateError } = await supabase
    .from("orders")
    .update(patch)
    .eq("id", orderId)
    .eq("status", from)
    .select(ORDER_COLUMNS)
    .maybeSingle();

  if (updateError) {
    console.error("[admin/orders] 更新訂單失敗", orderId, updateError.message);
    return { error: "更新訂單狀態失敗，資料沒有被改動。請重試一次。" };
  }

  const updated = updatedRaw as OrderRow | null;
  if (!updated) {
    // 影響 0 列 = 這筆訂單在我們讀取之後被別人改過了。
    // 這正是連按兩下的第二次會走到的分支：不會重複加名額、不會重複寫 audit。
    return { error: "這筆訂單已經處理過了，請重新整理看最新狀態" };
  }

  // 5) 🔴 開通線上課程。刻意排在 syncSeats 前面：
  //    名額沒同步只是「數字要人工對」，課程沒開通是「客人付了錢看不到課」。
  //    後者比較嚴重，所以先做，而且它的警告會蓋過名額的警告（見最後的回傳）。
  //
  //    只在轉成 paid 時做。轉成 refunded 刻意**不撤銷** ——
  //    entitlements 的 PK 是 (user_id, product_id)，權限跨訂單共用，
  //    自動撤銷會誤刪另一筆合法訂單帶來的權限（見 lib/admin/entitlements.ts）。
  const grant =
    to === "paid" ? await grantEntitlementsForOrder(orderId) : null;

  // 6) 名額連動。
  const seatOutcome = await syncSeats(supabase, orderId, seatSignFor(from, to));

  // 7) 稽核。writeAudit 永不 throw，所以不用包 try。
  await writeAudit(staff, {
    action: AUDIT_ACTION[to],
    entity: "order",
    entityId: orderId,
    summary:
      `訂單 ${updated.order_no}（${money(updated.total)}）` +
      `由「${ORDER_STATUS_LABELS[from]}」改為「${ORDER_STATUS_LABELS[to]}」` +
      grantNote(grant) +
      seatOutcome.auditNote,
    diff: {
      ...(diffOf(before, updated, ["status", "paid_at"]) ?? {}),
      ...(seatOutcome.applied.length > 0 ? { seats: seatOutcome.applied } : {}),
      ...(grant
        ? { entitlements: { granted: grant.granted, kept: grant.kept, reason: grant.reason } }
        : {}),
    },
  });

  // 8) 開通通知信。只在真的有新開通課程時寄——重按一次不會再寄一封
  //    （granted 會是 0），dedupe_key 綁 order_id 是第二道保險。
  if (grant?.ok && grant.granted > 0) {
    await queuePaidEmail(supabase, orderId, grant.products);
  }

  /*
    9) 電子發票。

    🔴 轉成 paid 時**不再**自動建立待開立列、也不再試開（2026-10-15 指示：
       先不開發票）。要開的話到訂單頁按「補開發票」，那是人按的。

    轉成 refunded → 作廢發票。這條留著：歷史上已經開出去的發票，退款時還是
       得作廢。
       🔴 沒有發票可作廢時 voidForOrder 會回 nothingToVoid —— **那不是失敗**，
          必須吞掉。不吞的話每一筆退款都會回 { error }，而
          markRefundedManually 的 `if (!out.error)` 就永遠不成立，
          `order.refunded_manual` 那筆稽核會靜默消失。
       ⚠️ 作廢失敗**不擋退款**：訂單狀態已經改完了，這裡再 throw 只會讓客服
          看到一個失敗訊息卻不知道退款到底有沒有成功。失敗的訊息會併進下面的
          警告一起回去。

    整段包在自己的 try：發票是附帶動作，不可以讓它把主要流程弄壞。
  */
  let invoiceNote = "";
  try {
    if (to === "refunded") {
      const voided = await voidForOrder(orderId, "訂單退款");
      if (!voided.ok && !voided.nothingToVoid) {
        invoiceNote = `發票作廢失敗（${voided.reason}），請到 Amego 後台手動處理。`;
        console.error("[orders/transition] 作廢發票失敗", orderId, voided.reason);
      }
    }
  } catch (err) {
    invoiceNote = "發票處理發生例外，請檢查後台紀錄。";
    console.error("[orders/transition] 發票流程例外", orderId, err);
  }

  revalidatePath("/admin/orders");
  revalidatePath(`/admin/orders/${orderId}`);

  // 狀態已經改成功了，但後面有一段沒做完 —— 必須講出來。
  // 這裡回 error 而不是靜默成功：客服看到訊息才會去補，
  // 靜默的話「付了錢看不到課」要等客人打 LINE 來罵才會發現。
  //
  // 順序＝嚴重度。課程沒開通 > 名額沒同步 > 發票作廢失敗：
  // 前兩個客人當下就受影響。發票這一項現在只會在「真的有一張開出去的發票
  // 卻作廢不掉」時出現 —— 沒有發票可作廢已經在上面吞掉了。
  if (grant?.warning) return { error: grant.warning };
  if (seatOutcome.warning) return { error: seatOutcome.warning };
  if (invoiceNote) return { error: invoiceNote };
  return {};
}

/** 開通結果寫進 audit summary 的那一句。沒開通的時候尤其要留痕。 */
function grantNote(grant: GrantResult | null): string {
  if (!grant) return "";
  if (grant.ok) {
    if (grant.granted === 0 && grant.kept === 0) return "";
    return `，開通線上課 ${grant.granted} 門（原本已有 ${grant.kept} 門）`;
  }
  return `，⚠️ 線上課未開通（${grant.reason ?? "unknown"}）`;
}

/**
 * 排「課程開通通知」信。
 *
 * 收件者用 orders.contact_email 而不是帳號的 email：代訂的情況下
 * （子女幫長輩訂）這兩個可能不一樣，而訂單上填的那個才是客人自己看的信箱。
 * worker 的 workshop-reminders.ts 也是同樣的優先序。
 */
async function queuePaidEmail(
  supabase: ReturnType<typeof createServiceClient>,
  orderId: string,
  products: string[],
) {
  if (products.length === 0) return;

  const { data, error } = await supabase
    .from("orders")
    .select("order_no, contact_name, contact_email")
    .eq("id", orderId)
    .maybeSingle();

  if (error || !data?.contact_email) {
    console.error("[admin/orders] 開通信少了收件者", orderId, error?.message);
    return;
  }

  await enqueueEmail({
    dedupeKey: `order_paid:${orderId}`,
    ...orderPaidEmail({
      to: data.contact_email as string,
      name: (data.contact_name as string | null) ?? "同學",
      orderNo: data.order_no as string,
      courseTitles: products,
    }),
  });
  await flushOutbox();
}

/* -------------------------------------------------------------- 名額同步 */

type SeatOutcome = {
  /** 給 audit diff 用的實際結果 */
  applied: { session_id: string; delta: number; seats_taken: number }[];
  /** 附在 audit summary 後面的一句話 */
  auditNote: string;
  /** 有問題時給操作者看的一句話；沒問題是 null */
  warning: string | null;
};

const NO_SEAT_CHANGE: SeatOutcome = { applied: [], auditNote: "", warning: null };

/**
 * 把這筆訂單的工作坊席次加上／還回去。
 *
 * 一律走 admin_adjust_seats RPC：它內部 `for update` 鎖住場次列再 clamp 到
 * [0, capacity]，所以並行的兩筆訂單不會互相蓋掉，也不會撞上
 * workshop_sessions_not_oversold 這個 check constraint（23514）。
 * 自己 update seats_taken 兩件事都做不到。
 *
 * ⚠️ clamp 是雙面刃：場次已經滿了的話，RPC 會「成功」但實際只加了一部分（甚至 0），
 *    而且不回報。所以這裡先把場次的 seats_taken 讀下來，
 *    事後比對 RPC 回傳的新值是不是等於預期，不等就當成需要人工確認。
 */
async function syncSeats(
  supabase: ReturnType<typeof createServiceClient>,
  orderId: string,
  sign: -1 | 0 | 1,
): Promise<SeatOutcome> {
  if (sign === 0) return NO_SEAT_CHANGE;

  const { data: itemsRaw, error: itemsError } = await supabase
    .from("order_items")
    .select("session_id, qty")
    .eq("order_id", orderId)
    .not("session_id", "is", null);

  if (itemsError) {
    console.error("[admin/orders] 讀取品項失敗", orderId, itemsError.message);
    return {
      applied: [],
      auditNote: "，但品項讀取失敗、名額未同步",
      warning:
        "訂單狀態已更新，但讀取品項失敗，工作坊名額沒有同步。請到場次頁人工確認報名人數。",
    };
  }

  const items = (itemsRaw ?? []) as { session_id: string | null; qty: number }[];

  // 同一個場次可能出現在多個品項（購物車分兩行買同一場），先合併再呼叫，
  // 一個場次只打一次 RPC，比對預期值時才有唯一的基準。
  const bySession = new Map<string, number>();
  for (const item of items) {
    if (!item.session_id) continue;
    bySession.set(item.session_id, (bySession.get(item.session_id) ?? 0) + (item.qty ?? 0));
  }
  if (bySession.size === 0) return NO_SEAT_CHANGE;

  const sessionIds = [...bySession.keys()];
  const { data: sessionsRaw } = await supabase
    .from("workshop_sessions")
    .select("id, capacity, seats_taken")
    .in("id", sessionIds);
  const seatsBefore = new Map<string, number>();
  for (const row of (sessionsRaw ?? []) as { id: string; seats_taken: number }[]) {
    seatsBefore.set(row.id, row.seats_taken);
  }

  const applied: SeatOutcome["applied"] = [];
  const failed: string[] = [];
  const clamped: string[] = [];
  let totalDelta = 0;

  for (const [sessionId, qty] of bySession) {
    const delta = sign * qty;
    const { data, error } = await supabase.rpc("admin_adjust_seats", {
      p_session_id: sessionId,
      p_delta: delta,
    });

    if (error) {
      console.error("[admin/orders] 調整名額失敗", sessionId, delta, error.message);
      failed.push(sessionId);
      continue;
    }

    const after = (data as { seats_taken?: number } | null)?.seats_taken;
    if (typeof after === "number") {
      applied.push({ session_id: sessionId, delta, seats_taken: after });
      totalDelta += delta;
      const expected = (seatsBefore.get(sessionId) ?? NaN) + delta;
      if (!Number.isNaN(expected) && after !== expected) clamped.push(sessionId);
    }
  }

  const auditNote =
    applied.length > 0
      ? `，工作坊名額 ${totalDelta >= 0 ? "+" : ""}${totalDelta}`
      : "";

  let warning: string | null = null;
  if (failed.length > 0) {
    warning =
      `訂單狀態已更新，但有 ${failed.length} 個工作坊場次的名額沒有同步成功。` +
      `請到場次頁人工確認報名人數。`;
  } else if (clamped.length > 0) {
    warning =
      `訂單狀態已更新，但有 ${clamped.length} 個場次的名額已達上下限，` +
      `實際加減的人數與這筆訂單不符。請到場次頁人工確認報名人數。`;
  }

  return { applied, auditNote, warning };
}
