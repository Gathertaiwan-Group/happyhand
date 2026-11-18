import { CATEGORY_HREF, CATEGORY_LABEL } from "@/lib/course-category";
/** 公司與品牌資訊 — 來源：design_handoff_happyhands/CONTENT.md，請照抄不要改寫 */
export const SITE = {
  /**
   * 正式網域是 happyhands.com.tw（**不是** happyhands.tw —— 那個網域從來沒
   * 註冊過，DNS 查不到 NS，之前寫在這裡是錯的）。
   *
   * ⚠️ 這個值不只影響 SEO。它同時是：
   *    - layout.tsx 的 metadataBase（og:url、canonical）
   *    - lib/account/provision.ts 組「設定密碼」信連結的基底
   *    - lib/email/templates.ts 裡「我的學習」按鈕的連結
   *    寫錯的話客人收到信、點了連結會打不開，而站上完全看不出異常。
   *
   * Vercel 上有設 NEXT_PUBLIC_SITE_URL 會蓋掉這裡的預設值，**換網域時那邊要
   * 一起改**，否則信裡的連結會繼續指向舊的 vercel.app 網址。
   */
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "https://happyhands.com.tw",
  brandZh: "快樂手",
  brandEn: "HAPPY HEALING HANDS",
  company: "好日子股份有限公司",
  companyEn: "GOOD DAY LOVE INC.",
  taxId: "53912857",
  representative: "劉柳樺",
  /**
   * 聯絡方式一律走 LINE 官方帳號，站上不再放電話。
   *
   * lineLabel 是給人看的顯示字（按鈕、內文），lineHref 是實際連結。
   * ⚠️ 這是外部連結（page.line.me），所有 <a> 要記得 target/rel，
   *    或直接用 LinkButton —— 它會自動判斷 http 開頭走原生 <a>。
   */
  lineId: "@hao2082l",
  lineLabel: "LINE 好友",
  lineHref: "https://page.line.me/hao2082l",
  /** Facebook 粉絲頁。與 lineHref 一樣是站外連結，<a> 要自己帶 target/rel。 */
  facebookHref: "https://www.facebook.com/JSJSelfhelp",
  facebookLabel: "Facebook 粉絲頁",
  address: "臺北市中山區新生北路三段 1 號 9 樓之 15",
  /**
   * 頁尾顯示的服務窗口。
   *
   * 🔴 這裡刻意**不是** address：客戶要求頁尾寫服務窗口而不是公司地址。
   *    address 仍然是真的公司地址，/terms（負責人與地址是法規要求）、
   *    /about 的公司資訊表、工作坊場地 fallback、交易信頁尾都還在用它，
   *    不要為了改頁尾就把 address 整個換掉。
   *
   * 拆成四段而不是一整個字串，是因為書店名要能點進他們自己的網站。
   */
  contactWindow: {
    prefix: "服務窗口：",
    shop: "小時光書店",
    shopHref: "https://www.intervalbooks.tw/",
    /** 全形空格：HTML 會把連續半形空格併成一個 */
    separator: "　",
    person: "柳樺老師",
  },
  footerLine:
    "好日子股份有限公司・LINE @hao2082l・臺北市中山區新生北路三段 1 號 9 樓之 15",
  copyright: "Copyright © 2026 快樂手",
  /** 法規要求：不得有醫療宣稱 */
  disclaimer:
    "本課程為自我保健練習，非醫療行為，不能取代專業醫療診斷與治療。",
} as const;

/**
 * 前三個是課程分類（業主 2026-11-18：預錄課程／線上直播／線下工作坊），
 * 網址與文字來自 lib/course-category.ts，跟 /courses 的篩選鈕同一份。
 * 桌機導覽把前 CATEGORY_NAV_COUNT 個放在字標左邊。
 */
export const NAV_LINKS = [
  { href: CATEGORY_HREF.recorded, label: CATEGORY_LABEL.recorded },
  { href: CATEGORY_HREF.live, label: CATEGORY_LABEL.live },
  { href: CATEGORY_HREF.onsite, label: CATEGORY_LABEL.onsite },
  { href: "/teachers", label: "關於老師" },
  { href: "/faq", label: "聯絡我們" },
] as const;

export const CATEGORY_NAV_COUNT = 3;

export function formatPrice(twd: number) {
  return `$${twd.toLocaleString("en-US")}`;
}
