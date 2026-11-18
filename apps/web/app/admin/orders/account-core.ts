import "server-only";
import { revalidatePath } from "next/cache";
import type { Staff } from "@/lib/admin/guard";
import { writeAudit } from "@/lib/admin/audit";
import { grantEntitlementsForOrder, revokeEntitlement } from "@/lib/admin/entitlements";
import { findOrCreateUser } from "@/lib/account/provision";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * 「修正訂單 Email 並重新綁定帳號」的本體（後台按鈕與 MCP 的 rebind_order_account 共用）。
 *
 * 原本整段寫在 account-actions.ts 的 rebindOrderAccount 裡，簽章是 useActionState 的
 * (orderId, prev, FormData)。2026-11-18 抽到這裡：
 *   · 後台 action ＝ requireCapability → 從 FormData 取 email → 呼叫這裡。行為一字不變。
 *   · MCP ＝ 在統一的身分包裝裡 requireCapability → 兩步確認 → 呼叫這裡。
 *
 * 🔴 這個檔**不是** "use server"：那個指示會把 export 的 async 函式變成瀏覽器可以直接
 *    POST 的端點，而這裡的函式不檢查權限（權限由呼叫端拿 Staff 進來）。
 *
 * 預覽（previewRebind）只讀不寫，條件跟 rebindOrderAccountCore 逐步對照。
 */

export type RebindResult = { error?: string | null; ok?: string | null };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 要綁的 Email：有填就用填的，沒填就用訂單原本的 contact_email。與後台原本的判斷相同。 */
export function resolveRebindEmail(
  typed: string,
  currentContactEmail: string | null | undefined,
): { email: string } | { error: string } {
  const t = String(typed ?? "").trim().toLowerCase();
  const nextEmail = t || String(currentContactEmail ?? "").trim().toLowerCase();
  if (!nextEmail) return { error: "這筆訂單沒有 Email，請先填一個才能綁定帳號。" };
  if (!EMAIL_RE.test(nextEmail)) return { error: "Email 格式看起來不太對，請再檢查一次。" };
  return { email: nextEmail };
}

/**
 * 修正訂單 Email 並重新綁定帳號。
 *
 * typedEmail 傳空字串代表「不改 Email，只是用現有的 contact_email 再綁一次」
 * （下單當時 Admin API 逾時的情況）。
 */
