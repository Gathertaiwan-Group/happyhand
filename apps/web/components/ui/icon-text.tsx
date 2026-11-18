import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Video, MapPin } from "lucide-react";
import { formatTag, type SessionFormat } from "@/lib/session-format";

/**
 * 「圖示＋短標籤」的共用元件（2026-11-18 全站減字）。
 *
 * 業主：字太多，能用圖示的就用圖示，尤其手機。
 * 以前每一行資訊前面都有「上課時間／上課方式／費用」這種文字標籤，
 * 現在改成一個 18px 焦糖色線條圖示，文字標籤留給螢幕報讀（sr-only）。
 *
 * 規則（全站一致）：
 * - 圖示一律 lucide-react、18px（行內）或 20px（區塊標題）、strokeWidth 1.8、caramel-dk。
 * - 圖示本身 aria-hidden；意思由 label（sr-only）或旁邊的文字說出來。
 */
export const ICON_CLASS = "h-[18px] w-[18px] shrink-0 text-caramel-dk";
export const ICON_STROKE = 1.8;

export function IconText({
  icon: Icon,
  label,
  children,
  className = "",
  iconClassName = "",
}: {
  icon: LucideIcon;
  /** 給螢幕報讀的欄位名（例如「上課時間」）。畫面上由圖示代替。 */
  label?: string;
  children: ReactNode;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span className={`inline-flex min-w-0 items-start gap-[8px] ${className}`}>
      <Icon
        aria-hidden="true"
        strokeWidth={ICON_STROKE}
        className={`mt-[0.22em] ${ICON_CLASS} ${iconClassName}`}
      />
      <span className="min-w-0">
        {label && <span className="sr-only">{label}：</span>}
        {children}
      </span>
    </span>
  );
}

/**
 * 線上／混合場次的小標籤（深底白字＋視訊圖示）。實體不標 —— 那是預設。
 * 文字沿用 lib/session-format.ts 的 formatTag，不另訂說法。
 */
export function FormatBadge({
  format,
  className = "",
}: {
  format: SessionFormat;
  className?: string;
}) {
  const tag = formatTag(format);
  if (!tag) return null;
  return (
    <span
      className={`inline-flex items-center gap-[4px] rounded-full bg-brown-900 px-[9px] text-[14px] leading-[1.7] font-medium text-white ${className}`}
    >
      <Video aria-hidden="true" strokeWidth={2} className="h-[14px] w-[14px]" />
      {format === "hybrid" && (
        <MapPin aria-hidden="true" strokeWidth={2} className="h-[14px] w-[14px]" />
      )}
      {tag}
    </span>
  );
}
