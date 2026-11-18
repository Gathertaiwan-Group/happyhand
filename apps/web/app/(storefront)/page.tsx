import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { LinkButton } from "@/components/ui/button";
import { Figure } from "@/components/ui/placeholder";
import { MobileActionBar } from "@/components/mobile-action-bar";
import { REASONS, TEACHER } from "@/lib/content";
import {
  getProducts,
  getSiteSetting,
  getWorkshopSessions,
  type TeacherSetting,
} from "@/lib/data";
import { SITE, formatPrice } from "@/lib/site";
import { HomeWorkshops } from "./_components/home-workshops";

/**
 * 首頁 /
 * 設計稿：design_handoff_happyhands/design/happyhands-B-all-pages.dc.html
 *   桌機 1240px：L41–123　手機 390px：L135–188
 * 規格：README §4.1
 * Nav / Footer 由 app/layout.tsx 提供，本頁不重複。
 */
export const metadata: Metadata = {
  // title 沿用 layout 的預設值（首頁不套 "%s｜快樂手" 模板）
  description:
    "快樂手是柳樺老師的仁神術（JSJ）練習。每天十分鐘、坐著也能做、有人陪著練；線上課程與台北實體工作坊，把手放在自己身上，慢慢把緊繃的地方鬆開。",
  alternates: { canonical: "/" },
};

/**
 * 首頁課程卡改成 5 分鐘一次的 ISR：後台改了課程最多五分鐘就會反映，
 * 而頁面仍然是靜態產出（不是每個請求都打資料庫）。
 */
export const revalidate = 300;

/**
 * 首頁精選課程的順序依設計稿；中間那張手機不顯示（設計稿手機只放兩張）。
 * 順序是設計決定所以留在程式碼裡，但「有哪些課、叫什麼、賣多少」一律讀資料庫。
 * 名單裡的課若被下架就自動跳過，再用 is_featured / sort_order 補到三張。
 */
const HOME_COURSE_SLUGS: { slug: string; hideOnMobile?: boolean }[] = [
  { slug: "self-help-book-28-lessons" },
  { slug: "jsj-beginner", hideOnMobile: true },
  { slug: "main-central-flow" },
];

/** footerLine 內的 LINE ID 要能直接點開，把字串切成「前段 / LINE ID / 後段」 */
const [footerLineBeforeLine, footerLineAfterLine] = SITE.footerLine.split(
  SITE.lineId,
);

