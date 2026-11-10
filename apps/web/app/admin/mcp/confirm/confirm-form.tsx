"use client";

import { useActionState } from "react";
import { confirmMcpRequest, type ConfirmState } from "./actions";

/**
 * 確認按鈕。只有一顆，送出的是 token 本身 —— server action 會從頭重新驗。
 *
 * 作廢發票多一個原因欄位：預填 AI 提供的字，但送出去的是本人在這裡確認過的值。
 */
export function ConfirmForm({
  token,
  danger,
  reasonDefault,
}: {
  token: string;
  danger: boolean;
  /** 只有作廢發票才傳。預填值來自 AI，畫面上明講 */
  reasonDefault?: string;
}) {
  const [state, formAction, pending] = useActionState<ConfirmState, FormData>(
    confirmMcpRequest,
    null,
  );

  if (state?.done) {
    return (
      <p role="status" className="rounded-input border border-line bg-panel px-4 py-3 text-[14px] leading-relaxed text-ok">
        {state.ok}
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="t" value={token} />

      {reasonDefault !== undefined && (
        <label className="flex flex-col gap-1.5 text-[14px] text-ink">
          作廢原因（會送到 Amego，20 字以內）
          <span className="text-[13px] text-ink-soft">
            下面預填的是 AI 提供的文字，請確認或改成你要的原因。
          </span>
          <input
            type="text"
            name="reason"
            defaultValue={reasonDefault}
            required
            maxLength={20}
            className="h-11 w-full rounded-input border border-line-input bg-paper px-3 text-[16px] text-ink admin:h-10 admin:text-[15px]"
          />
        </label>
      )}

      <div>
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className={
            "inline-flex min-h-11 items-center justify-center rounded-input px-5 text-[15px] font-medium transition-colors admin:min-h-10 disabled:cursor-not-allowed disabled:opacity-55 " +
            (danger
              ? "border border-danger bg-danger text-paper hover:opacity-90"
              : "border border-ink bg-ink text-paper hover:opacity-90")
          }
        >
          {pending ? "處理中…" : "我已核對，確認執行"}
        </button>
      </div>

      {state?.error && (
        <p role="alert" className="text-[14px] leading-relaxed text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
