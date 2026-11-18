"use client";

import { CircleHelp, LayoutGrid, MessageCircle, MonitorPlay, Sparkles, Users, Video, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { buttonClass } from "@/components/ui/button";
import { SITE } from "@/lib/site";
import type { ProductWithSessions } from "@/lib/data";
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  categoriesOf,
  categoryFromParams,
  type CourseCategory,
} from "@/lib/course-category";
import { CourseCard } from "./course-card";

type FilterKey = "all" | "new" | CourseCategory;

/**
 * 「近期新課」用標籤決定，不是用建立時間。
 *
 * Product 身上沒有 created_at，而且「新」本來就不等於「最近建的」——
 * 一門課可能先建成草稿擺兩個月才開賣。所以交給後台：課程標籤填
 * NEW_TAG 的就會收進這個分類，不新了把標籤拿掉即可，不用改程式。
 */
const NEW_TAG = "近期新課";

const isNew = (p: ProductWithSessions) => p.tags.includes(NEW_TAG);

/**
 * 分類鈕：全部／近期新課／預錄課程／線上直播／線下工作坊。
 * 後三個由型態 + 場次形式決定（lib/course-category.ts），不看自由標籤。
 * 以前的「訂閱」併進預錄課程（2026-11-18 業主定的分類）。
 */
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "全部" },
  ...CATEGORY_ORDER.map((c) => ({ key: c, label: CATEGORY_LABEL[c] })),
  // 2026-11-18：「近期新課」移到最後。三種上課方式才是主要的找課方式。
  { key: "new", label: NEW_TAG },
];

/** 每一類的一句話說明，選了之後出現在分類鈕下面（取代以前標題帶的長段落）。 */
const HINT: Partial<Record<FilterKey, string>> = {
  recorded: "永久回放・隨時倒帶",
  live: "在家開視訊・跟老師即時練",
  onsite: "小班面對面・工具講義備好",
};

/** 分類鈕的圖示：三類跟首頁入口同一組 */
const FILTER_ICON: Partial<Record<FilterKey, LucideIcon>> = {
  all: LayoutGrid,
  new: Sparkles,
  recorded: MonitorPlay,
  live: Video,
  onsite: Users,
};

const matches = (p: ProductWithSessions, key: FilterKey) =>
  key === "all" ||
  (key === "new" ? isNew(p) : categoriesOf(p).includes(key));

/**
 * 前端篩選（設計稿 215–221 桌機膠囊列、294–299 手機橫向捲動）
 * 手機 chip 列可橫向捲動，但捲軸藏起來、也不會讓整頁出現橫向捲軸。
 *
 * 網址帶 ?cat=recorded|live|onsite（導覽列「預錄課程」就是 /courses?cat=recorded）
 * 會預先選好那一類；舊寫法 ?type=course|subscription 也吃。按鈕切換時用
 * replaceState 同步網址，分享出去的連結會停在同一類。
 * 伺服器端不讀 searchParams，頁面維持靜態 —— 用到 useSearchParams 的這個元件
 * 在 page.tsx 包了 Suspense。
 */
export function CourseFilter({ products }: { products: ProductWithSessions[] }) {
  const params = useSearchParams();
  const fromUrl: FilterKey =
    params.get("cat") === "new"
      ? "new"
      : (categoryFromParams((k) => params.get(k)) ?? "all");
  return <CourseFilterView products={products} fromUrl={fromUrl} />;
}

/** Suspense 的 fallback（靜態 HTML）：先顯示全部，hydrate 後再套網址上的分類。 */
export function CourseFilterFallback({
  products,
}: {
  products: ProductWithSessions[];
}) {
  return <CourseFilterView products={products} fromUrl="all" />;
}

