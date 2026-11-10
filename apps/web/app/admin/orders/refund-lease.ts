import "server-only";

/**
 * 退款（呼叫黑貓 PAY 退刷）前的互斥鎖 —— 防止同一筆訂單被同時送出兩次退刷。
 *
 * ## 攻擊／事故情境（2026-11-10 資安審查）
 *
 * refundOrder 原本是「讀 status='paid' → 呼叫金流退刷 → 成功後才改狀態」。
 * 兩個同時進來的請求（客服連按兩下、兩個人同時按、或 MCP 的確認連結被分享後
 * 兩個人同時按確認）都會讀到 paid、都通過檢查、都呼叫 reverseCharge ——
 * 黑貓 PAY 收到兩次退刷指令。transitionOrder 的條件式 update 擋得住「改兩次狀態」，
 * 但它在退刷**之後**才跑，擋不住錢。
 *
 * ## 為什麼是 orders.updated_at，而不是新欄位／新表／RPC
 *
 * 合併資料庫沒有 DDL 權限。email_outbox 的 unique dedupe_key 不能借（列會被排程
 * 當成信寄出去）。orders.updated_at 是既有欄位，每一次寫入訂單都會更新它
 * （程式顯式寫入，DB 的 trg_orders_updated_at 也會蓋成 now()）。
 *
 * ## 怎麼用一個時間戳做出「租約鎖」
 *
 *   搶鎖 = update orders set updated_at = <現在>
 *          where id = ? and status = 'paid' and updated_at = <剛讀到的值>
 *          returning id
 *
 * 1. **原子性**：Postgres 對同一列的 UPDATE 會排隊（row lock）。後到的交易在前一個
 *    commit 後會重新評估 where（READ COMMITTED 的 EvalPlanQual），此時 updated_at
 *    已經不是它讀到的值 → 影響 0 列。所以「讀到同一個版本」的 N 個請求只有一個
 *    拿得到那一列。
 * 2. **在鎖期間晚到的請求**：它讀到的是剛被搶鎖改過的新 updated_at，光靠 CAS 會讓它
 *    也成功。所以多一條規則 —— 讀到的 updated_at 若在 REFUND_LEASE_MS 內，視為
 *    「有人正在處理」直接拒絕，不送出任何寫入。兩條合起來：任兩次成功搶鎖之間
 *    至少隔 REFUND_LEASE_MS。
 * 3. **釋放**：不需要、也做不到（trigger 會把 updated_at 蓋成 now()，不能改回去）。
 *    鎖是租約，到期自動失效 —— 不會有「永久卡住」的狀態，即使函式在退刷中途被殺掉。
 *    - 退刷成功 → transitionOrder 改成 refunded，之後 status 條件就擋住了。
 *    - 退刷失敗 → 狀態仍是 paid，REFUND_LEASE_MS 後可以再按；或直接用
 *      「已在後台退過款」（markRefundedManually 不呼叫金流，不受這把鎖限制）。
 *
 * ## 租約長度
 *
 * 必須長於「持鎖的那次請求最久能活多久」，否則它還在跟金流講話時鎖就過期了。
 * reverseCharge 的每次 HTTP 呼叫都有 20 秒 AbortSignal，最多約 4 次（Token、查詢、
 * 退刷），約 80 秒；Vercel 函式預設上限 300 秒（/api/mcp 的 maxDuration 也是 300）。
 * 取 6 分鐘 = 函式能存活的上限再加 1 分鐘，吸收 DB 與函式機器的時鐘誤差。
 *
 * 副作用：訂單在 6 分鐘內被改過（剛收款、剛開發票…）也會被擋，訊息會講清楚
 * 幾分鐘後再試。這是刻意的取捨：寧可晚幾分鐘退，不要退兩次。
 *
 * ⚠️ 不涵蓋 markRefundedManually（「已在後台退過款」）：它不呼叫金流，
 *    是退刷失敗時的逃生門，加鎖會讓客服在失敗後還得等。人工在黑貓後台退款
 *    與系統退刷同時發生的競態，屬於操作流程問題，不在這把鎖的範圍。
 */

export const REFUND_LEASE_MS = 6 * 60 * 1000;

/** 未來時間（DB 與函式機器的時鐘誤差）一律視為「剛改過」。 */
export type LeaseCheck = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * 讀到的 updated_at 是否已經「夠舊」，可以嘗試搶鎖。
 * 解析不出來 → 拒絕（fail closed，寧可讓客服改用人工退款按鈕）。
 */
export function leaseAvailable(seenUpdatedAt: string | null | undefined, nowMs: number): LeaseCheck {
  const seen = typeof seenUpdatedAt === "string" ? Date.parse(seenUpdatedAt) : Number.NaN;
  if (!Number.isFinite(seen)) return { ok: false, retryAfterMs: REFUND_LEASE_MS };
  const age = nowMs - seen;
  if (age < REFUND_LEASE_MS) return { ok: false, retryAfterMs: REFUND_LEASE_MS - Math.max(age, 0) };
  return { ok: true };
}

/** 只用到 supabase-js 的這一小段，測試時可以換成假的。 */
export type LeaseDb = {
  from(table: "orders"): {
    update(patch: { updated_at: string }): {
      eq(col: "id", v: string): {
        eq(col: "status", v: "paid"): {
          eq(col: "updated_at", v: string): {
            select(cols: "id"): {
              maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }>;
            };
          };
        };
      };
    };
  };
};

export type ClaimResult = { ok: true } | { ok: false; error: string };

function minutesText(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 60000))} 分鐘`;
}

/**
 * 搶退款鎖。只有回 ok:true 的那一個請求可以呼叫金流退刷。
 *
 * @param seenUpdatedAt 呼叫端剛剛讀訂單時拿到的 updated_at（原字串，不要轉換格式）
 */
export async function claimRefundLease(
  db: LeaseDb,
  orderId: string,
  seenUpdatedAt: string | null | undefined,
  nowMs: number = Date.now(),
): Promise<ClaimResult> {
  const lease = leaseAvailable(seenUpdatedAt, nowMs);
  if (!lease.ok) {
    return {
      ok: false,
      error:
        "這筆訂單剛剛被更新過，可能已經有人在處理退款。為了避免重複退刷，" +
        `請約 ${minutesText(lease.retryAfterMs)}後重新整理、確認狀態再試。` +
        "若確定已在黑貓 PAY 後台手動退過，請改用「已在後台退過款」。",
    };
  }

  const { data, error } = await db
    .from("orders")
    .update({ updated_at: new Date(nowMs).toISOString() })
    .eq("id", orderId)
    .eq("status", "paid")
    .eq("updated_at", seenUpdatedAt as string)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[admin/orders] 退款鎖寫入失敗", orderId, error.message);
    return { ok: false, error: "無法鎖定這筆訂單，沒有送出退款。請重新整理後再試一次。" };
  }
  if (!data) {
    // 影響 0 列 = 讀取之後被別人改過（另一個退款請求搶先了，或狀態變了）
    return {
      ok: false,
      error: "這筆訂單已經有人在處理退款（或剛被改過），這次沒有送出退刷。請重新整理看最新狀態。",
    };
  }
  return { ok: true };
}
