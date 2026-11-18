import type { Metadata } from "next";
import { PageHero } from "@/app/_components/page-hero";
import { ForgotForm } from "./_components/forgot-form";

export const metadata: Metadata = {
  title: "忘記密碼",
  description: "輸入你的 Email，我們寄一封信讓你設定新密碼。",
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <div className="pb-[80px]">
      <PageHero
        eyebrow="PASSWORD"
        title="忘記密碼"
        lead="輸入買課時的 Email，我們寄信讓你設定新密碼。"
      />
      <div className="mx-auto max-w-[560px] px-[20px] md:px-[40px]">
        <ForgotForm />
      </div>
    </div>
  );
}
