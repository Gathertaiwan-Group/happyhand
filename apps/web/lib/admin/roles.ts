/**
 * 後台角色與能力表。
 *
 * 這支刻意「純資料、零 IO」—— 不 import supabase、不碰 next/headers，
 * 所以 client 元件（側欄、按鈕）也能直接 import 來決定要不要顯示某個入口。
 * 真正的授權在 lib/admin/guard.ts，不在這裡。
 *
 * ⚠️ 顯示層用 can() 藏東西只是體貼，不是保護。
 *    每一支 server action 都必須自己再呼叫一次 requireCapability()。
 */

export const ROLES = ["customer", "support", "editor", "owner"] as const;
export type Role = (typeof ROLES)[number];

/** 能進後台的角色。customer 不在內。 */
export const STAFF_ROLES = ["support", "editor", "owner"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export type Capability =
  /** 進得了 /admin */
  | "admin:access"
  /** 看課程與工作坊的後台清單 */
  | "catalog:read"
  /** 改課程、單元、場次的日期地點價格；上下架；新增刪除 */
  | "catalog:write"
  /** 上傳圖片素材 */
  | "media:upload"
  /** 看訂單（含姓名電話 Email 地址） */
  | "orders:read"
  /** 改訂單狀態、標記收款、取消 */
  | "orders:write"
  /** 匯出報名名單 CSV */
  | "roster:export"
  /** 登記與處理候補 */
  | "waitlist:write"
  /** 開關某場次的報名、微調名額 */
  | "sessions:status"
  /** 邀請員工、改角色 */
  | "staff:manage"
  /** 看稽核紀錄 */
  | "audit:read"
  /**
   * 看、關閉 AI（MCP）提出的退款／作廢發票申請。只給負責人。
   *
   * 🔴 刻意不在 lib/admin/machine.ts 的 MCP_ACTOR.caps 裡：AI 只能「提出」申請，
   *    不能自己把申請關掉，也看不到後台的待處理清單。
   *    （申請本身是 audit_log 的一列，MCP 的 search_audit_log 讀得到稽核紀錄。）
   */
  | "mcp:requests";

/**
 * 角色 → 能力。
 *
 * 設計重點：editor 拿不到任何 orders:* 能力是刻意的。
 * 訂單裡有姓名、電話、Email、寄送地址，內容編輯的工作不需要看到這些。
 * 這是這個權限切分真正的價值，不是形式。
 *
 * sessions:status 同時給 editor 與 support：現場滿了通常是收 LINE 訊息的人先知道，
 * 但「改日期／地點／價格」仍然只有 catalog:write 才行。
 * 實作上是兩支不同的 server action（setSessionStatus vs upsertSession），
 * 不是在同一支裡開洞。
 */
const MATRIX: Record<Role, readonly Capability[]> = {
  customer: [],
  support: [
    "admin:access",
    "orders:read",
    "orders:write",
    "roster:export",
    "waitlist:write",
    "sessions:status",
  ],
  editor: [
    "admin:access",
    "catalog:read",
    "catalog:write",
    "media:upload",
    "sessions:status",
  ],
  owner: [
    "admin:access",
    "catalog:read",
    "catalog:write",
    "media:upload",
    "orders:read",
    "orders:write",
    "roster:export",
    "waitlist:write",
    "sessions:status",
    "staff:manage",
    "audit:read",
    "mcp:requests",
  ],
};

export function can(role: Role | null | undefined, cap: Capability): boolean {
  if (!role) return false;
  return MATRIX[role]?.includes(cap) ?? false;
}

export function isStaffRole(role: string | null | undefined): role is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(role ?? "");
}

/** 把資料庫來的任意字串收斂成合法角色，認不得的一律當 customer */
export function toRole(value: string | null | undefined): Role {
  return (ROLES as readonly string[]).includes(value ?? "")
    ? (value as Role)
    : "customer";
}

export const ROLE_LABELS: Record<Role, string> = {
  customer: "一般會員",
  support: "客服",
  editor: "內容編輯",
  owner: "負責人",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  customer: "只能使用前台，進不了後台。",
  support: "訂單、收款、報名名單、候補。看不到課程編輯。",
  editor: "課程、工作坊、單元、圖片。看不到訂單與客人個資。",
  owner: "全部功能，另外可以管理員工帳號與查看稽核紀錄。",
};
