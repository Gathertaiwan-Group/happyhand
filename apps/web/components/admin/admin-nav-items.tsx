import { can, type Capability, type Role } from "@/lib/admin/roles";

/**
 * 後台導覽的單一真相來源。
 *
 * 側欄（桌機）與底部分頁（手機）共用這一份定義，避免兩邊各自維護一份而漂移
 * —— 這是 goodday 那邊踩過的坑（見 goodday/docs/superpowers/specs/2026-07-20-admin-layout-design.md）。
 *
 * 圖示刻意用 inline SVG path 字串，不引入任何 icon 套件：
 * 六個圖示換不到一個 npm 依賴 + 一份 tree-shaking 設定。
 *
 * ⚠️ capability 只決定「要不要顯示這個入口」，那是體貼不是保護。
 *    每一支頁面與 server action 都必須自己再呼叫一次 requireCapability()。
 */

export type AdminNavItem = {
  href: string;
  label: string;
  /**
   * 進入這個頁面所需的能力（lib/admin/roles.ts）。
   *
   * ⚠️ 陣列的語意是 **任一即可（any-of）**，不是「全部都要」。
   *    型別上看不出來，所以寫在這裡：工作坊那一頁 catalog:read 或 orders:read
   *    任一就進得去（內容編輯來改場次、客服來看報名），區段各自再判一次。
   */
  capability: Capability | Capability[];
  /** SVG path 的 d 屬性，24x24 viewBox、stroke 樣式 */
  icon: string;
  /** true = 出現在手機底部分頁列 */
  primary?: boolean;
};

export const ADMIN_NAV: AdminNavItem[] = [
  {
    href: "/admin",
    label: "總覽",
    capability: "admin:access",
    icon: "M3 12h7V3H3v9Zm11 9h7v-9h-7v9ZM3 21h7v-6H3v6Zm11-12h7V3h-7v6Z",
    primary: true,
  },
  {
    href: "/admin/orders",
    label: "訂單",
    capability: "orders:read",
    icon: "M6 2h9l5 5v15H6V2Zm9 0v5h5M9 13h8M9 17h5",
    primary: true,
  },
  {
    // 諮詢紀錄裡有訪客留的姓名／Email／電話，跟訂單同等敏感，
    // 所以走 orders:read —— editor 看不到，這是刻意的。
    href: "/admin/inquiries",
    label: "小幫手諮詢",
    capability: "orders:read",
    icon: "M21 11.5a8.4 8.4 0 0 1-9 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5Z",
  },
  {
    // 線上課程與訂閱制：買了就能看的東西，內容是單元與影片。
    href: "/admin/courses",
    label: "線上課程",
    capability: "catalog:read",
    icon: "M4 4h5a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H4V4Zm16 0h-5a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h5V4Z",
    primary: true,
  },
  {
    /*
      實體工作坊：內容是場次與報名。

      🔴 這一項是全站唯一用「任一即可」的：
         內容編輯要來改場次的日期地點（catalog），客服要來看誰報名了（orders），
         兩種人的工作都在這一頁上，但看到的東西不一樣 ——
         頁面本身只顯示場次層資料（日期、地點、名額），
         報名名單在 /admin/sessions/[id]，那一頁仍然只認 orders:read。
    */
    href: "/admin/workshops",
    label: "工作坊",
    capability: ["catalog:read", "orders:read"],
    icon: "M4 5h16v16H4V5Zm0 5h16M9 3v4M15 3v4M8 14h3v3H8v-3Z",
    primary: true,
  },
  {
    href: "/admin/staff",
    label: "員工",
    capability: "staff:manage",
    icon: "M16 20v-1a4 4 0 0 0-8 0v1M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7 9v-1a4 4 0 0 0-3-3.9",
  },
  {
    href: "/admin/settings",
    label: "網站設定",
    capability: "catalog:write",
    icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3c0-.4 0-.8-.1-1.2l2-1.5-2-3.4-2.3.9a7.5 7.5 0 0 0-2-1.2L14.6 3h-4l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7.5 7.5 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z",
  },
  {
    // AI 連線（MCP OAuth）：連線說明＋撤銷。只給負責人（mcp:connect）。
    href: "/admin/mcp/connect",
    label: "AI 連線",
    capability: "mcp:connect",
    icon: "M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0V7Zm5 9v5",
  },
  {
    href: "/admin/audit",
    label: "稽核紀錄",
    capability: "audit:read",
    icon: "M5 3h9l5 5v13H5V3Zm9 0v5h5M8 12h8M8 16h5",
  },
];

/**
 * 這個角色看不看得到這一項。
 *
 * capability 是陣列時代表**任一即可**（見 AdminNavItem 的註解）。
 * 這只決定「導覽列上出不出現」—— 保護一律在頁面自己的守衛上。
 */
export function canSeeNavItem(role: Role | null, item: AdminNavItem): boolean {
  return Array.isArray(item.capability)
    ? item.capability.some((c) => can(role, c))
    : can(role, item.capability);
}

/**
 * 目前路徑是否命中該項目。
 *
 * /admin 必須完全相符：用 startsWith 的話每一個子頁都會讓「總覽」跟著亮，
 * 使用者永遠看到兩個 active。其餘項目才用前綴比對（含子路徑 /admin/orders/xxx）。
 */
export function isAdminNavActive(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminNavIcon({
  d,
  className = "",
}: {
  d: string;
  className?: string;
}) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}
