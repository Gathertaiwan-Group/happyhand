import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatPrice } from "@/lib/site";
import { IconText } from "@/components/ui/icon-text";
import { CalendarDays, MapPin } from "lucide-react";
import { getMyOrder } from "../../queries";
import {
  BackLink,
  Card,
  LineButton,
  PageHeading,
  StatusChip,
} from "../../_components/shell";
import {
  ORDER_STATUS_TEXT,
  NEXT_STEP,
  formatOrderDate,
  formatSessionTime,
  paymentLabel,
} from "../shared";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "訂單明細",
  robots: { index: false, follow: false },
};

/**
 * 訂單明細。
 *
 * 查不到就 404，而且**刻意不區分**「訂單不存在」與「這不是你的訂單」——
 * 區分等於告訴人家「這個 id 存在但不屬於你」。實際的過濾是 RLS 的
 * orders_select_own 做的，這裡只是把空結果轉成 404。
 */
export default async function AccountOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const order = await getMyOrder(id);
  if (!order) notFound();

  const status = ORDER_STATUS_TEXT[order.status] ?? {
    tone: "muted" as const,
    label: order.status,
  };
  const nextStep =
    order.status === "pending" ? NEXT_STEP[order.paymentMethod ?? "manual"] : null;

  return (
    <>
      <div className="mb-[10px]">
        <BackLink href="/account/orders" label="回我的訂單" />
      </div>

      <PageHeading
        title={order.orderNo}
        action={<StatusChip tone={status.tone}>{status.label}</StatusChip>}
        lead={`${formatOrderDate(order.createdAt)} 成立`}
      />

      {nextStep && (
        <Card className="mb-[18px] !bg-cream-100 !border-sand-400">
          <h2 className="t-h3 text-brown-900">接下來要做什麼</h2>
          <p className="t-body mt-[10px] text-pretty text-brown-700">{nextStep}</p>
          <div className="mt-[16px]">
            <LineButton />
          </div>
        </Card>
      )}

      <Card>
        <h2 className="t-h3 text-brown-900">買了什麼</h2>
        <ul className="mt-[14px] flex flex-col gap-[16px]">
          {order.items.map((item, index) => (
            <li
              key={`${order.id}-${index}`}
              className="border-b border-sand-300 pb-[16px] last:border-0 last:pb-0"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-[16px] gap-y-[4px]">
                <p className="t-body min-w-0 text-brown-900">{item.title}</p>
                <p className="t-body text-brown-700">
                  {formatPrice(item.unitPrice)}
                  {item.qty > 1 && (
                    <span className="text-brown-500"> ×{item.qty}</span>
                  )}
                </p>
              </div>
              {item.sessionStartsAt && (
                <p className="t-body-sm mt-[6px] flex flex-col gap-[2px] text-brown-500">
                  <IconText icon={CalendarDays} label="場次">
                    {formatSessionTime(item.sessionStartsAt)}
                  </IconText>
                  {item.sessionLocation && (
                    <IconText icon={MapPin} label="地點">{item.sessionLocation}</IconText>
                  )}
                </p>
              )}
            </li>
          ))}
        </ul>

        <div className="mt-[18px] border-t-2 border-sand-300 pt-[16px]">
          <p className="flex items-baseline justify-between">
            <span className="t-body text-brown-700">總金額</span>
            <strong className="font-serif text-[24px] text-brown-900">
              {formatPrice(order.total)}
            </strong>
          </p>
        </div>
      </Card>

      <Card className="mt-[18px]">
        <h2 className="t-h3 text-brown-900">訂單資訊</h2>
        <dl className="mt-[14px] flex flex-col gap-[14px]">
          <Row label="付款方式">{paymentLabel(order.paymentMethod)}</Row>
          {order.paidAt && (
            <Row label="付款完成">{formatOrderDate(order.paidAt)}</Row>
          )}
          {order.shippingAddress && (
            <Row label="寄送地址">{order.shippingAddress}</Row>
          )}
          {order.note && <Row label="你的備註">{order.note}</Row>}
        </dl>
      </Card>

      <p className="t-body-sm mt-[20px] text-pretty text-brown-500">
        訂單有問題？LINE 貼上訂單編號就好。
      </p>
      <div className="mt-[12px]">
        <LineButton />
      </div>
    </>
  );
}

/** 標籤在上、值在下。長輩讀並排的 label/value 容易看串行。 */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="t-body-sm text-brown-500">{label}</dt>
      <dd className="t-body mt-[2px] break-words text-brown-900">{children}</dd>
    </div>
  );
}
