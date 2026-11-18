import { Suspense } from "react";
import type { Metadata } from "next";
import { getProducts } from "@/lib/data";
import { MobileActionBar } from "@/components/mobile-action-bar";
import { SITE } from "@/lib/site";
import {
  CourseFilter,
  CourseFilterFallback,
} from "./_components/course-filter";

export const metadata: Metadata = {
  title: "課程總覽",
  description:
    "快樂手的課分三類：預錄課程買了就能永久回放、看不懂隨時倒帶重來；線上直播在家跟著老師做；線下工作坊小班面對面。不確定從哪堂開始可以用 LINE 問我們。",
  // ?cat= 只是同一頁的篩選，不要被當成另外幾頁收錄
  alternates: { canonical: "/courses" },
};

export const revalidate = 300;

/** 課程總覽（設計稿 195–336 行：桌機 201–280、手機 282–334） */
export default async function CoursesPage() {
  const products = await getProducts();

  return (
    <>
      <div className="pb-action-bar">
        {/* 標題帶：設計稿 210–214（桌機）／289–293（手機），底色 token cream-100 */}
        <section className="bg-cream-100 px-[22px] py-[32px] text-center md:px-[40px] md:py-[56px]">
          <div className="mx-auto max-w-maxw">
            {/* 這一頁列的是全部三類（預錄課程／線上直播／線下工作坊），
                標題不能再只講「永久回放」—— 直播與工作坊不是那樣上的。 */}
            <p className="t-eyebrow text-caramel-ink">COURSES</p>
            <h1 className="mt-[10px] font-serif text-[28px] font-medium leading-[1.5] text-brown-900 md:mt-[12px] md:text-[36px] lg:text-[42px]">
              找一堂適合你的課
            </h1>
            <p className="t-body mx-auto mt-[10px] max-w-[640px] text-brown-500 md:mt-[12px]">
              預錄課程買了就能永久回放，看不懂隨時倒帶重來；線上直播和線下工作坊有排好的時間，跟著老師一起練。
            </p>
          </div>
        </section>

        {products.length > 0 ? (
          <Suspense fallback={<CourseFilterFallback products={products} />}>
            <CourseFilter products={products} />
          </Suspense>
        ) : (
          /* 拿掉靜態 fallback 之後，「查不到課程」會誠實顯示成這樣。
             不留一個空的篩選列讓人以為是自己按錯了。 */
          <div className="mx-auto max-w-maxw px-[20px] py-[48px] text-center md:px-[40px] md:py-[72px]">
            <p className="t-body text-brown-700">
              課程清單暫時讀不到，可能是系統正在更新。
            </p>
            <p className="t-body mt-[8px] text-brown-500">
              想知道有哪些課，
              <a
                href={SITE.lineHref}
                target="_blank"
                rel="noopener noreferrer"
                className="-my-[7px] inline-block py-[11px] whitespace-nowrap text-brown-700 underline underline-offset-4 hover:text-caramel-dk"
              >
                用 LINE 問我們
                <span className="sr-only">（會開啟 LINE）</span>
              </a>
              ，我們直接告訴你。
            </p>
          </div>
        )}

        <div className="mx-auto max-w-maxw px-[20px] pb-[32px] md:px-[40px]">
          <p className="t-caption border-t border-sand-300 pt-[20px] text-brown-500">
            {SITE.disclaimer}
          </p>
        </div>
      </div>

      <MobileActionBar href="/workshops" label="看直播與工作坊場次" />
    </>
  );
}
