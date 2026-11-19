import type { Metadata } from "next";
import { LinkButton, buttonClass } from "@/components/ui/button";
import { BANK_TRANSFER_TEXT, SITE } from "@/lib/site";
import { isBlackcatConfigured } from "@/lib/payment/blackcat";
import { CheckoutSteps } from "@/app/(storefront)/checkout/_components/checkout-steps";
import {
  BookOpen,
  CircleCheck,
  Clock,
  CreditCard,
  Inbox,
  Landmark,
  Mail,
  MapPin,
  MessageCircle,
  MonitorPlay,
  type LucideIcon,
} from "lucide-react";
import { IconText, ICON_STROKE } from "@/components/ui/icon-text";

const NOTE_ICON: Record<string, LucideIcon> = {
  credit: CreditCard,
  atm: Landmark,
  manual: MessageCircle,
};

export const metadata: Metadata = {
  title: "報名完成",
  description: "我們收到你的訂單了。接下來會怎麼進行，這一頁都寫清楚了。",
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined) {
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
}

/**
 * 付款方式對應的下一步說明。
 *
 * 🔴 信用卡那一段依 isBlackcatConfigured() 分兩種說法。
 *    這裡曾經寫死「線上刷卡還在開通中…還沒有跟你收款」，但只要環境變數有值，
 *    客人其實剛剛已經在黑貓 PAY 的刷卡頁上輸入過卡號了 —— 那句話會讓他以為
 *    自己沒被扣款。文案與行為不同步在結帳流程上是會變成客訴的。
 */
function paymentNote(method: string, creditEnabled: boolean) {
  if (method === "credit") {
    return creditEnabled
      ? {
          title: "關於信用卡付款",
          body:
            "黑貓 PAY 的刷卡結果通常幾秒內就到。" +
            // 🔴 2026-10-17：這裡只講開通。發票不自動開立，也不承諾會寄 ——
            //    站上唯一的開票路徑是後台人工按，寫進來就是沒人保證的承諾。
            "課程自動開通，通知信寄到你填的 Email。" +
            "十分鐘還沒收到，用 LINE 說一聲。",
        }
      : {
          title: "關於信用卡付款",
          body: "線上刷卡還在開通中，我們會用 LINE 確認付款方式。現在還沒有收款。",
        };
  }
  return PAYMENT_NOTE[method];
}

const PAYMENT_NOTE: Record<string, { title: string; body: string }> = {
  atm: {
    title: "關於 ATM 匯款",
    body: `請匯到 ${BANK_TRANSFER_TEXT}。匯款後用 LINE 跟我們說一聲，對帳完成就開通，約 1 個工作天。`,
  },
  manual: {
    title: "我們會用 LINE 跟你聯絡",
    body: "這筆是代訂，我們會用 LINE 確認課程與付款方式；也可以直接 LINE 我們。",
  },
};

/**
 * /checkout/success — 第三步（設計稿 770–827 桌機／830–871 手機）
 * server component；Next 15 的 searchParams 是 Promise，要 await。
 * 沒有 order 參數也要能正常顯示，不可以噴錯。
 */
