import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { DB_SCHEMA } from "./schema";

export function hasSupabaseEnv() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

/** 一般讀取／使用者身分（受 RLS 保護） */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: { schema: DB_SCHEMA },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Component 內無法寫 cookie，交給 middleware 處理
          }
        },
      },
    },
  );
}

/**
 * 公開目錄專用：anon key + 不讀 cookie。
 *
 * 為什麼要跟 createClient() 分開：後者呼叫 next/headers 的 cookies()，
 * 那會讓整個頁面被迫變成 per-request 動態渲染。首頁只是要列課程，
 * 不需要知道你是誰 —— 用這支就能維持靜態 + ISR，後台寫入時再靠
 * revalidatePath() 打掉快取。
 *
 * 安全性上沒有放寬任何東西：沒有 cookie 就是 anon 角色，
 * products_select_published 這條 policy 照樣生效，只看得到已發布的商品。
 */
export function createPublicClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { db: { schema: DB_SCHEMA }, cookies: { getAll: () => [], setAll: () => {} } },
  );
}

/**
 * service role：只能在 Route Handler / Server Action 使用，
 * 絕不可以出現在 client bundle（README §3 RLS 要點）。
 */
export function createServiceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("缺少 SUPABASE_SERVICE_ROLE_KEY");
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    key,
    {
      db: { schema: DB_SCHEMA },
      cookies: { getAll: () => [], setAll: () => {} },
    },
  );
}
