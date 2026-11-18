import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getStaff } from "@/lib/admin/guard";
import { ROLE_LABELS } from "@/lib/admin/roles";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { AdminBottomNav } from "@/components/admin/admin-bottom-nav";

/**
 * 後台外殼 + 第 2 層守衛。
 *
 * 三層授權：
 *   1. middleware.ts        — 只看有沒有登入，不查 DB（每個請求都會跑，不能加往返）
 *   2. 這裡                  — 查 profiles.role，非員工一律擋掉
 *   3. requireCapability()  — 每一支 server action 自己再查一次
 *
 * 第 2 層理論上是雙保險（middleware 已經擋掉未登入），但它擋的是 middleware 擋不到的
 * 那一半：「登入了，可是他是一般會員」。少了這層，customer 拿到的是後台畫面
 * 只是查不到資料，而不是被導走。
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "後台管理",
  // 後台不該被搜尋引擎收錄。/admin 會 redirect 沒錯，但登入頁與網址結構仍不必外流。
  robots: { index: false, follow: false },
};

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // getStaff() 已經把「未登入」與「登入了但不是員工」都收斂成 null，
  // 而且不 throw —— 所以這裡只需要判一次。
  const staff = await getStaff();
  if (!staff) redirect("/login?redirect=/admin");

  return (
    <div className="min-h-svh bg-paper">
      <div className="mx-auto flex w-full max-w-[1400px]">
        <AdminSidebar role={staff.role} />

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex min-h-14 items-center gap-3 border-b border-line px-4 py-2 admin:px-6">
            {/* 手機沒有側欄，品牌名放這裡；桌機側欄已經有了就不重複 */}
            <span className="font-serif text-[16px] font-medium tracking-[0.06em] text-ink admin:hidden">
              快樂手 後台
            </span>

            <div className="ml-auto flex shrink-0 items-center gap-3">
              <div className="min-w-0 text-right leading-tight">
                <div className="max-w-[9rem] truncate text-[13px] text-ink admin:max-w-[16rem]">
                  {staff.email ?? "（此帳號沒有 Email）"}
                </div>
                <div className="text-[12px] text-ink-soft">
                  {ROLE_LABELS[staff.role]}
                </div>
              </div>

              {/*
                回前台。側欄最下面本來就有一個，但整條側欄是 `admin:flex` ——
                1024px 以下不顯示，手機與平板根本沒有出口；桌機上它也在捲動區外，
                頁面長一點就捲不到。放在 header 才是每一頁、每個裝置都看得到。
              */}
              <Link
                href="/"
                className="inline-flex min-h-11 items-center rounded-input border border-line-input px-3.5 text-[14px] text-ink transition-colors hover:bg-panel admin:min-h-10"
              >
                回前台
              </Link>

              {/* app/logout/route.ts 刻意只收 POST（GET 的話一張 <img src="/logout"> 就能把人登出），
                  所以這裡是 form 不是 Link。純 HTML 表單，不需要 client component。 */}
              <form action="/logout" method="post">
                <button
                  type="submit"
                  className="inline-flex min-h-11 items-center rounded-input border border-line-input px-3.5 text-[14px] text-ink transition-colors hover:bg-panel admin:min-h-10"
                >
                  登出
                </button>
              </form>
            </div>
          </header>

          {/*
            這裡刻意不是 <main>：app/layout.tsx 已經用 <main id="main"> 把所有路由包住，
            再開一個就是巢狀 main landmark，螢幕閱讀器會出現兩個「主要內容」。
            根治是把前台外殼移進 (storefront) route group（見交付說明），不是在這裡硬塞。

            手機底部要留出分頁列（54px）+ 安全區的高度，否則最後一列會被蓋住。
          */}
          <div className="flex-1 px-4 pt-5 pb-[calc(70px+env(safe-area-inset-bottom))] admin:px-6 admin:pb-10">
            {children}
          </div>
        </div>
      </div>

      <AdminBottomNav role={staff.role} />
    </div>
  );
}
