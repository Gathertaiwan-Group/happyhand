import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Figure } from "@/components/ui/placeholder";
import { buttonClass } from "@/components/ui/button";
import { MobileActionBar } from "@/components/mobile-action-bar";
import { SITE, formatPrice } from "@/lib/site";
import {
  getProduct,
  getWorkshopSessions,
  getPublishedSlugs,
  getSiteSetting,
  timeRange,
  twDate,
  type HealthNoticeSetting,
  type TeacherSetting,
} from "@/lib/data";
import { SessionRow } from "../_components/session-row";
import {
  BulletSection,
  CompareSection,
  FaqSection,
  FeatureSection,
  InfoTableSection,
  LeadText,
  PricingSection,
  StepSection,
  TagCloud,
  TeacherSection,
  HealthNoticeSection,
} from "../_components/content-sections";
import { NoSessions } from "../_components/no-sessions";
import { hasOnline, ONLINE_LINK_NOTE, placeText } from "@/lib/session-format";
import { CATEGORY_LABEL, categoriesOf } from "@/lib/course-category";
import {
  BookOpen,
  CalendarDays,
  ClipboardCheck,
  Link2,
  MapPin,
  MessageCircle,
  Check,
  UserCheck,
  Video,
  Wallet,
} from "lucide-react";
import { ICON_CLASS, ICON_STROKE } from "@/components/ui/icon-text";
import { ReadMore } from "@/components/ui/read-more";

type PageProps = { params: Promise<{ slug: string }> };

export const revalidate = 300;

export const dynamicParams = true;
/**
 * 「來之前先知道」的預設內容。
 * 後台沒填時用這一組 —— 這些話對每一場實體工作坊都適用，
 * 不該逼客戶每開一場就重打一次。
 */
const DEFAULT_NOTES = [
  "工具講義都備好，空手來就行。",
  "開課前七天跟我們說一聲，可以改期一次。",
  "額滿可用 LINE 登記候補，有人取消會通知你。",
  "膝蓋、腰不舒服可以坐著做，現場有助教。",
  "其他問題，用 LINE 問我們。",
];

/**
 * 全部場次都是線上時的預設注意事項。
 *
 * 實體那一組有兩條在線上課是錯的：「工具跟講義都準備好了，你空手來就行」
 * 與「現場有助教會陪你」。改期與候補的規則兩邊相同，照留。
 * 🔴 第一條一定是連結怎麼來 —— 線上課沒有連結就上不了。
 */
const ONLINE_DEFAULT_NOTES = [
  ONLINE_LINK_NOTE,
  "建議用電腦或平板，手機較難看清老師的手勢。",
  "找個安靜、能把手攤開的位置，可以坐著做。",
  "開課前七天跟我們說一聲，可以改期一次。",
  "額滿可用 LINE 登記候補，有人取消會通知你。",
  "其他問題，用 LINE 問我們。",
];

export async function generateStaticParams() {
  const slugs = await getPublishedSlugs("workshop");
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProduct(slug);
  if (!product || product.type !== "workshop") {
    return { title: "找不到這個工作坊" };
  }
  return {
    title: product.title,
    description:
      product.description ||
      `${product.title}｜${product.subtitle}。想問哪一場適合你，加我們的 LINE ${SITE.lineId}。`,
    openGraph: {
      title: `${product.title}｜快樂手`,
      description: product.description,
      type: "article",
    },
  };
}

/**
 * /workshops/[slug] — 單場工作坊詳情
 * 設計稿沒有這一頁，沿用課程頁與工作坊列表的語彙（封面 16:9、標題帶、場次列、地點、注意事項）。
 */
