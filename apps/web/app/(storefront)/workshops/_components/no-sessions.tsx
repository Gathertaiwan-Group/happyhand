import { CalendarX2, MessageCircle } from "lucide-react";
import { buttonClass } from "@/components/ui/button";
import { SITE } from "@/lib/site";

/**
 * 沒有場次時的空狀態。
 * 不留白畫面，直接給一個用 LINE 問的出口（README §4.4／樂齡族需求）。
 */
export function NoSessions({ message }: { message?: string }) {
  return (
    <div className="rounded-card border border-dashed border-sand-400 bg-cream-100 p-[24px] text-center md:p-[40px]">
      <CalendarX2 aria-hidden="true" strokeWidth={1.6} className="mx-auto mb-[8px] h-[36px] w-[36px] text-caramel-dk" />
      <p className="t-body mx-auto max-w-[560px] text-brown-500">
        {message ??
          "最近沒有安排場次，想知道下一場什麼時候開，用 LINE 問我們。"}
      </p>
      <div className="mt-[20px] flex justify-center">
        {/* 外部連結，要自己帶 target/rel — LinkButton 對外部連結不會轉發這些屬性 */}
        <a
          href={SITE.lineHref}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonClass({
            variant: "primary",
            className: "w-full md:w-auto",
          })}
        >
          <MessageCircle aria-hidden="true" strokeWidth={1.8} className="mr-[8px] h-[20px] w-[20px]" />
          用 LINE 問我們
          <span className="sr-only">（會開啟 LINE）</span>
        </a>
      </div>
    </div>
  );
}
