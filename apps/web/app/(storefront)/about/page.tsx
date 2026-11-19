import type { Metadata } from "next";
import Link from "next/link";
import { SITE } from "@/lib/site";
import { TEACHER } from "@/lib/content";
import { MobileActionBar } from "@/components/mobile-action-bar";
import { PageHero } from "@/app/_components/page-hero";
import { CallBand } from "@/app/_components/call-band";
import { TeacherFeature } from "@/app/_components/teacher-feature";
import { getSiteSetting, type TeacherSetting } from "@/lib/data";
import { ReadMore } from "@/components/ui/read-more";
import {
  Armchair,
  Building2,
  Hand,
  Hash,
  MapPin,
  MessageCircle,
  UserRound,
  Wind,
  type LucideIcon,
} from "lucide-react";

export const metadata: Metadata = {
  title: "品牌介紹",
  description:
    "快樂手是好日子股份有限公司的品牌，教的是仁神術（JSJ）。用自己的手照顧自己，坐著就能做，每天十分鐘。",
};

/** 「仁神術是什麼」沿用首頁三項理由的排版語彙（README §4.1 #3） */
const WHAT_IS_JSJ: { icon: LucideIcon; title: string; desc: string }[] = [
  { icon: Hand, title: "用自己的手", desc: "一雙手就夠，也能幫家人做。" },
  { icon: Armchair, title: "坐著就能做", desc: "不用換衣服、不用墊子，躺著也行。" },
  { icon: Wind, title: "慢慢來就好", desc: "一個位置放幾分鐘，呼吸放慢。" },
];

const WHY = [
  "柳樺老師教仁神術教了二十幾年。以前都是實體班，一次坐滿一間教室。",
  "後來常有人跟我們說，住得遠、腳不方便，來一趟不容易；也有人說上完課回家就忘了，想再聽一次卻沒機會。",
  "所以我們把課一堂一堂錄下來，放到網路上。你在家裡坐著，跟著影片一起做，哪裡不懂就倒回去再看一次，看幾次都可以。",
  "實體班我們沒有收掉。手要放到什麼程度、力氣要多輕，還是當面學最快。想來的話，台北每個月都有班。",
  "這件事不難，難的是有沒有人陪你開始。",
];

const COMPANY_ROWS: { icon: LucideIcon; label: string; value: string }[] = [
  { icon: Building2, label: "公司名稱", value: `${SITE.company} ${SITE.companyEn}` },
  { icon: Hash, label: "統一編號", value: SITE.taxId },
  { icon: UserRound, label: "代表人", value: SITE.representative },
  { icon: MapPin, label: "地址", value: SITE.address },
];

export const revalidate = 300;

