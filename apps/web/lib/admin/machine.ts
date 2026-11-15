import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Staff } from "@/lib/admin/guard";
import { can, capabilitiesOf, type Capability, type Role } from "@/lib/admin/roles";

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

/* ------------------------------------------------------------------
 * 這一次 MCP 請求「代表誰」（2026-11-15 加上 OAuth 之後）
 *
 * 兩種身分：
 *   - 靜態 MCP_TOKEN（業主的 Claude Code）→ MCP_ACTOR（沒有人，actor_id=null）。
 *   - OAuth（claude.ai／手機 App／ChatGPT）→ 授權的那位負責人本人：真實 id、email，
 *     via="mcp"，caps＝他的角色能力 ∩ MCP_ACTOR.caps（永遠不含 staff:manage）。
 *
 * app/api/mcp/route.ts 的 POST 驗完 token 後用 runMcpRequest() 把整個 MCP 請求包起來。
 * 之後**任何**地方拿 MCP_ACTOR 去 runAsMachine() 或 writeAudit()，都會自動換成這一次
 * 請求的身分（resolveMcpActor）。這樣 route.ts 那一處統一的 asMachine() 包裝、預覽稽核、
 * 申請制（mcp-pending-repo.ts）、以及之後新增的工具模組，全部不用改呼叫方式就會記到真人。
 * ------------------------------------------------------------------ */

const requestStore = new AsyncLocalStorage<Staff>();

/** 在這個 scope 內，MCP_ACTOR 一律代換成 actor。只有 app/api/mcp/route.ts 的入口該呼叫。 */
export function runMcpRequest<T>(actor: Staff, fn: () => Promise<T>): Promise<T> {
  return requestStore.run(actor, fn);
}

/** 這一次 MCP 請求的身分；不在 MCP 請求裡就是 MCP_ACTOR（與加 OAuth 之前一樣）。 */
export function currentMcpActor(): Staff {
  return requestStore.getStore() ?? MCP_ACTOR;
}

/** 傳進來的是 MCP_ACTOR 就換成這一次請求的身分；其他身分（真人 cookie）原樣回傳。 */
export function resolveMcpActor(actor: Staff): Staff {
  return actor === MCP_ACTOR ? currentMcpActor() : actor;
}

/**
 * OAuth 連進來的負責人 → 這次請求要用的 Staff。不是負責人（沒有 mcp:connect）回 null。
 *
 * 🔴 caps 是「角色能力 ∩ MCP_ACTOR.caps」，再保險地拿掉 staff:manage：
 *    就算之後有人把 staff:manage 加進 MCP_ACTOR 的白名單，AI 也不能自己加管理員。
 *    mcp:requests、mcp:connect 不在 MCP_ACTOR.caps，所以也不會出現 —— AI 不能關閉
 *    自己提的申請、不能替別人授權新連線（dismissMcpRequest 另外用 via 擋）。
 * 🔴 via 一律 "mcp"：稽核的 actor_role 寫 "mcp"（看得出是 AI 做的），actor_id 寫真人 id。
 */
export function oauthOwnerActor(user: {
  id: string;
  email: string | null;
  role: Role;
}): Staff | null {
  if (!user.id || !can(user.role, "mcp:connect")) return null;
  const allowed = new Set<Capability>(MCP_ACTOR.caps ?? []);
  const caps = capabilitiesOf(user.role).filter(
    (c) => allowed.has(c) && c !== "staff:manage",
  );
  return { id: user.id, email: user.email, role: user.role, via: "mcp", caps };
}

/**
 * 在這個 scope 內，getStaff() 會回 actor 而不是去讀 cookie。
 * 傳 MCP_ACTOR 時會換成這一次 MCP 請求的身分（OAuth 負責人或 MCP_ACTOR 本身）。
 */
export function runAsMachine<T>(actor: Staff, fn: () => Promise<T>): Promise<T> {
  return store.run(resolveMcpActor(actor), fn);
}

/** 目前是否在機器身分的 scope 內。給 getStaff() 用，其他地方不要呼叫。 */
export function machineActor(): Staff | null {
  return store.getStore() ?? null;
}