export default async function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const orderNo = one(sp.order);
  const pay = one(sp.pay);
  const note = paymentNote(pay, isBlackcatConfigured()) ?? null;
  const NoteIcon = NOTE_ICON[pay];

  return (
    <div>
      <CheckoutSteps current={3} />

      <div className="mx-auto max-w-maxw px-[20px] pb-[64px] md:px-[40px] md:pb-[80px]">
        <div className="mx-auto max-w-[1000px]">
          <div className="text-center">
            <div
              aria-hidden
              className="mx-auto flex h-[76px] w-[76px] items-center justify-center rounded-pill bg-cream-100 text-caramel-ink md:h-[96px] md:w-[96px]"
            >
              <CircleCheck strokeWidth={1.6} className="h-[40px] w-[40px] md:h-[52px] md:w-[52px]" />
            </div>

            <h1 className="t-h1 mt-[18px] text-brown-900 md:mt-[24px]">
              報名完成
            </h1>

            <p className="t-body-lg mx-auto mt-[12px] max-w-[640px] text-brown-700 md:mt-[14px]">
              {"訂單收到了。開通通知會寄到你的 Email，也會有專人聯絡你。"}
            </p>

            {orderNo ? (
              <div className="mx-auto mt-[18px] inline-block rounded-card bg-cream-100 px-[24px] py-[16px] md:mt-[22px] md:rounded-pill md:px-[28px]">
                <p className="text-[16px] text-brown-500">訂單編號</p>
                <p className="mt-[4px] font-serif text-[22px] font-semibold tracking-[0.06em] text-brown-900 select-all md:text-[26px]">
                  {orderNo}
                </p>
                <p className="mt-[6px] text-[16px] text-brown-300">
                  問 LINE 時貼這組號碼就好
                </p>
              </div>
            ) : (
              <p className="t-body mx-auto mt-[18px] max-w-[640px] text-brown-500">
                {"查詢這筆報名：LINE 告訴我們姓名與手機就好。"}
              </p>
            )}
          </div>

          {note && (
            <div className="mt-[32px] rounded-card border border-sand-500 px-[24px] py-[24px] md:mt-[44px] md:px-[30px] md:py-[28px]">
              <h2 className="flex items-center gap-[10px] font-serif text-[20px] font-semibold text-brown-900 md:text-[22px]">
                {NoteIcon && (
                  <NoteIcon aria-hidden="true" strokeWidth={ICON_STROKE} className="h-[22px] w-[22px] shrink-0 text-caramel-dk" />
                )}
                {note.title}
              </h2>
              <p className="t-body-sm mt-[10px] text-brown-500">{note.body}</p>
            </div>
          )}

          {/*
            🔴 這一段是下單到上課之間最容易斷掉的地方。

            系統已經用客人填的 Email 幫他開好帳號並寄了「設定密碼」信，
            但如果這一頁不講，他按下面的「看我的學習」就會被丟到登入頁——
            然後他不知道自己有帳號、也不知道密碼，整條路就卡死在這裡。
            對 60–75 歲客群這一步不能靠猜。
          */}
          <section
            aria-labelledby="account-ready"
            className="mt-[24px] rounded-card border-2 border-sand-400 bg-white px-[24px] py-[26px] md:mt-[32px] md:px-[32px] md:py-[34px]"
          >
            <h2
              id="account-ready"
              className="flex items-center gap-[10px] font-serif text-[20px] font-semibold text-brown-900 md:text-[22px]"
            >
              <Mail aria-hidden="true" strokeWidth={ICON_STROKE} className="h-[22px] w-[22px] shrink-0 text-caramel-dk" />
              我們幫你開好帳號了
            </h2>
            <p className="mt-[12px] text-[16.5px] leading-[1.9] text-brown-700 md:text-[17.5px]">
              已寄一封
              <strong className="font-semibold text-brown-900">「請設定密碼」</strong>
              信到你的信箱。按信裡的按鈕設好密碼，就能登入看課程與訂單。
            </p>
            <ul className="mt-[10px] flex list-none flex-col gap-[6px] text-[16px] leading-[1.7] text-brown-500">
              <li>
                <IconText icon={Inbox}>沒收到？先看垃圾郵件，信可能晚一兩分鐘</IconText>
              </li>
              <li>
                <IconText icon={Clock}>不急著設，開通後會再寄通知</IconText>
              </li>
            </ul>
          </section>

          <section
            aria-labelledby="next-steps"
            className="mt-[24px] rounded-card bg-cream-100 px-[24px] py-[26px] md:mt-[24px] md:px-[32px] md:py-[34px]"
          >
            <h2
              id="next-steps"
              className="font-serif text-[20px] font-semibold text-brown-900 md:text-[22px]"
            >
              接下來會發生什麼
            </h2>
            <ol className="mt-[16px] flex flex-col gap-[12px] text-[16.5px] leading-[1.9] text-brown-700 md:mt-[18px] md:gap-[14px] md:text-[17.5px]">
              <li>
                <IconText icon={MonitorPlay} iconClassName="h-[20px] w-[20px]">
                  <strong className="font-medium text-brown-900">線上課程</strong>
                  ：開通後在「我的學習」看，可重複看
                </IconText>
              </li>
              <li>
                <IconText icon={MapPin} iconClassName="h-[20px] w-[20px]">
                  <strong className="font-medium text-brown-900">實體工作坊</strong>
                  ：開課前三天提醒你，當天空手來
                </IconText>
              </li>
              <li>
                <IconText icon={BookOpen} iconClassName="h-[20px] w-[20px]">
                  <strong className="font-medium text-brown-900">紙本課本</strong>
                  ：寄到你填的地址
                </IconText>
              </li>
            </ol>
          </section>

          <div className="mt-[32px] flex flex-col items-center gap-[12px] sm:flex-row sm:justify-center md:mt-[40px]">
            <LinkButton
              href="/"
              variant="outline"
              size="lg"
              className="w-full sm:w-auto"
            >
              回首頁
            </LinkButton>
            <LinkButton
              href="/account"
              variant="primary"
              size="lg"
              className="w-full sm:w-auto"
            >
              看我的學習
            </LinkButton>
          </div>

          <div className="mt-[24px] text-center">
            <p className="t-caption text-brown-500">有問題隨時 LINE，真人回覆</p>
            <a
              href={SITE.lineHref}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClass({
                variant: "dark",
                size: "lg",
                className: "mt-[12px] w-full gap-[8px] sm:w-auto",
              })}
            >
              <MessageCircle aria-hidden="true" strokeWidth={ICON_STROKE} className="h-[20px] w-[20px]" />
              加我們的 LINE
              <span className="sr-only">（會開啟 LINE）</span>
            </a>
          </div>

          <p className="mt-[32px] text-center text-[16px] leading-[1.8] text-brown-300">
            {SITE.disclaimer}
          </p>
        </div>
      </div>
    </div>
  );
}