export default async function AboutPage() {
  const teacher = await getSiteSetting<TeacherSetting>("teacher");

  return (
    <div className="pb-action-bar">
      <PageHero
        eyebrow="ABOUT"
        title={
          <>
            把手放好，把呼吸放慢，
            <br className="hidden md:inline" />
            每天留一點時間給自己
          </>
        }
        lead="快樂手是好日子股份有限公司的品牌，教的是仁神術（Jin Shin Jyutsu）。這不是什麼神奇的東西，就是一套用自己的手照顧自己的方法。"
      >
        <div className="mt-[24px] flex flex-col items-center gap-[6px] md:mt-[30px]">
          <span className="font-serif text-[26px] font-bold tracking-[0.14em] text-caramel-ink md:text-[32px]">
            {SITE.brandZh}
          </span>
          <span className="t-caption tracking-[0.18em] text-brown-500">
            {SITE.brandEn}
          </span>
        </div>
      </PageHero>

      {/* 仁神術是什麼 —— 沿用三項理由的格線排版 */}
      <section className="bg-white">
        <div className="mx-auto max-w-maxw px-[20px] pt-[40px] pb-[34px] text-center md:px-[40px] md:pt-[72px] md:pb-[40px]">
          <h2 className="t-h2">仁神術是什麼</h2>
          <p className="t-body mx-auto mt-[16px] max-w-[680px] text-pretty text-brown-500 md:mt-[20px]">
            仁神術來自日本，英文寫作 Jin Shin Jyutsu，大家簡稱它 JSJ。做法很單純：把兩隻手放在身上幾個固定的位置，輕輕放著，等一等。不用出力，也不用按摩，更不用記一堆名詞。
          </p>
        </div>

        <div className="mx-auto max-w-maxw px-[20px] md:px-[40px]">
          <div className="border-t border-sand-300 md:grid md:grid-cols-3">
            {/* 2026-11-18 減字：國字編號換成圖示，說明縮成一行；手機改成靠左的列 */}
            {WHAT_IS_JSJ.map((item, i) => (
              <div
                key={item.title}
                className={[
                  "flex items-center gap-[14px] border-b border-sand-300 px-[4px] py-[18px] text-left md:block md:border-b-0 md:px-[40px] md:py-[52px] md:text-center",
                  i > 0 ? "md:border-l md:border-sand-300" : "",
                ].join(" ")}
              >
                <span className="flex h-[48px] w-[48px] shrink-0 items-center justify-center rounded-full bg-cream-200 text-caramel-dk md:mx-auto md:h-[60px] md:w-[60px]">
                  <item.icon aria-hidden="true" strokeWidth={1.8} className="h-[24px] w-[24px] md:h-[28px] md:w-[28px]" />
                </span>
                <div>
                  <h3 className="t-h3 md:mt-[12px]">{item.title}</h3>
                  <p className="t-body-sm mt-[2px] text-pretty text-brown-500 md:mt-[8px]">
                    {item.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 為什麼做這件事 */}
      <section className="bg-cream-100">
        <div className="mx-auto max-w-[860px] px-[20px] py-[40px] md:px-[40px] md:py-[72px]">
          <h2 className="t-h2">為什麼做這件事</h2>
          {/* 手機先露出前兩段，其餘展開看（文字都還在） */}
          <ReadMore collapsedHeight={200} moreLabel="繼續讀" fadeFrom="from-cream-100">
            <div className="mt-[18px] flex flex-col gap-[14px] md:mt-[26px] md:gap-[16px]">
              {WHY.map((p) => (
                <p key={p} className="t-body text-pretty text-brown-700">
                  {p}
                </p>
              ))}
            </div>
          </ReadMore>
        </div>
      </section>

      {/* 老師區（設計稿 895–910 行） */}
      <TeacherFeature
        eyebrow={TEACHER.eyebrow}
        heading={TEACHER.name}
        paragraphs={TEACHER.paragraphs}
        photoSrc={teacher?.photo_url}
        stats={[
          { value: "20 年", label: "教學經驗" },
          { value: "4,800+", label: "上過課的同學" },
          { value: "台北・台中", label: "每月開課" },
        ]}
      >
        <Link
          href="/teachers"
          className="mt-[20px] inline-flex min-h-[56px] items-center text-[18px] text-caramel-ink underline underline-offset-[6px] hover:text-caramel-dk md:mt-[24px]"
        >
          看柳樺老師的完整介紹
        </Link>
      </TeacherFeature>

      {/* 公司資訊 */}
      <section className="bg-cream-100">
        <div className="mx-auto max-w-[900px] px-[20px] py-[40px] md:px-[40px] md:py-[72px]">
          <h2 className="t-h2 text-center">關於好日子</h2>
          <p className="t-body mx-auto mt-[14px] max-w-[620px] text-center text-pretty text-brown-500 md:mt-[18px]">
            找得到人、找得到地址，有事用 LINE 說就好。
          </p>

          <dl className="mt-[24px] overflow-hidden rounded-card border border-sand-300 bg-white md:mt-[34px]">
            {COMPANY_ROWS.map((row) => (
              <div
                key={row.label}
                className="grid gap-[2px] border-b border-sand-300 px-[22px] py-[16px] md:grid-cols-[160px_1fr] md:items-baseline md:gap-[20px] md:px-[30px] md:py-[20px]"
              >
                <dt className="t-caption flex items-center gap-[6px] text-brown-500">
                  <row.icon aria-hidden="true" strokeWidth={1.8} className="h-[16px] w-[16px] shrink-0 text-caramel-dk" />
                  {row.label}
                </dt>
                <dd className="t-body text-brown-900">{row.value}</dd>
              </div>
            ))}
            <div className="grid gap-[2px] px-[22px] py-[10px] md:grid-cols-[160px_1fr] md:items-center md:gap-[20px] md:px-[30px] md:py-[12px]">
              <dt className="t-caption flex items-center gap-[6px] text-brown-500">
                <MessageCircle aria-hidden="true" strokeWidth={1.8} className="h-[16px] w-[16px] shrink-0 text-caramel-dk" />
                LINE
              </dt>
              <dd>
                <a
                  href={SITE.lineHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-[56px] items-center text-[19px] text-caramel-ink underline underline-offset-[6px] hover:text-caramel-dk"
                >
                  {SITE.lineId}
                  <span className="sr-only">（會開啟 LINE）</span>
                </a>
              </dd>
            </div>
          </dl>

          <p className="t-body-sm mt-[20px] rounded-card border border-sand-300 bg-white px-[22px] py-[18px] text-brown-500 md:mt-[28px] md:px-[30px] md:py-[22px]">
            {SITE.disclaimer}
          </p>
        </div>
      </section>

      <CallBand />

      <MobileActionBar href="/courses" label="開始線上練習" />
    </div>
  );
}
