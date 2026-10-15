import Link from "next/link";
import { requireCapability, adminErrorMessage } from "@/lib/admin/guard";
import { loadOrders, sanitizeSearch, type OrderListRow } from "./queries";
import { DataList, type DataListColumn } from "@/components/admin/data-list";
import { formatTaipei } from "@/components/admin/datetime-field";
import { AdminField, AdminSelect } from "@/components/admin/admin-field";
import { OrderStatusChip } from "./status-chip";
import {
  ORDER_STATUSES,
  ORDER_STATUS_LABELS,
  PAYMENT_METHODS,
  money,
  paymentMethodLabel,
} from "./shared";

/**
 * 訂單列表。
 *
 * 讀取走 service role：orders 的 RLS 只開放 `auth.uid() = user_id` 的 select，
 * 而全站是訪客結帳（/api/orders 從不寫 user_id，已核對過），
 * 所以用使用者自己的 client 查會是空的。授權靠下面的 requireCapability()。
 *
 * 篩選刻意做成 <form method="get"> 的純 HTML 表單：
 * 網址就是狀態，客服可以把「待收款 + ATM」這個網址存成書籤或貼給同事，
 * 重新整理也不會掉。做成 client component 反而要自己處理這些。
 */

export const dynamic = "force-dynamic";

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    await requireCapability("orders:read");
  } catch (err) {
    return <AccessDenied message={adminErrorMessage(err)} />;
  }

  const params = await searchParams;
  const status = pickOne(params.status, ORDER_STATUSES);
  const paymentMethod = pickOne(params.payment_method, PAYMENT_METHODS);
  const rawQuery = firstValue(params.q).trim().slice(0, 60);
  const search = sanitizeSearch(rawQuery);
  const hasFilter = Boolean(status || paymentMethod || rawQuery);

  const result = await loadOrders({ status, paymentMethod, search });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-serif text-[24px] leading-tight font-medium text-ink">
          訂單
        </h1>
        <p className="mt-1 text-[14px] leading-relaxed text-ink-soft">
          待收款的訂單需要人工核對匯款後標記收款，標記後才會佔用工作坊名額。
        </p>
      </div>

      {/* 篩選：三個欄位在手機是單欄堆疊，1024px 以上才並排 */}
      <form
        method="get"
        className="rounded-card border border-line bg-panel p-3.5 admin:p-4"
      >
        <div className="grid grid-cols-1 gap-3 admin:grid-cols-[minmax(0,11rem)_minmax(0,11rem)_minmax(0,1fr)]">
          <AdminSelect
            key={`status-${status}`}
            label="狀態"
            name="status"
            defaultValue={status}
            options={[
              { value: "", label: "全部狀態" },
              ...ORDER_STATUSES.map((s) => ({
                value: s,
                label: ORDER_STATUS_LABELS[s],
              })),
            ]}
          />
          <AdminSelect
            key={`pm-${paymentMethod}`}
            label="付款方式"
            name="payment_method"
            defaultValue={paymentMethod}
            options={[
              { value: "", label: "全部付款方式" },
              ...PAYMENT_METHODS.map((m) => ({
                value: m,
                label: paymentMethodLabel(m),
              })),
            ]}
          />
          <AdminField
            key={`q-${rawQuery}`}
            label="搜尋"
            name="q"
            type="search"
            inputMode="search"
            defaultValue={rawQuery}
            placeholder="訂單編號或聯絡電話"
            hint="輸入一部分就會比對，例如 HH-2026 或 0912"
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <button
            type="submit"
            className="inline-flex min-h-11 items-center justify-center rounded-input bg-accent-ink px-5 text-[14px] font-medium text-paper transition-opacity hover:opacity-90 admin:min-h-10"
          >
            套用篩選
          </button>
          {hasFilter && (
            <Link
              href="/admin/orders"
              className="inline-flex min-h-11 items-center justify-center rounded-input border border-line-input px-4 text-[14px] text-ink transition-colors hover:bg-paper admin:min-h-10"
            >
              清除
            </Link>
          )}
        </div>
      </form>

      {result.error ? (
        <p className="rounded-card border border-line bg-panel px-4 py-3 text-[14px] leading-relaxed text-ink-soft">
          {result.error}
          <span className="mt-1 block text-[13px]">
            詳細錯誤已記在伺服器 log。請重新整理，若持續失敗請截圖回報。
          </span>
        </p>
      ) : (
        <>
          <ResultSummary
            shown={result.rows.length}
            matched={result.matched}
            hasFilter={hasFilter}
          />

          <DataList
            items={result.rows}
            keyOf={(order) => order.id}
            columns={COLUMNS}
            href={(order) => `/admin/orders/${order.id}`}
            caption="訂單列表"
            empty={
              hasFilter
                ? "沒有符合這些條件的訂單。試著放寬篩選或清除搜尋字串。"
                : "目前還沒有任何訂單。前台有人結帳後就會出現在這裡。"
            }
          />
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- 欄位定義 */

const COLUMNS: DataListColumn<OrderListRow>[] = [
  {
    header: "訂單編號",
    primary: true,
    cell: (order) => order.order_no,
    className: "whitespace-nowrap",
  },
  {
    header: "狀態",
    trailing: true,
    cell: (order) => <OrderStatusChip status={order.status} />,
  },
  {
    header: "金額",
    align: "right",
    className: "whitespace-nowrap",
    cell: (order) => (
      <span className="inline-flex items-baseline gap-1.5">
        {money(order.total)}
        {/* 金額沒被 server 端定價核對過的訂單，在列表就要看得出來，
            不能等到有人點進明細才發現。 */}
        {order.price_unverified && (
          <span className="text-[12px] font-medium text-danger">待確認</span>
        )}
      </span>
    ),
  },
  {
    header: "付款方式",
    cell: (order) => paymentMethodLabel(order.payment_method),
  },
  {
    header: "聯絡人",
    cell: (order) => <ContactCell name={order.contact_name} phone={order.contact_phone} />,
  },
  {
    header: "成立時間",
    className: "whitespace-nowrap",
    cell: (order) => formatTaipei(order.created_at) || "—",
  },
];

function ContactCell({ name, phone }: { name: string | null; phone: string | null }) {
  if (!name && !phone) return <span className="text-ink-soft">（未填）</span>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      {name && <span>{name}</span>}
      {phone && <span className="text-[13px] text-ink-soft">{phone}</span>}
    </span>
  );
}

/* ------------------------------------------------------------------ 工具 */

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** 只接受白名單內的值，其他一律當成「沒篩選」。 */
function pickOne(
  value: string | string[] | undefined,
  allowed: readonly string[],
): string {
  const raw = firstValue(value);
  return allowed.includes(raw) ? raw : "";
}

/* ------------------------------------------------------------------ 版面 */

function ResultSummary({
  shown,
  matched,
  hasFilter,
}: {
  shown: number;
  matched: number | null;
  hasFilter: boolean;
}) {
  if (shown === 0) return null;

  // 被截斷時一定要講出來。客服如果以為看到的是全部，
  // 就會漏掉最舊的那幾筆待收款訂單而不自知。
  const truncated = typeof matched === "number" && matched > shown;

  return (
    <p className="text-[13px] leading-relaxed text-ink-soft">
      {hasFilter ? "符合條件共 " : "目前共 "}
      <span className="font-medium text-ink">
        {typeof matched === "number" ? matched : shown}
      </span>
      {" 筆"}
      {truncated && (
        <span className="text-danger">
          ，依成立時間由新到舊只顯示最近 {shown} 筆。要看更早的訂單請縮小篩選範圍。
        </span>
      )}
      。
    </p>
  );
}

function AccessDenied({ message }: { message: string }) {
  return (
    <div className="rounded-card border border-line bg-panel px-5 py-8 text-center">
      <h1 className="font-serif text-[20px] font-medium text-ink">看不到這一頁</h1>
      <p className="mx-auto mt-2 max-w-[28rem] text-[14px] leading-relaxed text-ink-soft">
        {message}
        <span className="mt-1 block">
          訂單含有客人的姓名、電話與地址，只有客服與負責人看得到。
        </span>
      </p>
      <Link
        href="/admin"
        className="mt-4 inline-flex min-h-11 items-center rounded-input border border-line-input bg-paper px-4 text-[14px] text-ink hover:bg-panel admin:min-h-10"
      >
        回總覽
      </Link>
    </div>
  );
}
