import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { safeRedirect } from "@/lib/auth/safe-redirect";

/**
 * GET /auth/confirm — 信件連結的落地點（token_hash + verifyOtp）
 *
 * 🔴 為什麼不能沿用 /auth/callback：
 *
 * /auth/callback 吃的是 `?code=`，走 PKCE。而 PKCE 的 code_verifier
 * **存在發起請求的那個瀏覽器**裡。對 60–75 歲客群，最典型的行為是：
 *
 *   在手機 Safari 按「忘記密碼」→ 打開 Gmail App → 點信裡的連結
 *   → Gmail 用它自己的內建瀏覽器開 → 那裡沒有 code_verifier → 失敗
 *
 * 而 /auth/callback 遇到這種情況會顯示「這個連結已經失效或被使用過了」——
 * **訊息本身是錯的**（連結沒失效，是瀏覽器換了），會把客服帶往錯誤方向查。
 *
 * verifyOtp 不需要 code_verifier，任何瀏覽器打開都能換到 session。
 * 所以規則是：
 *   ?code=       → /auth/callback（OAuth 專用，那一定是使用者自己按的按鈕）
 *   ?token_hash= → 這一支（信件連結：驗證信、重設密碼、magic link）
 *
 * 另外，auth.admin.generateLink() 產生的連結**本來就不走 PKCE**
 * （回的是 hashed token），所以「設定密碼」那條路無論如何都得用這一支。
 */

/** Supabase 認得的信件類型。認不得的一律當作壞連結，不要硬送給 verifyOtp。 */
const VALID_TYPES = new Set<EmailOtpType>([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const rawType = searchParams.get("type");
  // 只允許站內路徑，不擋會變成開放轉址，見 lib/auth/safe-redirect.ts。
  const next = safeRedirect(searchParams.get("next"), "/account");

  const type = VALID_TYPES.has(rawType as EmailOtpType)
    ? (rawType as EmailOtpType)
    : null;

  if (!tokenHash || !type) {
    return NextResponse.redirect(new URL("/auth/link-expired", origin));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

  if (error) {
    // 導到專屬的中文說明頁，不是 /login?error=。
    // 長輩看到登入頁配一句紅字錯誤，第一個反應是「我是不是打錯密碼」。
    console.error("[auth/confirm] verifyOtp 失敗", type, error.message);
    return NextResponse.redirect(new URL("/auth/link-expired", origin));
  }

  // 認領用同一個信箱下的訪客訂單。這一步只有在 email 已驗證時才會做事
  // （RPC 內部檢查 email_confirmed_at），而走到這裡就代表剛驗證過。
  const { error: claimError } = await supabase.rpc("claim_guest_orders");
  if (claimError) {
    console.error("[auth/confirm] claim_guest_orders 失敗", claimError.message);
  }

  return NextResponse.redirect(new URL(next, origin));
}
