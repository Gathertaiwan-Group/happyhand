import type { ReactNode } from "react";
import Link from "next/link";
import { SITE } from "@/lib/site";
import { ArrowLeft, MessageCircle, RotateCw } from "lucide-react";

/**
 * 會員中心共用的版面零件。
 *
 * 刻意做在 account 底下而不是 components/ui/：這些的字級與間距是
 * 為「已經登入、正在辦事」的畫面調的，跟行銷頁的節奏不一樣，
 * 混在一起會讓 components/ui 變成什麼都有的雜物間。
 *
 * 全站目前沒有共用的載入／空狀態／錯誤元件（一個 loading.tsx 都沒有），
 * 會員中心是唯一每頁都要打資料庫的動態區塊，慣例就從這裡開始建立。
 */

export function PageHeading({
  title,
  lead,
  action,
}: {
  title: string;
  lead?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="mb-[22px] md:mb-[30px]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-[16px] gap-y-[8px]">
        <h1 className="t-h1 text-brown-900">{title}</h1>
        {action}
      </div>
      {lead && (
        <p className="t-body mt-[10px] max-w-[640px] text-pretty text-brown-700">
          {lead}
        </p>
      )}
    </header>
  );
}

/**
 * 讀不到資料時的狀態。
 *
 * 刻意跟「沒有資料」分開：長輩看到空白會以為自己弄壞了什麼。
 * 這裡要說清楚「不是你的問題」並給一個能立刻用的出口。
 */
export function LoadError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-card border border-sand-400 bg-cream-100 px-[22px] py-[24px] md:px-[30px] md:py-[28px]"
    >
      <p className="t-body text-brown-900">{message}</p>
      <p className="t-body-sm mt-[8px] flex items-start gap-[8px] text-brown-500">
        <RotateCw aria-hidden="true" strokeWidth={1.8} className="mt-[0.22em] h-[18px] w-[18px] shrink-0 text-caramel-dk" />
        <span>不是你操作錯誤，重新整理通常就好。</span>
      </p>
      <LineButton className="mt-[16px]" />
    </div>
  );
}

/** 什麼都沒有的時候。標題一句、說明一句、然後一個明確的下一步。 */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-card border border-dashed border-sand-400 bg-cream-100 px-[22px] py-[30px] text-center md:px-[40px] md:py-[44px]">
      <p className="t-h3 text-brown-900">{title}</p>
      {children && (
        <div className="t-body mt-[12px] text-pretty text-brown-700">{children}</div>
      )}
      {action && <div className="mt-[20px]">{action}</div>}
    </div>
  );
}

export function LineButton({
  className = "",
  label = "用 LINE 問我們",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <a
      href={SITE.lineHref}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex min-h-[56px] items-center justify-center gap-[8px] rounded-pill border-2 border-sand-400 px-[32px] text-[18px] text-brown-900 transition-colors hover:bg-[#F5E7CE] ${className}`}
    >
      <MessageCircle aria-hidden="true" strokeWidth={1.8} className="h-[20px] w-[20px] shrink-0 text-caramel-dk" />
      {label}
      <span className="sr-only">（會開啟 LINE）</span>
    </a>
  );
}

/** 一般卡片。會員中心所有列表項目都用這個外框，視覺才不會東一塊西一塊。 */
export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-card border border-sand-300 bg-white px-[20px] py-[20px] md:px-[26px] md:py-[24px] ${className}`}
    >
      {children}
    </div>
  );
}

/** 狀態標籤。前台版（後台的 status-chip 用的是後台色票，不能直接借）。 */
export function StatusChip({
  tone,
  children,
}: {
  tone: "ok" | "wait" | "muted" | "danger";
  children: ReactNode;
}) {
  const styles: Record<typeof tone, string> = {
    ok: "border-[#3f6b4a] text-[#3f6b4a]",
    wait: "border-caramel-ink text-caramel-ink",
    muted: "border-sand-400 text-brown-500",
    danger: "border-error text-error",
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-pill border px-[12px] py-[3px] text-[15px] leading-normal ${styles[tone]}`}
    >
      {children}
    </span>
  );
}

/** 「回上一層」連結。長輩容易在子頁面迷路，每個明細頁都要有。 */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-[44px] items-center gap-[6px] text-[17px] text-caramel-dk hover:underline"
    >
      <ArrowLeft aria-hidden="true" strokeWidth={1.8} className="h-[18px] w-[18px] shrink-0" /> {label}
    </Link>
  );
}
