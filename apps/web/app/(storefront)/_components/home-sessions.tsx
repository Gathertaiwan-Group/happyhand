"use client";

import { Fragment, useState, type ReactNode } from "react";
import { LinkButton } from "@/components/ui/button";
import { NoSessions } from "@/app/(storefront)/workshops/_components/no-sessions";
import {
  CATEGORY_HREF,
  CATEGORY_LABEL,
  type CourseCategory,
} from "@/lib/course-category";

type Tab = Extract<CourseCategory, "live" | "onsite">;

export type HomeSessionItem = {
  key: string;
  /** 這一場屬於哪幾類。混合場次兩類都有，兩個分頁都會出現。 */
  cats: CourseCategory[];
  isNew: boolean;
  /** 伺服器端渲染好的 <SessionRow />（本身是 <li>） */
  node: ReactNode;
};

/** 每個分頁最多列幾場，其餘用底下的按鈕帶去 /workshops。首頁不是場次表。 */
const LIMIT = 4;

const TABS: Tab[] = ["live", "onsite"];

const EMPTY: Record<Tab, string> = {
  live: "最近沒有安排線上直播，想知道下一場用 LINE 問我們。",
  onsite: "最近沒有安排線下工作坊，想知道下一場用 LINE 問我們。",
};

/**
 * 首頁第二段（主視覺之後緊接著）：近期的線上直播與線下工作坊。
 *
 * 業主 2026-11-18：「讓學生一上來就可以看到新增的線上直播 or 線下工作坊」。
 * 所以這一段搬到最上面，手機 390×844 第一屏就要露出第一場的開頭。
 *
 * - 兩個分頁，分類規則跟 /courses、/workshops 同一套（lib/course-category.ts）。
 *   混合場次兩邊都出現。預設打開「有場次」的那一頁，直播優先。
 * - 某一類沒有場次時仍然留著分頁，點進去是「最近沒有安排…用 LINE 問我們」，
 *   不讓那一類整個消失（業主要的是讓人知道有這兩種課）。
 * - 「新開」= 場次建立 14 天內（見 page.tsx 的 NEW_DAYS），分頁上也標，
 *   不點進去也知道另一頁有新的。
 * - 每一列直接重用 /workshops 的 SessionRow：報名流程、額滿候補、
 *   不顯示剩餘名額的規則都跟場次頁一模一樣。
 */
export function HomeSessions({
  items,
  hasOnlineSessions,
}: {
  items: HomeSessionItem[];
  hasOnlineSessions: boolean;
}) {
  const inTab = (t: Tab) => items.filter((i) => i.cats.includes(t));
  const [tab, setTab] = useState<Tab>(
    inTab("live").length > 0 || inTab("onsite").length === 0 ? "live" : "onsite",
  );

  const all = inTab(tab);
  const shown = all.slice(0, LIMIT);

  return (
    <section
      aria-labelledby="home-sessions-title"
      className="fab-safe border-t border-sand-300 bg-cream-100 px-[20px] pt-[16px] pb-[36px] md:px-[40px] md:pt-[40px] md:pb-[64px]"
    >
      <div className="mx-auto max-w-[1080px]">
        <div className="text-center">
          <p className="t-eyebrow hidden text-caramel-ink md:block">LIVE &amp; WORKSHOPS</p>
          <h2 id="home-sessions-title" className="t-h2 md:mt-[6px]">
            近期開課，跟老師一起練
          </h2>
        </div>

        <div
          role="tablist"
          aria-label="課程類別"
          className="mt-[10px] grid grid-cols-2 gap-[10px] md:mx-auto md:mt-[24px] md:max-w-[560px] md:gap-[14px]"
        >
          {TABS.map((t) => {
            const list = inTab(t);
            const active = t === tab;
            const hasNew = list.some((i) => i.isNew);
            return (
              <button
                key={t}
                type="button"
                role="tab"
                id={`home-tab-${t}`}
                aria-selected={active}
                aria-controls="home-sessions-panel"
                onClick={() => setTab(t)}
                className={[
                  "flex min-h-[60px] flex-col items-center justify-center rounded-[18px] border-2 px-[10px] py-[6px] text-[18px] leading-[1.35] font-medium transition-colors duration-200 md:flex-row md:gap-[8px] md:text-[19px]",
                  active
                    ? "border-brown-900 bg-brown-900 text-white"
                    : "border-sand-400 bg-white text-brown-900 hover:border-caramel-ink",
                ].join(" ")}
              >
                <span>{CATEGORY_LABEL[t]}</span>
                <span
                  className={`text-[15px] font-normal ${active ? "text-cream-200" : "text-brown-500"}`}
                >
                  {list.length > 0 ? `${list.length} 場` : "尚未排課"}
                  {hasNew && (
                    <span className="ml-[6px] inline-block rounded-full bg-caramel-dk px-[8px] text-[14px] leading-[1.6] font-medium text-white">
                      有新開
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        <div
          id="home-sessions-panel"
          role="tabpanel"
          aria-labelledby={`home-tab-${tab}`}
          className="mt-[12px] md:mt-[24px]"
        >
          {all.length === 0 ? (
            <NoSessions message={EMPTY[tab]} />
          ) : (
            <ul className="flex list-none flex-col gap-[14px]">
              {shown.map((i) => (
                <Fragment key={i.key}>{i.node}</Fragment>
              ))}
            </ul>
          )}

          {tab === "live" && hasOnlineSessions && all.length > 0 && (
            <p className="t-body mt-[14px] text-center text-pretty text-brown-500">
              線上直播的上課連結，會在開課前用 Email 或 LINE 傳給你。
            </p>
          )}

          {all.length > 0 && (
          <div className="mt-[16px] text-center md:mt-[24px]">
            <LinkButton
              href={CATEGORY_HREF[tab]}
              variant="outline"
              className="w-full md:w-auto"
            >
              {all.length > shown.length
                ? `看全部 ${all.length} 場${CATEGORY_LABEL[tab]}`
                : `看${CATEGORY_LABEL[tab]}場次`}
            </LinkButton>
          </div>
          )}
        </div>
      </div>
    </section>
  );
}
