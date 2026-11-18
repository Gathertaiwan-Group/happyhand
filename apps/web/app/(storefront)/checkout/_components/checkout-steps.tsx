import { Fragment } from "react";
import { Check } from "lucide-react";

/**
 * 三步驟橫向進度指示（設計稿 634–640 桌機／713–719 手機、README §4.5）
 *
 * 已完成／目前這一步：bg-caramel-ink text-white
 * 還沒完成：bg-sand-400 text-white
 * 之間 1px 連接線。
 *
 * 手機不換行、標籤 15px（設計稿手機版只有數字，這裡照專案要求補上文字，
 * 讓長輩看得懂自己走到哪一步）。390px 實測寬度約 324px，不會橫向捲動。
 *
 * 純展示元件，沒有 hook，所以 server component（完成頁）與 client component
 * （購物車、結帳）都可以直接用。
 */

const STEPS = [
  { n: 1 as const, label: "購物車" },
  { n: 2 as const, label: "填資料" },
  { n: 3 as const, label: "完成" },
];

export function CheckoutSteps({ current }: { current: 1 | 2 | 3 }) {
  return (
    <nav
      aria-label="報名進度"
      className="flex items-center justify-center gap-[8px] px-[20px] py-[24px] md:gap-[18px] md:py-[32px]"
    >
      {STEPS.map((step, i) => {
        const done = step.n <= current;
        const isCurrent = step.n === current;
        return (
          <Fragment key={step.n}>
            {i > 0 && (
              <span
                aria-hidden
                className={`block h-px w-[18px] shrink-0 md:w-[60px] ${
                  STEPS[i - 1].n < current ? "bg-caramel-ink" : "bg-sand-400"
                }`}
              />
            )}
            <span
              aria-current={isCurrent ? "step" : undefined}
              className={`flex items-center gap-[6px] whitespace-nowrap md:gap-[10px] ${
                done ? "text-caramel-ink" : "text-brown-300"
              }`}
            >
              <span
                aria-hidden
                className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-pill text-[15px] text-white md:h-[32px] md:w-[32px] md:text-[16px] ${
                  done ? "bg-caramel-ink" : "bg-sand-400"
                }`}
              >
                {step.n < current ? (
                  <Check strokeWidth={2.6} className="h-[15px] w-[15px] md:h-[17px] md:w-[17px]" />
                ) : (
                  step.n
                )}
              </span>
              <span className="text-[15px] md:text-[17px]">{step.label}</span>
              <span className="sr-only">
                {isCurrent ? "，目前這一步" : done ? "，已完成" : "，還沒完成"}
              </span>
            </span>
          </Fragment>
        );
      })}
    </nav>
  );
}
