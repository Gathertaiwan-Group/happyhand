"use client";

import { useMemo, useState } from "react";
import { buttonClass } from "@/components/ui/button";
import { SITE } from "@/lib/site";
import type { Product, ProductType } from "@/lib/content";
import { CourseCard } from "./course-card";

type FilterKey = "all" | ProductType;

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "course", label: "線上課程" },
  { key: "workshop", label: "工作坊" },
  { key: "subscription", label: "訂閱" },
];

/**
 * 前端篩選（設計稿 215–221 桌機膠囊列、294–299 手機橫向捲動）
 * 手機 chip 列可橫向捲動，但捲軸藏起來、也不會讓整頁出現橫向捲軸。
 */
export function CourseFilter({ products }: { products: Product[] }) {
  const [active, setActive] = useState<FilterKey>("all");

  const filters = useMemo(
    () =>
      FILTERS.filter(
        (f) => f.key === "all" || products.some((p) => p.type === f.key),
      ),
    [products],
  );

  const list = useMemo(
    () =>
      active === "all" ? products : products.filter((p) => p.type === active),
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
              onClick={() => setActive(f.key)}
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

      <div className="mx-auto grid max-w-[1180px] grid-cols-1 gap-[14px] px-[20px] pt-[20px] pb-[32px] md:grid-cols-2 md:gap-[24px] md:px-[40px] md:pt-[36px] md:pb-[64px] lg:grid-cols-3">
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
