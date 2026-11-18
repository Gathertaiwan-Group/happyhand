import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass } from "@/components/ui/button";
import { formatPrice } from "@/lib/site";
import { IconText } from "@/components/ui/icon-text";
import { CalendarDays, CreditCard } from "lucide-react";
import { getMyOrders, type MyOrder } from "../queries";
import {
  Card,
  EmptyState,
  LoadError,
  PageHeading,
  StatusChip,
} from "../_components/shell";
import { ORDER_STATUS_TEXT, formatOrderDate, paymentLabel } from "./shared";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "我的訂單",
  description: "你在快樂手下過的訂單、金額與付款狀態。",
  robots: { index: false, follow: false },
};

/**
 * 我的訂單。
 *
 * 台灣慣例（Hahow）是分「等待付款／已完成訂單」兩個分頁籤，而且分頁籤就是狀態。
 * 這裡照做**但不用分頁籤**：長輩的訂單通常只有個位數，多一層點擊只是多一個
 * 迷路的機會。改成同一頁分兩段，待付款的排在上面 —— 那才是他需要行動的那些。
 *
 * 每一筆都連得到明細，因為訂單編號、匯款方式這些是客服會問的東西。
 */
export default async function AccountOrdersPage() {
  const { orders, error } = await getMyOrders();

  const waiting = orders.filter((o) => o.status === "pending");
  const settled = orders.filter((o) => o.status !== "pending");

  return (
    <>
      <PageHeading
        title="我的訂單"
        lead="問 LINE 時，貼訂單編號給我們就好。"
      />

      {error ? (
        <LoadError message={error} />
      ) : orders.length === 0 ? (
        <EmptyState
          title="你還沒有訂單。"
          action={
            <Link
              href="/courses"
              className={buttonClass({ variant: "primary", size: "lg" })}
            >
              看看有哪些課 →
            </Link>
          }
        >
          <p>
            買了卻看不到？多半是登入信箱跟下單時不同，LINE 報名字我們幫你查。
          </p>
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-[28px] md:gap-[36px]">
          {waiting.length > 0 && (
            <Section title="等待付款" orders={waiting} />
          )}
          {settled.length > 0 && (
            <Section
              title={waiting.length > 0 ? "已完成訂單" : "訂單紀錄"}
              orders={settled}
            />
          )}
        </div>
      )}
    </>
  );
}

function Section({ title, orders }: { title: string; orders: MyOrder[] }) {
  return (
    <section>
      <h2 className="t-h3 mb-[14px] text-brown-900">{title}</h2>
      <ul className="flex flex-col gap-[14px]">
        {orders.map((order) => (
          <li key={order.id}>
            <OrderRow order={order} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function OrderRow({ order }: { order: MyOrder }) {
  const status = ORDER_STATUS_TEXT[order.status] ?? {
    tone: "muted" as const,
    label: order.status,
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-x-[16px] gap-y-[10px]">
        <div className="min-w-0">
          <p className="font-serif text-[20px] leading-tight font-semibold tracking-[0.04em] break-all text-brown-900 md:text-[22px]">
            {order.orderNo}
          </p>
          <p className="t-body-sm mt-[4px] flex flex-wrap gap-x-[14px] gap-y-[2px] text-brown-500">
            <IconText icon={CalendarDays} label="下單日期">{formatOrderDate(order.createdAt)}</IconText>
            <IconText icon={CreditCard} label="付款方式">{paymentLabel(order.paymentMethod)}</IconText>
          </p>
        </div>
        <StatusChip tone={status.tone}>{status.label}</StatusChip>
      </div>

      <ul className="mt-[14px] flex flex-col gap-[6px]">
        {order.items.map((item, index) => (
          <li
            key={`${order.id}-${index}`}
            className="t-body flex flex-wrap items-baseline gap-x-[8px] text-brown-700"
          >
            <span className="min-w-0">{item.title}</span>
            {item.qty > 1 && (
              <span className="text-brown-500">×{item.qty}</span>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-[16px] flex flex-wrap items-center justify-between gap-[12px]">
        <p className="t-body text-brown-900">
          共 <strong className="font-serif text-[21px]">{formatPrice(order.total)}</strong>
        </p>
        <Link
          href={`/account/orders/${order.id}`}
          className={buttonClass({
            variant: "outline",
            size: "md",
            className: "!min-h-[48px] !px-[24px] !text-[17px]",
          })}
        >
          查看明細
        </Link>
      </div>
    </Card>
  );
}
