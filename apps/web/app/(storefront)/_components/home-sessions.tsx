"use client";

import { Fragment, useState, type ReactNode } from "react";
import Link from "next/link";
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
  /** 伺服器端渲染好的 <SessionCard />（或退回 <SessionRow />），本身是 <li> */
  node: ReactNode;
};

/** 每個分頁最多列幾場，其餘用「看全部」帶去 /workshops。首頁不是場次表。 */
const LIMIT = 4;

const TABS: Tab[] = ["live", "onsite"];

const EMPTY: Record<Tab, string> = {
  live: "最近沒有安排線上直播，想知道下一場用 LINE 問我們。",
  onsite: "最近沒有安排線下工作坊，想知道下一場用 LINE 問我們。",
};

/**
 * 首頁「近期開課」：線上直播／線下工作坊兩個分頁（業主 2026-11-18 要的）。
 *
 * 2026-11-18 手機版改版：
 * - 標題靠左、右邊「看全部 ›」（Hahow／Udemy 的區塊標題寫法），不再用置中大標＋底部外框鈕。
 * - 分頁改成一排分段按鈕（56px 高、一行字），以前是兩行字的 60px 大方塊。
 * - 每一場改用 SessionCard：整張卡可點，一屏可以看到兩場以上。
 *
 * 分類規則跟 /courses、/workshops 同一套（lib/course-category.ts），混合場次兩邊都出現。
 * 某一類沒有場次時仍然留著分頁，點進去是「最近沒有安排…用 LINE 問我們」。
 * 「新開」= 場次建立 14 天內（見 page.tsx 的 NEW_DAYS），分頁上也標。
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
      className="fab-safe px-[16px] pt-[28px] pb-[32px] md:px-[40px] md:pt-[48px] md:pb-[56px]"
    >
      <div className="mx-auto max-w-[1080px]">
        <div className="flex items-end justify-between gap-[12px]">
          <h2
            id="home-sessions-title"
            className="font-serif text-[23px] leading-[1.4] font-semibold text-brown-900 md:text-[30px]"
          >
            近期開課
          </h2>
          <Link
            href={CATEGORY_HREF[tab]}
            className="-my-[10px] inline-flex min-h-[48px] items-center gap-[2px] text-[17px] text-brown-700 underline-offset-4 hover:text-caramel-dk hover:underline"
          >
            看全部{all.length > 0 ? ` ${all.length} 場` : ""}
            <span aria-hidden="true">›</span>
          </Link>
        </div>

        <div
          role="tablist"
          aria-label="上課方式"
          className="mt-[14px] grid grid-cols-2 gap-[4px] rounded-pill bg-cream-200 p-[4px] md:mt-[20px] md:max-w-[480px]"
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
                  "relative flex min-h-[52px] items-center justify-center gap-[6px] rounded-pill px-[8px] text-[18px] font-medium transition-colors duration-200",
                  active
                    ? "bg-brown-900 text-white"
                    : "text-brown-900 hover:bg-cream-300",
                ].join(" ")}
              >
                {CATEGORY_LABEL[t]}
                <span
                  className={`text-[16px] font-normal ${active ? "text-cream-200" : "text-brown-700"}`}
                >
                  {list.length}
                </span>
                {hasNew && (
                  <>
                    <span
                      aria-hidden="true"
                      className="absolute top-[8px] right-[14px] h-[9px] w-[9px] rounded-full bg-caramel-dk ring-2 ring-white"
                    />
                    <span className="sr-only">（有新開的場次）</span>
                  </>
                )}
              </button>
            );
          })}
        </div>

        <div
          id="home-sessions-panel"
          role="tabpanel"
          aria-labelledby={`home-tab-${tab}`}
          className="mt-[14px] md:mt-[24px]"
        >
          {all.length === 0 ? (
            <NoSessions message={EMPTY[tab]} />
          ) : (
            <ul className="grid list-none gap-[12px] md:grid-cols-2 md:gap-[20px]">
              {shown.map((i) => (
                <Fragment key={i.key}>{i.node}</Fragment>
              ))}
            </ul>
          )}

          {tab === "live" && hasOnlineSessions && all.length > 0 && (
            <p className="mt-[12px] text-[16px] leading-[1.7] text-pretty text-brown-700">
              線上直播的上課連結，會在開課前用 Email 或 LINE 傳給你。
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
