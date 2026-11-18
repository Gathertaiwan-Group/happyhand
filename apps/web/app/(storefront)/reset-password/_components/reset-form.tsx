"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Field } from "@/components/ui/field";
import { buttonClass } from "@/components/ui/button";
import { SITE } from "@/lib/site";
import { MessageCircle } from "lucide-react";

/**
 * 設定新密碼。
 *
 * 這一頁同時是「首次設定密碼」（訪客結帳自動建的帳號）與「修改密碼」
 * （已登入的人自己來改）。**刻意不區分** —— 兩者的操作與結果完全一樣，
 * 分成兩頁只是多一個狀態要維護、多一個會寫錯的地方。
 *
 * 前置條件是已經有 session：/auth/confirm 的 verifyOtp 成功時就把 cookie 寫好了。
 * 沒有 session 的話 page.tsx 會先擋下來，這個元件不用自己判斷。
 */

const MIN_LENGTH = 10;

function mapError(raw: string): string {
  const message = raw.toLowerCase();
  if (message.includes("should be at least") || message.includes("password"))
    return `密碼太短了，請至少 ${MIN_LENGTH} 個字。`;
  if (message.includes("same") || message.includes("different from the old"))
    return "新密碼跟原本的一樣，請換一組。";
  if (message.includes("reauthentication") || message.includes("session"))
    return "這個連結已經過期了。請回「忘記密碼」重新寄一封信。";
  if (message.includes("rate") || message.includes("too many"))
    return "試太多次了，請等一分鐘再試。";
  return "設定失敗，請重試一次。還是不行的話用 LINE 跟我們說。";
}

export function ResetForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (password.length < MIN_LENGTH) {
      setError(`密碼請至少 ${MIN_LENGTH} 個字。可以用一句你記得住的話。`);
      return;
    }
    if (password !== confirm) {
      setError("兩次輸入的密碼不一樣，請再確認一次。");
      return;
    }

    setBusy(true);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.auth.updateUser({ password });
      if (err) {
        setError(mapError(err.message));
        setBusy(false);
        return;
      }
      setDone(true);
      // 密碼改好了，session 還在，直接帶去會員中心。
      router.push("/account");
      router.refresh();
    } catch (err) {
      console.error("[reset] 例外", err);
      setError("設定失敗，請重試一次。");
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div
        role="status"
        className="rounded-card border border-sand-300 bg-cream-100 px-[22px] py-[26px] md:px-[36px] md:py-[34px]"
      >
        <h2 className="t-h2 text-brown-900">密碼設定好了</h2>
        <p className="t-body mt-[12px] text-brown-700">正在帶你去「我的學習」…</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-[18px]">
      {error && (
        <p
          role="alert"
          className="t-body rounded-card border border-error bg-white px-[20px] py-[14px] text-error"
        >
          {error}
        </p>
      )}

      <Field
        label="新密碼"
        name="password"
        type={show ? "text" : "password"}
        required
        autoComplete="new-password"
        value={password}
        onChange={setPassword}
        hint={`至少 ${MIN_LENGTH} 個字。可以用一句你記得住的話，例如「我每天練仁神術」。`}
      />
      <Field
        label="再打一次新密碼"
        name="confirm"
        type={show ? "text" : "password"}
        required
        autoComplete="new-password"
        value={confirm}
        onChange={setConfirm}
        hint="確認兩次打的一樣，避免打錯字之後登不進來"
      />

      {/*
        「顯示密碼」對長輩幾乎是必要的：看不到自己打了什麼，
        又被要求打兩次，錯字率非常高。用 checkbox 而不是眼睛圖示，
        因為圖示還要解碼，文字不用。
      */}
      <label className="flex min-h-[44px] cursor-pointer items-center gap-[10px] text-[17px] text-brown-700">
        <input
          type="checkbox"
          checked={show}
          onChange={(e) => setShow(e.target.checked)}
          className="h-[22px] w-[22px] accent-[#a96c3c]"
        />
        顯示密碼，讓我看看打對了沒
      </label>

      <div>
        <button
          type="submit"
          disabled={busy}
          aria-busy={busy}
          className={buttonClass({
            variant: busy ? "disabled" : "primary",
            size: "lg",
            fullWidth: true,
            className: "sm:w-auto",
          })}
        >
          {busy ? "設定中…" : "設定新密碼"}
        </button>
      </div>

      <p className="t-body-sm text-pretty text-brown-500">
        設定不順利嗎？
        <a
          href={SITE.lineHref}
          target="_blank"
          rel="noopener noreferrer"
          className="-my-[11px] inline-flex items-center gap-[4px] py-[11px] align-middle text-caramel-dk hover:underline"
        >
          <MessageCircle aria-hidden="true" strokeWidth={1.8} className="h-[18px] w-[18px]" />
          用 LINE 問我們
          <span className="sr-only">（會開啟 LINE）</span>
        </a>
        ，我們直接幫你處理。
      </p>
    </form>
  );
}
