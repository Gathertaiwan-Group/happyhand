import { Suspense } from "react";
import type { Metadata } from "next";
import { buttonClass } from "@/components/ui/button";
import { SITE } from "@/lib/site";
import { MessageCircle, Users } from "lucide-react";
import { getProducts, getWorkshopSessions } from "@/lib/data";
import { SessionRow } from "./_components/session-row";
import { SessionCard } from "./_components/session-card";
import {
  WorkshopsBrowser,
  WorkshopsBrowserFallback,
} from "./_components/workshops-browser";
import { hasOnline } from "@/lib/session-format";
import { sessionCategories } from "@/lib/course-category";
import { detailHrefMap } from "@/lib/content";

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

  // 場次列的標題與「我要報名」連到這門課自己的介紹頁：workshop 走 /workshops/[slug]，
  // course（例如讀脈入門課的實體班）走 /courses/[slug]。查不到的留 null，CTA 退回加入購物車。
  const detailHrefs = detailHrefMap(products);

  const browserProps = {
    hasOnlineSessions: sessions.some((s) => hasOnline(s.format)),
    items: sessions.map((s) => {
      const key = s.id ?? `${s.slug}-${s.starts_at}`;
      const href = detailHrefs.get(s.slug);
      return {
        key,
        cats: sessionCategories(s.format),
        // 有介紹頁 → 整張可點的列表卡；查不到商品才退回舊的場次列（直接加入購物車／LINE）
        node: href ? (
          <SessionCard key={key} session={s} detailHref={href} />
        ) : (
          <SessionRow key={key} session={s} detailHref={null} />
        ),
      };
    }),
  };

  return (
    <div>
      {/* 標題帶 + 分類鈕（全部場次／線上直播／線下工作坊）+ 場次列表。
          篩選在瀏覽器端套用，見 workshops-browser.tsx。 */}
      <Suspense fallback={<WorkshopsBrowserFallback {...browserProps} />}>
        <WorkshopsBrowser {...browserProps} />
      </Suspense>

      <section className="fab-safe px-[16px] pt-[20px] pb-[32px] md:px-[40px] md:pt-[32px] md:pb-[48px]">
        <div className="mx-auto max-w-[1080px]">
          {/* 包班詢問（設計稿 L540–546） */}
          <div className="flex flex-col gap-[14px] rounded-sm border border-dashed border-sand-400 p-[18px] md:flex-row md:items-center md:justify-between md:gap-[24px] md:p-[26px_30px]">
            <div className="flex items-center gap-[12px]">
              <span aria-hidden="true" className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full bg-cream-200 text-caramel-dk">
                <Users strokeWidth={1.8} className="h-[22px] w-[22px]" />
              </span>
              <div>
                <h2 className="font-serif text-[19px] font-semibold text-brown-900 md:text-[21px]">
                  揪團包班
                </h2>
                <p className="text-[17px] leading-[1.7] text-brown-500">
                  滿 6 人・時間地點可談
                </p>
              </div>
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
              <MessageCircle aria-hidden="true" strokeWidth={1.8} className="mr-[8px] h-[20px] w-[20px]" />
              問包班
              <span className="sr-only">（會開啟 LINE）</span>
            </a>
          </div>

          <p className="mt-[24px] t-caption text-brown-500">
            {SITE.disclaimer}
          </p>
        </div>
      </section>

    </div>
  );
}