export async function rebindOrderAccountCore(
  staff: Staff,
  orderId: string,
  typedEmail: string,
): Promise<RebindResult> {
  const supabase = createServiceClient();

  const { data: order, error: readError } = await supabase
    .from("orders")
    .select("id, order_no, status, user_id, contact_email, contact_name")
    .eq("id", orderId)
    .maybeSingle();

  if (readError || !order) {
    return { error: "找不到這筆訂單，請重新整理後再試。" };
  }

  const resolved = resolveRebindEmail(typedEmail, order.contact_email as string | null);
  if ("error" in resolved) return { error: resolved.error };
  const nextEmail = resolved.email;

  const provisioned = await findOrCreateUser(
    nextEmail,
    String(order.contact_name ?? ""),
  );
  if (!provisioned) {
    return {
      error: "建立或查詢帳號失敗，訂單沒有被改動。請稍後再試一次；持續失敗請截圖回報。",
    };
  }

  const previousUserId = order.user_id as string | null;

  // 換帳號時要把已開通的課一起搬過去，否則客人登入新帳號還是看不到課。
  // 先撤舊的再重發：entitlements 的 PK 是 (user_id, product_id)，
  // 不撤的話舊帳號會永遠留著一份可以看的權限。
  const movedFrom =
    previousUserId && previousUserId !== provisioned.userId ? previousUserId : null;

  if (movedFrom) {
    const { data: old } = await supabase
      .from("entitlements")
      .select("product_id")
      .eq("user_id", movedFrom)
      .eq("order_id", orderId);
    for (const row of old ?? []) {
      await revokeEntitlement(movedFrom, row.product_id as string);
    }
  }

  const { error: updateError } = await supabase
    .from("orders")
    .update({
      user_id: provisioned.userId,
      contact_email: nextEmail,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId);

  if (updateError) {
    console.error("[admin/orders] 綁定帳號失敗", orderId, updateError.message);
    return { error: "更新訂單失敗，資料沒有被改動。請重試一次。" };
  }

  // 已付款的訂單順手開通，客服不用再按第二顆按鈕
  const grant =
    order.status === "paid" ? await grantEntitlementsForOrder(orderId) : null;

  await writeAudit(staff, {
    action: "order.rebind_account",
    entity: "order",
    entityId: orderId,
    summary:
      `訂單 ${order.order_no} 綁定會員帳號 ${nextEmail}` +
      (movedFrom ? "（從另一個帳號搬移）" : "") +
      (grant?.ok ? `，開通線上課 ${grant.granted} 門` : ""),
    diff: {
      contact_email: { from: order.contact_email, to: nextEmail },
      user_id: { from: previousUserId, to: provisioned.userId },
    },
  });

  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/orders");

  if (grant && !grant.ok) return { error: grant.warning };
  return {
    ok:
      `已綁定 ${nextEmail}` +
      (grant?.ok ? `，並開通了 ${grant.granted} 門課。` : "。") +
      (provisioned.created ? "這是新建立的帳號，記得按「重寄設定密碼信」。" : ""),
  };
}

/* ================================================================ 預覽 */

type Db = ReturnType<typeof createServiceClient>;

export type RebindPreview =
  | {
      ok: true;
      orderId: string;
      email: string;
      /** 兩步確認的狀態指紋：任何一項變了，第一步拿到的 confirm_token 就失效 */
      state: string;
      preview: {
        order_no: string;
        order_status: string;
        email_from: string | null;
        email_to: string;
        email_changes: boolean;
        new_email_has_account: boolean;
        account_changes: boolean;
        courses_to_move: string[];
        will_grant_courses: boolean;
        summary: string;
      };
    }
  | { ok: false; error: string };

/**
 * rebind 的預覽：只讀，條件與 rebindOrderAccountCore 逐步對照。
 *
 *   · Email 的決定與驗證 → 同一支 resolveRebindEmail()
 *   · 新信箱有沒有帳號 → 同一支 RPC find_auth_user_id（findOrCreateUser 的第一步），**不建帳號**
 *   · 會搬哪幾門課 → 同一條查詢（舊帳號 + 這張訂單的 entitlements）
 *   · 會不會開通 → 同一個條件（訂單 status === "paid"）
 *
 * 狀態指紋含 orders.updated_at：執行一次一定會寫 updated_at，所以同一個 token 用過一次
 * 指紋就對不上 —— 不開新表也做得到「只能用一次」。
 */
export async function previewRebind(db: Db, orderId: string, typedEmail: string): Promise<RebindPreview> {
  const { data: order, error: readError } = await db
    .from("orders")
    .select("id, order_no, status, user_id, contact_email, updated_at")
    .eq("id", orderId)
    .maybeSingle();
  if (readError) throw new Error(`[account-core] 讀取訂單失敗：${readError.message}`);
  if (!order) return { ok: false, error: "找不到這筆訂單。" };
  const o = order as {
    id: string;
    order_no: string;
    status: string;
    user_id: string | null;
    contact_email: string | null;
    updated_at: string;
  };

  const resolved = resolveRebindEmail(typedEmail, o.contact_email);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const email = resolved.email;

  const { data: existingId, error: findError } = await db.rpc("find_auth_user_id", { p_email: email });
  if (findError) throw new Error(`[account-core] 查帳號失敗：${findError.message}`);
  const targetUserId = typeof existingId === "string" && existingId ? existingId : null;

  const currentEmail = String(o.contact_email ?? "").trim().toLowerCase();
  const emailChanges = currentEmail !== email;
  // 新信箱沒有帳號 → 執行時會新建一個，一定不是現在綁的那個。
  const accountChanges = !o.user_id || targetUserId === null || o.user_id !== targetUserId;
  const moving = Boolean(o.user_id) && accountChanges;

  if (!emailChanges && !accountChanges) {
    return {
      ok: false,
      error: `新信箱跟這筆訂單目前的信箱一樣（${email}），而且已經綁在這個信箱的帳號上，不需要重綁。要補開課請用 regrant_entitlements。`,
    };
  }

  let moved: { product_id: string; title: string }[] = [];
  if (moving) {
    const { data, error } = await db
      .from("entitlements")
      .select("product_id, products(title)")
      .eq("user_id", o.user_id as string)
      .eq("order_id", o.id);
    if (error) throw new Error(`[account-core] 讀取開通紀錄失敗：${error.message}`);
    moved = ((data ?? []) as { product_id: string; products: { title: string | null } | { title: string | null }[] | null }[])
      .map((row) => {
        const p = Array.isArray(row.products) ? row.products[0] : row.products;
        return { product_id: row.product_id, title: p?.title ?? "（商品已刪除）" };
      })
      .sort((a, b) => (a.product_id < b.product_id ? -1 : 1));
  }

  const willGrant = o.status === "paid";
  const lines = [
    `訂單 ${o.order_no}：Email ${o.contact_email ?? "（未填）"} → ${email}。`,
    targetUserId
      ? "新信箱已經有會員帳號，會把訂單綁到那個帳號。"
      : "新信箱還沒有會員帳號，執行時會新建一個（之後記得用 resend_setup_email 寄設定密碼信）。",
    moving
      ? moved.length
        ? `會把已開通的 ${moved.length} 門課從原本的帳號搬到新帳號：${moved.map((m) => `「${m.title}」`).join("、")}。原帳號會看不到這些課。`
        : "原本的帳號這張訂單沒有已開通的課，沒有課要搬。"
      : "這張訂單原本沒有綁帳號，沒有課要搬。",
    willGrant ? "訂單已收款，綁定後會依品項開通線上課（已開通的不會重複）。" : "訂單還沒收款，不會開通課程。",
  ];

  const state = JSON.stringify({
    contact_email: o.contact_email,
    user_id: o.user_id,
    status: o.status,
    updated_at: o.updated_at,
    target: targetUserId ?? "none",
    moved: moved.map((m) => m.product_id),
  });

  return {
    ok: true,
    orderId: o.id,
    email,
    state,
    preview: {
      order_no: o.order_no,
      order_status: o.status,
      email_from: o.contact_email,
      email_to: email,
      email_changes: emailChanges,
      new_email_has_account: targetUserId !== null,
      account_changes: accountChanges,
      courses_to_move: moved.map((m) => m.title),
      will_grant_courses: willGrant,
      summary: lines.join(""),
    },
  };
}
