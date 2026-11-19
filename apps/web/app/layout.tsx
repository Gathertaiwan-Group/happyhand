import type { Metadata, Viewport } from "next";
import { Noto_Sans_TC, Noto_Serif_TC } from "next/font/google";
import "./globals.css";
import { SITE } from "@/lib/site";

/**
 * CJK 字型的 @font-face 宣告很貴：每個 family × 每個字重會展開上百條
 * unicode-range，兩個 family 目前佔約 70 KB（brotli 後）的 render-blocking CSS。
 * 所以只載真的用到的字重 —— 300 全站 0 次使用，已移除。
 * 要再降就得自架 subset（見 README「尚未完成」）。
 */
const notoSans = Noto_Sans_TC({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-noto-sans-tc",
  display: "swap",
  preload: false,
});

const notoSerif = Noto_Serif_TC({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-noto-serif-tc",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: "快樂手 Happy Healing Hands｜仁神術 JSJ 線上課程與工作坊",
    template: "%s｜快樂手",
  },
  description:
    "快樂手是柳樺老師的仁神術（JSJ）練習。不需要體力、不需要器材，把手放在自己身上，跟著呼吸慢慢練。",
  openGraph: {
    title: "快樂手 Happy Healing Hands",
    description:
      "柳樺老師的仁神術（JSJ）練習。每天十分鐘，坐著也能做，有人陪著練。",
    type: "website",
    locale: "zh_TW",
    siteName: "快樂手",
    // 這個客群主要靠 LINE 轉傳，沒有預覽圖的連結在 LINE 裡就是一行灰字
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "快樂手 Happy Healing Hands — 仁神術 JSJ 線上課程與台北實體工作坊",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "快樂手 Happy Healing Hands",
    description:
      "柳樺老師的仁神術（JSJ）練習。每天十分鐘，坐著也能做，有人陪著練。",
    images: ["/og.png"],
  },
  icons: {
    // favicon 不用寫：app/favicon.ico 走 Next 的檔案慣例會自動掛上，
    // 這裡再寫一次會產生重複的 <link>。
    // apple-touch-icon 在 public/ 底下，Next 不會自動掛，所以要明寫。
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // 樂齡族需要放大到 200%，不可鎖定縮放
  maximumScale: 5,
  themeColor: "#FFFFFF",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant-TW" className={`${notoSans.variable} ${notoSerif.variable}`}>
      {/*
        這一層刻意只留 html/body/字體/metadata。
        前台的導覽列、頁尾、購物車 provider 在 app/(storefront)/layout.tsx，
        後台的側欄與分頁在 app/admin/layout.tsx，兩邊互不影響。
      */}
      <body>{children}</body>
    </html>
  );
}
