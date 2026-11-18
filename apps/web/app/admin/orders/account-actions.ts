"use server";

import { revalidatePath } from "next/cache";
import { requireCapability, adminErrorMessage } from "@/lib/admin/guard";
import { writeAudit } from "@/lib/admin/audit";
import {
  grantEntitlementsForOrder,
  revokeEntitlement,
} from "@/lib/admin/entitlements";
import { generateSetupLink } from "@/lib/account/provision";
import { enqueueEmail, flushOutbox } from "@/lib/email/outbox";
import { accountSetupEmail, orderPaidEmail } from "@/lib/email/templates";
import { createServiceClient } from "@/lib/supabase/server";
import { rebindOrderAccountCore } from "./account-core";

/**
 * 訂單的「會員帳號與課程開通」補救動作。
 *
 * 這些按鈕存在的理由：自動綁定會失敗，而且失敗方式都很無聊 ——
 * 客人把 gmail.com 打成 gmial.com、下單當下 Admin API 逾時、
 * 或這是改版前留下的歷史訂單。沒有補救 UI 的話，這些人就是「付了錢看不到課」，
 * 而客服除了叫工程師下 SQL 之外什麼都做不了。
 *
 * ⚠️ 每一支都自己 requireCapability("orders:write") ——
 *    layout 守衛管不到 server action 的 POST。
 * ⚠️ 每一支都寫 audit：這些動作會改變「誰能看哪門課」，出事時要查得到是誰按的。
 */

export type AccountActionResult = { error?: string | null; ok?: string | null };

/* ------------------------------------------------------- 綁定 / 修正 Email */

/**
 * 修正訂單 Email 並重新綁定帳號。
 *
 * 傳空字串代表「不改 Email，只是用現有的 contact_email 再綁一次」
 * （下單當時 Admin API 逾時的情況）。
 *
 * 本體在 ./account-core.ts（MCP 的 rebind_order_account 共用同一支），這裡只做
 * 權限檢查與 FormData 轉換。
 */
export async function rebindOrderAccount(
  orderId: string,
  _prev: AccountActionResult,
  formData: FormData,
): Promise<AccountActionResult> {
  let staff;
  try {
    staff = await requireCapability("orders:write");
  } catch (err) {
    return { error: adminErrorMessage(err) };
  }

  return rebindOrderAccountCore(staff, orderId, String(formData.get("email") ?? ""));
}

/* --------------------------------------------------------------- 重新開通 */

export async function regrantEntitlements(
  orderId: string,
): Promise<AccountActionResult> {
  let staff;
  try {
    staff = await requireCapability("orders:write");
  } catch (err) {
    return { error: adminErrorMessage(err) };
  }

  const grant = await grantEntitlementsForOrder(orderId);

  await writeAudit(staff, {
    action: "order.regrant",
    entity: "order",
    entityId: orderId,
    summary: grant.ok
      ? `手動重新開通：新開通 ${grant.granted} 門，原本已有 ${grant.kept} 門`
      : `手動重新開通失敗：${grant.reason ?? "unknown"}`,
    diff: { granted: grant.granted, kept: grant.kept, reason: grant.reason },
  });

  revalidatePath(`/admin/orders/${orderId}`);

  if (!grant.ok) return { error: grant.warning };
  if (grant.granted > 0) {
    await queuePaidNotice(orderId, grant.products);
    return { ok: `開通了 ${grant.granted} 門課，也寄了開通通知信。` };
  }
  return { ok: `這筆訂單的課本來就都開通了（共 ${grant.kept} 門），沒有變動。` };
}

/**
 * 金額未核對的訂單：先把旗標改掉（留 audit），再開通。
 *
 * 分成兩步而不是直接在 RPC 裡放行，是因為「誰決定這個金額沒問題」必須查得到。
 * 按鈕文字寫的是「我已核對金額無誤」——那句話要有人負責。
 */
export async function forceGrantEntitlements(
  orderId: string,
): Promise<AccountActionResult> {
  let staff;
  try {
    staff = await requireCapability("orders:write");
  } catch (err) {
    return { error: adminErrorMessage(err) };
  }

  const supabase = createServiceClient();
  const { data: updated, error } = await supabase
    .from("orders")
    .update({ price_unverified: false, updated_at: new Date().toISOString() })
    .eq("id", orderId)
    .eq("price_unverified", true)
    .select("order_no, total")
    .maybeSingle();

  if (error) {
    console.error("[admin/orders] 解除金額旗標失敗", orderId, error.message);
    return { error: "更新失敗，資料沒有被改動。請重試一次。" };
  }
  if (!updated) {
    return { error: "這筆訂單的金額旗標已經解除過了，請直接按「重新開通」。" };
  }

  await writeAudit(staff, {
    action: "order.confirm_price",
    entity: "order",
    entityId: orderId,
    summary: `人工核對金額無誤（${updated.total} 元），解除 price_unverified 並開通課程`,
    diff: { price_unverified: { from: true, to: false } },
  });

  return regrantEntitlements(orderId);
}

