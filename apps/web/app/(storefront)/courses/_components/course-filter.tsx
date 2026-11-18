"use client";

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
  { key: "new", label: NEW_TAG },
  ...CATEGORY_ORDER.map((c) => ({ key: c, label: CATEGORY_LABEL[c] })),
];

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

      <div
        role="group"
        aria-label="課程分類"
        className="flex gap-[10px] overflow-x-auto px-[20px] pt-[20px] pb-[8px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:justify-center md:gap-[12px] md:px-[40px] md:pt-[32px]"
      >
        {filters.map((f) => {
          const isActive = f.key === active;
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => select(f.key)}
              className={[
                "inline-flex min-h-[56px] shrink-0 items-center rounded-pill border px-[26px] text-[17px] whitespace-nowrap transition-colors duration-200",
                isActive
                  ? "border-caramel-ink bg-caramel-ink text-white"
                  : "border-sand-500 bg-cream-200 text-brown-500 hover:bg-cream-300",
              ].join(" ")}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      <p aria-live="polite" className="sr-only">
        目前顯示 {list.length} 項課程
      </p>

      <div className="fab-safe mx-auto grid max-w-[1180px] grid-cols-1 gap-[14px] px-[20px] pt-[20px] pb-[32px] md:grid-cols-2 md:gap-[24px] md:px-[40px] md:pt-[36px] md:pb-[64px] lg:grid-cols-3">
        {list.map((p) => (
          <CourseCard key={p.slug} product={p} />
        ))}

        {list.length === 0 ? (
          <p className="t-body text-brown-500 md:col-span-2 lg:col-span-3">
            這個分類目前沒有課程，可以先看看其他分類。
          </p>
        ) : null}

        {/* 每頁都要有的「用 LINE 問」出口（設計稿 273–277） */}
        <div className="flex flex-col items-center justify-center rounded-[20px] border border-dashed border-sand-400 bg-cream-100 p-[28px] text-center md:rounded-card md:p-[32px]">
          <h3 className="font-serif text-[19px] leading-[1.5] text-brown-900 md:text-[21px] md:leading-[1.55]">
            不確定從哪堂開始？
          </h3>
          <p className="mt-[10px] text-[17px] leading-[1.9] text-brown-500">
            用 LINE 問我們，有真人陪你挑。
          </p>
          <a
            href={SITE.lineHref}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass({
              variant: "outline",
              className: "mt-[16px]",
            })}
          >
            用 LINE 問我們
            <span className="sr-only">（會開啟 LINE）</span>
          </a>
        </div>
      </div>
    </section>
  );
}
