/**
 * Supabase service role client。
 *
 * ⚠️ service role key 會繞過所有 RLS。這個 client 只能在 worker process 內使用，
 * 任何回傳到外部的資料都要自己過濾。
 *
 * 這裡刻意不帶 Database 泛型：`supabase/migrations/` 由另一位負責，
 * 型別檔（supabase gen types）還沒產出。所有查詢集中在 db.ts，
 * 由該處明確標註回傳型別，job 端就拿得到具名型別而不是 any。
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { WorkerEnv } from "./env.js";

/** 合併後快樂手的表住在 happyhands schema；與 apps/web/lib/supabase/schema.ts 同一個值。
 *  worker 與 web 沒有共用 package，所以這裡各寫一份——兩邊都改到才算改完。 */
export const DB_SCHEMA = "happyhands";

/**
 * 🔴 型別參數要帶 schema：`SupabaseClient` 的預設 schema 是 "public"（＝合併後小時光的表）。
 *    不帶的話 tsc 會擋下 createServiceClient()（TS2322），這其實是好事——型別系統就是第二道防護，
 *    讓「忘記帶 db:{schema}」在 typecheck 就爆掉，而不是上線後靜默讀到別站的資料。
 */
export type ServiceClient = SupabaseClient<any, typeof DB_SCHEMA>;

export function createServiceClient(env: WorkerEnv): ServiceClient {
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    db: { schema: DB_SCHEMA },
    auth: {
      // 背景服務沒有使用者 session，關掉才不會在記憶體裡累積 token 更新計時器
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        "x-application-name": "happyhands-worker",
      },
    },
  });
}

/** PostgREST 回傳的錯誤形狀（supabase-js 的 PostgrestError）。 */
export interface QueryError {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}

/**
 * 判斷錯誤是不是「migration 還沒跑」造成的。
 * 首次部署時 worker 會早於 migration 上線，這種錯要給明確提示而不是紅色堆疊。
 *
 * 42P01 = undefined_table、42883 = undefined_function
 * PGRST202 = PostgREST 找不到該 RPC、PGRST205 = 找不到該 table
 */
export function isSchemaMissingError(error: QueryError | null): boolean {
  if (error === null) return false;
  const code = error.code ?? "";
  return ["42P01", "42883", "PGRST202", "PGRST205"].includes(code);
}

/** 把 supabase 的錯誤轉成 log 可序列化的欄位。 */
export function describeError(error: QueryError): Record<string, string> {
  const out: Record<string, string> = { message: error.message };
  if (error.code !== undefined) out["code"] = error.code;
  if (error.details !== undefined && error.details !== null) out["details"] = String(error.details);
  if (error.hint !== undefined && error.hint !== null) out["hint"] = String(error.hint);
  return out;
}
