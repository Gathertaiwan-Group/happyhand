import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { checkCapability, getStaff, requireCapability, adminErrorMessage } from "@/lib/admin/guard";
import { loadPendingMcpRequests } from "@/lib/admin/mcp-pending-repo";
import { findPending, type PendingMcpRequest } from "@/lib/admin/mcp-pending";
import { McpRequestNotice } from "@/components/admin/mcp-request-banner";
import { can } from "@/lib/admin/roles";
import { createServiceClient } from "@/lib/supabase/server";
import { formatTaipei } from "@/components/admin/datetime-field";
import { OrderStatusButtons } from "@/components/admin/order-status-buttons";
import {
  OrderAccountPanel,
  type OrderAccountInfo,
} from "@/components/admin/order-account-panel";
import {
  OrderInvoicePanel,
  type OrderInvoiceInfo,
} from "@/components/admin/order-invoice-panel";
import { OrderStatusChip } from "../status-chip";
import { money, paymentMethodLabel } from "../shared";

/**
 * 訂單明細。
 *
 * 這頁是客服處理一筆訂單時唯一要看的畫面，所以四件事必須同時在上面：
 * 收多少錢、聯絡得到誰、買了哪一場（幾點在哪裡）、現在能做什麼。
 *
 * 讀取一律 service role（orders 的 RLS 只認 user_id，而訪客結帳沒有 user_id）。
 * 授權靠 requireCapability("orders:read")——editor 角色沒有這個能力，
 * 那是刻意的：內容編輯的工作不需要看到客人的電話與地址。
 */

export const dynamic = "force-dynamic";

type OrderRow = {
  id: string;
  order_no: string;
  status: string;
  /** 綁定的會員帳號。訪客結帳且自動建帳號失敗時是 null。 */
  user_id: string | null;
  payment_method: string | null;
  total: number;
  price_unverified: boolean;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  shipping_address: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
};

type Embedded<T> = T | T[] | null;

type ItemRow = {
  id: string;
  qty: number;
  unit_price: number;
  product_id: string | null;
  session_id: string | null;
  products: Embedded<{ title: string | null; type: string | null }>;
  workshop_sessions: Embedded<{
    starts_at: string | null;
    ends_at: string | null;
    location: string | null;
    address: string | null;
    status: string | null;
  }>;
};

