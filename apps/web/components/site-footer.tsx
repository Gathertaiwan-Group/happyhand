import Link from "next/link";
import Image from "next/image";
import { SITE, NAV_LINKS } from "@/lib/site";
import { Clock, MessageCircle } from "lucide-react";
import { IconText } from "@/components/ui/icon-text";

/**
 * Facebook 圖示。內嵌 SVG，維持全站「不裝 icon 套件」的慣例
 *（site-header.tsx 的購物車與會員圖示也是這樣做的）。
 * currentColor 讓它跟著父層文字顏色走，hover 才會一起變。
 */
function FacebookIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M24 12.073C24 5.446 18.627 0 12 0S0 5.446 0 12.073C0 18.062 4.388 23.027 10.125 23.927v-8.385H7.078v-3.469h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.313 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.469h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
    </svg>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-sand-300 bg-white">
      <div className="mx-auto grid max-w-maxw gap-[28px] px-[20px] py-[40px] md:grid-cols-[1.2fr_1fr_1fr] md:px-[40px] md:py-[56px]">
        <div>
          <Image
            src="/logo-wordmark.png"
            alt={SITE.brandZh}
            width={695}
            height={280}
            sizes="90px"
            className="h-[30px] w-auto"
          />
          <div className="t-micro mt-[10px] tracking-[0.14em] text-brown-300">
            {SITE.brandEn}
          </div>
          <p className="t-body-sm mt-[16px] text-brown-500">
            {SITE.company} {SITE.companyEn}
            <br />
            {/* 代表人姓名不放頁尾（客戶要求）。/terms 的負責人欄位是法規需要、
                /about 的公司資訊表是介紹用，那兩處保留。 */}
            統一編號 {SITE.taxId}
            <br />
            {SITE.contactWindow.prefix}
            {/* 站外連結，要自己帶 target/rel；加底線讓它看得出來可以點 */}
            <a
              href={SITE.contactWindow.shopHref}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-[3px] transition-colors duration-200 hover:text-caramel-dk"
            >
              {SITE.contactWindow.shop}
              <span className="sr-only">（會開啟小時光書店網站）</span>
            </a>
            {SITE.contactWindow.separator}
            {SITE.contactWindow.person}
          </p>
        </div>

        <nav aria-label="頁尾選單">
          <h2 className="t-caption font-medium text-brown-900">網站導覽</h2>
          <ul className="mt-[12px] flex flex-col">
            {NAV_LINKS.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className="flex min-h-[44px] items-center text-[17px] text-brown-500 hover:text-caramel-dk"
                >
                  {l.label}
                </Link>
              </li>
            ))}
            <li>
              <Link
                href="/about"
                className="flex min-h-[44px] items-center text-[17px] text-brown-500 hover:text-caramel-dk"
              >
                品牌介紹
              </Link>
            </li>
            {/* 買過課的人回來時要找得到入口。原本全站只有手機版抽屜有，
                桌機使用者只能自己打網址。 */}
            <li>
              <Link
                href="/account"
                className="flex min-h-[44px] items-center text-[17px] text-brown-500 hover:text-caramel-dk"
              >
                我的學習
              </Link>
            </li>
            <li>
              <Link
                href="/terms"
                className="flex min-h-[44px] items-center text-[17px] text-brown-500 hover:text-caramel-dk"
              >
                服務條款與退費規定
              </Link>
            </li>
          </ul>
        </nav>

        <div>
          <h2 className="t-caption font-medium text-brown-900">有問題想問</h2>
          {/* 外部連結，要自己帶 target/rel — LinkButton 對外部連結不會轉發這些屬性 */}
          <a
            href={SITE.lineHref}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-[12px] flex min-h-[56px] w-full items-center justify-center rounded-pill border-2 border-sand-400 text-[18px] text-brown-900 transition-colors duration-200 hover:bg-[#F5E7CE] md:w-auto md:px-[28px]"
          >
            <MessageCircle aria-hidden="true" strokeWidth={1.8} className="mr-[8px] h-[20px] w-[20px] text-caramel-dk" />
            用 LINE 問我們
            <span className="sr-only">（會開啟 LINE）</span>
          </a>
          {/* CONTENT.md：說明文字最小 16px，所以這裡不用 t-micro(15px) */}
          <p className="t-caption mt-[14px] text-brown-500">
            <IconText icon={Clock} label="服務時間">週一至週五 10:00–18:00</IconText>
          </p>

          {/* 粉絲頁。同樣是站外連結，要自己帶 target/rel。
              min-h-44px 是全站觸控區下限（客群 60–75 歲，手指點不準）。 */}
          <a
            href={SITE.facebookHref}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-[10px] inline-flex min-h-[44px] items-center gap-[8px] text-[17px] text-brown-500 transition-colors duration-200 hover:text-caramel-dk"
          >
            <FacebookIcon className="h-[20px] w-[20px] shrink-0" />
            {SITE.facebookLabel}
            <span className="sr-only">（會開啟 Facebook）</span>
          </a>
        </div>
      </div>

      <div className="border-t border-sand-300">
        <div className="mx-auto max-w-maxw px-[20px] py-[20px] md:px-[40px]">
          {/* 免責聲明是法規要求的內容，不可以縮到 15px 灰字 */}
          <p className="t-caption text-brown-500">{SITE.disclaimer}</p>
          <p className="t-caption mt-2 text-brown-500">{SITE.copyright}</p>
        </div>
      </div>
    </footer>
  );
}
