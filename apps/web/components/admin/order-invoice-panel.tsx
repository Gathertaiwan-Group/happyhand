"use client";

import { useActionState, useState } from "react";
import { ConfirmButton } from "@/components/admin/confirm-button";
import {
  reissueInvoice,
  voidInvoiceAction,
  type InvoiceActionResult,
} from "@/app/admin/orders/invoice-actions";

/**
 * 訂單的電子發票面板。
 *
 * 這一區要回答兩個問題：「這筆有沒有開發票」以及「沒開的話卡在哪」。
 *
 * 🔴 2026-10-15 起**自動開票已經移除**（付款、後台標記付款、每日排程三條路
 *    都不開了）。所以「已付款但沒有發票」變成**正常狀態**而不是異常 ——
 *    紅字警示只留給「開到一半卡住」的，掛在每一頁等於沒有警示。
 *
 * ⚠️ 顯示層藏按鈕只是體貼，不是保護。兩支 action 都自己驗權限。
 * ⚠️ 「補開發票」按下去會自己建待開立列再開（含 DB claim），
 *    連按兩下不會開出兩張。防重複是靠資料庫，不是靠這裡的 disabled。
 */

export type OrderInvoiceInfo = {
  orderId: string;
  orderStatus: string;
  /** 客人在結帳時選的載具種類 */
  carrierType: string | null;
  carrierId: string | null;
  taxId: string | null;
  title: string | null;
  /** 沒有 invoices 列時是 null（例如還沒付款、或舊訂單） */
  invoice: {
    status: string;
    invoiceNumber: string | null;
    randomCode: string | null;
    issuedAt: string | null;
    voidedAt: string | null;
    retryCount: number;
    issueAttempts: number;
    lastError: string | null;
    nextAttemptAt: string | null;
  } | null;
};

const EMPTY: InvoiceActionResult = {};

const CARRIER_LABEL: Record<string, string> = {
  cloud: "雲端發票",
  phone: "手機條碼",
  natural_person: "自然人憑證",
  love_code: "捐贈",
  b2b: "公司統編（三聯式）",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "待開立",
  issuing: "開立中",
  issued: "已開立",
  voided: "已作廢",
};

function Notice({ state }: { state: InvoiceActionResult }) {
  if (!state.error && !state.ok) return null;
  const isError = Boolean(state.error);
  return (
    <p
      role={isError ? "alert" : "status"}
      className={`mt-3 rounded-card border px-4 py-2.5 text-[14px] leading-relaxed ${
        isError ? "border-danger bg-paper text-danger" : "border-line bg-panel text-ink"
      }`}
    >
      {state.error ?? state.ok}
    </p>
  );
}