/** PostgREST 的內嵌關聯有時回物件、有時回陣列，統一收斂成單一物件。 */
function one<T>(value: Embedded<T>): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function AdminOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  try {
    await requireCapability("orders:read");
  } catch (err) {
    return <AccessDenied message={adminErrorMessage(err)} />;
  }

  const { id } = await params;
  const staff = await getStaff();
  const canWrite = can(staff?.role, "orders:write");

  let supabase: ReturnType<typeof createServiceClient>;
  try {
    supabase = createServiceClient();
  } catch (err) {
    console.error("[admin/orders] service client 建立失敗", err);
    return <LoadError message="資料庫連線未設定，請聯絡工程師檢查伺服器環境變數。" />;
  }

  const { data: orderRaw, error: orderError } = await supabase
    .from("orders")
    .select(
      "id, order_no, status, payment_method, total, price_unverified, user_id, contact_name, contact_phone, contact_email, shipping_address, note, created_at, updated_at, paid_at, " +
        "invoice_carrier_type, invoice_carrier_id, invoice_tax_id, invoice_title",
    )
    .eq("id", id)
    .maybeSingle();

  if (orderError) {
    console.error("[admin/orders] 讀取訂單失敗", id, orderError.message);
    return <LoadError message="訂單讀取失敗。請重新整理，若持續失敗請截圖回報。" />;
  }

  const order = orderRaw as OrderRow | null;
  if (!order) notFound();

  // 品項查壞了不該讓整頁白畫面——狀態操作是這一頁最重要的功能，
  // 就算看不到買了什麼，客服至少還能標記收款。
  const { data: itemsRaw, error: itemsError } = await supabase
    .from("order_items")
    .select(
      "id, qty, unit_price, product_id, session_id, products(title, type), workshop_sessions(starts_at, ends_at, location, address, status)",
    )
    .eq("order_id", id);

  if (itemsError) {
    console.error("[admin/orders] 讀取品項失敗", id, itemsError.message);
  }
  const items = (itemsRaw ?? []) as ItemRow[];
  const itemsTotal = items.reduce((sum, item) => sum + item.unit_price * item.qty, 0);

  // 發票。查不到不擋整頁（同品項的判準）—— 面板會顯示「尚未建立」。
  const { data: invoiceRaw, error: invoiceError } = await supabase
    .from("invoices")
    .select(
      "status, invoice_number, random_code, issued_at, voided_at, retry_count, issue_attempts, last_error, next_attempt_at",
    )
    .eq("order_id", id)
    .maybeSingle();

  if (invoiceError) {
    console.error("[admin/orders] 讀取發票失敗", id, invoiceError.message);
  }

  const invoiceRow = invoiceRaw as Record<string, unknown> | null;
  const orderExtra = order as unknown as Record<string, string | null>;
  const invoiceInfo: OrderInvoiceInfo = {
    orderId: order.id,
    orderStatus: order.status,
    carrierType: orderExtra.invoice_carrier_type ?? null,
    carrierId: orderExtra.invoice_carrier_id ?? null,
    taxId: orderExtra.invoice_tax_id ?? null,
    title: orderExtra.invoice_title ?? null,
    invoice: invoiceRow
      ? {
          status: String(invoiceRow.status ?? "pending"),
          invoiceNumber: (invoiceRow.invoice_number as string | null) ?? null,
          randomCode: (invoiceRow.random_code as string | null) ?? null,
          issuedAt: formatTaipei(invoiceRow.issued_at as string | null) || null,
          voidedAt: formatTaipei(invoiceRow.voided_at as string | null) || null,
          retryCount: Number(invoiceRow.retry_count ?? 0),
          issueAttempts: Number(invoiceRow.issue_attempts ?? 0),
          lastError: (invoiceRow.last_error as string | null) ?? null,
          nextAttemptAt: formatTaipei(invoiceRow.next_attempt_at as string | null) || null,
        }
      : null,
  };

  const accountInfo = await loadAccountInfo(supabase, order, items);

  // AI（MCP）提出的退款／作廢申請 —— 只給負責人（mcp:requests）看。
  // undefined = 不顯示（沒權限）；null = 讀取失敗。
  let mcpRequests: PendingMcpRequest[] | null | undefined;
  if (await checkCapability("mcp:requests")) {
    try {
      mcpRequests = await loadPendingMcpRequests(supabase, { orderId: order.id });
    } catch (err) {
      console.error("[admin/orders] 讀取 AI 申請失敗", order.id, err);
      mcpRequests = null;
    }
  }
  const refundRequest = mcpRequests ? findPending(mcpRequests, order.id, "refund") : null;
  const voidRequest = mcpRequests ? findPending(mcpRequests, order.id, "invoice_void") : null;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link
          href="/admin/orders"
          className="inline-flex items-center gap-1 text-[13px] text-accent-ink hover:underline"
        >
          <span aria-hidden="true">←</span> 回訂單列表
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="font-serif text-[24px] leading-tight font-medium break-all text-ink">
            {order.order_no}
          </h1>
          <OrderStatusChip status={order.status} />
        </div>
      </div>

      {order.price_unverified && <PriceUnverifiedBanner total={order.total} />}

      <OrderAccountPanel info={accountInfo} canWrite={canWrite} />

      {mcpRequests === null && (
        <p role="status" className="rounded-card border border-line bg-panel px-4 py-3 text-[14px] text-ink-soft">
          AI 申請（退款／作廢發票）讀取失敗，請重新整理。
        </p>
      )}

      <McpRequestNotice request={voidRequest} />

      <OrderInvoicePanel info={invoiceInfo} canWrite={canWrite} />

      <Panel title="訂單資訊">
        <DescList>
          <Row label="金額">
            <span className="font-medium text-ink">{money(order.total)}</span>
          </Row>
          <Row label="付款方式">{paymentMethodLabel(order.payment_method)}</Row>
          <Row label="成立時間">{formatTaipei(order.created_at) || "—"}</Row>
          <Row label="付款時間">
            {order.paid_at ? (
              formatTaipei(order.paid_at)
            ) : (
              <span className="text-ink-soft">尚未收款</span>
            )}
          </Row>
          <Row label="最後更新">{formatTaipei(order.updated_at) || "—"}</Row>
        </DescList>
      </Panel>

      <Panel title="聯絡資訊">
        <DescList>
          <Row label="姓名">{order.contact_name || <Missing />}</Row>
          <Row label="電話">
            {order.contact_phone ? (
              // tel: 讓客服在手機後台可以直接撥出去，這是他們最常做的下一步
              <a href={`tel:${order.contact_phone}`} className="text-accent-ink hover:underline">
                {order.contact_phone}
              </a>
            ) : (
              <Missing />
            )}
          </Row>
          <Row label="Email">
            {order.contact_email ? (
              <a
                href={`mailto:${order.contact_email}`}
                className="break-all text-accent-ink hover:underline"
              >
                {order.contact_email}
              </a>
            ) : (
              <Missing />
            )}
          </Row>
          <Row label="寄送地址">{order.shipping_address || <Missing />}</Row>
          <Row label="備註">
            {order.note ? (
              <span className="whitespace-pre-wrap">{order.note}</span>
            ) : (
              <Missing />
            )}
          </Row>
        </DescList>
      </Panel>

      <Panel title="品項">
        {itemsError ? (
          <p className="text-[14px] leading-relaxed text-ink-soft">
            品項讀取失敗，下方的狀態操作仍然可以使用。詳細錯誤已記在伺服器 log。
          </p>
        ) : items.length === 0 ? (
          <p className="text-[14px] leading-relaxed text-ink-soft">
            這筆訂單沒有任何品項。這通常代表結帳當下寫入品項失敗了，請人工確認客人買了什麼。
          </p>
        ) : (
          <>
            <ul className="flex flex-col gap-3">
              {items.map((item) => (
                <OrderItem key={item.id} item={item} />
              ))}
            </ul>
            {itemsTotal !== order.total && (
              <p className="mt-3 rounded-input border border-danger bg-panel px-3 py-2 text-[13px] leading-relaxed text-danger">
                品項小計 {money(itemsTotal)} 與訂單金額 {money(order.total)} 不一致，
                請人工確認以哪個為準再處理收款。
              </p>
            )}
          </>
        )}
      </Panel>

      <McpRequestNotice request={refundRequest} />

      <Panel title="狀態操作">
        <OrderStatusButtons orderId={order.id} status={order.status} canWrite={canWrite} />
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ 品項 */

