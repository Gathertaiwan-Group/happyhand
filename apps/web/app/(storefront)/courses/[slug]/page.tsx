import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getProduct,
  getPublishedSlugs,
  getSiteSetting,
  type TeacherSetting,
} from "@/lib/data";
import { TEACHER, FAQS } from "@/lib/content";
import { SITE, formatPrice } from "@/lib/site";
import { Figure } from "@/components/ui/placeholder";
import { Accordion } from "@/components/ui/accordion";
import { buttonClass } from "@/components/ui/button";
import { LessonList } from "../_components/lesson-list";
import { AddToCartButton } from "../_components/add-to-cart-button";
import { CourseBuyBar } from "../_components/course-buy-bar";
import { formatTotalDuration } from "../_components/format";

export const revalidate = 300;

/**
 * 明寫出來當文件：後台新增的課程在下一次 revalidate 之前會走 on-demand 渲染，
 * 不會因為不在這份清單裡就 404。
 */
export const dynamicParams = true;

export async function generateStaticParams() {
  const slugs = await getPublishedSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProduct(slug);
  if (!product) return { title: "找不到這堂課" };

  return {
    title: product.title,
    description: product.description,
    openGraph: {
      title: `${product.title}｜${SITE.brandZh}`,
      description: product.description,
      type: "article",
    },
  };
}

