import Link from "next/link";
import { Figure } from "@/components/ui/placeholder";
import { buttonClass } from "@/components/ui/button";
import { formatPrice } from "@/lib/site";
import type { ProductWithSessions } from "@/lib/data";
import { cardTagLine } from "@/lib/course-category";

/**
 * 課程卡（設計稿 195–466 行 /courses 區塊、桌機 223–232、手機 301–309）
 * 沿用首頁課程卡語彙：外框 sand-500、radius 22px（手機 20px）、
 * hover 上浮 4px + shadow-card。
 * 整張卡可點：CTA 用 `after:inset-0` 撐滿卡片，但語意上仍只有一個連結。
 */
export function CourseCard({ product }: { product: ProductWithSessions }) {
  const isWorkshop = product.type === "workshop";
  const href = isWorkshop ? "/workshops" : `/courses/${product.slug}`;
  const cta = isWorkshop
    ? "看場次"
    : product.type === "subscription"
      ? "了解計畫"
      : "了解課程";

  return (
    <article className="relative flex flex-col overflow-hidden rounded-[20px] border border-sand-500 bg-white transition duration-200 hover:-translate-y-1 hover:shadow-card md:rounded-card">
      <Figure
        src={product.cover_url}
        alt={`${product.title} 課程封面`}
        className="aspect-[16/9] w-full md:aspect-[16/10]"
        sizes="(min-width: 1280px) 340px, (min-width: 768px) 45vw, 100vw"
      />

      <div className="flex flex-1 flex-col p-[20px] md:p-[24px]">
        {/* 第一個詞是分類（預錄課程／線上直播／線下工作坊），由型態與場次形式產生；
            後台自由標籤裡的分類字眼（「線上課程」「實體工作坊」…）不再照印，
            免得跟分類打架。見 lib/course-category.ts */}
        <p className="t-caption text-caramel-ink">{cardTagLine(product)}</p>

        <h3 className="mt-[8px] font-serif text-[19px] leading-[1.5] text-brown-900 md:mt-[10px] md:text-[21px] md:leading-[1.55]">
          {product.title}
        </h3>

        <p className="mt-[10px] text-[17px] leading-[1.9] text-brown-500">
          {product.subtitle}
        </p>

        <div className="mt-auto pt-[16px]">
          <p className="flex items-baseline gap-[10px]">
            <span className="font-serif text-[23px] font-semibold text-caramel-ink md:text-[25px]">
              {formatPrice(product.price)}
            </span>
            {product.compare_at_price ? (
              <span className="text-[16px] text-brown-300">
                <span className="sr-only">原價 </span>
                <span className="line-through">
                  {formatPrice(product.compare_at_price)}
                </span>
              </span>
            ) : null}
          </p>

          <Link
            href={href}
            aria-label={`${cta}：${product.title}`}
            className={buttonClass({
              variant: product.featured ? "primary" : "outline",
              size: "md",
              fullWidth: true,
              className:
                "mt-[16px] after:absolute after:inset-0 after:content-['']",
            })}
          >
            {cta}
          </Link>
        </div>
      </div>
    </article>
  );
}