function OrderItem({ item }: { item: ItemRow }) {
  const product = one(item.products);
  const session = one(item.workshop_sessions);

  return (
    <li className="rounded-input border border-line bg-panel p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 text-[15px] font-medium break-words text-ink">
          {product?.title ?? (
            // product_id 是 nullable，而且 FK 是 on delete restrict，
            // 所以查不到通常代表結帳當下就沒對上商品——正是要人工複核的那種訂單。
            <span className="text-danger">（找不到商品資料）</span>
          )}
        </span>
        <span className="shrink-0 text-[14px] whitespace-nowrap text-ink">
          {money(item.unit_price)} × {item.qty}
        </span>
      </div>

      {session ? (
        <div className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
          <div>
            場次：{formatTaipei(session.starts_at)}
            {session.ends_at ? ` – ${formatTaipei(session.ends_at).split(" ")[1] ?? ""}` : ""}
          </div>
          {(session.location || session.address) && (
            <div className="break-words">
              地點：{[session.location, session.address].filter(Boolean).join("・")}
            </div>
          )}
        </div>
      ) : item.session_id ? (
        <div className="mt-1.5 text-[13px] leading-relaxed text-danger">
          這個品項指定了場次，但場次資料查不到，請人工確認。
        </div>
      ) : null}

      <div className="mt-1.5 text-[13px] text-ink-soft">
        小計 {money(item.unit_price * item.qty)}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ 版面 */

function PriceUnverifiedBanner({ total }: { total: number }) {
  return (
    <div role="alert" className="rounded-card border-2 border-danger bg-panel p-4">
      <p className="text-[15px] font-medium text-danger">
        這筆訂單成立時有商品查不到價格，金額請人工確認
      </p>
      <p className="mt-1.5 text-[14px] leading-relaxed text-ink">
        系統記錄的金額是 <span className="font-medium">{money(total)}</span>，
        但其中至少有一個品項的單價是前台送上來的、沒有經過伺服器端的定價核對。
        <span className="mt-1 block">
          標記收款前請先對照下方品項與目前的商品定價，確認客人該付多少。
        </span>
      </p>
    </div>
  );
}

/**
 * 蒐集「訂單 → 帳號 → 已開通課程」這條鏈的現況。
 *
 * 帳號 Email 用 getUserById 單筆查，不用 admin/staff 那支 loadUserEmailIndex()
 * ——後者會把全站帳號掃一遍建索引，這裡只要一個人。
 *
 * 任何一步失敗都只記 log 不炸頁：這個面板是輔助資訊，
 * 壞掉不該讓客服連「標記已收款」都按不了。
 */
async function loadAccountInfo(
  supabase: ReturnType<typeof createServiceClient>,
  order: OrderRow & { user_id?: string | null },
  items: ItemRow[],
): Promise<OrderAccountInfo> {
  const userId = (order as { user_id?: string | null }).user_id ?? null;

  let accountEmail: string | null = null;
  if (userId) {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error) {
      console.error("[admin/orders] 讀取帳號失敗", userId, error.message);
    } else {
      accountEmail = data.user?.email ?? null;
    }
  }

  let entitlements: OrderAccountInfo["entitlements"] = [];
  if (userId) {
    const { data, error } = await supabase
      .from("entitlements")
      .select("product_id, expires_at, products(title)")
      .eq("user_id", userId)
      .eq("order_id", order.id);

    if (error) {
      console.error("[admin/orders] 讀取開通紀錄失敗", order.id, error.message);
    } else {
      entitlements = (data ?? []).map((row) => {
        const product = one(
          row.products as Embedded<{ title: string | null }>,
        );
        return {
          productId: row.product_id as string,
          title: product?.title ?? "（商品已刪除）",
          expiresAt: (row.expires_at as string | null) ?? null,
        };
      });
    }
  }

  // workshop 不發 entitlement（報名名單是從 order_items 即時算的），
  // 所以「該不該有開通紀錄」只看線上課與訂閱制的品項數。
  const courseItemCount = items.filter((item) => {
    const type = one(item.products)?.type;
    return type === "course" || type === "subscription";
  }).length;

  return {
    orderId: order.id,
    orderNo: order.order_no,
    status: order.status,
    priceUnverified: order.price_unverified,
    contactEmail: order.contact_email,
    userId,
    accountEmail,
    entitlements,
    courseItemCount,
  };
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-paper p-4 admin:p-5">
      <h2 className="mb-3 text-[16px] font-medium text-ink">{title}</h2>
      {children}
    </section>
  );
}

