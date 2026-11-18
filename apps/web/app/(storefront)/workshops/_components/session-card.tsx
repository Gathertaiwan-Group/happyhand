import Link from "next/link";
import { formatPrice } from "@/lib/site";
import { timeRange, twDate, type WorkshopRow } from "@/lib/data";
import { Clock, MapPin, ChevronRight } from "lucide-react";
import { FormatBadge, ICON_CLASS, ICON_STROKE } from "@/components/ui/icon-text";

/**
 * 場次「列表卡」（首頁、/workshops 用）。2026-11-18 手機版改版。
 *
 * 跟 SessionRow 的差別：
 * - 整張卡就是一個連結，點哪裡都進課程介紹頁（參考 Accupass／Hahow 的列表卡）。
 *   以前每一張卡底下都有一顆滿版深色「我要報名」，一屏只看得到一張半，
 *   而且那顆鈕本來就只是帶去介紹頁 —— 真正的報名（加入購物車）在介紹頁上，
 *   流程沒有改變。
 * - 資訊順序固定：日期 → 課名 → 上課方式與時間 → 梯次說明 → 價格。
 *   字一律 ≥ 16px，次要文字用 brown-500/700（不用 brown-300，那個只有 3.49:1）。
 *
 * 額滿的場次照樣連到介紹頁，介紹頁上的場次列會給「已額滿・我要候補」（LINE）。
 * 沒有介紹頁可去的場次（查不到商品）不走這個元件，呼叫端改用 SessionRow。
 */
export function SessionCard({
  session,
  detailHref,
  isNew = false,
  showProductName = false,
}: {
  session: WorkshopRow;
  detailHref: string;
  isNew?: boolean;
  /** 有梯次名稱時在上面補一行課名（首頁用：只看一列看不出是哪一門課） */
  showProductName?: boolean;
}) {
  const { month, day, weekday } = twDate(session.starts_at);
  // 與 SessionRow 同一套冪等正規化（twDate 可能吐出「9月 月」「12日」）
  const monthLabel = month.replace(/\s+/g, "").replace(/月+$/, "月");
  const dayLabel = day.replace(/日+$/, "");
  const dateText = `${monthLabel}${dayLabel}日（${weekday}）`;

  // 跟 SessionRow／結帳同一個定義：扣掉未付款訂單佔住的位子。數字不印，只判斷額滿。
  const remaining = Math.max(
    0,
    session.capacity - session.seats_taken - (session.held ?? 0),
  );
  const soldOut = remaining <= 0;

  const headline = session.sessionTitle?.trim() || session.title;
  const productLine =
    showProductName && session.sessionTitle?.trim() ? session.title : null;
  const time = timeRange(session.starts_at, session.ends_at);
  const place = session.format === "online" ? null : session.location?.trim();
  const summary = session.sessionSummary?.trim();
  // 意願登記這類 0 元的梯次，「$0」看起來像標錯價
  const priceText = session.price > 0 ? formatPrice(session.price) : "不收費";

  return (
    <li className="list-none">
      <Link
        href={detailHref}
        className="group flex h-full gap-[14px] rounded-[18px] border border-sand-300 bg-white p-[16px] transition-[border-color,box-shadow] duration-200 hover:border-caramel hover:shadow-card md:gap-[18px] md:p-[20px]"
      >
        {/* 日期方塊 */}
        <div
          aria-hidden="true"
          className="flex w-[62px] shrink-0 flex-col items-center self-start rounded-[12px] bg-cream-200 py-[8px] text-center md:w-[72px]"
        >
          <span className="text-[15px] leading-[1.4] text-brown-700">{monthLabel}</span>
          <span className="font-serif text-[28px] leading-[1.15] font-semibold text-brown-900 md:text-[32px]">
            {dayLabel}
          </span>
          <span className="text-[15px] leading-[1.4] text-brown-700">{weekday}</span>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <span className="sr-only">{dateText}</span>
          {productLine && (
            <span className="text-[16px] leading-[1.5] text-brown-500">{productLine}</span>
          )}
          <h3 className="font-serif text-[19px] leading-[1.45] font-semibold text-brown-900 group-hover:text-caramel-dk md:text-[20px]">
            {isNew && (
              /* 深焦糖底白字 6.3:1；淺焦糖只有 2.96:1，不用 */
              <span className="mr-[8px] inline-block rounded-full bg-caramel-dk px-[9px] align-[2px] font-sans text-[14px] leading-[1.7] font-medium text-white">
                新開
              </span>
            )}
            {headline}
          </h3>

          {/* 2026-11-18 減字：時間、地點前面改用圖示，線上標籤帶視訊圖示 */}
          <div className="mt-[6px] flex flex-col gap-[2px] text-[16px] leading-[1.6] text-brown-700">
            <span className="flex flex-wrap items-center gap-x-[8px]">
              <FormatBadge format={session.format} />
              <span className="inline-flex items-start gap-[6px]">
                <Clock aria-hidden="true" strokeWidth={ICON_STROKE} className={`mt-[0.2em] ${ICON_CLASS}`} />
                <span><span className="sr-only">時間：</span>{time}</span>
              </span>
            </span>
            {place && (
              <span className="flex items-start gap-[6px]">
                <MapPin aria-hidden="true" strokeWidth={ICON_STROKE} className={`mt-[0.2em] ${ICON_CLASS}`} />
                <span><span className="sr-only">地點：</span>{place}</span>
              </span>
            )}
          </div>

          {summary && (
            <p className="mt-[4px] line-clamp-2 text-[16px] leading-[1.6] text-brown-500">
              {summary}
            </p>
          )}

          <div className="mt-auto flex items-center justify-between gap-[12px] pt-[10px]">
            <span className="font-serif text-[21px] font-semibold text-caramel-dk">
              {priceText}
            </span>
            <span className="inline-flex items-center gap-[4px] text-[16px] font-medium whitespace-nowrap text-brown-900">
              {soldOut ? "額滿・候補" : "報名"}
              <ChevronRight
                aria-hidden="true"
                strokeWidth={2}
                className="h-[18px] w-[18px] transition-transform duration-200 group-hover:translate-x-[2px]"
              />
            </span>
          </div>
        </div>
      </Link>
    </li>
  );
}
