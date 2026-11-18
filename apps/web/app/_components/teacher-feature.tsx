import type { ReactNode } from "react";
import { Figure } from "@/components/ui/placeholder";
import { ReadMore } from "@/components/ui/read-more";

export type TeacherStat = { value: string; label: string };

/**
 * 老師區（設計稿 895–910 行桌機、949–959 行手機；README §4.1 #5）
 * 桌機 grid 0.85fr / 1.15fr、gap 56px、max-width 1100px；手機上下堆疊、圖在上。
 * 直式照 4:5，圓角 999px 999px 28px 28px（手機 24px）。
 */
export function TeacherFeature({
  eyebrow,
  heading,
  paragraphs,
  stats,
  photoSrc,
  photoAlt = "劉柳樺老師教學照",
  photoLabel = "柳樺老師教學照",
  children,
  className = "",
}: {
  eyebrow?: string;
  heading: ReactNode;
  paragraphs: string[];
  stats?: TeacherStat[];
  photoSrc?: string | null;
  photoAlt?: string;
  photoLabel?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`bg-white ${className}`}>
      <div className="mx-auto grid max-w-[1100px] gap-[22px] px-[20px] py-[34px] md:grid-cols-[0.85fr_1.15fr] md:items-start md:gap-[56px] md:px-[40px] md:py-[56px] lg:py-[72px]">
        <Figure
          src={photoSrc}
          alt={photoAlt}
          label={photoLabel}
          className="aspect-[4/5] w-full"
          rounded="rounded-[999px_999px_24px_24px] md:rounded-[999px_999px_28px_28px]"
          sizes="(min-width: 768px) 42vw, 100vw"
        />

        <div>
          {eyebrow && <p className="t-eyebrow text-caramel-ink">{eyebrow}</p>}
          <h2 className={`t-h2 ${eyebrow ? "mt-[12px]" : ""}`}>{heading}</h2>

          {/* 手機只露出前幾行，其餘按「看完整介紹」展開（文字仍在 DOM 裡）。
              只有一段時不收。 */}
          {(() => {
            const body = (
              <div className="mt-[14px] flex flex-col gap-[14px] md:mt-[20px] md:gap-[16px]">
                {paragraphs.map((p) => (
                  <p key={p} className="t-body text-pretty text-brown-700">
                    {p}
                  </p>
                ))}
              </div>
            );
            return paragraphs.length > 1 ? (
              <ReadMore collapsedHeight={220} moreLabel="看完整介紹">
                {body}
              </ReadMore>
            ) : (
              body
            );
          })()}

          {stats && stats.length > 0 && (
            <div className="mt-[20px] flex flex-wrap gap-x-[24px] gap-y-[14px] md:mt-[30px] md:gap-x-[40px]">
              {stats.map((s) => (
                <div key={s.label}>
                  <div className="font-serif text-[23px] font-semibold text-caramel-ink md:text-[28px]">
                    {s.value}
                  </div>
                  <div className="t-caption mt-[2px] text-brown-500 md:mt-[4px]">
                    {s.label}
                  </div>
                </div>
              ))}
            </div>
          )}

          {children}
        </div>
      </div>
    </section>
  );
}
