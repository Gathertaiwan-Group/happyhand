import type { ReactNode } from "react";
import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { formatTaipei } from "@/components/admin/datetime-field";
import { APPROVAL_TOOLS } from "@/lib/admin/mcp-requests";
import { evaluateApproval } from "./evaluate";
import { ConfirmForm } from "./confirm-form";

/**
 * AI（MCP）提出的「動錢／不可逆」操作，由管理員本人在這裡確認。
 *
 * 已經在 middleware 的 /admin/:path* 底下：未登入會被導去登入，
 * admin/layout.tsx 再擋掉非員工。
 *
 * 🔴 畫面上的每一個事實（訂單編號、金額、聯絡人、品項、目前狀態）都是
 *    **這一刻從資料庫讀出來的**。token 只提供「哪一個工具、哪一個 id」，
 *    它的文字是 AI 產的、可能被 prompt injection 汙染，一個字都不當事實顯示。
 *    標題與「按下去會發生什麼」是程式裡寫死的固定文案。
 *    唯一的例外是作廢原因：它是要送出去的值，放在可編輯欄位裡並明講來源。
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "確認 AI 提出的操作",
  // 網址帶著確認碼，不要讓瀏覽器把它當 referrer 帶出去
  referrer: "no-referrer" as const,
};

export default async function McpConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string | string[] }>;
}) {
  const { t } = await searchParams;
  const token = typeof t === "string" ? t : "";

  if (!token) {
    return <Refused message="網址裡沒有確認碼。請從 AI 給你的完整連結重新開啟。" />;
  }

  const ev = await evaluateApproval(token);
  if (!ev.ok) return <Refused message={ev.message} />;

  const def = APPROVAL_TOOLS[ev.tool];
  const rows = await def.summary(createServiceClient(), ev.payload.args);
  if (!rows) return <Refused message="讀取資料失敗，請重新整理後再試一次。" />;

  const danger = ev.tool !== "force_grant_entitlements";
  const detailHref =
    ev.snap.entity === "order"
      ? `/admin/orders/${ev.snap.entityId}`
      : ev.snap.entity === "product"
        ? `/admin/products/${ev.snap.entityId}`
        : `/admin/sessions/${ev.snap.entityId}`;

  return (
    <div className="flex max-w-[44rem] flex-col gap-5">
      <div>
        <p className="text-[13px] text-ink-soft">AI 透過 MCP 提出、等待你本人確認的操作</p>
        <h1 className="mt-1 font-serif text-[24px] leading-tight font-medium text-ink">{def.title}</h1>
      </div>

      <section className="rounded-card border border-danger bg-paper p-4 admin:p-5">
        <h2 className="mb-2 text-[16px] font-medium text-danger">按下確認會發生什麼</h2>
        <p className="text-[14px] leading-relaxed text-ink">{def.effect}</p>
      </section>

      <section className="rounded-card border border-line bg-paper p-4 admin:p-5">
        <h2 className="mb-1 text-[16px] font-medium text-ink">對象（即時從資料庫讀取）</h2>
        <p className="mb-3 text-[13px] text-ink-soft">
          以下內容不是 AI 寫的。如果和你預期的不一樣，不要按確認。
        </p>
        <dl className="grid grid-cols-1 gap-y-2.5 text-[14px] admin:grid-cols-[8rem_minmax(0,1fr)] admin:gap-x-4 admin:gap-y-3">
          {rows.map((r) => (
            <Row key={r.label} label={r.label}>
              <span className={r.strong ? "font-medium text-ink" : undefined}>{r.value}</span>
            </Row>
          ))}
        </dl>
        <Link
          href={detailHref}
          className="mt-4 inline-flex text-[13px] text-accent-ink hover:underline"
        >
          開啟完整頁面核對 →
        </Link>
      </section>

      <section className="rounded-card border border-line bg-panel p-4 admin:p-5">
        <p className="mb-3 text-[13px] leading-relaxed text-ink-soft">
          確認者：{ev.staff.email ?? "（此帳號沒有 Email）"}　·　連結有效到{" "}
          {formatTaipei(new Date(ev.payload.exp * 1000).toISOString())}
          <br />
          稽核紀錄會記下「AI 提出、由你確認」。
        </p>
        <ConfirmForm
          token={token}
          danger={danger}
          reasonDefault={
            ev.tool === "void_invoice" ? String(ev.payload.args.reason ?? "").slice(0, 20) : undefined
          }
        />
      </section>
    </div>
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

function Refused({ message }: { message: string }) {
  return (
    <div className="max-w-[44rem] rounded-card border border-line bg-panel px-5 py-8">
      <h1 className="font-serif text-[20px] font-medium text-ink">無法執行這個請求</h1>
      <p data-mcp-refused className="mt-2 text-[14px] leading-relaxed text-ink-soft">
        {message}
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
