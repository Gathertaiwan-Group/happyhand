import { Suspense } from "react";
import type { Metadata } from "next";
import { buttonClass } from "@/components/ui/button";
import { MobileActionBar } from "@/components/mobile-action-bar";
import { SITE } from "@/lib/site";
import { getProducts, getWorkshopSessions } from "@/lib/data";
import { SessionRow } from "./_components/session-row";
import {
  WorkshopsBrowser,
  WorkshopsBrowserFallback,
} from "./_components/workshops-browser";
import { hasOnline } from "@/lib/session-format";
import { sessionCategories } from "@/lib/course-category";

/** 與 /courses 一致的 ISR 週期。後台改動仍靠 revalidatePath 立即生效，
 *  這個值只是「就算沒人呼叫 revalidate，最久也就過期五分鐘」的保底。 */
export const revalidate = 300;

export const metadata: Metadata = {
  title: "線上直播與線下工作坊",
  description:
    "快樂手的線上直播與線下工作坊場次表。直播在家打開視訊就能跟著老師做；線下工作坊小班制，老師會一個一個看過去，空手來就行。想問哪一場適合你，加我們的 LINE @hao2082l。",
  // ?format=online／onsite 只是同一頁的篩選，不要被當成另外幾頁收錄
  alternates: { canonical: "/workshops" },
};

/**
 * /workshops — 線上直播與線下工作坊的場次列表（導覽列兩個入口都指到這頁，帶 ?format=）
 * 設計稿 happyhands-B-all-pages.dc.html：桌機 L465–549、手機 L551–615；規格 README §4.4。
 * 垂直卡片列（非網格），桌機每列 grid 96px/1fr/auto/auto，手機上下堆疊、CTA 滿版。
 */
export default async function WorkshopsPage() {
  const [sessions, products] = await Promise.all([
    getWorkshopSessions(),
    getProducts(),
  ]);

  // 只有 type=workshop 的商品才有單場詳情頁，其餘（例如讀脈入門課的實體班）標題不做連結，避免連到 404
  const workshopSlugs = new Set(
    products.filter((p) => p.type === "workshop").map((p) => p.slug),
  );

  const browserProps = {
    hasOnlineSessions: sessions.some((s) => hasOnline(s.format)),
    items: sessions.map((s) => {
      const key = s.id ?? `${s.slug}-${s.starts_at}`;
      return {
        key,
        cats: sessionCategories(s.format),
        node: (
          <SessionRow
            key={key}
            session={s}
            detailHref={
              workshopSlugs.has(s.slug) ? `/workshops/${s.slug}` : null
            }
          />
        ),
      };
    }),
  };

  return (
    <div className="pb-action-bar">
      {/* 標題帶 + 分類鈕（全部場次／線上直播／線下工作坊）+ 場次列表。
          篩選在瀏覽器端套用，見 workshops-browser.tsx。 */}
      <Suspense fallback={<WorkshopsBrowserFallback {...browserProps} />}>
        <WorkshopsBrowser {...browserProps} />
      </Suspense>

      <section className="fab-safe px-[20px] pt-[14px] pb-[28px] md:px-[40px] md:pb-[48px]">
        <div className="mx-auto max-w-maxw">
          {/* 包班詢問（設計稿 L540–546） */}
          <div className="flex flex-col gap-[16px] rounded-sm border border-dashed border-sand-400 p-[20px] md:flex-row md:items-center md:justify-between md:gap-[24px] md:p-[26px_30px]">
            <div>
              <h2 className="font-serif text-[19px] font-semibold text-brown-900 md:text-[21px]">
                想揪一群朋友一起上？
              </h2>
              <p className="mt-[8px] text-[17px] leading-[1.9] text-brown-500">
                滿 6 人可以另外安排包班，地點時間都能談。
              </p>
            </div>
            <a
              href={SITE.lineHref}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClass({
                variant: "outline",
                className: "w-full whitespace-nowrap md:w-auto",
              })}
            >
              問包班
              <span className="sr-only">（會開啟 LINE）</span>
            </a>
          </div>

          <p className="mt-[24px] t-caption text-brown-300">
            {SITE.disclaimer}
          </p>
        </div>
      </section>

      {/* 主要動作就是開 LINE，關掉左邊的 LINE 鈕改成單顆滿版，長輩更好按 */}
      <MobileActionBar
        href={SITE.lineHref}
        label="用 LINE 報名"
        showLine={false}
      />
    </div>
  );
}
