import type { Metadata } from "next";
import { LinkButton, buttonClass } from "@/components/ui/button";
import { SITE } from "@/lib/site";
import { isBlackcatConfigured } from "@/lib/payment/blackcat";
import { CheckoutSteps } from "@/app/(storefront)/checkout/_components/checkout-steps";

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
            "刷卡結果會由黑貓 PAY 通知我們，通常幾秒內就會完成。" +
            // 2026-10-15：發票不再自動開立，只有開通是自動的。
            "課程會自動開通，通知信會寄到你填的 Email。電子發票我們另外開立後再寄給你。" +
            "如果過了十分鐘還沒收到，用 LINE 跟我們說一聲。",
        }
      : {
          title: "關於信用卡付款",
          body: "線上刷卡還在開通中，所以我們會用 LINE 跟你確認付款方式。現在還沒有跟你收款，請放心。",
        };
  }
  return PAYMENT_NOTE[method];
}

const PAYMENT_NOTE: Record<string, { title: string; body: string }> = {
  atm: {
    title: "關於 ATM 匯款",
    body: `匯款帳號請用 LINE 跟我們拿，戶名是${SITE.company}。匯款後我們對帳完成就會開通，大約 1 個工作天。`,
  },
  manual: {
    title: "我們會用 LINE 跟你聯絡",
    body: "這筆訂單是請我們代訂的。我們會用 LINE 跟你確認課程與付款方式；等不及的話也可以直接用 LINE 找我們。",
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
  const note = paymentNote(one(sp.pay), isBlackcatConfigured()) ?? null;

  return (
    <div>
      <CheckoutSteps current={3} />

      <div className="mx-auto max-w-maxw px-[20px] pb-[64px] md:px-[40px] md:pb-[80px]">
        <div className="mx-auto max-w-[1000px]">
          <div className="text-center">
            <div
              aria-hidden
              className="mx-auto flex h-[76px] w-[76px] items-center justify-center rounded-pill bg-cream-100 text-[32px] text-caramel-ink md:h-[96px] md:w-[96px] md:text-[40px]"
            >
              ✓
            </div>

            <h1 className="t-h1 mt-[18px] text-brown-900 md:mt-[24px]">
              報名完成
            </h1>

            <p className="t-body-lg mx-auto mt-[12px] max-w-[640px] text-brown-700 md:mt-[14px]">
              {"我們收到你的訂單了。開通通知會寄到你剛剛填的 Email，也會有專人跟你聯絡，不用擔心漏掉。"}
            </p>

            {orderNo ? (
              <div className="mx-auto mt-[18px] inline-block rounded-card bg-cream-100 px-[24px] py-[16px] md:mt-[22px] md:rounded-pill md:px-[28px]">
                <p className="text-[16px] text-brown-500">訂單編號</p>
                <p className="mt-[4px] font-serif text-[22px] font-semibold tracking-[0.06em] text-brown-900 select-all md:text-[26px]">
                  {orderNo}
                </p>
                <p className="mt-[6px] text-[16px] text-brown-300">
                  用 LINE 問我們的時候，把這一組號碼貼給我們就可以了
                </p>
              </div>
            ) : (
              <p className="t-body mx-auto mt-[18px] max-w-[640px] text-brown-500">
                {"如果要查詢這筆報名，用 LINE 問我們，報一下你的姓名與手機號碼就可以了。"}
              </p>
            )}
          </div>

          {note && (
            <div className="mt-[32px] rounded-card border border-sand-500 px-[24px] py-[24px] md:mt-[44px] md:px-[30px] md:py-[28px]">
              <h2 className="font-serif text-[20px] font-semibold text-brown-900 md:text-[22px]">
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
              className="font-serif text-[20px] font-semibold text-brown-900 md:text-[22px]"
            >
              我們幫你開好帳號了
            </h2>
            <p className="mt-[12px] text-[16.5px] leading-[1.9] text-brown-700 md:text-[17.5px]">
              我們已經寄了一封
              <strong className="font-semibold text-brown-900">「請設定密碼」</strong>
              的信到你剛剛填的信箱。打開信、按裡面那顆按鈕設定一組密碼，
              之後就能登入看你買的課程和訂單。
            </p>
            <p className="mt-[10px] text-[16px] leading-[1.9] text-brown-500">
              ・沒收到的話，先看看「垃圾郵件」那一夾，信可能要等一兩分鐘。
              <br />
              ・不想現在設定也沒關係，課程開通之後我們會再寄一次通知。
            </p>
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
                一、線上課程：我們開通之後，你登入就能在「我的學習」裡看，想看幾次都可以。
              </li>
              <li>
                二、實體工作坊：開課前三天我們會再提醒你一次，當天空手來就好。
              </li>
              <li>
                三、有紙本課本的話，會寄到你填的地址；沒收到通知信請先看看垃圾信件匣。
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
            <p className="t-caption text-brown-500">有問題隨時用 LINE 說，有真人回訊息。</p>
            <a
              href={SITE.lineHref}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClass({
                variant: "dark",
                size: "lg",
                className: "mt-[12px] w-full sm:w-auto",
              })}
            >
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
