import { SITE } from "@/lib/site";

/**
 * 登入後／點完信件連結後要跳去哪裡——全站唯一一支判斷函式。
 *
 * 用在：
 *   - app/(storefront)/login/_components/login-form.tsx 的 ?redirect=（router.push）
 *   - app/auth/confirm/route.ts、app/auth/callback/route.ts 的 ?next=（NextResponse.redirect）
 * 新增任何「登入後跳轉」的地方一律呼叫這支，不要再各寫各的字串檢查。
 *
 * 🔴 為什麼不能只檢查「/ 開頭、不是 // 開頭」（舊寫法）：
 * 瀏覽器、router.push、new URL() 都照 WHATWG URL 規則解析，對 http(s) 網址而言
 * `\` 等同 `/`，tab／換行會被直接刪掉。所以這些值都會通過舊檢查、最後卻跳到外站：
 *
 *     /\evil.com        → https://evil.com/
 *     /\/evil.com       → https://evil.com/
 *     /<tab>/evil.com   → https://evil.com/   （網址裡寫 %09 就會解碼成 tab）
 *
 * 攻擊情境：寄一封「請確認這筆退款」的信，連結是我們自己網域的
 * /login?redirect=/%5Cevil.com，管理員登入成功後就被送到長得一模一樣的假後台。
 *
 * 所以改成：用跟瀏覽器一樣的解析器把它解析成絕對網址，origin 必須是本站，
 * 只取 pathname + search + hash 回傳；解析失敗、origin 不同一律退回預設頁。
 * 另外擋 pathname 以 // 開頭（例如 `/.//evil.com` 正規化後會變成 `//evil.com`），
 * 這種值回傳出去之後會再被當成 protocol-relative 網址。
 */
export function safeRedirect(
  raw: string | null | undefined,
  fallback = "/account",
): string {
  if (!raw) return fallback;

  let base: URL;
  let url: URL;
  try {
    base = new URL(SITE.url);
    url = new URL(raw, base);
  } catch {
    return fallback;
  }

  if (url.origin !== base.origin) return fallback;
  if (!url.pathname.startsWith("/") || url.pathname.startsWith("//")) {
    return fallback;
  }

  return `${url.pathname}${url.search}${url.hash}`;
}
