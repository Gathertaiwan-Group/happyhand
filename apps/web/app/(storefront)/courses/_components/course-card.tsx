import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Figure } from "@/components/ui/placeholder";
import { formatPrice } from "@/lib/site";
import type { ProductWithSessions } from "@/lib/data";
import { cardTagLine } from "@/lib/course-category";
import { productDetailHref } from "@/lib/content";

/**
 * 課程卡。首頁「預錄課程」與 /courses 共用。
 *
 * 2026-11-18 手機版改版：
 * - 手機（< 768px）改成「左圖右文」的橫式卡（參考 Hahow 課程列表、Udemy），
 *   一屏看得到三到四門課；以前是 16:9 大圖＋滿版按鈕，一屏只有一門。
 *   封面是 16:9，但本來就設計成能吃正方形置中裁切（購物車、結帳也是這樣裁）。
 * - 桌機（>= 768px）維持直式卡：圖在上、按鈕在下。
 * - 資訊層級：分類 → 課名（最多兩行）→ 一句話 → 價格。整張卡可點。
 */
export function CourseCard({
  product,
  headingLevel = "h3",
}: {
  product: ProductWithSessions;
  headingLevel?: "h2" | "h3";
}) {
  const isWorkshop = product.type === "workshop";
  // 工作坊以前連到 /workshops 整張場次表，客人得再找一次是哪一門。
  // 現在直接進那門課自己的介紹頁（上面就有場次與報名）。
  const href = productDetailHref(product) ?? `/courses/${product.slug}`;
  const cta = isWorkshop
    ? "看場次"
    : product.type === "subscription"
      ? "了解計畫"
      : "了解課程";
  const H = headingLevel;

  return (
    <article className="relative flex gap-[14px] overflow-hidden rounded-[18px] border border-sand-300 bg-white p-[12px] transition duration-200 hover:border-caramel hover:shadow-card md:flex-col md:gap-0 md:rounded-card md:border-sand-500 md:p-0 md:hover:-translate-y-1">
      <Figure
        src={product.cover_url}
        alt=""
        rounded="rounded-[12px] md:rounded-none"
        className="h-[108px] w-[108px] shrink-0 md:aspect-[16/10] md:h-auto md:w-full"
        sizes="(min-width: 1280px) 340px, (min-width: 768px) 45vw, 108px"
      />

      <div className="flex min-w-0 flex-1 flex-col md:p-[24px]">
        {/* 第一個詞是分類（預錄課程／線上直播／線下工作坊），由型態與場次形式產生，
            見 lib/course-category.ts */}
        <p className="truncate text-[15px] leading-[1.6] text-caramel-dk md:text-[16px]">
          {cardTagLine(product)}
        </p>

        <H className="mt-[2px] line-clamp-2 font-serif text-[18px] leading-[1.45] font-semibold text-brown-900 md:mt-[8px] md:text-[21px] md:leading-[1.5]">
          {product.title}
        </H>

        {product.subtitle && (
          <p className="mt-[2px] line-clamp-1 text-[16px] leading-[1.6] text-brown-500 md:mt-[8px] md:line-clamp-2 md:text-[17px] md:leading-[1.8]">
            {product.subtitle}
          </p>
        )}

        <div className="mt-auto flex items-center justify-between gap-[8px] pt-[6px] md:block md:pt-[16px]">
          <p className="flex flex-wrap items-baseline gap-x-[8px]">
            <span className="font-serif text-[20px] font-semibold text-caramel-dk md:text-[25px]">
              {formatPrice(product.price)}
            </span>
            {product.compare_at_price ? (
              <span className="text-[15px] text-brown-500 md:text-[16px]">
                <span className="sr-only">原價 </span>
                <span className="line-through">
                  {formatPrice(product.compare_at_price)}
                </span>
              </span>
            ) : null}
          </p>

          {/* 唯一的連結。after:inset-0 撐滿整張卡，點哪裡都可以進去。
              手機是行內的「了解課程 ›」，桌機是滿版按鈕。 */}
          <Link
            href={href}
            aria-label={`${cta}：${product.title}`}
            className={[
              "inline-flex shrink-0 items-center gap-[2px] text-[16px] font-medium whitespace-nowrap text-brown-900",
              "after:absolute after:inset-0 after:content-['']",
              "md:mt-[16px] md:flex md:min-h-[56px] md:w-full md:justify-center md:rounded-pill md:text-[18px] md:font-normal md:transition-colors md:duration-200",
              product.featured
                ? "md:bg-caramel-ink md:text-white md:hover:bg-caramel-dk"
                : "md:border-2 md:border-sand-400 md:hover:bg-[#F5E7CE]",
            ].join(" ")}
          >
            {cta}
            <ChevronRight aria-hidden="true" strokeWidth={2} className="h-[18px] w-[18px] md:hidden" />
          </Link>
        </div>
      </div>
    </article>
  );
}
