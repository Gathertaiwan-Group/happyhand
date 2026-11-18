import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass } from "@/components/ui/button";
import { KeyRound, LogOut, Mail, UserRound, type LucideIcon } from "lucide-react";
import { getMember } from "@/lib/account/guard";
import { Card, LineButton, PageHeading } from "../_components/shell";
import { ProfileForm } from "./_components/profile-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "我的資料",
  description: "修改姓名、電話，或設定新密碼。",
  robots: { index: false, follow: false },
};

/**
 * 我的資料。
 *
 * 四塊：可以改的資料、不能改的帳號、密碼、登出。
 * Email 刻意設計成**不能在這裡改** —— 它是訂單歸戶的鍵，
 * 改掉會讓客人跟自己的訂單斷開。要改請走 LINE，由客服在後台處理
 * （/admin/orders/[id] 的「修正 Email／換綁帳號」會一併搬移已開通的課）。
 */
export default async function AccountSettingsPage() {
  const member = await getMember();

  return (
    <>
      <PageHeading
        title="我的資料"
        lead="只有我們看得到，用來聯絡你與寄課本。"
      />

      <Card>
        <CardTitle icon={UserRound} className="mb-[16px]">基本資料</CardTitle>
        <ProfileForm
          defaults={{
            fullName: member?.fullName ?? "",
            phone: member?.phone ?? "",
            birthYear: member?.birthYear ? String(member.birthYear) : "",
          }}
        />
      </Card>

      <Card className="mt-[18px]">
        <CardTitle icon={Mail}>登入用的信箱</CardTitle>
        <p className="t-body mt-[10px] break-all text-brown-900">
          {member?.email ?? "—"}
        </p>
        <p className="t-body-sm mt-[10px] text-pretty text-brown-500">
          信箱是你的帳號，也綁著你買過的課，所以不能自己改。
          要換用 LINE 說，買過的課會一起帶過去。
        </p>
        <LineButton className="mt-[16px]" label="我要換信箱" />
      </Card>

      <Card className="mt-[18px]">
        <CardTitle icon={KeyRound}>密碼</CardTitle>
        <p className="t-body mt-[10px] text-pretty text-brown-700">
          換密碼，或用 LINE／Google 登入、還沒設過密碼，都在這裡設定。
        </p>
        <Link
          href="/reset-password"
          className={buttonClass({
            variant: "outline",
            size: "lg",
            fullWidth: true,
            className: "mt-[16px] sm:w-auto",
          })}
        >
          設定新密碼
        </Link>
      </Card>

      <Card className="mt-[18px]">
        <CardTitle icon={LogOut}>登出</CardTitle>
        <p className="t-body mt-[10px] text-pretty text-brown-700">
          用別人的電腦或手機記得登出，課不會不見。
        </p>
        {/* 原生 form POST：/logout 只收 POST（收 GET 的話 <img src="/logout">
            就能把人登出）。不需要 client component。 */}
        <form action="/logout" method="post" className="mt-[16px]">
          <button
            type="submit"
            className={buttonClass({
              variant: "outline",
              size: "lg",
              fullWidth: true,
              className: "sm:w-auto",
            })}
          >
            登出
          </button>
        </form>
      </Card>
    </>
  );
}

function CardTitle({
  icon: Icon,
  children,
  className = "",
}: {
  icon: LucideIcon;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2 className={`t-h3 flex items-center gap-[10px] text-brown-900 ${className}`}>
      <Icon aria-hidden="true" strokeWidth={1.8} className="h-[22px] w-[22px] shrink-0 text-caramel-dk" />
      {children}
    </h2>
  );
}
