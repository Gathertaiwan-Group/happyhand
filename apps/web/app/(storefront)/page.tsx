import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { Figure } from "@/components/ui/placeholder";
import { REASONS, TEACHER, detailHrefMap } from "@/lib/content";
import {
  getProducts,
  getSiteSetting,
  getWorkshopSessions,
  type TeacherSetting,
} from "@/lib/data";
import { SITE } from "@/lib/site";
import { HomeSessions } from "./_components/home-sessions";
import { SessionRow } from "./workshops/_components/session-row";
import { SessionCard } from "./workshops/_components/session-card";
import { CourseCard } from "./courses/_components/course-card";
import { CategoryTiles } from "./_components/category-tiles";
import { hasOnline } from "@/lib/session-format";
import { CATEGORY_HREF, sessionCategories } from "@/lib/course-category";

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
    "快樂手是柳樺老師的仁神術（JSJ）練習。每天十分鐘、坐著也能做、有人陪著練；預錄課程、線上直播與線下工作坊，把手放在自己身上，慢慢把緊繃的地方鬆開。",
  alternates: { canonical: "/" },
};

/**
 * 首頁課程卡改成 5 分鐘一次的 ISR：後台改了課程最多五分鐘就會反映，
 * 而頁面仍然是靜態產出（不是每個請求都打資料庫）。
 */
export const revalidate = 300;

/**
 * 首頁精選課程的順序依設計稿。2026-11-18 起手機改成橫式小卡，三張都顯示
 * （hideOnMobile 欄位保留但目前不使用）。
 * 順序是設計決定所以留在程式碼裡，但「有哪些課、叫什麼、賣多少」一律讀資料庫。
 * 名單裡的課若被下架就自動跳過，再用 is_featured / sort_order 補到三張。
 */
const HOME_COURSE_SLUGS: { slug: string; hideOnMobile?: boolean }[] = [
  { slug: "self-help-book-28-lessons" },
  { slug: "jsj-beginner", hideOnMobile: true },
  { slug: "main-central-flow" },
];

/**
 * 場次建立幾天內算「新開」。看的是 workshop_sessions.created_at（這一場什麼時候排出來），
 * 不是開課日期 —— 兩個月後才開的課，昨天剛排出來，對學生來說就是新的。
 */
