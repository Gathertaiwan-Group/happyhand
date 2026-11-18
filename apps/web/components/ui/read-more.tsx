"use client";

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ChevronDown } from "lucide-react";

/** 內容超過收合高度這個倍數才值得收；只多一兩行就收起來反而多一個按鈕要按 */
const COLLAPSE_SLACK = 1.25;

/**
 * 手機版「先收起來、按了再展開」的長段落（2026-11-18 全站減字）。
 *
 * - 只在手機（< 768px）收合；桌機永遠全文顯示、按鈕不出現。
 * - 文字一直都在 DOM 裡（只是用 max-height 遮住），搜尋引擎與螢幕報讀都讀得到，
 *   退款規則這類「不能刪」的資訊用這個收起來不算刪掉。
 * - 按鈕觸控區 ≥ 44px，aria-expanded／aria-controls 齊全。
 * - 會量內容實際高度：沒超過收合高度 × 1.25 就不收、也不出現按鈕。
 *   SSR 首屏先用收合樣式（避免長內容先全展開再縮回去的大跳動），量完才取消。
 */
export function ReadMore({
  children,
  collapsedHeight = 168,
  moreLabel = "展開全文",
  lessLabel = "收合",
  className = "",
  fadeFrom = "from-white",
}: {
  children: ReactNode;
  /** 手機收合時保留的高度（px） */
  collapsedHeight?: number;
  moreLabel?: string;
  lessLabel?: string;
  className?: string;
  /** 漸層遮罩的底色，要跟所在區塊的背景一樣 */
  fadeFrom?: string;
}) {
  const [open, setOpen] = useState(false);
  // null = 還沒量（SSR／hydration 前），先當成需要收合
  const [overflows, setOverflows] = useState<boolean | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    // 量的是內層（不受 max-height 影響）的實際高度
    const measure = () =>
      setOverflows(el.offsetHeight > collapsedHeight * COLLAPSE_SLACK);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsedHeight]);

  const collapsible = overflows !== false;
  const clipped = collapsible && !open;

  return (
    <div className={className}>
      <div className="relative">
        <div
          id={id}
          style={clipped ? ({ "--rm-h": `${collapsedHeight}px` } as CSSProperties) : undefined}
          className={clipped ? "max-md:max-h-(--rm-h) max-md:overflow-hidden" : ""}
        >
          {/* flow-root：讓子元素的 margin 算進量到的高度 */}
          <div ref={contentRef} className="flow-root">
            {children}
          </div>
        </div>
        {clipped && (
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-x-0 bottom-0 h-[56px] bg-gradient-to-t ${fadeFrom} to-transparent md:hidden`}
          />
        )}
      </div>
      {collapsible && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="mt-[4px] inline-flex min-h-[44px] items-center gap-[4px] text-[16px] font-medium text-caramel-dk md:hidden"
        >
          {open ? lessLabel : moreLabel}
          <ChevronDown
            aria-hidden="true"
            strokeWidth={2}
            className={`h-[18px] w-[18px] transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          />
        </button>
      )}
    </div>
  );
}