export default async function HomePage() {
  // 併成一次 Promise.all：三個查詢彼此無關，串著等會多花兩趟往返
  const [all, sessions, teacher] = await Promise.all([
    getProducts(),
    getWorkshopSessions(),
    getSiteSetting<TeacherSetting>("teacher"),
  ]);
  const courses = all.filter((p) => p.type === "course");

  // 只有 type=workshop 的商品有單場詳情頁。讀脈入門課是 course 卻掛著實體場次，
  // 它的標題不能連到 /workshops/[slug]，否則是 404。與 /workshops 列表頁同一套判斷。
  const workshopSlugs = new Set(
    all.filter((p) => p.type === "workshop").map((p) => p.slug),
  );

  const picked = HOME_COURSE_SLUGS.flatMap(({ slug, hideOnMobile }) => {
    const product = courses.find((p) => p.slug === slug);
    return product ? [{ product, hideOnMobile: Boolean(hideOnMobile) }] : [];
  });

  // 指定的課被下架時補上精選課，湊滿三張；補進來的一律顯示（不隱藏）
  const filler = courses
    .filter((p) => !picked.some((x) => x.product.slug === p.slug))
    .sort((a, b) => Number(b.featured) - Number(a.featured))
    .slice(0, Math.max(0, 3 - picked.length))
    .map((product) => ({ product, hideOnMobile: false }));

  const HOME_COURSES = [...picked, ...filler];

  return (
    <div className="pb-action-bar">
      {/* ── 1. Hero ── 設計稿 L41–54（桌機）／L135–146（手機） */}
      <section
        aria-labelledby="hero-title"
        className="relative overflow-hidden px-[22px] pt-[40px] pb-[52px] text-center md:px-[40px] md:pt-[86px] md:pb-[92px]"
      >
        <div
          aria-hidden="true"
          className="halo-bg pointer-events-none absolute top-[10px] left-1/2 h-[420px] w-[420px] -translate-x-1/2 rounded-full md:top-[30px] md:h-[660px] md:w-[660px]"
        />
        <div className="relative mx-auto max-w-maxw">
          {/* 品牌標記。logo-mark.png 是去背過的墨圈，四周留了 6% 白邊，
              所以不會被 rounded-full 切到外緣。 */}
          <Image
            src="/logo-mark.png"
            alt="快樂手 Happy Healing Hands"
            width={691}
            height={691}
            priority
            sizes="(min-width: 768px) 210px, 140px"
            className="mx-auto h-[140px] w-[140px] md:h-[210px] md:w-[210px]"
          />
          <h1 id="hero-title" className="t-h1 pt-[26px] md:pt-[38px]">
            身體會記得
            <br />
            被好好對待的感覺
          </h1>
          <p className="t-body-lg mx-auto mt-[18px] max-w-[640px] text-pretty text-brown-500 md:mt-[26px]">
            快樂手是柳樺老師的仁神術（JSJ）練習。不需要體力、不需要器材，把手放在自己身上，慢慢把緊繃的地方鬆開。
          </p>
          <div className="mt-[24px] flex flex-col gap-[10px] md:mt-[38px] md:flex-row md:justify-center md:gap-[16px]">
            <LinkButton
              href="/courses"
              variant="primary"
              size="lg"
              className="w-full md:w-auto"
            >
              開始線上練習
            </LinkButton>
            <LinkButton
              href="/workshops"
              variant="outline"
              size="lg"
              className="w-full md:w-auto"
            >
              預約直播或工作坊
            </LinkButton>
          </div>
        </div>
      </section>

      {/* ── 2. 三項理由 ── 設計稿 L56–72（桌機）／L147–163（手機） */}
      <section aria-label="快樂手的三個特點" className="border-t border-sand-300">
        <ul className="mx-auto max-w-maxw md:grid md:grid-cols-3">
          {REASONS.map((reason, i) => (
            <li
              key={reason.no}
              className={`border-b border-sand-300 px-[24px] py-[30px] text-center md:border-b-0 md:px-[40px] md:py-[52px] ${
                i < REASONS.length - 1 ? "md:border-r md:border-sand-300" : ""
              }`}
            >
              <span
                aria-hidden="true"
                className="block font-serif text-[28px] text-caramel-ink md:text-[36px]"
              >
                {reason.no}
              </span>
              <h2 className="t-h3 pt-[8px] md:pt-[14px]">{reason.title}</h2>
              <p className="t-body-sm mt-[8px] text-pretty text-brown-500 md:mt-[12px]">
                {reason.desc}
              </p>
            </li>
          ))}
        </ul>
      </section>

      {/* ── 3. 課程卡 ── 設計稿 L74–105（桌機）／L164–184（手機）
          一門課都沒有時整段不渲染：留一個「從哪一堂開始都可以」配空白格
          比直接不出現還糟。 */}
      {HOME_COURSES.length > 0 && (
      <section
        aria-labelledby="courses-title"
        className="bg-cream-100 px-[20px] pt-[40px] pb-[96px] md:px-[40px] md:py-[76px]"
      >
        <div className="mx-auto max-w-[1080px]">
          <div className="text-center">
            <p className="t-eyebrow text-caramel-ink">COURSES</p>
            <h2 id="courses-title" className="t-h2 pt-[8px] md:pt-[12px]">
              從哪一堂開始都可以
            </h2>
          </div>

          <ul className="mt-[22px] grid gap-[14px] md:mt-[40px] md:grid-cols-2 md:gap-[24px] lg:grid-cols-3">
            {HOME_COURSES.map(({ product, hideOnMobile }) => {
              const featured = Boolean(product.featured);
              return (
                <li
                  key={product.slug}
                  className={hideOnMobile ? "hidden md:flex" : "flex"}
                >
                  <article
                    className={`flex w-full flex-col rounded-card bg-white px-[30px] py-[34px] text-center transition duration-200 hover:-translate-y-1 hover:shadow-card ${
                      featured
                        ? "border-2 border-caramel"
                        : "border border-sand-500"
                    }`}
                  >
                    <Figure
                      /* /courses、/courses/[slug]、/account 都有傳 cover_url，
                         只有首頁漏掉 —— 後台上傳封面之後這裡不會跟著換。 */
                      src={product.cover_url}
                      rounded="rounded-full"
                      alt={`${product.title} 課程縮圖`}
                      className="mx-auto h-[76px] w-[76px] shrink-0 md:h-[96px] md:w-[96px]"
                      sizes="96px"
                    />
                    <h3 className="mt-[16px] font-serif text-[19px] leading-[1.55] md:mt-[22px] md:text-[22px]">
                      {product.title}
                    </h3>
                    <p className="mt-[12px] text-[17px] leading-[1.9] text-pretty text-brown-500">
                      {product.subtitle}
                    </p>
                    <p className="mt-[12px] flex items-baseline justify-center gap-[10px] md:mt-[16px]">
                      <span className="font-serif text-[23px] text-caramel-ink md:text-[26px]">
                        {formatPrice(product.price)}
                      </span>
                      {product.compare_at_price ? (
                        <span className="text-[16px] text-brown-300 line-through">
                          {formatPrice(product.compare_at_price)}
                        </span>
                      ) : null}
                    </p>
                    <div className="mt-auto pt-[14px] md:pt-[18px]">
                      <LinkButton
                        href={`/courses/${product.slug}`}
                        variant={featured ? "primary" : "outline"}
                        className="w-full md:w-auto"
                      >
                        了解課程
                      </LinkButton>
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        </div>
      </section>
      )}

      {/* ── 3.5 工作坊 ── 設計稿沒有這一段，是後來補的。
          放在課程與老師之間：線上課是低門檻入口，工作坊是更高的承諾，
          而且它有「特定日期 + 剩幾位」這種線上課沒有的具體性。
          先讓人看到具體的東西，再用老師那段收信任。 */}
      <HomeWorkshops sessions={sessions} workshopSlugs={workshopSlugs} />

      {/* ── 4. 老師 ── 設計稿 L107–118（桌機；手機稿未收錄本區，改上下堆疊） */}
      <section
        aria-labelledby="teacher-title"
        className="mx-auto grid max-w-[1100px] gap-[28px] px-[20px] py-[40px] md:grid-cols-[0.85fr_1.15fr] md:items-center md:gap-[56px] md:px-[40px] md:py-[80px]"
      >
        <Figure
          /* 照片放在 site_settings，後台 /admin/settings 換一次三頁一起換。
             沒設定時 Figure 自己會退回斜紋佔位圖。 */
          src={teacher?.photo_url}
          rounded="rounded-[999px_999px_28px_28px]"
          label="柳樺老師教學照"
          alt="劉柳樺老師教學照"
          className="mx-auto aspect-[4/5] w-full max-w-[300px] md:max-w-none"
          sizes="(min-width: 768px) 42vw, 300px"
        />
        <div>
          <p className="t-eyebrow text-caramel-ink">{TEACHER.eyebrow}</p>
          <h2 id="teacher-title" className="t-h2 pt-[14px]">
            {TEACHER.name}
          </h2>
          {TEACHER.paragraphs.map((paragraph, i) => (
            <p
              key={paragraph.slice(0, 8)}
              className={`t-body text-pretty text-brown-700 ${
                i === 0 ? "mt-[20px]" : "mt-[16px]"
              }`}
            >
              {paragraph}
            </p>
          ))}
          <Link
            href="/teachers"
            className="mt-[16px] inline-block border-b border-caramel pt-[11px] pb-[6px] text-[18px] text-brown-900 transition-colors duration-200 hover:text-caramel-ink"
          >
            看完整師資介紹 →
          </Link>
        </div>
      </section>

      {/* ── 5. Footer CTA 帶 ── 設計稿 L120–123 */}
      <section
        aria-labelledby="contact-title"
        className="bg-caramel px-[20px] py-[40px] text-center text-white md:px-[40px] md:py-[64px]"
      >
        <div className="mx-auto max-w-maxw">
          <h2
            id="contact-title"
            className="font-serif text-[24px] leading-[1.4] font-medium md:text-[32px]"
          >
            想問什麼都可以，我們有真人回訊息
          </h2>
          <p className="mt-[12px] text-[18px] leading-[1.95]">
            {footerLineBeforeLine}
            {/* LINE ID 要能直接點開，行內連結補上下 padding 讓觸控區達 44px */}
            <a
              href={SITE.lineHref}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="用 LINE 聯絡我們（會開啟 LINE）"
              className="inline-block py-[9px] underline underline-offset-4 hover:text-cream-200"
            >
              {SITE.lineId}
            </a>
            {footerLineAfterLine}
          </p>
        </div>
      </section>

      {/* ── 6. 手機固定行動列 ── 設計稿 L185–188 */}
      <MobileActionBar href="/courses" label="開始線上練習" />
    </div>
  );
}
