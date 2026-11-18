import { SITE } from "@/lib/site";
import { LinkButton, buttonClass } from "@/components/ui/button";
import { MessageCircle } from "lucide-react";

/**
 * 手機固定行動列（README §4.1 #7）
 * 桌機不顯示。頁面容器需加 `.pb-action-bar` 預留 96px，避免遮擋內容。
 */
export function MobileActionBar({
  href = "/courses",
  label = "開始線上練習",
  showLine = true,
}: {
  href?: string;
  label?: string;
  /** 主要動作本身就是 LINE 時設 false，否則會出現兩顆一樣的 LINE 鈕 */
  showLine?: boolean;
}) {
  // 主要動作也可能是 LINE（例如 /workshops）。外部連結一律走原生 <a>，
  // 因為 LinkButton 對外部連結不會轉發 target/rel。
  const external = href.startsWith("http");
  const mainClass = showLine
    ? "flex-[1.4] px-2 text-[17px]"
    : "flex-1 px-2 text-[17px]";

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-sand-300 bg-white/96 px-[16px] pb-[calc(12px+env(safe-area-inset-bottom))] pt-[12px] backdrop-blur-sm md:hidden">
      <div className="flex gap-[10px]">
        {showLine && (
          <a
            href={SITE.lineHref}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass({
              variant: "outline",
              className: "flex-1 gap-[6px] px-2 text-[17px] whitespace-nowrap",
            })}
          >
            <MessageCircle aria-hidden="true" strokeWidth={1.8} className="h-[20px] w-[20px] shrink-0 text-caramel-dk" />
            用 LINE 問
            <span className="sr-only">（會開啟 LINE）</span>
          </a>
        )}
        {external ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass({
              variant: "primary",
              className: mainClass,
            })}
          >
            {label}
            <span className="sr-only">（會開啟 LINE）</span>
          </a>
        ) : (
          <LinkButton href={href} variant="primary" className={mainClass}>
            {label}
          </LinkButton>
        )}
      </div>
    </div>
  );
}
