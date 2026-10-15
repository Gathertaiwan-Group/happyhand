import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Staff } from "@/lib/admin/guard";
import type { Capability } from "@/lib/admin/roles";

/**
 * 機器身分 —— 讓沒有 cookie 的請求也能呼叫後台的 server action。
 *
 * 為什麼需要這個：後台的授權（lib/admin/guard.ts 的 getStaff()）只認 cookie，
 * 而且第一行就 `await cookies()`。MCP 這類程式化入口帶的是 bearer token，
 * 走不進去。
 *
 * 為什麼用 AsyncLocalStorage 而不是給每支 action 加一個 actor 參數：
 * 那幾支 action 的冪等寫法（條件式 update）、「先退錢後改狀態」「先開通後同步
 * 名額」的順序保證、以及每一支自己的 writeAudit()，全都是已經驗過的東西。
 * 加參數等於把它們全部重寫一次，風險遠大於在 getStaff() 開一道口。
 *
 * ⚠️ getStaff() 被 React.cache() 包著，而 cache 的範圍是單一次請求。
 *    所以 route handler 內**第一次**呼叫 getStaff() 就必須已經在
 *    runAsMachine() 的 scope 裡 —— 先在外面呼叫過一次的話，被快取的 null
 *    會贏，之後再進 scope 也沒用。
 */

const store = new AsyncLocalStorage<Staff>();

/**
 * MCP 的機器身分。
 *
 * 🔴 `id` 刻意是空字串：它不是 auth.users 裡的人。audit_log.actor_id 有
 *    FK 指向 auth.users，塞一個假 UUID 會違反外鍵，而 writeAudit() 刻意
 *    永不 throw —— 結果會是「退款成功但稽核完全沒留下」。
 *    lib/admin/audit.ts 會把空字串寫成 null。
 *
 * 🔴 `caps` 是白名單，不是角色。直接給 owner 會把 staff:manage 一起給出去，
 *    那條等於讓一個可撤銷的 token 變成「可以把自己加成管理員」的永久帳號 ——
 *    token 外洩時爆炸半徑從「rotate 一個環境變數」變成「要逐一清帳號」。
 *    所以這裡逐項列出，而且刻意不含 staff:manage。
 */
export const MCP_ACTOR: Staff = {
  id: "",
  email: "mcp",
  role: "owner",
  via: "mcp",
  caps: [
    "admin:access",
    "catalog:read",
    "catalog:write",
    "media:upload",
    "orders:read",
    "orders:write",
    "roster:export",
    "waitlist:write",
    "sessions:status",
    "audit:read",
    // 🔴 刻意沒有 "staff:manage"
  ] satisfies readonly Capability[],
};

/** 在這個 scope 內，getStaff() 會回 actor 而不是去讀 cookie。 */
export function runAsMachine<T>(actor: Staff, fn: () => Promise<T>): Promise<T> {
  return store.run(actor, fn);
}

/** 目前是否在機器身分的 scope 內。給 getStaff() 用，其他地方不要呼叫。 */
export function machineActor(): Staff | null {
  return store.getStore() ?? null;
}