export default async function WorkshopDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const [product, allSessions, teacher, healthNotice] = await Promise.all([
    getProduct(slug),
    getWorkshopSessions(),
    // 講師與健康聲明是所有課共用的，放在 site_settings 而不是每個商品重填
    getSiteSetting<TeacherSetting>("teacher"),
    getSiteSetting<HealthNoticeSetting>("health_notice"),
  ]);

  if (!product || product.type !== "workshop") notFound();

  const sessions = allSessions.filter((s) => s.slug === slug);
  // 內容區塊依 kind 分組。RLS 已經擋掉未發布商品的區塊，這裡不用再過濾。
  const blocks = product.blocks ?? [];
  const blocksOf = (kind: string) => blocks.filter((b) => b.kind === kind);
  const openSession = sessions.find(
    (s) => s.capacity - s.seats_taken - (s.held ?? 0) > 0,
  );
  /*
    這門課的場次是不是全部線上。全線上就不給地圖、改用線上的注意事項。
    沒有場次時兩個都是 false → 照實體的樣子顯示（跟以前一樣）。
  */
  const allOnline = sessions.length > 0 && sessions.every((s) => s.format === "online");
  const anyOnline = sessions.some((s) => hasOnline(s.format));
  // 🔴 地圖要取第一個「有實體成分」的場次，不能直接拿 sessions[0] ——
  //    那可能是一場線上課，它的 location 是「ON LINE」或空字串。
  const venue = sessions.find((s) => s.format !== "online");
  const address = venue?.address ?? SITE.address;
  const venueName = venue?.location ?? "好日子・台北教室";
  const mapHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    address,
  )}`;

  // 標題下方「報名重點」用：最近一場的時間、方式，與最低價
  const firstSession = sessions[0] ?? null;
  const firstSessionText = firstSession
    ? (() => {
        const d = twDate(firstSession.starts_at);
        const m = d.month.replace(/\s+/g, "").replace(/月+$/, "月");
        const day = d.day.replace(/日+$/, "");
        return `${m}${day}日（${d.weekday}）${timeRange(firstSession.starts_at, firstSession.ends_at)}`;
      })()
    : "";
  // 0 元的是「意願登記」梯次，不拿來當「起價」；全部都是 0 才寫不收費
  const paid = sessions.map((s) => s.price).filter((p) => p > 0);
  const minPrice = paid.length ? Math.min(...paid) : 0;
  const priceText =
    minPrice > 0
      ? `${formatPrice(minPrice)}${paid.some((p) => p !== minPrice) ? " 起" : ""}`
      : "不收費";

  const openSessionKey = openSession
    ? (openSession.id ?? `${openSession.slug}@${openSession.starts_at}`)
    : null;

  return (
    <div className="pb-action-bar">
      {/* 標題與封面 */}
      <section className="mx-auto max-w-maxw px-[20px] pt-[20px] pb-[28px] md:px-[40px] md:pt-[32px] md:pb-[48px]">
        <Link
          href="/workshops"
          className="inline-flex min-h-[56px] items-center text-[17px] text-brown-700 transition-colors duration-200 hover:text-caramel-ink"
        >
          <span aria-hidden="true">←&nbsp;</span>回場次列表
        </Link>

        <Figure
          src={product.cover_url}
          alt={`${product.title} 上課現場`}
          label="workshop cover 16:9"
          rounded="rounded-card"
          className="mt-[12px] aspect-[16/9] w-full max-w-[860px]"
          sizes="(min-width: 900px) 860px, 100vw"
          priority
        />

        {/* 間距用 flex gap，不用 margin：t-h1/t-h2/t-h3 utility 自帶 margin:0 會蓋掉 mt-* */}
        <div className="mt-[20px] flex max-w-[760px] flex-col gap-[8px] md:mt-[24px] md:gap-[10px]">
          {/* 以前寫死英文「WORKSHOP」，線上直播課也這樣標。改成跟 /courses 同一套分類 */}
          <span className="text-[16px] leading-[1.6] text-caramel-dk">
            {categoriesOf(product).map((c) => CATEGORY_LABEL[c]).join("・")}
          </span>
          <h1 className="font-serif text-[28px] leading-[1.4] font-semibold text-brown-900 md:text-[44px] md:leading-[1.35]">
            {product.title}
          </h1>
          {product.subtitle && (
            <p className="text-[18px] leading-[1.7] text-brown-700 md:text-[20px]">{product.subtitle}</p>
          )}

          {/* 報名重點。2026-11-18 手機版改版：以前要捲過一整段介紹文字才看得到
              「場次與報名」。參考 Accupass 活動頁：標題正下方先給時間、方式、費用，
              和一顆直接跳到場次的按鈕。 */}
          {firstSession && (
            <div className="mt-[8px] rounded-[18px] border border-sand-300 bg-cream-100 p-[16px] md:p-[22px]">
              {/* 2026-11-18 減字：「上課時間／上課方式／費用」文字欄名換成圖示，欄名留給螢幕報讀 */}
              <dl className="grid gap-[8px] text-[17px] leading-[1.6]">
                <div className="flex items-start gap-[10px]">
                  <dt>
                    <CalendarDays aria-hidden="true" strokeWidth={ICON_STROKE} className={`mt-[0.2em] ${ICON_CLASS}`} />
                    <span className="sr-only">{sessions.length > 1 ? "最近一場" : "上課時間"}</span>
                  </dt>
                  <dd className="text-brown-900">
                    {firstSessionText}
                    {sessions.length > 1 && (
                      <span className="ml-[6px] text-[16px] text-brown-500">等 {sessions.length} 場</span>
                    )}
                  </dd>
                </div>
                <div className="flex items-start gap-[10px]">
                  <dt>
                    {firstSession.format === "online" ? (
                      <Video aria-hidden="true" strokeWidth={ICON_STROKE} className={`mt-[0.2em] ${ICON_CLASS}`} />
                    ) : (
                      <MapPin aria-hidden="true" strokeWidth={ICON_STROKE} className={`mt-[0.2em] ${ICON_CLASS}`} />
                    )}
                    <span className="sr-only">上課方式</span>
                  </dt>
                  <dd className="text-brown-900">{placeText(firstSession.format, firstSession.location)}</dd>
                </div>
                <div className="flex items-center gap-[10px]">
                  <dt>
                    <Wallet aria-hidden="true" strokeWidth={ICON_STROKE} className={ICON_CLASS} />
                    <span className="sr-only">費用</span>
                  </dt>
                  <dd className="font-serif text-[19px] font-semibold text-caramel-dk">{priceText}</dd>
                </div>
              </dl>
              <a
                href="#sessions"
                className={buttonClass({ variant: "primary", className: "mt-[14px] w-full md:w-auto" })}
              >
                {sessions.length > 1 ? `選場次報名（${sessions.length}）` : "看場次・報名"}
              </a>
            </div>
          )}
          {/* 簡介來自後台，長的話手機先收起來 */}
          {(product.description?.length ?? 0) > 110 ? (
            <ReadMore className="mt-[4px]" collapsedHeight={128}>
              <p className="t-body text-brown-700">{product.description}</p>
            </ReadMore>
          ) : (
            <p className="t-body mt-[4px] text-brown-700">{product.description}</p>
          )}

          {/* 後台「標題下方引言」。留空就不渲染，換行會保留。 */}
          <LeadText text={product.hero_lead} />

          {product.benefits.length > 0 && (
            <ul className="mt-[10px] flex list-none flex-wrap gap-[10px]">
              {product.benefits.map((b) => (
                <li
                  key={b}
                  className="inline-flex items-center gap-[6px] rounded-pill border border-sand-500 px-[16px] py-[8px] text-[16px] text-brown-700"
                >
                  <Check aria-hidden="true" strokeWidth={2} className="h-[16px] w-[16px] shrink-0 text-caramel-dk" />
                  {b}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* 場次列表 */}
      <section
        id="sessions"
        className="fab-safe scroll-mt-[72px] bg-cream-100 px-[16px] py-[28px] md:px-[40px] md:py-[48px]"
      >
        <div className="mx-auto max-w-maxw">
          <h2 className="font-serif text-[24px] leading-[1.4] font-semibold text-brown-900 md:text-[32px]">場次與報名</h2>
          <p className="mt-[8px] flex items-center gap-[6px] text-[17px] leading-[1.8] text-brown-700">
            <MessageCircle aria-hidden="true" strokeWidth={ICON_STROKE} className={ICON_CLASS} />
            <span>
              不方便線上付款？
              <a
                href={SITE.lineHref}
                target="_blank"
                rel="noopener noreferrer"
                className="-my-[7px] inline-block py-[11px] whitespace-nowrap text-brown-900 underline underline-offset-4 hover:text-caramel-dk"
              >
                LINE 幫你代訂
                <span className="sr-only">（會開啟 LINE）</span>
              </a>
            </span>
          </p>

          <div className="mt-[20px]">
            {sessions.length === 0 ? (
              <NoSessions
                message="這門工作坊最近沒有安排場次，想知道下一場什麼時候開，用 LINE 問我們。"
              />
            ) : (
              <ul className="flex list-none flex-col gap-[14px]">
                {sessions.map((s) => (
                  <SessionRow
                    key={s.id ?? `${s.slug}-${s.starts_at}`}
                    session={s}
                    showTitle={false}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/*
        報名頁內容。全部來自後台，每一塊「資料為空就整塊不渲染」，
        所以不需要的區塊留空不填即可，不會出現空標題。
      */}
      <div className="mx-auto flex w-full max-w-maxw flex-col gap-[40px] px-[20px] py-[40px] md:gap-[56px] md:px-[40px] md:py-[56px]">
        <CompareSection
          eyebrow="適合的對象"
          title="適合誰、不適合誰"
          icon={UserCheck}
          leftTitle="適合"
          leftItems={product.suitable_for}
          rightTitle="目前可能不適合"
          rightItems={product.not_suitable_for}
        />

        <BulletSection
          eyebrow="學完之後"
          title="你將能夠——"
          items={product.outcomes}
          tone="cream"
        />

        <StepSection blocks={blocksOf("step")} />

        <CompareSection
          eyebrow="課程內容"
          title="這堂課會上什麼"
          icon={BookOpen}
          leftTitle="線上"
          leftItems={product.curriculum_online}
          rightTitle="實體練習"
          rightItems={product.curriculum_onsite}
        />

        <FeatureSection blocks={blocksOf("feature")} />

        <TagCloud
          eyebrow="完整配套"
          title="一次報名，全部帶走"
          items={product.includes}
        />

        <InfoTableSection blocks={blocksOf("info_row")} />

        <PricingSection blocks={blocksOf("pricing")} />

        <TeacherSection teacher={teacher} />

        <FaqSection blocks={blocksOf("faq")} />

        <HealthNoticeSection notice={healthNotice} />
      </div>


      {/* 地點與注意事項 */}
      <section className="mx-auto max-w-maxw px-[20px] py-[32px] md:px-[40px] md:py-[48px]">
        <div className="flex flex-col gap-[24px] md:flex-row md:gap-[40px]">
          <div className="md:flex-1">
            {allOnline ? (
              /*
                全線上：沒有地點、沒有地圖、沒有「用 LINE 問路」。
                以前這一區一律印台北教室加 Google 地圖 —— 一門線上課的頁面上
                附一張教室地圖，客人只會以為要親自到場。
              */
              <>
                <h2 className="t-h3 flex items-center gap-[8px]">
                  <Video aria-hidden="true" strokeWidth={ICON_STROKE} className="h-[22px] w-[22px] shrink-0 text-caramel-dk" />
                  線上上課（視訊）
                </h2>
                <p className="t-body mt-[10px] flex items-start gap-[8px] text-brown-500">
                  <Link2 aria-hidden="true" strokeWidth={ICON_STROKE} className={`mt-[0.3em] ${ICON_CLASS}`} />
                  <span>{ONLINE_LINK_NOTE}</span>
                </p>
                <div className="mt-[16px] flex flex-col flex-wrap gap-[10px] md:flex-row">
                  <a
                    href={SITE.lineHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonClass({
                      variant: "outline",
                      className: "w-full shrink-0 whitespace-nowrap md:w-auto",
                    })}
                  >
                    <MessageCircle aria-hidden="true" strokeWidth={ICON_STROKE} className="mr-[8px] h-[20px] w-[20px]" />
                    用 LINE 問我們
                    <span className="sr-only">（會開啟 LINE）</span>
                  </a>
                </div>
              </>
            ) : (
              <>
            <h2 className="t-h3 flex items-center gap-[8px]">
              <MapPin aria-hidden="true" strokeWidth={ICON_STROKE} className="h-[22px] w-[22px] shrink-0 text-caramel-dk" />
              上課地點
            </h2>
            <p className="t-body mt-[10px] text-brown-900">{venueName}</p>
            <p className="t-body mt-[2px] text-brown-500">{address}</p>
            <div className="mt-[16px] flex flex-col flex-wrap gap-[10px] md:flex-row">
              {/* 用原生 <a> 是為了帶 target/rel — LinkButton 對外部連結不會轉發這些屬性 */}
              <a
                href={mapHref}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonClass({
                  variant: "outline",
                  className: "w-full shrink-0 whitespace-nowrap md:w-auto",
                })}
              >
                <MapPin aria-hidden="true" strokeWidth={ICON_STROKE} className="mr-[8px] h-[20px] w-[20px]" />
                Google 地圖
                <span className="sr-only">（另開新視窗）</span>
              </a>
              <a
                href={SITE.lineHref}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonClass({
                  variant: "outline",
                  className: "w-full shrink-0 whitespace-nowrap md:w-auto",
                })}
              >
                <MessageCircle aria-hidden="true" strokeWidth={ICON_STROKE} className="mr-[8px] h-[20px] w-[20px]" />
                用 LINE 問路
                <span className="sr-only">（會開啟 LINE）</span>
              </a>
            </div>
            {/* 有實體也有線上：地圖給實體場次用，另外講一句讓人知道可以選。 */}
            {anyOnline && (
              <p className="t-body-sm mt-[14px] flex items-start gap-[8px] text-brown-500">
                <Video aria-hidden="true" strokeWidth={ICON_STROKE} className={`mt-[0.3em] ${ICON_CLASS}`} />
                <span>標「線上」的場次可視訊參加。{ONLINE_LINK_NOTE}</span>
              </p>
            )}
              </>
            )}
          </div>

          <div className="md:flex-1">
            <h2 className="t-h3 flex items-center gap-[8px]">
              <ClipboardCheck aria-hidden="true" strokeWidth={ICON_STROKE} className="h-[22px] w-[22px] shrink-0 text-caramel-dk" />
              來之前先知道
            </h2>
            <ul className="mt-[10px] flex list-none flex-col gap-[10px]">
              {/*
                後台「來之前先知道」欄位。原本這五條是寫死在這裡的字串陣列，
                每開一個新工作坊都得改程式。留空時用同一組預設值，
                所以舊資料不會突然變空白。
              */}
              {(product.notes && product.notes.length > 0
                ? product.notes
                : allOnline
                  ? ONLINE_DEFAULT_NOTES
                  : DEFAULT_NOTES
              ).map((t) => (
                <li
                  key={t}
                  className="t-body-sm flex gap-[10px] text-brown-500"
                >
                  <Check aria-hidden="true" strokeWidth={2} className="mt-[0.3em] h-[16px] w-[16px] shrink-0 text-caramel-dk" />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <p className="mt-[28px] t-caption text-brown-500">{SITE.disclaimer}</p>
      </section>

      {/*
        手機底部列捲到場次區，不直接跳結帳 ——
        原本是連 /checkout?session=<id>，但沒有任何地方讀那個參數，
        客人會落到「購物車還是空的」。而且這頁可能有好幾場，
        替客人選一場也不對，讓他自己挑日子比較合理。
      */}
      <MobileActionBar
        href={openSessionKey ? "#sessions" : "/workshops"}
        label={openSessionKey ? "看場次報名" : "看其他場次"}
      />
    </div>
  );
}
