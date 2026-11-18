"use client";

import { Fragment, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { SITE } from "@/lib/site";
import {
  CATEGORY_LABEL,
  categoryFromParams,
  type CourseCategory,
} from "@/lib/course-category";
import { NoSessions } from "./no-sessions";

type View = "all" | Extract<CourseCategory, "live" | "onsite">;

export type SessionItem = {
  key: string;
  /** 這一場屬於哪幾類。hybrid 兩類都有。 */
  cats: CourseCategory[];
  /** 已經在伺服器端渲染好的 <SessionRow />（它本身是 <li>） */
  node: ReactNode;
};

/**
 * 每一類的標題帶文案。
 *
 * 「線下工作坊」沿用原本的品牌文案（面對面、小班、空手來就行）——那些話只對
 * 實體課成立，所以只放在這一類。「全部」要同時涵蓋直播與實體，不能再只寫
 * 面對面。
 */
const INTRO: Record<View, { title: string; lead: string }> = {
  all: {
    title: "直播與工作坊場次",
    lead: "選一個方便的日子，點進去看介紹、報名。",
  },
  live: {
    title: "線上直播",
    lead: "排好時間的直播課，在家打開視訊就能跟著老師做。",
  },
  onsite: {
    title: "線下工作坊",
    lead: "小班制，老師一個一個看過去。工具講義都準備好，空手來就行。",
  },
};

const EMPTY: Record<View, string | undefined> = {
  all: undefined,
  live: "最近沒有安排線上直播。想知道下一場什麼時候開，用 LINE 問我們。",
  onsite: "最近沒有安排線下工作坊。想知道下一場什麼時候開，用 LINE 問我們。",
};

const TABS: { key: View; label: string }[] = [
  { key: "all", label: "全部場次" },
  { key: "live", label: CATEGORY_LABEL.live },
  { key: "onsite", label: CATEGORY_LABEL.onsite },
];

function viewFrom(params: URLSearchParams | null): View {
  const c = params ? categoryFromParams((k) => params.get(k)) : null;
  return c === "live" || c === "onsite" ? c : "all";
}

/**
 * /workshops 的標題帶 + 分類鈕 + 場次列表。
 *
 * 導覽列的「線上直播」＝/workshops?format=online、「線下工作坊」＝?format=onsite。
 * 篩選只在瀏覽器端做：伺服器不讀 searchParams，頁面維持靜態 + ISR。
 * 按鈕用 replaceState 改網址，Next 會把它同步回 useSearchParams。
 */
export function WorkshopsBrowser({
  items,
  hasOnlineSessions,
}: {
  items: SessionItem[];
  hasOnlineSessions: boolean;
}) {
  return <Inner items={items} hasOnlineSessions={hasOnlineSessions} view={viewFrom(useSearchParams())} />;
}

/** Suspense 的 fallback（靜態 HTML）用這個：先顯示全部，hydrate 後再套網址上的篩選。 */
export function WorkshopsBrowserFallback(props: {
  items: SessionItem[];
  hasOnlineSessions: boolean;
}) {
  return <Inner {...props} view="all" />;
}

function Inner({
  items,
  hasOnlineSessions,
  view,
}: {
  items: SessionItem[];
  hasOnlineSessions: boolean;
  view: View;
}) {
  const intro = INTRO[view];
  const list =
    view === "all" ? items : items.filter((i) => i.cats.includes(view));
  // 有場次的類別才給按鈕；全部都同一類的話整排不顯示
  const tabs = TABS.filter(
    (t) => t.key === "all" || items.some((i) => i.cats.includes(t.key as CourseCategory)),
  );

  const select = (key: View) => {
    const url = new URL(window.location.href);
    url.searchParams.delete("cat");
    url.searchParams.delete("type");
    if (key === "all") url.searchParams.delete("format");
    else url.searchParams.set("format", key === "live" ? "online" : "onsite");
    window.history.replaceState(window.history.state, "", url);
  };

  return (
    <>
      {/* 標題帶。2026-11-18 手機版改版：以前是置中的英文小標＋大標＋三行說明，
          光這一段就佔掉手機半個螢幕。改成靠左一行標題＋一句話，分類鈕緊接在後。 */}
      <section className="bg-cream-100 px-[16px] pt-[22px] pb-[18px] md:px-[40px] md:pt-[48px] md:pb-[36px]">
        <div className="mx-auto max-w-[1080px] md:text-center">
          <h1 className="font-serif text-[26px] leading-[1.4] font-semibold text-brown-900 md:text-[38px]">
            {intro.title}
          </h1>
          <p className="mt-[6px] text-[17px] leading-[1.75] text-pretty text-brown-700 md:mt-[10px] md:text-[18px]">
            {intro.lead}
          </p>
          {/* 不方便線上付款的長輩多半直接用 LINE 報名。手機以前靠底部固定列，
              現在拿掉固定列，改成這裡一行看得到的連結。 */}
          <p className="mt-[2px] text-[17px] leading-[1.75] text-brown-700 md:mt-[6px] md:text-[18px]">
            不方便線上付款？
            <a
              href={SITE.lineHref}
              target="_blank"
              rel="noopener noreferrer"
              className="-my-[7px] inline-block py-[11px] font-medium whitespace-nowrap text-brown-900 underline underline-offset-4 hover:text-caramel-dk"
            >
              用 LINE 報名
              <span className="sr-only">（會開啟 LINE）</span>
            </a>
          </p>
        </div>
      </section>

      {tabs.length > 1 && (
        <div className="px-[16px] pt-[16px] md:px-[40px] md:pt-[28px]">
          <div
            role="group"
            aria-label="場次分類"
            className="mx-auto grid max-w-[1080px] gap-[4px] rounded-pill bg-cream-200 p-[4px] md:max-w-[640px]"
            style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
          >
            {tabs.map((t) => {
              const isActive = t.key === view;
              const n =
                t.key === "all"
                  ? items.length
                  : items.filter((i) => i.cats.includes(t.key as CourseCategory)).length;
              return (
                <button
                  key={t.key}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => select(t.key)}
                  className={[
                    "flex min-h-[56px] items-center justify-center gap-[4px] rounded-pill px-[4px] text-[17px] leading-[1.3] font-medium transition-colors duration-200 md:text-[18px]",
                    isActive ? "bg-brown-900 text-white" : "text-brown-900 hover:bg-cream-300",
                  ].join(" ")}
                >
                  {t.key === "all" ? "全部" : t.label}
                  <span className={`text-[15px] font-normal ${isActive ? "text-cream-200" : "text-brown-700"}`}>
                    {n}
                  </span>
                </button>
              );
            })}
          </div>
          {hasOnlineSessions && view !== "onsite" && (
            <p className="mx-auto mt-[10px] max-w-[1080px] text-[16px] leading-[1.7] text-brown-700 md:text-center">
              標「線上」的場次，上課連結會在開課前用 Email 或 LINE 傳給你。
            </p>
          )}
        </div>
      )}

      <p aria-live="polite" className="sr-only">
        目前顯示 {list.length} 個場次
      </p>

      {/* 場次列表（設計稿 L491–539 桌機／L569–609 手機）。
          包班詢問留在 page.tsx，緊接在這之後。 */}
      <div className="fab-safe px-[16px] pt-[16px] md:px-[40px] md:pt-[32px]">
        <div className="mx-auto max-w-[1080px]">
          <h2 className="sr-only">近期場次</h2>
          {list.length === 0 ? (
            <NoSessions message={EMPTY[view]} />
          ) : (
            <ul className="grid list-none gap-[12px] md:grid-cols-2 md:gap-[20px]">
              {list.map((i) => (
                <Fragment key={i.key}>{i.node}</Fragment>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
