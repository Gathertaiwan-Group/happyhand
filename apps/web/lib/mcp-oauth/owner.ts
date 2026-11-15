import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { oauthOwnerActor } from "@/lib/admin/machine";
import { toRole } from "@/lib/admin/roles";
import type { Staff } from "@/lib/admin/guard";

/**
 * OAuth token 裡只有 user id（sub），沒有 cookie 可讀 —— 所以每一次 MCP 請求、每一次換
 * token 都用 service role 重查一次：這個人**現在**的角色還有沒有 mcp:connect（負責人）、
 * 帳號還在不在、有沒有被停權。角色一被拔掉，下一個請求就失效（token 還沒到期也一樣）。
 *
 * 回 null ＝不放行。查詢出錯一律 throw（fail closed）—— 呼叫端不可以把錯誤當成
 * 「大概還是負責人」：route.ts 回 503、token 端點回 500，都不發東西。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 撤銷版號：auth.users.app_metadata.mcp_oauth_epoch（不需要 DDL；app_metadata 使用者自己
 * 改不到，只有 service role 寫得進去）。沒設過＝0。碼與 token 帶著簽發當時的值，
 * 負責人按「撤銷我的所有 AI 連線」就加 1，手上全部的 token 下一個請求就失效。
 *
 * 🔴 不可以刪除或手動調小這個鍵（Supabase dashboard、整包覆寫 app_metadata 的程式）：
 *    版號倒退回 0 會讓已撤銷的舊 token 重新生效。要全撤請換 MCP_OAUTH_SECRET。
 */
export function epochOf(user: { app_metadata?: Record<string, unknown> | null } | null | undefined): number {
  const v = user?.app_metadata?.mcp_oauth_epoch;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

/** 目前的撤銷版號（同意頁簽授權碼時用）。查詢出錯 throw。 */
export async function readOAuthEpoch(userId: string): Promise<number> {
  const { data, error } = await createServiceClient().auth.admin.getUserById(userId);
  if (error || !data?.user) throw new Error(`[mcp-oauth] 讀取帳號失敗：${error?.message ?? "not found"}`);
  return epochOf(data.user);
}

/** 撤銷這個人所有 OAuth 連線：epoch 加 1。回新的值。查詢或寫入出錯 throw。 */
export async function bumpOAuthEpoch(userId: string): Promise<number> {
  const db = createServiceClient();
  const { data, error } = await db.auth.admin.getUserById(userId);
  if (error || !data?.user) throw new Error(`[mcp-oauth] 讀取帳號失敗：${error?.message ?? "not found"}`);
  const next = epochOf(data.user) + 1;
  const { error: uErr } = await db.auth.admin.updateUserById(userId, {
    // 帶上原本的 app_metadata（provider 等），只改這一個鍵。
    app_metadata: { ...(data.user.app_metadata ?? {}), mcp_oauth_epoch: next },
  });
  if (uErr) throw new Error(`[mcp-oauth] 寫入撤銷版號失敗：${uErr.message}`);
  return next;
}

/**
 * @param epoch token 裡的撤銷版號；與帳號現在的值不同＝已撤銷，回 null。
 */
export async function lookupOAuthOwner(userId: string, epoch: number): Promise<Staff | null> {
  if (typeof userId !== "string" || !UUID_RE.test(userId)) return null;
  const db = createServiceClient();

  const [{ data: profile, error: pErr }, { data: userData, error: uErr }] = await Promise.all([
    db.from("profiles").select("role").eq("id", userId).maybeSingle(),
    db.auth.admin.getUserById(userId),
  ]);
  if (pErr) throw new Error(`[mcp-oauth] 讀取 profile 失敗：${pErr.message}`);
  if (!profile) return null;

  if (uErr) {
    // 帳號被刪掉時 getUserById 回 404 —— 那是「不放行」，不是暫時性錯誤。
    const status = (uErr as { status?: number }).status;
    if (status === 404) return null;
    throw new Error(`[mcp-oauth] 讀取帳號失敗：${uErr.message}`);
  }
  const user = userData?.user;
  if (!user || user.id !== userId) return null;
  const bannedUntil = (user as { banned_until?: string | null }).banned_until;
  if (bannedUntil && Date.parse(bannedUntil) > Date.now()) return null;
  if ((user as { deleted_at?: string | null }).deleted_at) return null;
  if (epochOf(user) !== epoch) return null;

  return oauthOwnerActor({
    id: user.id,
    email: user.email ?? null,
    role: toRole((profile as { role?: string | null }).role),
  });
}
