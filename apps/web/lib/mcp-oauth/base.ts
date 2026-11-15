import "server-only";
import { headers } from "next/headers";
import { oauthBaseUrl } from "@/lib/mcp-oauth/core";

/**
 * 同意頁／server action 拿不到原始 Request，用 Host 標頭組一個網址交給 oauthBaseUrl()。
 * oauthBaseUrl() 只在 http://localhost／127.0.0.1 時採用它，其他一律回正式站 origin ——
 * 所以偽造 Host 改不了 issuer／resource。
 */
export async function currentOAuthBaseUrl(): Promise<string> {
  try {
    const h = await headers();
    const host = h.get("host") ?? "";
    const proto = (h.get("x-forwarded-proto") ?? "http").split(",")[0].trim();
    return oauthBaseUrl(`${proto}://${host}/`);
  } catch {
    return oauthBaseUrl("");
  }
}
