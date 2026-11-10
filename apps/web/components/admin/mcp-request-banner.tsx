import Link from "next/link";
import { ConfirmButton } from "@/components/admin/confirm-button";
import { formatTaipei } from "@/components/admin/datetime-field";
import { money, paymentMethodLabel } from "@/app/admin/orders/shared";
import { dismissMcpRequestAction } from "@/app/admin/orders/mcp-request-actions";
import { MCP_REQUEST_KIND_LABEL, type PendingMcpRequest } from "@/lib/admin/mcp-pending";

/**
 * AI（MCP）提出的退款／作廢發票申請 —— 只給負責人看（呼叫端要先過 mcp:requests）。
 *
 * AI 只能「申請」，不會自己退款或作廢。負責人進訂單頁用原本的按鈕處理，
 * 或按「不處理，關閉申請」。待處理的定義在 lib/admin/mcp-pending.ts。
 *
 * 🔴 reason 是 AI 寫的文字：一律當一般文字渲染（React 會跳脫），並標明「AI 提供的原因」。
 */

/** 後台首頁的橫幅。null = 讀取失敗；空陣列 = 不顯示。 */
export function McpRequestBanner({ requests }: { requests: PendingMcpRequest[] | null }) {
  if (requests !== null && requests.length === 0) return null;
  if (requests === null) {
    return (
      <p role="status" className="rounded-card border border-line bg-panel px-4 py-3 text-[14px] text-ink-soft">
        AI 申請（退款／作廢發票）讀取失敗，請重新整理；仍失敗請聯絡工程師。
      </p>
    );
  }
  return (
    <section className="rounded-card border border-danger bg-paper p-4 admin:p-5">
      <h2 className="text-[16px] font-medium text-danger">
        AI 提出的申請待處理：{requests.length} 筆
      </h2>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
        AI 只能提出申請，<span className="font-medium text-ink">不會自己退款或作廢發票</span>。
        請點進訂單核對後，用訂單頁原本的按鈕處理；不處理就在訂單頁按「不處理，關閉申請」。
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {requests.map((r) => (
          <li key={r.requestId}>
            <Link
              href={`/admin/orders/${r.orderId}`}
              className="block rounded-input border border-line bg-panel px-3 py-2 text-[14px] text-ink hover:bg-paper"
            >
              <span className="font-medium">{r.orderNo}</span>
              {" ・ "}
              {MCP_REQUEST_KIND_LABEL[r.kind]}
              {" ・ "}
              {r.kind === "refund"
                ? `${money(r.amount)}（${paymentMethodLabel(r.paymentMethod)}）`
                : `發票 ${r.invoiceNumber}`}
              <span className="mt-0.5 block text-[13px] text-ink-soft">
                申請時間 {formatTaipei(r.requestedAt) || "—"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 訂單內頁、退款或發票區塊旁的提示。request 為 null 就不顯示。 */
export function McpRequestNotice({ request }: { request: PendingMcpRequest | null }) {
  if (!request) return null;
  const isRefund = request.kind === "refund";
  return (
    <section role="alert" className="rounded-card border-2 border-danger bg-paper p-4 admin:p-5">
      <h2 className="text-[16px] font-medium text-danger">
        AI 提出了{MCP_REQUEST_KIND_LABEL[request.kind]}（尚未{isRefund ? "退款" : "作廢"}）
      </h2>
      <dl className="mt-2 grid grid-cols-1 gap-y-1.5 text-[14px] admin:grid-cols-[8rem_minmax(0,1fr)] admin:gap-x-4">
        {isRefund ? (
          <>
            <dt className="text-ink-soft">訂單金額</dt>
            <dd className="text-ink">
              {money(request.amount)}（{paymentMethodLabel(request.paymentMethod)}）
            </dd>
          </>
        ) : (
          <>
            <dt className="text-ink-soft">發票號碼</dt>
            <dd className="text-ink">{request.invoiceNumber}</dd>
          </>
        )}
        <dt className="text-ink-soft">AI 提供的原因</dt>
        <dd className="whitespace-pre-wrap break-words text-ink">{request.reason || "—"}</dd>
        <dt className="text-ink-soft">申請時間</dt>
        <dd className="text-ink">{formatTaipei(request.requestedAt) || "—"}</dd>
      </dl>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
        這是 AI 透過 MCP 提出的申請，系統沒有做任何{isRefund ? "退款" : "作廢"}。
        上面的原因是 AI 寫的，請自行核對。確定要處理，
        <span className="font-medium text-ink">
          請用下面原本的按鈕處理
          {isRefund ? "（「退款」或「已經在黑貓 PAY 後台退過款了？」）" : "（「作廢這張發票」）"}
        </span>
        ，處理完這則提示會自動消失。
      </p>
      <div className="mt-3">
        <ConfirmButton
          action={dismissMcpRequestAction.bind(null, request.orderId, request.kind)}
          confirmText={`確定不處理這筆 AI 的${MCP_REQUEST_KIND_LABEL[request.kind]}？\n\n會記錄是你關閉的。訂單與發票都不會有任何變動。`}
          pendingLabel="關閉中…"
        >
          不處理，關閉申請
        </ConfirmButton>
      </div>
    </section>
  );
}
