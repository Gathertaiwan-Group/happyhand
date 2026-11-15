"use client";

import { useState } from "react";
import { revokeMyMcpConnections } from "./actions";

/** 「撤銷我的所有 AI 連線」—— 按兩下確認，避免手機上誤觸。 */
export function RevokeButton() {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function run() {
    setBusy(true);
    try {
      setResult(await revokeMyMcpConnections());
    } catch {
      setResult({ ok: false, message: "撤銷失敗，請稍後再試。" });
    }
    setBusy(false);
    setArmed(false);
  }

  return (
    <div className="flex flex-col gap-3">
      {armed ? (
        <div className="flex gap-3">
          <button
            type="button"
            className="inline-flex min-h-12 flex-1 items-center justify-center rounded-input border border-line-input px-4 text-[15px] text-ink hover:bg-paper"
            disabled={busy}
            onClick={() => setArmed(false)}
          >
            取消
          </button>
          <button
            type="button"
            className="inline-flex min-h-12 flex-1 items-center justify-center rounded-input border border-danger px-4 text-[15px] text-danger hover:bg-paper disabled:opacity-50"
            disabled={busy}
            onClick={run}
          >
            {busy ? "撤銷中…" : "確定撤銷"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="inline-flex min-h-12 w-full items-center justify-center rounded-input border border-danger px-4 text-[15px] text-danger hover:bg-paper"
          onClick={() => {
            setResult(null);
            setArmed(true);
          }}
        >
          撤銷我的所有 AI 連線
        </button>
      )}
      {result ? (
        <p role="status" className={`text-[14px] leading-relaxed ${result.ok ? "text-ink" : "text-danger"}`}>
          {result.message}
        </p>
      ) : null}
    </div>
  );
}