/** 單一課程頁（設計稿 338–463 行：桌機 344–408、手機 410–461） */
export default async function CourseDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  /*
    講師照放在 site_settings.teacher，不在 lib/content.ts 的靜態 TEACHER 裡。
    這一頁原本只讀靜態常數，所以下面那個 <Figure> 從來沒拿到 src ——
    資料庫裡明明有一張真的照片，這頁卻一直畫斜紋佔位圖。
    文字仍沿用靜態 TEACHER（那是這一頁的既有行為，不在這次的範圍內），
    只把照片接上。
  */
  const [product, teacher] = await Promise.all([
    getProduct(slug),
    getSiteSetting<TeacherSetting>("teacher"),
  ]);
  if (!product) notFound();

  const lessons = product.lessons ?? [];
  const meta = [
    ...(lessons.length
      ? [
          `${lessons.length} 堂課`,
          `總長 ${formatTotalDuration(lessons.map((l) => l.duration_sec))}`,
        ]
      : []),
    ...product.benefits,
  ];

  return (
    <>
      <div className="pb-action-bar">
        <div className="mx-auto max-w-maxw px-[20px] md:px-[40px]">
          {/* 麵包屑：設計稿 353 行 */}
          <nav
            aria-label="麵包屑"
            className="t-caption py-[8px] text-brown-500 md:py-[12px]"
          >
            <Link
              href="/courses?cat=recorded"
              className="inline-block py-[11px] text-brown-700 underline-offset-4 hover:text-caramel-dk hover:underline"
            >
              預錄課程
            </Link>
            <span aria-hidden className="px-[6px] text-brown-300">
              ／
            </span>
            <span aria-current="page">{product.title}</span>
          </nav>

          {/* 桌機 1.15fr / .85fr 兩欄；平板與手機單欄，購買卡插在簡介之後 */}
          <div className="grid gap-[28px] pb-[40px] lg:grid-cols-[1.15fr_.85fr] lg:gap-[48px] lg:pb-[72px]">
            {/* 左欄上半：封面 + 標題 + 簡介（設計稿 356–363） */}
            <div className="lg:col-start-1 lg:row-start-1">
              <Figure
                src={product.cover_url}
                alt={`${product.title} 課程封面`}
                label="課程封面"
                rounded="rounded-card"
                className="aspect-[16/9] w-full"
                sizes="(min-width: 1280px) 660px, 100vw"
                priority
              />

              <p className="t-caption mt-[20px] text-caramel-ink md:mt-[24px]">
                {product.tags.join("・")}
              </p>

              <h1 className="mt-[8px] font-serif text-[26px] leading-[1.5] font-semibold text-brown-900 md:text-[34px] lg:text-[40px] lg:leading-[1.4]">
                {product.title}
              </h1>

              <p className="t-body mt-[14px] text-brown-500 md:mt-[18px]">
                {product.description}
              </p>

              {meta.length ? (
                <ul className="mt-[16px] flex flex-wrap gap-[10px] md:mt-[24px] md:gap-[32px]">
                  {meta.map((m) => (
                    <li
                      key={m}
                      className="rounded-pill bg-cream-100 px-[14px] py-[8px] text-[16px] text-brown-500 md:bg-transparent md:px-0 md:py-0 md:text-[17px]"
                    >
                      {m}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            {/* 右欄：sticky 購買卡（設計稿 393–405） */}
            <aside
              aria-label="購買資訊"
              className="lg:col-start-2 lg:row-span-2 lg:row-start-1"
            >
              <div className="rounded-card border border-sand-500 bg-cream-200 p-[24px] md:p-[30px] lg:sticky lg:top-[24px]">
                <p className="flex items-baseline gap-[12px]">
                  <span className="font-serif text-[32px] font-semibold text-caramel-ink">
                    {formatPrice(product.price)}
                  </span>
                  {product.compare_at_price ? (
                    <span className="text-[17px] text-brown-300">
                      <span className="sr-only">原價 </span>
                      <span className="line-through">
                        {formatPrice(product.compare_at_price)}
                      </span>
                    </span>
                  ) : null}
                </p>

                {/* 手機的加入購物車在底部固定列，這裡不重複出現，避免兩個狀態各走各的 */}
                <AddToCartButton
                  product={product}
                  className="mt-[20px] hidden md:block"
                />

                <a
                  href={SITE.lineHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClass({
                    variant: "outline",
                    size: "md",
                    fullWidth: true,
                    className: "mt-[20px] md:mt-[10px]",
                  })}
                >
                  先用 LINE 問問
                  <span className="sr-only">（會開啟 LINE）</span>
                </a>

                <ul className="mt-[24px] flex flex-col gap-[12px] border-t border-sand-300 pt-[20px] text-[17px] leading-[1.6] text-brown-700">
                  {product.benefits.map((b) => (
                    <li key={b}>
                      <span aria-hidden className="text-caramel-ink">
                        ・
                      </span>
                      {b}
                    </li>
                  ))}
                </ul>

                <p className="mt-[20px] rounded-input bg-cream-100 px-[18px] py-[16px] text-[16px] leading-[1.8] text-brown-500">
                  不會線上付款也沒關係，
                  <a
                    href={SITE.lineHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="-my-[7px] inline-block py-[11px] whitespace-nowrap text-brown-700 underline underline-offset-4 hover:text-caramel-dk"
                  >
                    用 LINE 問我們
                    <span className="sr-only">（會開啟 LINE）</span>
                  </a>
                  ，我們幫你處理。
                </p>
              </div>
            </aside>

            {/* 左欄下半：單元列表 + 老師 + FAQ */}
            <div className="lg:col-start-1 lg:row-start-2">
              {lessons.length ? (
                <section aria-labelledby="lessons-heading">
                  <h2
                    id="lessons-heading"
                    className="font-serif text-[22px] font-semibold text-brown-900 md:text-[28px]"
                  >
                    課程內容
                  </h2>
                  <LessonList lessons={lessons} />
                </section>
              ) : null}

              {/* 老師簡介：設計稿 384–391（桌機）／446–452（手機） */}
              <section
                aria-labelledby="teacher-heading"
                className="mt-[32px] rounded-card bg-cream-100 p-[26px_20px] md:mt-[40px] md:p-[34px_32px]"
              >
                <div className="grid grid-cols-[76px_1fr] items-start gap-[16px] md:grid-cols-[120px_1fr] md:items-center md:gap-[26px]">
                  <Figure
                    src={teacher?.photo_url}
                    alt={`${teacher?.name ?? TEACHER.name} 照片`}
                    rounded="rounded-full"
                    className="h-[76px] w-[76px] md:h-[120px] md:w-[120px]"
                    sizes="120px"
                    // 講師照是 4:5 直式，放進圓形（等於方框）置中裁切會切掉頭頂。
                    // 與 workshops/_components/content-sections.tsx 的講師區同樣處理。
                    objectPosition="object-top"
                  />
                  <div>
                    <p className="t-eyebrow hidden text-caramel-ink md:block">
                      {TEACHER.eyebrow}
                    </p>
                    <h2
                      id="teacher-heading"
                      className="font-serif text-[19px] text-brown-900 md:mt-[8px] md:text-[24px]"
                    >
                      {TEACHER.name}
                    </h2>
                    {TEACHER.paragraphs.map((p, i) => (
                      <p
                        key={i}
                        className="mt-[10px] text-[16.5px] leading-[1.9] text-brown-500 md:text-[17.5px] md:leading-[1.95]"
                      >
                        {p}
                      </p>
                    ))}
                  </div>
                </div>
              </section>

              {/* 常見問題：取前 4 題 */}
              <section aria-labelledby="faq-heading" className="mt-[32px] md:mt-[44px]">
                <h2
                  id="faq-heading"
                  className="font-serif text-[22px] font-semibold text-brown-900 md:text-[28px]"
                >
                  常見問題
                </h2>
                <Accordion items={FAQS.slice(0, 4)} className="mt-[18px]" />
              </section>
            </div>
          </div>

          <p className="t-caption border-t border-sand-300 py-[20px] text-brown-500">
            {SITE.disclaimer}
          </p>
        </div>
      </div>

      <CourseBuyBar product={product} />
    </>
  );
}
