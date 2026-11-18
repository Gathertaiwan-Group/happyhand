import { SITE } from "@/lib/site";
import { MapPin, MessageCircle } from "lucide-react";

/**
 * 焦糖色「用 LINE 問」出口（設計稿 930–933 行桌機、973–977 行手機）
 * 每一頁都要有這一段（README 無障礙需求：每頁都要有聯絡我們的出口）。
 * 手機稿的白色聯絡鈕在桌機也保留，桌機改為置中的膠囊按鈕。
 */
export function CallBand({
  heading = (
    <>
      想問什麼都可以，
      <br className="md:hidden" />
      我們有真人回訊息
    </>
  ),
  note,
}: {
  heading?: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <section className="bg-caramel text-white">
      <div className="mx-auto max-w-maxw px-[20px] py-[34px] text-center md:px-[40px] md:py-[56px]">
        <h2 className="font-serif text-[22px] leading-[1.55] font-medium md:text-[30px] md:leading-[1.4]">
          {heading}
        </h2>

        {note && (
          <p className="t-body-sm mx-auto mt-[12px] max-w-[620px] text-pretty text-white">
            {note}
          </p>
        )}

        {/* 外部連結，要自己帶 target/rel — LinkButton 對外部連結不會轉發這些屬性 */}
        <a
          href={SITE.lineHref}
          target="_blank"
          rel="noopener noreferrer"
          className="mx-auto mt-[18px] flex min-h-[56px] w-full items-center justify-center rounded-pill bg-white px-[24px] text-[19px] text-brown-900 transition-colors duration-200 hover:bg-cream-200 md:mt-[24px] md:inline-flex md:w-auto md:px-[40px]"
        >
          <MessageCircle aria-hidden="true" strokeWidth={1.8} className="mr-[8px] h-[20px] w-[20px] text-caramel-dk" />
          加我們的 LINE
          <span className="sr-only">（會開啟 LINE）</span>
        </a>

        <p className="t-caption mt-[16px] text-white">
          <span className="inline-flex items-start gap-[6px] md:hidden">
            <MapPin aria-hidden="true" strokeWidth={1.8} className="mt-[0.25em] h-[16px] w-[16px] shrink-0" />
            <span className="sr-only">地址：</span>
            <span className="text-left">
              {SITE.company}
              <br />
              {SITE.address}
            </span>
          </span>
          <span className="hidden md:inline">{SITE.footerLine}</span>
        </p>
      </div>
    </section>
  );
}
