import type { Metadata } from "next";
import { SITE } from "@/lib/site";
import { FAQS } from "@/lib/content";
import { Accordion, type AccordionItem } from "@/components/ui/accordion";
import { buttonClass } from "@/components/ui/button";
import { MobileActionBar } from "@/components/mobile-action-bar";
import { PageHero } from "@/app/_components/page-hero";
import { CallBand } from "@/app/_components/call-band";

export const metadata: Metadata = {
  title: "常見問題",
  description:
    "快樂手常見問題：零基礎能不能學、線上課程看多久、ATM 匯款、課本寄送、工作坊改期與候補。找不到答案就加我們的 LINE @hao2082l，有真人回訊息。",
};

/**
 * 依主題分組。`picks` 取自 lib/content.ts 的 FAQS（勿改寫），
 * `extra` 是本頁補寫的題目，同樣不得有醫療宣稱。
 * FAQS 之後若新增題目而沒被分到組，會自動落在第一組，不會消失。
 */
const GROUPS: { title: string; picks: string[]; extra: AccordionItem[] }[] = [
  {
    title: "課程相關",
    picks: [
      "我沒有基礎，也沒有運動習慣，可以學嗎？",
      "膝蓋或腰不好，做得來嗎？",
      "預錄課程可以看多久？",
    ],
    extra: [
      {
        q: "用手機看課程可以嗎？字太小看不清楚怎麼辦？",
        a: "可以。手機、平板、電腦都看得到。字幕大小可以自己調，影片也能放慢。真的調不出來，用 LINE 告訴我們，我們在 LINE 上陪你設定一次。",
      },
    ],
  },
  {
    title: "付款與寄送",
    picks: ["可以用 ATM 匯款嗎？", "課本會寄到家裡嗎？"],
    extra: [
      {
        q: "不會線上付款怎麼辦？",
        a: "用 LINE 問我們，有真人回訊息。我們可以幫你代訂，再告訴你匯款帳號，不用自己在網路上填資料。",
      },
      {
        q: "付完錢多久可以開始上課？",
        a: "信用卡付款完成之後馬上就能看。ATM 匯款的話，我們對帳完成會寄一封開通信給你，通常一到兩個工作天。沒收到信先看看垃圾信件匣，還是沒有就用 LINE 問我們。",
      },
    ],
  },
  {
    title: "工作坊",
    picks: ["工作坊如果臨時不能去怎麼辦？"],
    extra: [
      {
        q: "工作坊額滿了，還可以報名嗎？",
        a: "可以候補。額滿的場次按「已額滿・我要候補」用 LINE 跟我們說一聲，有人取消我們會照順序通知你。",
      },
    ],
  },
];

const byQuestion = new Map(FAQS.map((f) => [f.q, f]));
const pickedQuestions = new Set(GROUPS.flatMap((g) => g.picks));
const unassigned = FAQS.filter((f) => !pickedQuestions.has(f.q));

const SECTIONS = GROUPS.map((group, i) => ({
  title: group.title,
  items: [
    ...group.picks.flatMap((q) => {
      const found = byQuestion.get(q);
      return found ? [found] : [];
    }),
    ...(i === 0 ? unassigned : []),
    ...group.extra,
  ],
}));

export default function FaqPage() {
  return (
    <div className="pb-action-bar">
      <PageHero
        eyebrow="FAQ"
        title="常見問題"
        lead="這裡整理了大家最常問的幾題。看完還是不確定的話，直接用 LINE 問我們，不用客氣。"
      />

      {/* 找不到答案就用 LINE 問 */}
      <section className="bg-white">
        <div className="mx-auto max-w-[860px] px-[20px] pt-[26px] md:px-[40px] md:pt-[40px]">
          <div className="rounded-card border border-sand-300 bg-cream-100 px-[22px] py-[24px] text-center md:px-[40px] md:py-[34px]">
            <h2 className="t-h3">找不到答案，就用 LINE 問</h2>
            <p className="t-body-sm mx-auto mt-[10px] max-w-[540px] text-pretty text-brown-500">
              週一到週五 10:00–18:00 有真人回訊息。不用先想好怎麼問，想到什麼就問什麼。
            </p>
            <a
              href={SITE.lineHref}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClass({
                variant: "outline",
                size: "lg",
                fullWidth: true,
                className: "mt-[18px] md:mt-[22px] md:w-auto",
              })}
            >
              用 LINE 問我們
              <span className="sr-only">（會開啟 LINE）</span>
            </a>
          </div>
        </div>
      </section>

      {/* 分組 FAQ（設計稿 911–929 行桌機、960–972 行手機） */}
      <section className="mt-[34px] bg-cream-100 md:mt-[56px]">
        <div className="mx-auto max-w-[860px] px-[20px] py-[34px] md:px-[40px] md:py-[64px]">
          {SECTIONS.map((section) => (
            <div key={section.title} className="mt-[28px] first:mt-0 md:mt-[40px]">
              <h2 className="t-h3">{section.title}</h2>
              <div className="mt-[12px] rounded-card border border-sand-300 bg-white px-[20px] md:mt-[16px] md:px-[26px]">
                <Accordion items={section.items} className="-mt-px -mb-px" />
              </div>
            </div>
          ))}

          <p className="t-caption mt-[26px] text-center text-brown-500 md:mt-[34px]">
            {SITE.disclaimer}
          </p>
        </div>
      </section>

      <CallBand />

      <MobileActionBar href="/courses" label="開始線上練習" />
    </div>
  );
}