function CourseFilterView({
  products,
  fromUrl,
}: {
  products: ProductWithSessions[];
  fromUrl: FilterKey;
}) {
  const [active, setActive] = useState<FilterKey>(fromUrl);

  // 在同一頁上點導覽列（例如從 ?cat=recorded 回到 /courses）時跟著網址走
  useEffect(() => {
    setActive(fromUrl);
  }, [fromUrl]);

  const select = (key: FilterKey) => {
    setActive(key);
    const url = new URL(window.location.href);
    url.searchParams.delete("type");
    url.searchParams.delete("format");
    if (key === "all") url.searchParams.delete("cat");
    else url.searchParams.set("cat", key);
    window.history.replaceState(window.history.state, "", url);
  };

  const filters = useMemo(
    () =>
      FILTERS.filter((f) => {
        if (f.key === "all") return true;
        // 沒有任何課屬於這一類時不顯示晶片，免得按了是空的
        return products.some((p) => matches(p, f.key));
      }),
    [products],
  );

  const list = useMemo(
    () => products.filter((p) => matches(p, active)),
    [active, products],
  );

  return (
    <section aria-labelledby="course-list-heading">
      <h2 id="course-list-heading" className="sr-only">
        課程列表
      </h2>

      {/* 分類鈕。2026-11-18 手機版改版：以前是一排橫向捲動的膠囊，
          第三顆以後被切在螢幕外，長輩不知道還能往右滑。
          現在折行全部攤開（手機兩欄格狀），每顆都帶數量。 */}
      <div
        role="group"
        aria-label="課程分類"
        className="mx-auto grid max-w-[1080px] grid-cols-2 gap-[8px] px-[16px] pt-[16px] md:flex md:flex-wrap md:justify-center md:gap-[12px] md:px-[40px] md:pt-[28px]"
      >
        {filters.map((f) => {
          const isActive = f.key === active;
          const n = products.filter((p) => matches(p, f.key)).length;
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => select(f.key)}
              className={[
                "inline-flex min-h-[56px] items-center justify-center gap-[6px] rounded-pill border-2 px-[14px] text-[18px] whitespace-nowrap transition-colors duration-200 md:px-[26px]",
                // 手機兩欄：其餘按鈕是偶數顆時讓「全部」獨佔一排，格子才不會缺一角
                f.key === "all" && (filters.length - 1) % 2 === 0 ? "col-span-2" : "",
                isActive
                  ? "border-brown-900 bg-brown-900 font-medium text-white"
                  : "border-sand-400 bg-white text-brown-900 hover:border-caramel-ink",
              ].join(" ")}
            >
              {(() => {
                const FIcon = FILTER_ICON[f.key];
                return FIcon ? (
                  <FIcon aria-hidden="true" strokeWidth={1.8} className="h-[20px] w-[20px] shrink-0" />
                ) : null;
              })()}
              {f.label}
              <span className={`text-[16px] ${isActive ? "text-cream-200" : "text-brown-500"}`}>
                {n}
              </span>
            </button>
          );
        })}
      </div>

      {HINT[active] && (
        <p className="mx-auto max-w-[1080px] px-[16px] pt-[12px] text-[17px] leading-[1.7] text-brown-700 md:px-[40px] md:text-center">
          {HINT[active]}
        </p>
      )}

      <p aria-live="polite" className="sr-only">
        目前顯示 {list.length} 項課程
      </p>

      <div className="fab-safe mx-auto grid max-w-[1180px] grid-cols-1 gap-[12px] px-[16px] pt-[16px] pb-[32px] md:grid-cols-2 md:gap-[24px] md:px-[40px] md:pt-[32px] md:pb-[64px] lg:grid-cols-3">
        {list.map((p) => (
          <CourseCard key={p.slug} product={p} />
        ))}

        {list.length === 0 ? (
          <p className="t-body text-brown-500 md:col-span-2 lg:col-span-3">
            這個分類目前沒有課程，可以先看看其他分類。
          </p>
        ) : null}

        {/* 每頁都要有的「用 LINE 問」出口（設計稿 273–277） */}
        <div className="mt-[8px] flex flex-col items-center justify-center rounded-[18px] border border-dashed border-sand-400 bg-cream-100 p-[22px] text-center md:mt-0 md:rounded-card md:p-[32px]">
          <h3 className="flex items-center gap-[8px] font-serif text-[19px] leading-[1.5] text-brown-900 md:text-[21px] md:leading-[1.55]">
            <CircleHelp aria-hidden="true" strokeWidth={1.8} className="h-[22px] w-[22px] text-caramel-dk" />
            不知道選哪堂？
          </h3>
          <a
            href={SITE.lineHref}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass({
              variant: "outline",
              className: "mt-[14px] w-full md:w-auto",
            })}
          >
            <MessageCircle aria-hidden="true" strokeWidth={1.8} className="mr-[8px] h-[20px] w-[20px]" />
            用 LINE 問真人
            <span className="sr-only">（會開啟 LINE）</span>
          </a>
        </div>
      </div>
    </section>
  );
}