function DescList({ children }: { children: ReactNode }) {
  // 手機單欄（標籤在上、值在下），1024px 以上才變成兩欄的 label/value。
  // 用 grid + contents 讓 dt/dd 對齊，同時保留 <dl> 的語意。
  return (
    <dl className="grid grid-cols-1 gap-y-2.5 text-[14px] admin:grid-cols-[8rem_minmax(0,1fr)] admin:gap-x-4 admin:gap-y-3">
      {children}
    </dl>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="admin:contents">
      <dt className="text-[13px] text-ink-soft admin:text-[14px]">{label}</dt>
      <dd className="mt-0.5 min-w-0 break-words text-ink admin:mt-0">{children}</dd>
    </div>
  );
}

function Missing() {
  return <span className="text-ink-soft">（未填）</span>;
}

function LoadError({ message }: { message: string }) {
  return (
    <div className="rounded-card border border-line bg-panel px-5 py-8">
      <p className="text-[14px] leading-relaxed text-ink-soft">{message}</p>
      <Link
        href="/admin/orders"
        className="mt-4 inline-flex min-h-11 items-center rounded-input border border-line-input bg-paper px-4 text-[14px] text-ink hover:bg-panel admin:min-h-10"
      >
        回訂單列表
      </Link>
    </div>
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
