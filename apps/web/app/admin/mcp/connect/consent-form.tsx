"use client";

import { useState } from "react";
import { decideMcpConnect } from "./actions";

/**
 * 同意頁的按鈕。
 *
 * 釣魚防線（比照小時光書店）：別人可以在**他自己的** Claude／ChatGPT 帳號按「連接」，再把
 * 這條授權網址寄給負責人。PKCE、CSRF 都擋不住，因為按允許的真的是負責人本人。所以要先勾
 * 「是我自己剛剛發起的」，允許才按得下去。
 */
export function ConsentForm({ query, csrf }: { query: string; csrf: string }) {
  const [busy, setBusy] = useState<null | "allow" | "deny">(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  async function decide(allow: boolean) {
    setBusy(allow ? "allow" : "deny");
    setError(null);
    try {
      const r = await decideMcpConnect(query, csrf, allow);
      if (r.ok) {
        window.location.assign(r.url);
        return;
      }
      setError(r.message);
    } catch {
      setError("授權失敗，請稍後再試一次。");
    }
    setBusy(null);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-input border border-line-input bg-paper px-4 py-3 text-[14px] leading-relaxed">
        <p className="font-medium text-ink">
          如果這不是你自己剛剛在 Claude／ChatGPT 按下「連接」打開的頁面，請按「拒絕」。
        </p>
        <p className="text-[13px] text-ink-soft">
          別人寄來的授權連結，按下允許會讓<strong>對方的</strong> AI 帳號取得後台的操作權限。
        </p>
        <label className="flex min-h-11 items-start gap-2.5 pt-1 text-ink">
          <input
            type="checkbox"
            className="mt-1 h-5 w-5 shrink-0"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>我確認是我自己剛剛發起這個連線</span>
        </label>
      </div>

      {error ? (
        <p role="alert" className="rounded-input border border-danger px-3 py-2 text-[14px] text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex gap-3">
        <button
          type="button"
          className="inline-flex min-h-12 flex-1 items-center justify-center rounded-input border border-line-input px-4 text-[16px] text-ink hover:bg-paper disabled:opacity-50"
          disabled={busy !== null}
          onClick={() => decide(false)}
        >
          {busy === "deny" ? "處理中…" : "拒絕"}
        </button>
        <button
          type="button"
          className="inline-flex min-h-12 flex-1 items-center justify-center rounded-input bg-caramel-ink px-4 text-[16px] text-white hover:bg-caramel-dk disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy !== null || !confirmed}
          onClick={() => decide(true)}
        >
          {busy === "allow" ? "授權中…" : "允許"}
        </button>
      </div>
    </div>
  );
}
