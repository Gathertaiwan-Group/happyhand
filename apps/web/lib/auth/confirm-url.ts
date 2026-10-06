/**
 * 信件連結的落地網址：剛好是 `<本站網域>/auth/confirm`，**不帶任何 query string**。
 *
 * 2026-10 三站（小時光書店／好日子／快樂手）合併成同一個 Supabase 專案，共用一組 Auth 信件模板：
 *
 *     {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup&next=/account
 *     {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password
 *
 * `RedirectTo` 就是這裡傳給 signUp（emailRedirectTo）／resetPasswordForEmail（redirectTo）的值。
 * 合併前快樂手的模板寫死 `{{ .SiteURL }}/auth/confirm`，但合併後 SiteURL 只有一個（小時光），
 * 所以改成由各站自己帶網域回來。
 *
 * 🔴 不要在這裡加 ?next= 或 ?type=：模板會直接接 `?token_hash=…`，多一個 `?` 整條連結就壞了，
 *    而且 type／next 模板已經依信件種類帶好（/auth/confirm/route.ts 照樣讀得到）。
 */
export function authConfirmUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/auth/confirm`;
}