export function OrderInvoicePanel({
  info,
  canWrite,
}: {
  info: OrderInvoiceInfo;
  canWrite: boolean;
}) {
  const [reissueState, reissueAction, reissuing] = useActionState(
    async () => reissueInvoice(info.orderId),
    EMPTY,
  );
  const [voidReason, setVoidReason] = useState("");
  const [voidState, setVoidState] = useState<InvoiceActionResult>(EMPTY);
  const [voiding, setVoiding] = useState(false);

  const inv = info.invoice;
  const isPaid = info.orderStatus === "paid";

  // 開到一半卡住：有待開立／開立中的列，但沒走到 issued 或 voided。
  // 這是真的要吵的狀態 —— 有人（或以前的自動流程）起了頭卻沒結束。
  const stuck =
    isPaid && !!inv && inv.status !== "issued" && inv.status !== "voided";
  // 已付款但根本沒有發票列。自動開票移除之後這是常態，用灰字陳述就好。
  const notIssuedYet = isPaid && !inv;
  /*
    已退款、發票卻還是「已開立」＝ 作廢沒成功，客人手上有一張該作廢而沒作廢
    的稅務憑證。這是整個面板最該吵的一格，而它以前完全不吵 —— stuck 與
    notIssuedYet 都要求 isPaid，refunded 時兩個都是 false。
  */
  const refundedButIssued =
    info.orderStatus === "refunded" && inv?.status === "issued";

  async function doVoid() {
    setVoiding(true);
    try {
      setVoidState(await voidInvoiceAction(info.orderId, voidReason.trim()));
    } finally {
      setVoiding(false);
    }
  }

  return (
    <section className="rounded-card border border-line bg-paper p-4 admin:p-5">
      <h2 className="mb-3 text-[16px] font-medium text-ink">電子發票</h2>

      {/* --- 最重要的一句話放最上面 --- */}
      {stuck && (
        <p className="mb-3 rounded-card border border-danger bg-paper px-4 py-3 text-[14px] leading-relaxed text-danger">
          <strong>這筆訂單已收款，發票開到一半卡住了。</strong>
          <br />
          {inv?.status === "issuing"
            ? "正在開立中。如果超過 10 分鐘還是這個狀態，按「補開發票」會自動反查 Amego 認回，不會重複開。"
            : "不會自動重試了。請先看下面的錯誤訊息把資料改對，再按「補開發票」。"}
        </p>
      )}

      {notIssuedYet && (
        <p className="mb-3 text-[14px] leading-relaxed text-ink-soft">
          這筆還沒開發票。自動開票已經關掉了，要開的話按下面的「補開發票」。
        </p>
      )}

      {refundedButIssued && (
        <p className="mb-3 rounded-card border border-danger bg-paper px-4 py-3 text-[14px] leading-relaxed text-danger">
          <strong>這筆訂單已退款，發票卻還是「已開立」。</strong>
          <br />
          客人手上有一張該作廢而沒作廢的稅務憑證，請按下面的「作廢這張發票」。
        </p>
      )}

      {/* 「還沒收款」這句以前被 pending／cancelled／refunded 三種狀態共用，
          對已退款的訂單是錯的，而且還會叫客服去幫一張退掉的訂單開發票。 */}
      {!isPaid && !refundedButIssued && (
        <p className="mb-3 text-[14px] text-ink-soft">
          {info.orderStatus === "refunded"
            ? "這筆訂單已退款。"
            : info.orderStatus === "cancelled"
              ? "這筆訂單已取消，不會有發票。"
              : "這筆訂單還沒收款。發票不會自動開立，收款之後要人工按「補開發票」。"}
        </p>
      )}

      <dl className="grid grid-cols-1 gap-y-2.5 text-[14px] admin:grid-cols-[8rem_minmax(0,1fr)] admin:gap-x-4 admin:gap-y-3">
        <dt className="text-ink-soft">狀態</dt>
        <dd className="text-ink">
          {inv ? (STATUS_LABEL[inv.status] ?? inv.status) : "（尚未建立）"}
        </dd>

        <dt className="text-ink-soft">開立方式</dt>
        <dd className="text-ink">
          {CARRIER_LABEL[info.carrierType ?? "cloud"] ?? info.carrierType}
          {info.carrierId && (
            <span className="ml-2 text-ink-soft">{info.carrierId}</span>
          )}
          {info.taxId && (
            <span className="ml-2 text-ink-soft">
              {info.taxId}
              {info.title ? `　${info.title}` : ""}
            </span>
          )}
        </dd>

        {inv?.invoiceNumber && (
          <>
            <dt className="text-ink-soft">發票號碼</dt>
            <dd className="font-medium text-ink">
              {inv.invoiceNumber}
              {inv.randomCode && (
                <span className="ml-2 text-ink-soft">隨機碼 {inv.randomCode}</span>
              )}
            </dd>
          </>
        )}

        {inv?.issuedAt && (
          <>
            <dt className="text-ink-soft">開立時間</dt>
            <dd className="text-ink">{inv.issuedAt}</dd>
          </>
        )}

        {inv?.voidedAt && (
          <>
            <dt className="text-ink-soft">作廢時間</dt>
            <dd className="text-ink">{inv.voidedAt}</dd>
          </>
        )}

        {inv && inv.lastError && (
          <>
            <dt className="text-ink-soft">最後的錯誤</dt>
            <dd className="text-danger">
              {inv.lastError}
              <span className="mt-1 block text-[13px] text-ink-soft">
                {/* 不會自動重試了。next_attempt_at 現在只是「再按一次」的冷卻時間，
                    寫成「下次自動重試」會跟上面那句紅字直接打對台。 */}
                已重試 {inv.retryCount} 次
                {inv.nextAttemptAt ? `，${inv.nextAttemptAt} 之後才能再按一次` : ""}
              </span>
            </dd>
          </>
        )}
      </dl>

      {canWrite ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {inv?.status !== "voided" && (
            <form action={reissueAction}>
              <button
                type="submit"
                disabled={reissuing}
                className="inline-flex min-h-11 items-center justify-center rounded-input border border-line-input bg-paper px-4 text-[14px] font-medium text-ink transition-colors hover:bg-panel disabled:opacity-55 admin:min-h-10"
              >
                {reissuing ? "處理中…" : inv?.status === "issued" ? "重新檢查" : "補開發票"}
              </button>
            </form>
          )}

          {inv?.status === "issued" && inv.invoiceNumber && (
            <details className="w-full">
              <summary className="flex min-h-11 cursor-pointer list-none items-center text-[14px] font-medium text-danger admin:min-h-10 [&::-webkit-details-marker]:hidden">
                ＋ 作廢這張發票
              </summary>
              <div className="mt-2 flex flex-col gap-2 rounded-card bg-panel p-3">
                <p className="text-[13px] leading-relaxed text-ink-soft">
                  作廢是不可逆的，而且
                  <span className="font-medium text-ink">同一張訂單之後不能再開一次</span>
                  （Amego 對訂單編號做唯一性檢查，這個編號會被用掉）。只是要退款的話請
                  直接按上面的「標記為已退款」，那顆會自己作廢發票。
                </p>
                <input
                  type="text"
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  placeholder="作廢原因（會送到 Amego，20 字以內）"
                  maxLength={20}
                  className="h-11 w-full rounded-input border border-line-input bg-paper px-3 text-[16px] text-ink admin:h-10 admin:text-[15px]"
                />
                <div>
                  <ConfirmButton
                    action={doVoid}
                    variant="danger"
                    confirmText={
                      `確定要作廢發票 ${inv.invoiceNumber} 嗎？\n\n` +
                      "作廢之後這張訂單就不能再開發票了（訂單編號在 Amego 已經用掉）。\n" +
                      "客人那邊看到的發票號碼也會一起清掉。"
                    }
                  >
                    {voiding ? "作廢中…" : "確定作廢"}
                  </ConfirmButton>
                </div>
              </div>
            </details>
          )}
        </div>
      ) : (
        <p className="mt-4 border-t border-line pt-4 text-[14px] text-ink-soft">
          你的帳號沒有處理訂單的權限，所以只能看不能改。
        </p>
      )}

      <Notice state={reissueState} />
      <Notice state={voidState} />
    </section>
  );
}
