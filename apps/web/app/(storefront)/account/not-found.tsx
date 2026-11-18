import Link from "next/link";
import { buttonClass } from "@/components/ui/button";
import { SITE } from "@/lib/site";

/**
 * 會員中心的 404。
 *
 * 最常見的來路是「訂單明細的網址過期或不是自己的」——
 * getMyOrder() 查不到就 notFound()，而且刻意不區分「不存在」與「不是你的」
 * （區分等於告訴人家某個 id 存在但不屬於他）。
 *
 * 所以文案要涵蓋這兩種情形而不明說是哪一種，並且立刻給出口。
 */
export default function AccountNotFound() {
  return (
    <div className="rounded-card border border-sand-400 bg-cream-100 px-[22px] py-[30px] md:px-[40px] md:py-[40px]">
      <h1 className="t-h2 text-brown-900">找不到這一頁</h1>
      <p className="t-body mt-[14px] text-pretty text-brown-700">
        連結可能過期了，回「我的訂單」重新找一次通常就有。
      </p>

      <div className="mt-[24px] flex flex-col gap-[12px] sm:flex-row">
        <Link
          href="/account"
          className={buttonClass({
            variant: "primary",
            size: "lg",
            fullWidth: true,
            className: "sm:w-auto",
          })}
        >
          回我的學習
        </Link>
        <Link
          href="/account/orders"
          className={buttonClass({
            variant: "outline",
            size: "lg",
            fullWidth: true,
            className: "sm:w-auto",
          })}
        >
          看我的訂單
        </Link>
      </div>

      <p className="t-body-sm mt-[20px] text-pretty text-brown-500">
        找不到你要的東西嗎？
        <a
          href={SITE.lineHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block py-[10px] text-caramel-dk hover:underline"
        >
          用 LINE 問我們
          <span className="sr-only">（會開啟 LINE）</span>
        </a>
        ，報你的名字就好。
      </p>
    </div>
  );
}
