import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SITE } from "@/lib/site";
import { PageHero } from "@/app/_components/page-hero";
import { CallBand } from "@/app/_components/call-band";
import {
  BookOpen,
  CreditCard,
  MessageCircle,
  PlayCircle,
  RotateCcw,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

export const metadata: Metadata = {
  title: "服務條款與退費規定",
  description:
    "快樂手線上課程與工作坊的購買、開通、退費與個人資料使用說明。",
};

/**
 * 服務條款與退費規定。
 *
 * 這一頁存在的直接原因：結帳頁寫著「送出即表示同意服務條款與退費規定」，
 * 但那句話原本**只是純文字，沒有連結、也沒有對應的頁面**——
 * 等於要客人同意一份不存在的東西。
 *
 * ⚠️ 內容原則：這裡只寫「現在確實成立」的事實
 *    （站上實際的運作方式、FAQ 已經對外講過的承諾）。
 *
 * 🔴 需要好日子拍板才能寫死的兩件事，目前刻意用「請用 LINE 聯絡我們」帶過：
 *    1. 線上課程的七天鑑賞期。台灣《消保法》通訊交易解除權原則上有七天，
 *       但「數位內容或一經提供即完成之線上服務，經消費者事先同意始提供者」
 *       屬於合理例外——要主張這個例外，必須在購買前明確揭露並取得同意。
 *       要不要主張、怎麼揭露，是經營決定也是法律決定，不該由工程端替客戶決定。
 *    2. 工作坊的退費比例級距（開課前幾天退多少）。
 *    這兩件確定之後，把下面對應段落換成明確條文即可。
 */
export default function TermsPage() {
  return (
    <div className="pb-[40px]">
      <PageHero
        eyebrow="TERMS"
        title="服務條款與退費規定"
        lead="買課、上課、退費，我們會怎麼做。有疑問用 LINE 問我們。"
      />

      <div className="mx-auto max-w-[760px] px-[20px] pb-[56px] md:px-[40px] md:pb-[72px]">
        <Section title="一、你買的是什麼" icon={BookOpen}>
          <P>
            快樂手提供兩種東西：<Strong>線上課程</Strong>（影片，在網站上看）與
            <Strong>實體工作坊</Strong>（到現場上課）。有些課程另外附紙本課本，
            會寄到你下單時填的地址。
          </P>
          <P>
            課程內容是<Strong>自我保健的練習方法</Strong>，
            不是醫療行為，也不能取代專業醫療診斷與治療。
            身體有狀況請先諮詢醫師。
          </P>
        </Section>

        <Section title="二、怎麼開通、可以看多久" icon={PlayCircle}>
          <P>
            下單之後我們會用你填的 Email 幫你開一個帳號，並寄一封信讓你設定密碼。
            我們確認收到款項後就會開通課程，並再寄一封通知信給你。
          </P>
          <P>
            線上課程<Strong>不限觀看次數，也沒有觀看期限</Strong>。
            （如果某一門課另有期限，會在該課程頁面上明確標示。）
          </P>
          <P>
            課程影片與課本內容僅供你個人學習使用。
            請不要重製、公開播送，或把觀看連結轉給沒有購買的人。
          </P>
        </Section>

        <Section title="三、付款方式" icon={CreditCard}>
          <P>
            目前提供 <Strong>ATM 匯款</Strong>與
            <Strong>請我們代訂（用 LINE 聯絡）</Strong>兩種方式。
            線上刷卡還在開通中，你在網站上選了信用卡之後，
            我們會先幫你保留名額，再用 LINE 跟你確認付款方式，
            <Strong>這個階段不會扣款</Strong>。
          </P>
        </Section>

        <Section title="四、退費" icon={RotateCcw}>
          <P>
            我們是小團隊，退費一律<Strong>個別處理</Strong>，不用填表單。
            用 LINE 跟我們說你的訂單編號與情況就可以，我們會盡快回覆你。
          </P>
          <P>
            <Strong>工作坊</Strong>：開課前七天告訴我們可以改期一次。
            身體不舒服或臨時有事，也請用 LINE 跟我們說，我們會盡量協助。
          </P>
          <P>
            <Strong>線上課程</Strong>：因為是數位內容，開通之後的退費請直接與我們聯絡，
            我們會依照你的實際使用情況與你討論處理方式。
          </P>
        </Section>

        <Section title="五、你的個人資料" icon={ShieldCheck}>
          <P>
            我們會蒐集你在結帳時填寫的姓名、電話、Email、寄送地址，
            用途只有三個：<Strong>聯絡你、寄送課本、開通課程</Strong>。
          </P>
          <P>
            我們不會把你的資料賣給任何人，也不會用在上述用途以外的地方。
            想查詢、更正或刪除你的資料，用 LINE 跟我們說就可以。
            部分資料（例如交易紀錄）依法需要保存一段時間，這部分我們會跟你說明。
          </P>
        </Section>

        <Section title="六、聯絡我們" icon={MessageCircle}>
          <P>
            任何問題都可以用 LINE 官方帳號{" "}
            <Strong>{SITE.lineId}</Strong> 找到我們，有真人回覆。
          </P>
          <P className="text-brown-500">
            {SITE.company}（統一編號 {SITE.taxId}）
            <br />
            負責人：{SITE.representative}
            <br />
            {SITE.address}
          </P>
        </Section>

        <p className="mt-[36px] border-t border-sand-300 pt-[20px] text-[16px] leading-[1.8] text-brown-500">
          {SITE.disclaimer}
        </p>
      </div>

      <CallBand
        heading={
          <>
            條款看不懂，
            <br className="md:hidden" />
            或想確認自己的情況？
          </>
        }
        note="用 LINE 問我們，報一下訂單編號就可以，有真人回覆。"
      />
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section className="mt-[32px] first:mt-[8px] md:mt-[44px]">
      {/* 2026-11-18：每一節加圖示小標方便掃讀。🔴 條文本身一個字都不刪（退費與個資是紅線）。 */}
      <h2 className="t-h2 flex items-center gap-[10px] text-brown-900">
        {Icon && (
          <span className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-full bg-cream-200 text-caramel-dk">
            <Icon aria-hidden="true" strokeWidth={1.8} className="h-[22px] w-[22px]" />
          </span>
        )}
        <span>{title}</span>
      </h2>
      <div className="mt-[14px] flex flex-col gap-[14px] md:mt-[18px]">
        {children}
      </div>
    </section>
  );
}

function P({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={`t-body text-pretty text-brown-700 ${className}`}>{children}</p>
  );
}

function Strong({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-brown-900">{children}</strong>;
}
