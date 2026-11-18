"use client";

import { Fragment, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { buttonClass } from "@/components/ui/button";
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
const INTRO: Record<View, { eyebrow: string; title: string; lead: string }> = {
  all: {
    eyebrow: "LIVE & WORKSHOPS",
    title: "跟著老師，一起練一次",
    lead: "線上直播在家打開視訊就能跟著做；線下工作坊是小班制，八到十個人，老師會一個一個看過去，工具跟講義都準備好，你空手來就行。",
  },
  live: {
    eyebrow: "LIVE",
    title: "在家，跟老師一起練",
    lead: "排好時間的線上直播課，打開視訊就能跟著老師做，不用出門。",
  },
  onsite: {
    eyebrow: "WORKSHOPS",
    title: "跟老師面對面練一次",
    lead: "小班制，八到十個人，老師會一個一個看過去。工具跟講義都準備好了，你空手來就行。",
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
      {/* 標題帶（設計稿 L480–484 桌機／L558–562 手機） */}
      <section className="bg-cream-100 px-[20px] py-[32px] text-center md:px-[40px] md:py-[56px]">
        {/* 間距用 flex gap，不用 margin：t-h1/t-h2/t-h3 utility 自帶 margin:0 會蓋掉 mt-* */}
        <div className="mx-auto flex max-w-[720px] flex-col items-center gap-[12px]">
          <span className="t-eyebrow text-caramel-ink">{intro.eyebrow}</span>
          <h1 className="t-h2">{intro.title}</h1>
          <p className="t-body-lg text-pretty text-brown-500">{intro.lead}</p>
          {/* 有線上場次、而且現在看得到它們（不是只看線下）時，補一句連結怎麼來 */}
          {hasOnlineSessions && view !== "onsite" && (
            <p className="t-body text-brown-500">
              標示「線上」的場次，上課連結會在開課前用 Email 或 LINE 傳給你。
            </p>
          )}
          {/* 桌機沒有底部行動列，這裡補一個用 LINE 問的出口 */}
          <div className="hidden w-full pt-[8px] md:block md:w-auto">
            <a
              href={SITE.lineHref}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClass({ variant: "outline" })}
            >
              用 LINE 問場次
              <span className="sr-only">（會開啟 LINE）</span>
            </a>
          </div>
        </div>
      </section>

      {tabs.length > 1 && (
        <div
          role="group"
          aria-label="場次分類"
          className="flex gap-[10px] overflow-x-auto px-[20px] pt-[20px] [scrollbar-width:none] md:justify-center md:gap-[12px] md:px-[40px] md:pt-[32px] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map((t) => {
            const isActive = t.key === view;
            return (
              <button
                key={t.key}
                type="button"
                aria-pressed={isActive}
                onClick={() => select(t.key)}
                className={[
                  "inline-flex min-h-[56px] shrink-0 items-center rounded-pill border px-[26px] text-[17px] whitespace-nowrap transition-colors duration-200",
                  isActive
                    ? "border-caramel-ink bg-caramel-ink text-white"
                    : "border-sand-500 bg-cream-200 text-brown-500 hover:bg-cream-300",
                ].join(" ")}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      )}

      <p aria-live="polite" className="sr-only">
        目前顯示 {list.length} 個場次
      </p>

      {/* 場次列表（設計稿 L491–539 桌機／L569–609 手機）。
          包班詢問留在 page.tsx，緊接在這之後。 */}
      <div className="fab-safe px-[20px] pt-[28px] md:px-[40px] md:pt-[48px]">
        <div className="mx-auto max-w-maxw">
          <h2 className="sr-only">近期場次</h2>
          {list.length === 0 ? (
            <NoSessions message={EMPTY[view]} />
          ) : (
            <ul className="flex list-none flex-col gap-[14px]">
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
