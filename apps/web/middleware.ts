import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { DB_SCHEMA } from "@/lib/supabase/schema";

/**
 * Supabase session 自動刷新 + 未登入導轉。
 *
 * 這是計畫裡的「第 1 層」，刻意只做兩件事：刷新 session cookie、把未登入的人
 * 導去登入頁。**不查資料庫、不判斷角色**——middleware 每個匹配到的請求都會跑，
 * 多一次 profiles 查詢就是每頁多一次網路往返。
 * 真正的授權在 app/admin/layout.tsx（第 2 層）與每支 server action 的
 * requireCapability()（第 3 層）。
 *
 * 改寫自 goodday/web/src/middleware.ts，砍掉全部 /en i18n rewrite 邏輯
 * （快樂手是純中文站），並把 matcher 從 catch-all 收窄成只有需要登入的路徑——
 * 原本那條 catch-all 讓幾乎每個請求都跑一次 getUser()。
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  let response = NextResponse.next({ request: { headers: request.headers } });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    // 目前這裡只呼叫 auth.getUser()，schema 用不到；先帶上是為了以後有人在 middleware 讀表時，
    // 不會靜默讀到小時光的同名表。
    db: { schema: DB_SCHEMA },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // 先寫回 request，讓同一次請求後續讀得到刷新後的 cookie，
        // 再重建 response 並把 Set-Cookie 帶上去。順序不能顛倒。
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        response = NextResponse.next({ request: { headers: request.headers } });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) return response;

  // /api/admin/* 是給 fetch 用的，導轉到 HTML 登入頁會讓前端拿到一坨 HTML
  // 卻以為是 JSON。這裡直接回 401。
  if (pathname.startsWith("/api/admin")) {
    return NextResponse.json({ error: "請先登入" }, { status: 401 });
  }

  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  // 只帶 pathname，不帶原本的 query string——query 可能含有訂單編號之類的東西，
  // 沒必要出現在登入頁的網址列。
  login.searchParams.set("redirect", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/admin/:path*", "/account/:path*", "/api/admin/:path*"],
};
