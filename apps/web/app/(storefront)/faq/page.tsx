import type { Metadata } from "next";
import { SITE } from "@/lib/site";
import { getSiteSetting } from "@/lib/data";
import { DEFAULT_FAQ, readFaq } from "@/lib/faq";
import { Accordion } from "@/components/ui/accordion";
import { buttonClass } from "@/components/ui/button";
import { MobileActionBar } from "@/components/mobile-action-bar";
import { PageHero } from "@/app/_components/page-hero";
import { CallBand } from "@/app/_components/call-band";
import { IconText } from "@/components/ui/icon-text";
import { BookOpen, Clock, CreditCard, MessageCircle, Users, type LucideIcon } from "lucide-react";

/** 分組標題的圖示，依 GROUPS 的 title 對應 */
const GROUP_ICONS: Record<string, LucideIcon> = {
  課程相關: BookOpen,
  付款與寄送: CreditCard,
  工作坊: Users,
};

export const metadata: Metadata = {
  title: "常見問題",
  description:
    "快樂手常見問題：零基礎能不能學、線上課程看多久、ATM 匯款、課本寄送、工作坊改期與候補。找不到答案就加我們的 LINE @hao2082l，有真人回訊息。",
};

/**
 * 分組內容：site_settings 的 faq 有值就用它（業主可透過 MCP 的 update_faq 修改），
 * 沒有或形狀不對就用 lib/faq.ts 的預設（原本寫死在這裡的那一份，內容不變）。
 * ISR 300 秒；update_faq 寫入時會 revalidatePath("/faq")，不用等。
 */
export const revalidate = 300;

export default async function FaqPage() {
  const SECTIONS = (readFaq(await getSiteSetting<unknown>("faq")) ?? DEFAULT_FAQ).groups;
  return (
    <div className="pb-action-bar">
      <PageHero
        eyebrow="FAQ"
        title="常見問題"
        lead="看完還不確定，直接用 LINE 問我們。"
      />

      {/* 找不到答案就用 LINE 問 */}
      <section className="bg-white">
        <div className="mx-auto max-w-[860px] px-[20px] pt-[26px] md:px-[40px] md:pt-[40px]">
          <div className="rounded-card border border-sand-300 bg-cream-100 px-[22px] py-[24px] text-center md:px-[40px] md:py-[34px]">
            <h2 className="t-h3">找不到答案，就用 LINE 問</h2>
            <p className="t-body-sm mx-auto mt-[10px] max-w-[540px] text-pretty text-brown-500">
              <IconText icon={Clock} label="真人回覆時間">週一到週五 10:00–18:00 真人回覆</IconText>
            </p>
            <a
              href={SITE.lineHref}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClass({
                variant: "outline",
                size: "lg",
                fullWidth: true,
                className: "mt-[18px] gap-[8px] md:mt-[22px] md:w-auto",
              })}
            >
              <MessageCircle aria-hidden="true" strokeWidth={1.8} className="h-[20px] w-[20px] text-caramel-dk" />
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
              <h2 className="t-h3 flex items-center gap-[10px]">
                {(() => {
                  const Icon = GROUP_ICONS[section.title];
                  return Icon ? (
                    <Icon aria-hidden="true" strokeWidth={1.8} className="h-[22px] w-[22px] shrink-0 text-caramel-dk" />
                  ) : null;
                })()}
                {section.title}
              </h2>
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
