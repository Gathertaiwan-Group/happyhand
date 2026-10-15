import "server-only";
import { cache } from "react";
import { createClient, hasSupabaseEnv } from "@/lib/supabase/server";
import { can, toRole, isStaffRole, type Capability, type Role } from "@/lib/admin/roles";
import { machineActor } from "@/lib/admin/machine";

/**
 * 後台授權。
 *
 * 這是計畫裡「第 3 層」——唯一不能少的一層。
 * middleware 只看有沒有登入（不查 DB），admin/layout.tsx 擋的是「進得了頁面嗎」，
 * 但 server action 的 POST 不會經過 layout 的 render，
 * 所以每一支寫入都必須自己再呼叫一次 requireCapability()。
 *
 * ⚠️ 與 goodday 不同：那邊有 requireAdmin()（throw）與 isAdminRequest()（boolean）
 *    兩份各自獨立的實作，原始碼註解說明那是既有爆炸半徑造成的取捨。
 *    快樂手從零開始，這裡只有一份查詢 getStaff()，另外兩支只是薄包裝。
 *    改授權邏輯只要改一個地方。
 *
 * 身分讀取刻意用使用者自己的 session client（受 RLS 保護）而不是 service role：
 * profiles_select_own 保證他只讀得到自己那一列，
 * 而 role 欄位已經由 20260810000001 的欄位級 grant 擋住不讓他自己寫。
 */

export type Staff = {
  /**
   * auth.users 的 id。
   * 🔴 機器身分（MCP）是空字串 —— 它不是一個人。audit_log.actor_id 有 FK
   *    指向 auth.users，所以 writeAudit() 會把空字串寫成 null。
   */
  id: string;
  email: string | null;
  role: Role;
  /** 非 cookie 身分的來源標記，目前只有 "mcp"。人類身分一律 undefined。 */
  via?: "mcp";
  /**
   * 機器身分專用的能力白名單，有值時**取代**角色推導。
   *
   * 為什麼不是直接給一個角色：MCP 需要的能力橫跨 support 與 editor，
   * 聯集只有 owner 蓋得住，而 owner 會順便把 staff:manage 給出去 ——
   * 那會讓一個可撤銷的 token 變成可以自己加管理員的永久後門。
   */
  caps?: readonly Capability[];
};

export class AdminAuthError extends Error {
  constructor(
    message: string,
    readonly reason: "unauthenticated" | "forbidden" | "unconfigured",
  ) {
    super(message);
    this.name = "AdminAuthError";
  }
}

/**
 * 目前登入者的員工身分。未登入、不是員工、或環境變數沒設定都回 null。
 * 不 throw —— 給 layout 與顯示層用。
 *
 * 用 React.cache() 包起來：App Router 沒辦法從 layout 把值傳給 page，
 * 所以 admin/layout.tsx 與每個 admin 頁面都會各自呼叫一次。
 * 沒有這層去重的話，每個後台請求會跑兩次 auth.getUser() 加兩次 profiles 查詢。
 * cache 的存活範圍就是單一次請求，不會跨使用者汙染。
 */
export const getStaff = cache(async function getStaff(): Promise<Staff | null> {
  /*
    機器身分優先（MCP）。放在最前面是因為後面第一行就要 await cookies()，
    而程式化入口根本沒有 cookie。

    ⚠️ 這整支被 React.cache() 包著、範圍是單一次請求，所以呼叫端必須在
       **第一次**呼叫 getStaff() 之前就進入 runAsMachine() 的 scope。
  */
  const machine = machineActor();
  if (machine) return machine;

  if (!hasSupabaseEnv()) return null;

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const { data, error } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    // 查詢失敗一律當「不是員工」。這裡刻意不 fallback 成放行。
    if (error) {
      console.error("[admin/guard] 讀取 profile 失敗", error.message);
      return null;
    }

    const role = toRole(data?.role);
    if (!isStaffRole(role)) return null;

    return { id: user.id, email: user.email ?? null, role };
  } catch (err) {
    console.error("[admin/guard] getStaff 例外", err);
    return null;
  }
});

/**
 * 要求特定能力，不符合就 throw。給 server action 用。
 *
 * 用法：
 *   const staff = await requireCapability("orders:write");
 */
export async function requireCapability(cap: Capability): Promise<Staff> {
  const staff = await getStaff();

  if (!staff) {
    throw new AdminAuthError("請先登入", "unauthenticated");
  }
  if (!hasCapability(staff, cap)) {
    throw new AdminAuthError("你的帳號沒有這項權限", "forbidden");
  }
  return staff;
}

/**
 * 這個身分有沒有這項能力。
 * 機器身分用自己的白名單，人類身分照角色推導。
 */
function hasCapability(staff: Staff, cap: Capability): boolean {
  return staff.caps ? staff.caps.includes(cap) : can(staff.role, cap);
}

/**
 * 同上但不 throw，回 null。給 route handler 用
 * （route handler 要自己決定回 401 還是 403 與回應格式）。
 */
export async function checkCapability(cap: Capability): Promise<Staff | null> {
  const staff = await getStaff();
  if (!staff || !hasCapability(staff, cap)) return null;
  return staff;
}

/**
 * 把 AdminAuthError 轉成給使用者看的一句話。
 * 其他例外不吞掉——那是真的 bug，應該讓它冒上去。
 */
export function adminErrorMessage(err: unknown): string {
  if (err instanceof AdminAuthError) return err.message;
  if (err instanceof Error) return err.message;
  return "發生未預期的錯誤，請重試一次";
}