/* ----------------------------------------------------- 重寄設定密碼信 */

export async function resendSetupEmail(
  orderId: string,
): Promise<AccountActionResult> {
  let staff;
  try {
    staff = await requireCapability("orders:write");
  } catch (err) {
    return { error: adminErrorMessage(err) };
  }

  const supabase = createServiceClient();
  const { data: order } = await supabase
    .from("orders")
    .select("order_no, contact_email, contact_name, user_id, created_at")
    .eq("id", orderId)
    .maybeSingle();

  if (!order?.contact_email || !order.user_id) {
    return { error: "這筆訂單還沒有綁定帳號，請先按「綁定並開通」。" };
  }

  const link = await generateSetupLink(order.contact_email as string);
  if (!link) {
    return { error: "產生設定密碼連結失敗，請稍後再試一次。" };
  }

  // ⚠️ 這裡的 dedupe_key 刻意帶時間戳，跟自動寄那封（account_setup:<user_id>）
  //    不同。自動那封一輩子只寄一次是防濫用；這一顆是客服在客人要求下手動按的，
  //    要真的寄得出去，否則「我沒收到信」就無解了。
  //    濫用風險由 orders:write 這個能力本身控制（只有員工按得到）。
  const stamp = Math.floor(Date.now() / 1000);
  // 🔴 排不進 outbox 就是沒寄。以前不看回傳值，排入失敗也回「已重寄」。
  //    MCP 的重寄冷卻也是讀這一列（lib/admin/mcp-requests.ts），兩邊要一致。
  const queued = await enqueueEmail({
    dedupeKey: `account_setup_manual:${order.user_id}:${stamp}`,
    ...accountSetupEmail({
      to: order.contact_email as string,
      name: (order.contact_name as string | null) ?? "同學",
      link,
      orderNo: order.order_no as string,
      orderDate: new Intl.DateTimeFormat("zh-TW", {
        timeZone: "Asia/Taipei",
        month: "long",
        day: "numeric",
      }).format(new Date(order.created_at as string)),
    }),
  });
  if (!queued) {
    return {
      error: "這封信沒有排進寄送佇列（可能一秒內重複送出，或資料庫寫入失敗），沒有寄出。請稍後再試一次。",
    };
  }
  await flushOutbox();

  await writeAudit(staff, {
    action: "order.resend_setup_email",
    entity: "order",
    entityId: orderId,
    summary: `重寄設定密碼信到 ${order.contact_email}`,
  });

  revalidatePath(`/admin/orders/${orderId}`);
  return {
    ok: `已重寄到 ${order.contact_email}。提醒客人：連結一小時內有效，而且只能用一次。`,
  };
}

/* ------------------------------------------------------------- 撤銷權限 */

export async function revokeCourseAccess(
  orderId: string,
  userId: string,
  productId: string,
): Promise<AccountActionResult> {
  let staff;
  try {
    staff = await requireCapability("orders:write");
  } catch (err) {
    return { error: adminErrorMessage(err) };
  }

  const supabase = createServiceClient();
  const { data: product } = await supabase
    .from("products")
    .select("title")
    .eq("id", productId)
    .maybeSingle();

  const removed = await revokeEntitlement(userId, productId);

  await writeAudit(staff, {
    action: "entitlement.revoke",
    entity: "order",
    entityId: orderId,
    summary: removed
      ? `關閉「${product?.title ?? productId}」的觀看權限`
      : `嘗試關閉「${product?.title ?? productId}」的觀看權限，但那筆權限已經不存在`,
    diff: { user_id: userId, product_id: productId },
  });

  revalidatePath(`/admin/orders/${orderId}`);
  return removed
    ? { ok: `已關閉「${product?.title ?? "這門課"}」的觀看權限。` }
    : { error: "那筆權限已經不存在了，可能剛剛被別人關掉。" };
}

/* -------------------------------------------------------------------- */

async function queuePaidNotice(orderId: string, products: string[]) {
  if (products.length === 0) return;
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("orders")
    .select("order_no, contact_name, contact_email")
    .eq("id", orderId)
    .maybeSingle();
  if (!data?.contact_email) return;

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
