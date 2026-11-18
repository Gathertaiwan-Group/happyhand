import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass } from "@/components/ui/button";
import { ICON_CLASS, ICON_STROKE } from "@/components/ui/icon-text";
import { CalendarDays, MapPin, ReceiptText, Shirt, Video, type LucideIcon } from "lucide-react";
import { getMyWorkshops, type MyWorkshop } from "../queries";
import {
  Card,
  EmptyState,
  LineButton,
  LoadError,
  PageHeading,
  StatusChip,
} from "../_components/shell";
import { formatSessionTime } from "../orders/shared";
import { ONLINE_LINK_NOTE, placeText } from "@/lib/session-format";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "我報名的工作坊",
  description: "你報名的工作坊場次、時間與地點。",
  robots: { index: false, follow: false },
};

/**
 * 我報名的工作坊。
 *
 * 資料來源是訂單，不是 entitlements —— workshop 從來不發 entitlement，
 * 報名名單一律從 order_items.session_id 推導（跟 worker 寄提醒信的方式一致）。
 *
 * 待付款的訂單也列出來並標「還沒收到款項」：ATM 匯款到對帳完成通常隔一天，
 * 這段時間客人最想確認的就是「我到底報名了沒」。藏起來只會讓他打電話來問。
 */
export default async function AccountWorkshopsPage() {
  const { upcoming, past, error } = await getMyWorkshops();

  return (
    <>
      <PageHeading
        title="我報名的工作坊"
        lead="開課前三天會再寄 Email 提醒你。"
      />

      {error ? (
        <LoadError message={error} />
      ) : upcoming.length === 0 && past.length === 0 ? (
        <EmptyState
          title="你還沒有報名工作坊。"
          action={
            <Link
              href="/workshops"
              className={buttonClass({ variant: "primary", size: "lg" })}
            >
              看看最近有哪幾場 →
            </Link>
          }
        >
          <p>小班制，通常很快就滿。</p>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-[28px] md:gap-[36px]">
          {upcoming.length > 0 && (
            <section>
              <h2 className="t-h3 mb-[14px] text-brown-900">即將舉行</h2>
              <ul className="flex flex-col gap-[14px]">
                {upcoming.map((w, i) => (
                  <li key={`${w.orderId}-${i}`}>
                    <WorkshopCard workshop={w} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {past.length > 0 && (
            <section>
              <h2 className="t-h3 mb-[14px] text-brown-900">已經結束</h2>
              <ul className="flex flex-col gap-[14px]">
                {past.map((w, i) => (
                  <li key={`${w.orderId}-past-${i}`}>
                    <WorkshopCard workshop={w} past />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      <div className="mt-[28px]">
        <p className="t-body-sm text-pretty text-brown-500">
          要改期？用 LINE 跟我們說。
        </p>
        <LineButton className="mt-[12px]" />
      </div>
    </>
  );
}

function WorkshopCard({
  workshop,
  past = false,
}: {
  workshop: MyWorkshop;
  past?: boolean;
}) {
  const cancelled = workshop.sessionStatus === "cancelled";
  const unpaid = workshop.orderStatus === "pending";

  return (
    <Card className={past ? "opacity-80" : ""}>
      <div className="flex flex-wrap items-start justify-between gap-x-[16px] gap-y-[8px]">
        <h3 className="t-h3 min-w-0 text-brown-900">{workshop.title}</h3>
        {cancelled ? (
          <StatusChip tone="danger">這一場取消了</StatusChip>
        ) : unpaid ? (
          <StatusChip tone="wait">還沒收到款項</StatusChip>
        ) : past ? (
          <StatusChip tone="muted">已結束</StatusChip>
        ) : (
          <StatusChip tone="ok">報名完成</StatusChip>
        )}
      </div>

      <dl className="mt-[12px] flex flex-col gap-[8px]">
        <div className="flex gap-x-[10px]">
          <MetaDt icon={CalendarDays} label="時間" />
          <dd className="t-body min-w-0 text-brown-900">
            {formatSessionTime(workshop.startsAt)}
          </dd>
        </div>
        {/*
          線上場次：這一頁是付了錢的學員確認「我要怎麼上課」的地方。以前它照印
          location —— 填「ON LINE」就印 ON LINE、留空就整欄消失，學員找不到任何
          關於連結的說明。
        */}
        {workshop.format === "online" ? (
          <div className="flex gap-x-[10px]">
            <MetaDt icon={Video} label="上課方式" />
            <dd className="t-body min-w-0 text-brown-900">
              線上（視訊）
              <span className="block text-[17px] text-brown-500">{ONLINE_LINK_NOTE}</span>
            </dd>
          </div>
        ) : (
          workshop.location && (
            <div className="flex gap-x-[10px]">
              <MetaDt icon={MapPin} label="地點" />
              <dd className="t-body min-w-0 text-brown-900">
                {placeText(workshop.format, workshop.location)}
                {workshop.address && (
                  <span className="block text-[17px] text-brown-500">
                    {workshop.address}
                  </span>
                )}
                {workshop.format === "hybrid" && (
                  <span className="block text-[17px] text-brown-500">{ONLINE_LINK_NOTE}</span>
                )}
              </dd>
            </div>
          )
        )}
        <div className="flex gap-x-[10px]">
          <MetaDt icon={ReceiptText} label="訂單" />
          <dd className="t-body min-w-0">
            <Link
              href={`/account/orders/${workshop.orderId}`}
              className="-my-[10px] inline-block break-all py-[10px] text-caramel-dk hover:underline"
            >
              {workshop.orderNo}
            </Link>
          </dd>
        </div>
      </dl>

      {unpaid && !past && (
        <p className="t-body-sm mt-[12px] rounded-card bg-cream-100 px-[16px] py-[12px] text-brown-700">
          還沒收到款項。匯款對帳完成就會確認你的位子。
        </p>
      )}

      {/* 線上場次不印「空手來、提前到」—— 那是實體課的提醒 */}
      {!past && !cancelled && workshop.format !== "online" && (
        <p className="t-body-sm mt-[12px] flex items-start gap-[8px] text-brown-500">
          <Shirt aria-hidden="true" strokeWidth={ICON_STROKE} className={`mt-[0.22em] ${ICON_CLASS}`} />
          <span>空手來・穿寬鬆・提前 10 分鐘到</span>
        </p>
      )}
    </Card>
  );
}

/** 欄位名改成圖示，文字留給螢幕報讀。 */
function MetaDt({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <dt className="shrink-0 pt-[0.3em]">
      <Icon aria-hidden="true" strokeWidth={ICON_STROKE} className={`h-[20px] w-[20px] ${ICON_CLASS}`} />
      <span className="sr-only">{label}</span>
    </dt>
  );
}
