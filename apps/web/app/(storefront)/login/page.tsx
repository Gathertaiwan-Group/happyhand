import type { Metadata } from "next";
import { PageHero } from "@/app/_components/page-hero";
import { LoginForm } from "@/app/(storefront)/login/_components/login-form";

export const metadata: Metadata = {
  title: "登入",
  description: "快樂手工作人員登入。",
  robots: { index: false, follow: false },
};

/**
 * 登入頁。前台版型，因為員工也是從一般網站點進來的。
 * middleware 未登入時會導到這裡並帶 ?redirect=<原本要去的路徑>。
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string; error?: string }>;
}) {
  const { redirect, error } = await searchParams;

  return (
    <div className="pb-[80px]">
      <PageHero
        eyebrow="LOGIN"
        title="登入"
        lead="看你的課程與訂單。第一次來，用下單的 Email 註冊。"
      />
      <div className="px-[20px] md:px-[40px]">
        <LoginForm redirect={redirect} initialError={error} />
      </div>
    </div>
  );
}
