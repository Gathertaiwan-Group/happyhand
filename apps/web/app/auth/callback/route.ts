import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeRedirect } from "@/lib/auth/safe-redirect";

/**
 * Supabase 驗證連結的落地點。
 *
 * 信箱驗證信、重設密碼信、magic link 都會把使用者導回這裡並帶 ?code=…，
 * 必須用這個 code 換成 session cookie。沒有這支的話，員工點完驗證信會落在
 * 首頁、看起來什麼都沒發生，得再自己回登入頁輸入一次密碼。
 *
 * next 參數只允許站內相對路徑，理由見 lib/auth/safe-redirect.ts：
 * 不擋的話這裡會變成開放轉址。
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  // 只允許站內路徑，不擋會變成開放轉址，見 lib/auth/safe-redirect.ts。
  const next = safeRedirect(searchParams.get("next"), "/account");

  // Supabase 在連結失效或被用過時會帶 error 回來，直接把原因轉給登入頁顯示
  const errorDescription = searchParams.get("error_description");
  if (errorDescription) {
    const url = new URL("/login", origin);
    url.searchParams.set("error", errorDescription);
    return NextResponse.redirect(url);
  }

  if (!code) {
    return NextResponse.redirect(new URL("/login", origin));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const url = new URL("/login", origin);
    url.searchParams.set(
      "error",
      "這個連結已經失效或被使用過了，請重新登入或再要一次驗證信",
    );
    return NextResponse.redirect(url);
  }

  // 認領用同一個信箱下的訪客訂單。
  //
  // 這一段是「用 Google／LINE 登入後看得到之前買的課」真的成立的地方：
  // 訂單的 user_id 是下單當下寫進去的，如果那時候 Admin API 逾時、
  // 或客人是後來才註冊的，那筆訂單就還掛著 null。
  // /account 的 layout 也會跑一次，這裡先跑是為了讓第一次登入的人
  // 一進去就看得到東西，而不是先看到空白再重整。
  //
  // 失敗不擋登入：人已經驗證過了，把他擋在門外沒有任何好處。
  const { error: claimError } = await supabase.rpc("claim_guest_orders");
  if (claimError) {
    console.error("[auth/callback] claim_guest_orders 失敗", claimError.message);
  }

  return NextResponse.redirect(new URL(next, origin));
}
