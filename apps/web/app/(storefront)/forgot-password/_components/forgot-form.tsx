"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Field } from "@/components/ui/field";
import { buttonClass } from "@/components/ui/button";
import { SITE } from "@/lib/site";
import { authConfirmUrl } from "@/lib/auth/confirm-url";

/**
 * 忘記密碼。
 *
 * **只有一條路：寄信。** 刻意不同時提供 magic link、簡訊、LINE 三種選項——
 * 長輩分不清那些的差別，選項愈多愈容易卡住。LINE 是求助出口，不是第二種登入方式。
 *
 * 寄信本身走 Supabase 內建的 resetPasswordForEmail（不是我們的 outbox）。
 * 這是刻意的：Supabase 那條路自帶防帳號枚舉與 rate limit，
 * 自己用 generateLink 重做一遍很容易做錯。README 有記一筆為什麼兩條路並存。
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Supabase 對同一使用者的 /recover 有 60 秒間隔限制。 */
const COOLDOWN_SECONDS = 60;

export function ForgotForm() {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const noticeRef = useRef<HTMLDivElement>(null);

  // 倒數。這是**功能不是裝飾**：沒有它，長輩連按兩下就會撞到 Supabase 的
  // rate limit，然後拿到一句英文錯誤訊息。
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((v) => v - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  // 送出後把焦點移到說明區，螢幕閱讀器才會讀到「信寄出去了」
  useEffect(() => {
    if (sentTo) noticeRef.current?.focus();
  }, [sentTo]);

  async function send(target: string) {
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      // 信件連結＝這個網址＋?token_hash=…&type=recovery&next=/reset-password（模板帶的）。
      // 三站共用一組信件模板，網域要由各站自己帶回來，見 lib/auth/confirm-url.ts。
      const { error: err } = await supabase.auth.resetPasswordForEmail(target, {
        redirectTo: authConfirmUrl(window.location.origin),
      });

      // ⚠️ 就算 err 存在也不要把細節顯示出來。Supabase 對「信箱不存在」
      //    刻意不報錯（防帳號枚舉），我們也不能自己開一個洞。
      //    唯一會顯示的是 rate limit——那個要讓人知道「再等一下」。
      if (err && /rate|too many|60 seconds/i.test(err.message)) {
        setError("剛剛才寄過一封，請等一分鐘再按一次。");
        setBusy(false);
        return;
      }
      if (err) {
        console.error("[forgot] resetPasswordForEmail", err.message);
      }

      setSentTo(target);
      setCooldown(COOLDOWN_SECONDS);
    } catch (err) {
      console.error("[forgot] 例外", err);
      setError("送出失敗，請重試一次。還是不行的話用 LINE 跟我們說。");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const target = email.trim();
    if (!EMAIL_RE.test(target)) {
      setError("Email 格式看起來不太對，請再檢查一次。");
      return;
    }
    await send(target);
  }

  /* --------------------------------------------------- 已送出的畫面 */

  if (sentTo) {
    return (
      <div
        ref={noticeRef}
        tabIndex={-1}
        className="rounded-card border border-sand-300 bg-cream-100 px-[22px] py-[26px] outline-none md:px-[36px] md:py-[34px]"
      >
        <h2 className="t-h2 text-brown-900">信寄出去了</h2>
        {/* ⚠️ 「如果…有註冊過」這個寫法是必要的：不論信箱存不存在，
            畫面都必須一模一樣，否則這裡就變成帳號枚舉的工具。 */}
        <p className="t-body mt-[14px] text-pretty text-brown-700">
          如果 <strong className="break-all font-semibold">{sentTo}</strong>{" "}
          有註冊過，我們已經寄了一封信過去。打開信，按裡面那顆「設定新密碼」的按鈕就可以了。
        </p>

        <h3 className="t-h3 mt-[24px] text-brown-900">沒收到嗎</h3>
        <ul className="t-body mt-[10px] flex flex-col gap-[8px] text-brown-700">
          <li>・先看看「垃圾郵件」那一夾。</li>
          <li>・信可能要等一到兩分鐘。</li>
          <li>
            ・
            <strong className="font-semibold">如果你按了兩次，請用最新的那一封</strong>
            ，舊的那封會失效。
          </li>
        </ul>

        <button
          type="button"
          disabled={cooldown > 0 || busy}
          onClick={() => void send(sentTo)}
          className={buttonClass({
            variant: cooldown > 0 || busy ? "disabled" : "outline",
            size: "lg",
            fullWidth: true,
            className: "mt-[22px] sm:w-auto",
          })}
        >
          {cooldown > 0 ? `還要等 ${cooldown} 秒` : busy ? "寄送中…" : "再寄一次"}
        </button>

        <p className="t-body-sm mt-[20px] text-pretty text-brown-500">
          還是不行的話，
          <a
            href={SITE.lineHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-caramel-dk hover:underline"
          >
            用 LINE 問我們
            <span className="sr-only">（會開啟 LINE）</span>
          </a>
          ，報一下你的名字就好。
        </p>
      </div>
    );
  }

  /* ------------------------------------------------------- 輸入畫面 */

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
        label="你的 Email"
        name="email"
        type="email"
        inputMode="email"
        required
        autoComplete="email"
        value={email}
        onChange={setEmail}
        hint="就是你買課的時候填的那一個"
      />

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
          {busy ? "寄送中…" : "寄設定密碼的信給我"}
        </button>
      </div>

      <p className="t-body-sm text-pretty text-brown-500">
        不記得當初用哪個信箱嗎？
        <a
          href={SITE.lineHref}
          target="_blank"
          rel="noopener noreferrer"
          className="text-caramel-dk hover:underline"
        >
          用 LINE 問我們
          <span className="sr-only">（會開啟 LINE）</span>
        </a>
        ，報你的名字和手機號碼就好，我們幫你查。
      </p>
    </form>
  );
}
