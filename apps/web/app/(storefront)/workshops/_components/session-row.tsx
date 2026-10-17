import Link from "next/link";
import { buttonClass } from "@/components/ui/button";
import { SITE, formatPrice } from "@/lib/site";
import { timeRange, twDate, type WorkshopRow } from "@/lib/data";
import { AddSessionButton } from "./add-session-button";
import { formatTag } from "@/lib/session-format";

/**
 * 工作坊場次列。
 * 設計稿 happyhands-B-all-pages.dc.html：桌機 L492–539、手機 L570–608。
 *
 * 桌機（>=768px）：grid 96px / 1fr / auto / auto，gap 28px，cream-400 底、radius 18px、padding 24px 30px。
 * 手機（<768px）：上下堆疊 — 日期方塊與標題同一行 → 地點時間 → 價格名額 → CTA 滿版，padding 20px。
 *
 * 額滿（剩餘 <= 0）時 CTA 換成 sand-400 底、文案「已額滿・我要候補」，
 * 仍是可以點的連結（用 LINE 登記候補），不是 disabled。
 *
 * 剩餘名額只拿來判斷額滿，**不顯示數字**（見下方價格區塊的註解）。
 */
export function SessionRow({
  session,
  detailHref,
  showTitle = true,
}: {
  session: WorkshopRow;
  /** 有值時標題可以點進單場詳情；沒有就是純文字 */
  detailHref?: string | null;
  /** 單場詳情頁已經有大標，不必再重複商品名 */
  showTitle?: boolean;
}) {
  const { month, day, weekday } = twDate(session.starts_at);
  // 扣掉未付款訂單佔住的位子，跟 /api/orders 的容量檢查用同一個定義
  // （兩邊都以 workshop_holds() 為準）。數字本身不印出來了，但額滿與否
  // 仍然要跟結帳算得一樣，否則會出現「頁面能按、結帳說滿了」。
  const remaining = Math.max(
    0,
    session.capacity - session.seats_taken - (session.held ?? 0),
  );
  const soldOut = remaining <= 0;

  // lib/data.ts 的 twDate 目前會吐出「9月 月」與「12日」
  //（Intl zh-TW 的 numeric month/day 本身就帶單位，外面又加了一次）。
  // 這裡做冪等的正規化：共用層修好之後這兩行仍然安全。
  const monthLabel = month.replace(/\s+/g, "").replace(/月+$/, "月");
  const dayLabel = day.replace(/日+$/, "");

  // 語音朗讀用的完整日期，例如「9月12日（週六）」
  const dateText = `${monthLabel}${dayLabel}日（${weekday}）`;

  // 梯次名稱優先於商品名。同一門課有好幾梯時（假日班／平日線上班），
  // 每列都印一樣的商品名，客人分不出差別。
  const headline = session.sessionTitle?.trim() || session.title;
  // 線上／混合才有標籤。實體是預設，不標。
  const tag = formatTag(session.format);
  // 場次時段，會跟著訂單一路顯示到購物車與訂單摘要。線上場次要帶著標籤走 ——
  // 客人在購物車裡看到的那一行，是他確認「我買的是線上那場」的最後機會。
  const sessionLabel =
    `${dateText} ${timeRange(session.starts_at, session.ends_at)}` + (tag ? `・${tag}` : "");

  // 沒有 id 就報不了名 —— /api/orders 用 UUID_RE 驗 sessionId，
  // 收到非 UUID 會當成「沒選場次」，訂單就不會綁到這一場、名額也不會扣。
  // 與其讓客人下一張沒有場次的單，不如導去 LINE 讓客服處理。
  const canRegister = Boolean(session.id);

  // 地點與時間。有標題時排在標題下方；沒有標題（單場詳情頁）時直接接在日期方塊旁邊
  const locationLine = (
    <p
      className={
        showTitle
          ? "mt-[12px] min-w-0 text-[17px] leading-[1.8] text-brown-500 md:col-start-2 md:row-start-2 md:mt-[8px]"
          : "min-w-0 text-[17px] leading-[1.8] text-brown-500 md:col-start-2 md:row-span-2 md:row-start-1"
      }
    >
      {/*
        純線上：不印 location。管理員可能填「ON LINE」也可能留空 ——
        留空的話以前會印成「・09:00–17:00」，前面少一截。
        混合：地點照印，標籤說明也能線上參加。
      */}
      {tag && (
        <span className="mr-[8px] inline-block rounded-full bg-brown-900 px-[10px] align-[2px] text-[14px] leading-[1.7] font-medium text-white">
          {tag}
        </span>
      )}
      {session.format === "online"
        ? timeRange(session.starts_at, session.ends_at)
        : `${session.location}・${timeRange(session.starts_at, session.ends_at)}`}
      {session.sessionSummary?.trim() && (
        <>
          <br />
          <span className="text-brown-300">{session.sessionSummary}</span>
        </>
      )}
      {/*
        梯次補充說明。後台一直讓人填、提示也寫著「例如『直播連結於開課前發送』」，
        但以前前台沒有任何地方顯示它 —— 又一個存了也看不到的欄位。
        只在單場詳情頁（showTitle=false）顯示：列表與首頁要保持一列一行。
      */}
      {!showTitle && session.sessionNotes?.trim() && (
        <>
          <br />
          <span className="text-brown-500">{session.sessionNotes}</span>
        </>
      )}
    </p>
  );

  return (
    <li className="rounded-sm bg-cream-400 p-[20px] md:grid md:grid-cols-[96px_1fr_auto_auto] md:grid-rows-[auto_auto] md:items-center md:gap-x-[20px] md:p-[24px_30px] lg:gap-x-[28px]">
      {/* 日期方塊與標題：手機同一行；桌機 display:contents 讓兩者各自成為 grid item */}
      <div className="flex items-center gap-[14px] md:contents">
        <div className="shrink-0 rounded-input bg-white px-[12px] py-[8px] text-center md:col-start-1 md:row-span-2 md:row-start-1 md:bg-transparent md:p-0">
          <div className="t-micro tracking-[0.1em] text-brown-300">
            {monthLabel}
          </div>
          <div className="font-serif text-[26px] font-semibold leading-[1.1] text-brown-900 md:text-[34px]">
            {dayLabel}
          </div>
          <div className="t-micro text-brown-300">{weekday}</div>
        </div>

        {!showTitle && locationLine}

        {showTitle && (
          <h3 className="t-h3 min-w-0 md:col-start-2 md:row-start-1">
            {detailHref ? (
              <Link
                href={detailHref}
                /* -my/py 對消：點擊區補到 56px（樂齡族需求），但不撐開列高。
                   t-h3 在 375px 是 20px×1.4 = 28px 行高，加上下 14px 剛好 56px。 */
                className="-my-[14px] inline-block py-[14px] transition-colors duration-200 hover:text-caramel-ink"
              >
                {headline}
              </Link>
            ) : (
              headline
            )}
          </h3>
        )}
      </div>

      {showTitle && locationLine}

      {/* 價格與名額 */}
      <div className="mt-[12px] flex items-baseline gap-[12px] md:col-start-3 md:row-span-2 md:row-start-1 md:mt-0 md:block md:text-right">
        <span className="font-serif text-[23px] font-semibold text-caramel-ink md:text-[24px]">
          {formatPrice(session.price)}
        </span>
        {/*
          🔴 不印剩餘名額（2026-10-15 指示）。小班制的課在開賣初期，「剩 16 位」
             等於公告「目前沒有人報名」—— 本來想製造的稀缺感會反過來變成冷清的
             證據。
          額滿仍然要講：那是**狀態**不是數字，客人要知道按鈕為什麼變成候補。
        */}
        {soldOut && (
          <span className="block text-[16px] text-brown-300 md:mt-[4px]">
            已額滿
          </span>
        )}
      </div>

      {/* CTA */}
      {/* min-w 讓「已額滿・我要候補」與「我要報名」佔一樣寬的欄，各列價格才會對齊 */}
      <div className="mt-[14px] md:col-start-4 md:row-span-2 md:row-start-1 md:mt-0 md:flex md:min-w-[208px] md:justify-end">
        {soldOut || !canRegister ? (
          <a
            href={SITE.lineHref}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass({
              variant: "dark",
              className:
                "w-full whitespace-nowrap bg-sand-400! hover:bg-caramel-ink! md:w-auto",
            })}
          >
            {/* 視覺文案與朗讀文案分開：畫面看得出額滿，語音直接說可以用 LINE 候補 */}
            <span aria-hidden="true">
              {soldOut ? "已額滿・我要候補" : "用 LINE 報名"}
            </span>
            <span className="sr-only">
              {soldOut
                ? "已額滿，用 LINE 登記候補（會開啟 LINE）"
                : "用 LINE 報名這一場（會開啟 LINE）"}
            </span>
          </a>
        ) : (
          <AddSessionButton
            sessionId={session.id}
            slug={session.slug}
            title={headline}
            price={session.price}
            sessionLabel={sessionLabel}
            asksIntake={session.asksIntake}
            ariaLabel={`我要報名：${headline} ${dateText}${tag ? `（${tag}）` : ""}`}
          />
        )}
      </div>
    </li>
  );
}
