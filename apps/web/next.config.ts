import type { NextConfig } from "next";

/**
 * 後台上傳的圖片存在 Supabase Storage 的 public bucket，
 * 前台用 next/image（components/ui/placeholder.tsx 的 Figure）顯示。
 *
 * ⚠️ 沒有這段 remotePatterns，只要 products.cover_url 有值，
 * /courses、/courses/[slug]、/workshops/[slug]、/cart、/checkout 會全部 500。
 * 目前 cover_url 都是 null 所以看不出問題，後台一上傳就會炸。
 *
 * 只放行 /storage/v1/object/public/**：簽名 URL（私有檔，例如課程影片）
 * 不該經過 next/image 快取層。
 */
/**
 * 後台防點擊劫持（clickjacking）。
 *
 * 情境：別的網站把 /admin/...（例如訂單頁）放進透明 iframe，
 * 誘使已登入的管理員點到「退款」之類的按鈕。
 * frame-ancestors 'none' 讓瀏覽器拒絕把後台嵌進任何框架；X-Frame-Options 給
 * 不認 CSP frame-ancestors 的舊瀏覽器。
 *
 * 只套 /admin 底下：前台頁面可能被嵌入（合作夥伴、社群預覽），不動它們。
 * 用 next.config 的 headers() 而不是 middleware：靜態規則、不用多跑程式，
 * 而且 middleware 只在需要登入的路徑上跑，不該再背這個責任。
 */
const ADMIN_FRAME_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      // `/admin/:path*` 也涵蓋 /admin 本身（:path* 可以是零段）
      { source: "/admin/:path*", headers: ADMIN_FRAME_HEADERS },
    ];
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
};

export default nextConfig;
