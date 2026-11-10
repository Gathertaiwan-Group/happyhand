import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { checkCapability, getStaff } from "@/lib/admin/guard";
import { loadPendingMcpRequests } from "@/lib/admin/mcp-pending-repo";
import type { PendingMcpRequest } from "@/lib/admin/mcp-pending";
import { McpRequestBanner } from "@/components/admin/mcp-request-banner";
import { can } from "@/lib/admin/roles";
import { createServiceClient } from "@/lib/supabase/server";
import { DataList } from "@/components/admin/data-list";
import { formatTaipei } from "@/components/admin/datetime-field";

/**
 * 後台總覽。
 *
 * 每一塊都依 capability 決定要不要出現：內容編輯（editor）拿不到任何 orders:* 能力，
 * 所以他看不到訂單與營收數字——那是刻意的權限切分，不是漏做。
 *
 * 讀取一律走 service role：後台要看得到草稿課程與所有訂單，
 * 使用者自己的 session client 會被 RLS 擋掉大半。
 * 授權在上面 can() 與 layout 的 getStaff()，不靠 RLS。
 *
 * ⚠️ 每一個查詢都各自 try/catch。總覽是六塊獨立資訊拼起來的，
 *    一塊查壞了應該只有那一塊顯示「讀取失敗」，不是整頁白畫面。
 * ⚠️ audit_log 與 workshop_waitlist 的 migration 還沒 push，這頁不查那兩張表。
 */

export const dynamic = "force-dynamic";

type Db = ReturnType<typeof createServiceClient>;

type SessionRow = {
  id: string;
  starts_at: string;
  location: string | null;
  capacity: number;
  seats_taken: number;
  status: string;
  products: { title: string | null } | { title: string | null }[] | null;
};

const SESSION_STATUS_LABEL: Record<string, string> = {
  open: "開放報名",
  full: "已額滿",
  closed: "已關閉",
  cancelled: "已取消",
};

function money(value: number): string {
  return `NT$ ${value.toLocaleString("zh-TW")}`;
}

/** PostgREST 的內嵌關聯有時是物件、有時是陣列，這裡統一收斂 */
function productTitle(row: SessionRow): string {
  const product = Array.isArray(row.products) ? row.products[0] : row.products;
  return product?.title ?? "（找不到課程）";
}