const NEW_DAYS = 14;

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

  // 場次列的標題與「我要報名」要連到這門課自己的介紹頁。
  // workshop 走 /workshops/[slug]，course（讀脈入門課就是 course 卻掛著實體場次）
  // 走 /courses/[slug] —— 以前這裡只認 workshop，讀脈那一列就只能直接進購物車。
  const detailHrefs = detailHrefMap(all);

  // 「新開」：場次建立 NEW_DAYS 天內。用 render 當下的時間算 —— 頁面是 ISR，
  // 最多晚五分鐘（加上 stale-while-revalidate 的那一位訪客）才翻過去，夠用。
  const newSince = Date.now() - NEW_DAYS * 24 * 60 * 60 * 1000;
  const sessionItems = sessions.map((s) => {
    const key = s.id ?? `${s.slug}-${s.starts_at}`;
    const isNew = s.createdAt ? Date.parse(s.createdAt) >= newSince : false;
    const href = detailHrefs.get(s.slug);
    return {
      key,
      cats: sessionCategories(s.format),
      isNew,
      // 有介紹頁可去 → 整張可點的列表卡；查不到商品（沒有介紹頁）才退回舊的場次列，
      // 它會直接給加入購物車／LINE 的按鈕。
      node: href ? (
        <SessionCard
          key={key}
          session={s}
          isNew={isNew}
          showProductName
          detailHref={href}
        />
      ) : (
        <SessionRow key={key} session={s} isNew={isNew} showProductName compact detailHref={null} />
      ),
    };
  });

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

  // 第一屏三類入口旁的數字（桌機才顯示）
  const counts = {
    recorded: courses.length,
    live: sessions.filter((s) => sessionCategories(s.format).includes("live")).length,
    onsite: sessions.filter((s) => sessionCategories(s.format).includes("onsite")).length,
  };

  return (
    <div>
      {/* ── 1. 開場＋三類課程入口 ──
          2026-11-18 手機版改版：業主說手機版「不好閱讀、找不到課」。
          參考 PressPlay／MasterClass，第一屏先給「三種上課方式」的入口，
          品牌標語縮成一行小標，墨圈只在桌機出現（手機頁首已經有字標）。
          下一段「近期開課」仍然在手機 390×844 的第一屏露出開頭。 */}
      <section
        aria-labelledby="hero-title"
        className="relative overflow-hidden bg-cream-100 px-[16px] pt-[20px] pb-[22px] md:px-[40px] md:pt-[44px] md:pb-[44px]"
      >
        <div
          aria-hidden="true"
          className="halo-bg pointer-events-none absolute top-[-80px] left-1/2 hidden h-[520px] w-[520px] -translate-x-1/2 rounded-full md:block"
        />
        <div className="relative mx-auto max-w-[1080px]">
          <div className="text-center">
            <Image
              src="/logo-mark.png"
              alt=""
              width={691}
              height={691}
              priority
              sizes="72px"
              className="mx-auto hidden h-[72px] w-[72px] md:block"
            />
            <h1
              id="hero-title"
              className="font-serif text-[24px] leading-[1.5] font-medium tracking-[0.04em] text-brown-900 md:mt-[12px] md:text-[42px]"
            >
              身體會記得被好好對待的感覺
            </h1>
            <p className="mx-auto mt-[4px] max-w-[760px] text-[17px] leading-[1.75] text-pretty text-brown-700 md:mt-[10px] md:text-[19px]">
              柳樺老師的仁神術（JSJ）練習<span className="hidden md:inline">。不需要體力、不需要器材，把手放在自己身上，慢慢把緊繃的地方鬆開</span>
            </p>
          </div>

          <h2 className="mt-[18px] mb-[10px] text-[17px] font-medium text-brown-900 md:mt-[32px] md:mb-[16px] md:text-center md:text-[19px]">
            想怎麼上課？
          </h2>
          <CategoryTiles counts={counts} />
        </div>
      </section>

      {/* ── 2. 近期開課（線上直播／線下工作坊）── */}
      <HomeSessions
        items={sessionItems}
        hasOnlineSessions={sessions.some((s) => hasOnline(s.format))}
      />

      {/* ── 3. 預錄課程 ── 手機是左圖右文的橫式卡（三門都顯示），桌機三欄直式卡。
          一門課都沒有時整段不渲染。 */}
      {HOME_COURSES.length > 0 && (
        <section
          aria-labelledby="courses-title"
          className="border-t border-sand-300 bg-cream-100 px-[16px] pt-[28px] pb-[36px] md:px-[40px] md:py-[64px]"
        >
          <div className="mx-auto max-w-[1080px]">
            <div className="flex items-end justify-between gap-[12px]">
              <h2
                id="courses-title"
                className="font-serif text-[23px] leading-[1.4] font-semibold text-brown-900 md:text-[30px]"
              >
                預錄課程
              </h2>
              <Link
                href={CATEGORY_HREF.recorded}
                className="-my-[10px] inline-flex min-h-[48px] items-center gap-[2px] text-[17px] text-brown-700 underline-offset-4 hover:text-caramel-dk hover:underline"
              >
                看全部<span aria-hidden="true">›</span>
              </Link>
            </div>
            <p className="mt-[4px] text-[17px] leading-[1.75] text-pretty text-brown-700">
              買了就能永久回放，不用配合時間，在家慢慢練。
            </p>

            <ul className="mt-[16px] grid list-none gap-[12px] md:mt-[28px] md:grid-cols-2 md:gap-[24px] lg:grid-cols-3">
              {HOME_COURSES.map(({ product }) => (
                <li key={product.slug} className="flex">
                  <div className="w-full">
                    <CourseCard product={product} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* ── 4. 三項理由 ── 手機改成靠左的三列，不再每一項置中佔掉半個螢幕 */}
      <section aria-label="快樂手的三個特點" className="border-t border-sand-300 px-[16px] py-[28px] md:px-[40px] md:py-[56px]">
        <ul className="mx-auto grid max-w-[1080px] gap-[18px] md:grid-cols-3 md:gap-[32px]">
          {REASONS.map((reason) => (
            <li key={reason.no} className="flex gap-[14px] md:flex-col md:gap-[8px] md:text-center">
              <span
                aria-hidden="true"
                className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full bg-cream-200 font-serif text-[22px] text-caramel-dk md:mx-auto md:h-[56px] md:w-[56px] md:text-[26px]"
              >
                {reason.no}
              </span>
              <div>
                <h2 className="font-serif text-[20px] leading-[1.45] font-semibold text-brown-900 md:text-[23px]">
                  {reason.title}
                </h2>
                <p className="mt-[2px] text-[17px] leading-[1.75] text-pretty text-brown-700 md:mt-[6px]">
                  {reason.desc}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* ── 5. 老師 ── 手機改成圓形小照＋文字，不再放一張佔滿整個螢幕的大照片 */}
      <section
        aria-labelledby="teacher-title"
        className="border-t border-sand-300 px-[16px] py-[32px] md:px-[40px] md:py-[72px]"
      >
        <div className="mx-auto grid max-w-[1080px] gap-[18px] md:grid-cols-[0.8fr_1.2fr] md:items-center md:gap-[56px]">
          <Figure
            /* 照片放在 site_settings，後台 /admin/settings 換一次三頁一起換。 */
            src={teacher?.photo_url}
            rounded="rounded-[999px_999px_28px_28px]"
            label="柳樺老師教學照"
            alt="劉柳樺老師教學照"
            className="mx-auto hidden aspect-[4/5] w-full md:block"
            sizes="(min-width: 768px) 40vw, 1px"
          />
          <div>
            <div className="flex items-center gap-[14px]">
              <Figure
                src={teacher?.photo_url}
                rounded="rounded-full"
                alt=""
                className="h-[72px] w-[72px] shrink-0 md:hidden"
                sizes="72px"
                objectPosition="object-top"
              />
              <div>
                <p className="text-[16px] tracking-[0.12em] text-caramel-dk">{TEACHER.eyebrow}</p>
                <h2 id="teacher-title" className="font-serif text-[23px] leading-[1.4] font-semibold text-brown-900 md:mt-[6px] md:text-[32px]">
                  {TEACHER.name}
                </h2>
              </div>
            </div>
            {TEACHER.paragraphs.map((paragraph, i) => (
              <p
                key={paragraph.slice(0, 8)}
                className={`text-[17px] leading-[1.85] text-pretty text-brown-700 md:text-[18px] ${
                  i === 0 ? "mt-[14px] md:mt-[20px]" : "mt-[10px] md:mt-[14px]"
                }`}
              >
                {paragraph}
              </p>
            ))}
            <Link
              href="/teachers"
              className="mt-[8px] inline-flex min-h-[48px] items-center border-b border-caramel text-[18px] text-brown-900 transition-colors duration-200 hover:text-caramel-dk"
            >
              看完整師資介紹 →
            </Link>
          </div>
        </div>
      </section>

      {/* ── 6. 聯絡帶 ──
          底色從淺焦糖（#C08B5C，白字只有 2.96:1）換成深焦糖（#8A5227，白字 6.33:1）。
          手機沒有底部固定列了，LINE 的主要出口在這裡與選單抽屜裡。 */}
      <section
        aria-labelledby="contact-title"
        className="bg-caramel-dk px-[20px] py-[36px] text-center text-white md:px-[40px] md:py-[60px]"
      >
        <div className="mx-auto max-w-maxw">
          <h2
            id="contact-title"
            className="font-serif text-[23px] leading-[1.45] font-medium md:text-[32px]"
          >
            想問什麼都可以，我們有真人回訊息
          </h2>
          <p className="mt-[10px] text-[18px] leading-[1.9]">
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
          <a
            href={SITE.lineHref}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-[14px] inline-flex min-h-[56px] w-full items-center justify-center rounded-pill bg-white px-[32px] text-[18px] font-medium text-brown-900 transition-colors duration-200 hover:bg-cream-200 md:w-auto"
          >
            用 LINE 問我們
            <span className="sr-only">（會開啟 LINE）</span>
          </a>
        </div>
      </section>
    </div>
  );
}
