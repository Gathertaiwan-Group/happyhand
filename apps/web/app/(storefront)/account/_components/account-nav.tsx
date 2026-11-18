"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { BookOpen, CalendarDays, ReceiptText, UserRound } from "lucide-react";

/**
 * 會員中心導覽。桌機是左側欄，手機是底部固定分頁。
 *
 * 三個對長輩的刻意設計：
 * 1. **圖示一律配文字**。研究台灣課程平台時最常見的問題就是純圖示導覽
 *    （📎 = 附件、✏️ = 筆記），那是給年輕人的視覺速記，長輩不解碼。
 * 2. **目前頁面用整格底色 + 上緣粗色條 + 加粗字**，不是只有文字變色。
 *    Hahow 只把當前單元變成綠色字，遠看根本分不出來。
 * 3. 底部每一格 ≥ 56px 高再加上 safe-area，拇指按得到、也不會被 iPhone
 *    的home indicator 蓋住。
 *
 * ⚠️ 這一列與 components/mobile-action-bar.tsx 都是 fixed bottom-0 md:hidden，
 *    同時渲染會疊在一起。所以 /account/* 底下一律不放 MobileActionBar，
 *    LINE 出口改由每頁底部的 CallBand 提供（那本來就是每頁必備的）。
 *
 * 用 usePathname 而不是由 server 傳 prop：這一列在 layout 裡，
 * layout 不會隨子路由重新 render，傳 prop 的話切頁時高亮不會動。
 */

type Item = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** 只有完全相符才算目前頁面（避免 /account 把所有子頁都吃掉） */
  exact?: boolean;
};

const ITEMS: Item[] = [
  {
    href: "/account",
    label: "我的學習",
    exact: true,
    icon: BookOpen,
  },
  {
    href: "/account/orders",
    label: "我的訂單",
    icon: ReceiptText,
  },
  {
    href: "/account/workshops",
    label: "工作坊",
    icon: CalendarDays,
  },
  {
    href: "/account/settings",
    label: "我的資料",
    icon: UserRound,
  },
];

function isCurrent(pathname: string, item: Item): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function NavIcon({ icon: I }: { icon: LucideIcon }) {
  return <I aria-hidden="true" strokeWidth={1.7} className="h-[26px] w-[26px]" />;
}

/** 桌機左側欄。1280px（lg）以上才出現。 */
export function AccountSidebar() {
  const pathname = usePathname();

  return (
    <nav aria-label="會員中心" className="hidden lg:block">
      <ul className="flex flex-col gap-[6px]">
        {ITEMS.map((item) => {
          const current = isCurrent(pathname, item);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={`flex min-h-[56px] items-center gap-[14px] rounded-card border-l-[4px] px-[18px] text-[18px] transition-colors ${
                  current
                    ? "border-caramel-ink bg-cream-100 font-semibold text-brown-900"
                    : "border-transparent text-brown-700 hover:bg-cream-100"
                }`}
              >
                <NavIcon icon={item.icon} />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** 手機底部固定分頁。lg 以下出現。 */
export function AccountBottomNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="會員中心"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-sand-300 bg-white pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <ul className="mx-auto flex max-w-[560px]">
        {ITEMS.map((item) => {
          const current = isCurrent(pathname, item);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={`flex min-h-[60px] flex-col items-center justify-center gap-[2px] border-t-[3px] px-[4px] py-[8px] text-[13px] leading-tight transition-colors ${
                  current
                    ? "border-caramel-ink bg-cream-100 font-semibold text-brown-900"
                    : "border-transparent text-brown-500"
                }`}
              >
                <NavIcon icon={item.icon} />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