export default async function AdminDashboardPage() {
  // layout 已經擋過一次，這裡再拿一次是為了 role（layout 無法把值傳給 page）。
  const staff = await getStaff();
  if (!staff) redirect("/login?redirect=/admin");

  let db: Db | null = null;
  try {
    db = createServiceClient();
  } catch (err) {
    // SUPABASE_SERVICE_ROLE_KEY 沒設時 createServiceClient() 會 throw。
    console.error("[admin] service client 建立失敗", err);
  }

  const showOrders = can(staff.role, "orders:read");
  const showCatalog = can(staff.role, "catalog:read");

  // AI（MCP）申請只給負責人看：用能力表（mcp:requests）判斷，不比對角色字串。
  const showMcpRequests = (await checkCapability("mcp:requests")) !== null;

  const [orderStats, catalogStats, sessions, health, mcpRequests] = await Promise.all([
    showOrders ? loadOrderStats(db) : null,
    showCatalog ? loadCatalogStats(db) : null,
    loadUpcomingSessions(db),
    showOrders ? loadHealthStats(db) : null,
    showMcpRequests ? loadMcpRequests(db) : undefined,
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-serif text-[24px] leading-tight font-medium text-ink">
          總覽
        </h1>
        <p className="mt-1 text-[14px] text-ink-soft">
          你好，{staff.email ?? "同事"}。以下只顯示你權限範圍內的資料。
        </p>
      </div>

      {/* AI 提出的退款／作廢申請（負責人限定）。沒有待處理時不渲染。 */}
      {mcpRequests !== undefined && <McpRequestBanner requests={mcpRequests} />}

      {/* 🔴 需要處理的異常放最上面。
          「客人付了錢但看不到課」如果沒有一個每天會被看到的地方顯示，
          就要等客人打 LINE 來罵才會發現。沒有異常時整塊不渲染，
          免得變成永遠都在的裝飾品而被忽略。 */}
      {health &&
        (health.unfulfilled > 0 ||
          health.failedEmails > 0 ||
          health.stuckInvoices > 0 ||
          health.paymentAlerts > 0) && (
        <section className="rounded-card border border-danger bg-paper p-4 admin:p-5">
          <h2 className="text-[16px] font-medium text-danger">需要處理</h2>
          <ul className="mt-2 flex flex-col gap-2 text-[14px] leading-relaxed text-ink">
            {health.unfulfilled > 0 && (
              <li>
                有 <strong className="text-danger">{health.unfulfilled}</strong>{" "}
                筆訂單已收款，但線上課還沒有開通 —— 這些客人現在登入是看不到課的。
                <Link
                  href="/admin/orders?status=paid"
                  className="ml-1 text-accent-ink underline"
                >
                  去處理
                </Link>
              </li>
            )}
            {health.paymentAlerts > 0 && (
              <li>
                有 <strong className="text-danger">{health.paymentAlerts}</strong>{" "}
                筆線上刷卡的付款通知<strong className="text-danger">沒能處理完</strong>
                —— 金額對不上、回查不到、處理到一半中斷，
                或是授權已經被取消但訂單還掛在「已收款」。
                前幾種是客人可能扣了錢卻沒拿到課；最後一種相反，是錢已經退回去了
                但席次與課程權限還佔著。兩種都要一筆一筆對，
                請開黑貓 PAY 後台的交易明細比對訂單編號。
              </li>
            )}
            {health.failedEmails > 0 && (
              <li>
                有 <strong className="text-danger">{health.failedEmails}</strong>{" "}
                封信重試多次仍寄不出去（訂單通知或設定密碼信）。
                請確認客人的 Email 是否打錯，或改用 LINE 通知。
              </li>
            )}
            {health.stuckInvoices > 0 && (
              <li>
                有 <strong className="text-danger">{health.stuckInvoices}</strong>{" "}
                筆訂單的電子發票還沒開出來 —— 這些客人拿不到稅務憑證。
                進訂單頁看「電子發票」那一區有寫卡在哪。
                <Link
                  href="/admin/orders?status=paid"
                  className="ml-1 text-accent-ink underline"
                >
                  去處理
                </Link>
              </li>
            )}
          </ul>
        </section>
      )}

      {/*
        「開通了但金額沒核對過」刻意跟上面那塊分開，而且不是紅的。
        客人沒有受影響（課已經開了），差別只在我們少了一個能證明金額正確的欄位 ——
        混進「需要處理」會稀釋掉那一塊的意義，讓真正掉單的那幾筆被當成雜訊滑過去。
      */}
      {health && health.paymentUnverified > 0 && (
        <section className="rounded-card border border-line bg-panel p-4 admin:p-5">
          <p className="text-[14px] leading-relaxed text-ink-soft">
            近 30 天有 <span className="font-medium text-ink">{health.paymentUnverified}</span>{" "}
            筆線上刷卡已開通，但系統
            <span className="font-medium text-ink">沒有核對過金額</span>
            —— 黑貓 PAY 的回應裡找不到可用的實收金額欄位（規格只寫了代收代付用的
            pay_amount）。課程與席次都正常，對帳時請用黑貓 PAY 後台的交易明細
            比對一次金額。這個數字要歸零需要工程師依實際回應補上欄位名。
          </p>
        </section>
      )}

      {/* orderStats 只有在 showOrders 時才會是非 null。
          寫成 `showOrders && orderStats.error` 的話 TS 無法把布林值與 null 關聯起來，
          直接判物件本身既通過型別檢查也更誠實。 */}
      {orderStats && (
        <Section title="訂單" href="/admin/orders" linkLabel="查看全部訂單">
          {orderStats.error ? (
            <LoadError message={orderStats.error} />
          ) : (
            <div className="grid grid-cols-2 gap-3 admin:grid-cols-3">
              <StatCard
                label="待收款訂單"
                value={String(orderStats.pending)}
                unit="筆"
                emphasis={orderStats.pending > 0}
                note={orderStats.pending > 0 ? "需要人工確認匯款" : "目前都處理完了"}
              />
              <StatCard
                label="近 7 天成立訂單"
                value={String(orderStats.recentCount)}
                unit="筆"
              />
              <StatCard
                label="近 7 天已收款"
                value={money(orderStats.recentPaidTotal)}
                note="只計算狀態為已付款的訂單"
              />
            </div>
          )}
        </Section>
      )}

      {catalogStats && (
        <Section title="課程與工作坊" href="/admin/courses" linkLabel="管理課程">
          {catalogStats.error ? (
            <LoadError message={catalogStats.error} />
          ) : (
            <div className="grid grid-cols-2 gap-3 admin:grid-cols-3">
              <StatCard label="已發布" value={String(catalogStats.published)} unit="門" />
              <StatCard
                label="草稿"
                value={String(catalogStats.draft)}
                unit="門"
                note={catalogStats.draft > 0 ? "尚未對外顯示" : undefined}
              />
            </div>
          )}
        </Section>
      )}

      <Section title="即將開課的場次">
        {sessions.error ? (
          <LoadError message={sessions.error} />
        ) : (
          <DataList
            items={sessions.rows}
            keyOf={(row) => row.id}
            caption="即將開課的工作坊場次與剩餘名額"
            empty="目前沒有即將開課的場次。新增場次後會出現在這裡。"
            columns={[
              {
                header: "課程",
                primary: true,
                cell: (row) => productTitle(row),
              },
              {
                header: "狀態",
                trailing: true,
                cell: (row) => (
                  <StatusChip
                    label={SESSION_STATUS_LABEL[row.status] ?? row.status}
                    tone={row.status === "full" ? "warn" : "ok"}
                  />
                ),
              },
              {
                header: "開始時間",
                cell: (row) => formatTaipei(row.starts_at),
              },
              {
                header: "地點",
                cell: (row) => row.location ?? "—",
              },
              {
                header: "剩餘名額",
                align: "right",
                cell: (row) => {
                  const left = row.capacity - row.seats_taken;
                  return (
                    <span className={left <= 0 ? "text-danger" : undefined}>
                      {left} / {row.capacity}
                    </span>
                  );
                },
              },
            ]}
          />
        )}
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------ 查詢 */

async function loadOrderStats(db: Db | null) {
  const empty = { pending: 0, recentCount: 0, recentPaidTotal: 0, error: "" };
  if (!db) return { ...empty, error: "資料庫連線未設定，請檢查伺服器環境變數。" };

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [pending, recent] = await Promise.all([
      db.from("orders").select("id", { count: "exact", head: true }).eq("status", "pending"),
      db.from("orders").select("total, status").gte("created_at", sevenDaysAgo),
    ]);

    // Supabase 查詢失敗不會 throw，錯誤在回傳值的 error 欄位。
    // 不顯式檢查的話數字會永遠是 0 而沒人發現。
    if (pending.error) throw new Error(pending.error.message);
    if (recent.error) throw new Error(recent.error.message);

    const rows = (recent.data ?? []) as { total: number; status: string }[];
    return {
      pending: pending.count ?? 0,
      recentCount: rows.length,
      recentPaidTotal: rows
        .filter((row) => row.status === "paid")
        .reduce((sum, row) => sum + (row.total ?? 0), 0),
      error: "",
    };
  } catch (err) {
    console.error("[admin] 訂單統計查詢失敗", err);
    return { ...empty, error: "訂單統計讀取失敗。" };
  }
}

/**
 * 兩個「有沒有人付了錢卻沒拿到東西」的指標。
 *
 * 查失敗時回 0 而不是顯示錯誤：這一區只在數字 > 0 時渲染，
 * 查不到就當作沒事，總覽的其他部分照常運作。失敗會進 log。
 */
async function loadHealthStats(db: Db | null) {
  const empty = {
    unfulfilled: 0,
    failedEmails: 0,
    stuckInvoices: 0,
    paymentAlerts: 0,
    paymentUnverified: 0,
  };
  if (!db) return empty;

  try {
    const [unfulfilled, failed, invoices, payments, unverified] = await Promise.all([
      db.rpc("count_unfulfilled_paid_orders"),
      db
        .from("email_outbox")
        .select("id", { count: "exact", head: true })
        .eq("status", "failed"),
      db.rpc("count_invoice_alerts"),
      /*
        付款異常。
        ⚠️ count_payment_alerts() 從 20260817 就寫好了，但**沒有任何畫面呼叫它**，
           所以「收到付款通知卻沒能把課開出去」這件事一直沒有人看得到 ——
           而那正好是 APN 那幾個 bug 掉單時會留下的痕跡。這一行就是補上這個缺口。
      */
      db.rpc("count_payment_alerts"),
      db.rpc("count_payment_unverified"),
    ]);

    if (unfulfilled.error) {
      console.error("[admin] 未開通訂單查詢失敗", unfulfilled.error.message);
    }
    if (failed.error) {
      console.error("[admin] 寄信失敗數查詢失敗", failed.error.message);
    }

    if (invoices.error) {
      console.error("[admin] 發票異常查詢失敗", invoices.error.message);
    }
    if (payments.error) {
      console.error("[admin] 付款異常查詢失敗", payments.error.message);
    }
    if (unverified.error) {
      console.error("[admin] 未核對金額查詢失敗", unverified.error.message);
    }

    // RPC 回的是一列三個計數。三種都是「客人拿不到發票」，加總成一個數字就好 ——
    // 客服要的是「有幾筆要看」，細節在訂單頁上。
    const invRow = (Array.isArray(invoices.data) ? invoices.data[0] : invoices.data) as
      | { pending_overdue?: number; stuck_issuing?: number; exhausted?: number }
      | null;

    return {
      unfulfilled: typeof unfulfilled.data === "number" ? unfulfilled.data : 0,
      failedEmails: failed.count ?? 0,
      stuckInvoices:
        Number(invRow?.pending_overdue ?? 0) +
        Number(invRow?.stuck_issuing ?? 0) +
        Number(invRow?.exhausted ?? 0),
      paymentAlerts: typeof payments.data === "number" ? payments.data : 0,
      paymentUnverified: typeof unverified.data === "number" ? unverified.data : 0,
    };
  } catch (err) {
    console.error("[admin] 健康度統計查詢失敗", err);
    return empty;
  }
}

async function loadCatalogStats(db: Db | null) {
  const empty = { published: 0, draft: 0, error: "" };
  if (!db) return { ...empty, error: "資料庫連線未設定，請檢查伺服器環境變數。" };

  try {
    const [published, draft] = await Promise.all([
      db.from("products").select("id", { count: "exact", head: true }).eq("is_published", true),
      db.from("products").select("id", { count: "exact", head: true }).eq("is_published", false),
    ]);
    if (published.error) throw new Error(published.error.message);
    if (draft.error) throw new Error(draft.error.message);

    return { published: published.count ?? 0, draft: draft.count ?? 0, error: "" };
  } catch (err) {
    console.error("[admin] 課程統計查詢失敗", err);
    return { ...empty, error: "課程統計讀取失敗。" };
  }
}

async function loadUpcomingSessions(db: Db | null) {
  const empty = { rows: [] as SessionRow[], error: "" };
  if (!db) return { ...empty, error: "資料庫連線未設定，請檢查伺服器環境變數。" };

  try {
    const { data, error } = await db
      .from("workshop_sessions")
      .select("id, starts_at, location, capacity, seats_taken, status, products(title)")
      .gt("starts_at", new Date().toISOString())
      .in("status", ["open", "full"])
      .order("starts_at", { ascending: true })
      .limit(8);
    if (error) throw new Error(error.message);

    return { rows: (data ?? []) as SessionRow[], error: "" };
  } catch (err) {
    console.error("[admin] 場次查詢失敗", err);
    return { ...empty, error: "場次讀取失敗。" };
  }
}

/* ------------------------------------------------------------------ 版面 */

function Section({
  title,
  href,
  linkLabel,
  children,
}: {
  title: string;
  href?: string;
  linkLabel?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h2 className="text-[16px] font-medium text-ink">{title}</h2>
        {href && linkLabel && (
          <Link
            href={href}
            className="shrink-0 text-[13px] text-accent-ink hover:underline"
          >
            {linkLabel}
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

function StatCard({
  label,
  value,
  unit,
  note,
  emphasis = false,
}: {
  label: string;
  value: string;
  unit?: string;
  note?: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`rounded-card border p-4 ${
        emphasis ? "border-accent bg-panel" : "border-line bg-paper"
      }`}
    >
      <div className="text-[13px] text-ink-soft">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="font-serif text-[24px] leading-none font-medium text-ink">
          {value}
        </span>
        {unit && <span className="text-[13px] text-ink-soft">{unit}</span>}
      </div>
      {note && <div className="mt-1.5 text-[12px] leading-snug text-ink-soft">{note}</div>}
    </div>
  );
}

function StatusChip({ label, tone }: { label: string; tone: "ok" | "warn" }) {
  return (
    <span
      className={`inline-flex items-center rounded-pill bg-chip px-2.5 py-1 text-[12px] font-medium whitespace-nowrap ${
        tone === "ok" ? "text-ok" : "text-danger"
      }`}
    >
      {label}
    </span>
  );
}

function LoadError({ message }: { message: string }) {
  return (
    <p className="rounded-card border border-line bg-panel px-4 py-3 text-[14px] text-ink-soft">
      {message}
      <span className="block text-[13px]">
        其他區塊不受影響。詳細錯誤已記在伺服器 log。
      </span>
    </p>
  );
}

/** null = 讀取失敗（橫幅顯示「讀取失敗」，不當成沒有申請） */
async function loadMcpRequests(db: Db | null): Promise<PendingMcpRequest[] | null> {
  if (!db) return null;
  try {
    return await loadPendingMcpRequests(db);
  } catch (err) {
    console.error("[admin] 讀取 AI 申請失敗", err);
    return null;
  }
}
