"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { SITE } from "@/lib/site";
import { authConfirmUrl } from "@/lib/auth/confirm-url";

/**
 * 登入／註冊表單。
 *
 * 這是 lib/supabase/client.ts 的第一個使用者——在此之前全站沒有任何
 * browser client 的引用。
 *
 * 註冊之後不會自動變成員工：角色由 handle_new_user() trigger 依
 * staff_invites 決定（20260810000001_staff_roles.sql）。沒被邀請的人
 * 註冊完就是一般會員，進 /admin 會被導回首頁。
 */

/** Supabase 的錯誤訊息是英文的，客群看不懂。 */
function mapAuthError(raw: string): string {
  const m = raw.toLowerCase();
  if (m.includes("invalid login credentials"))
    return "帳號或密碼不對，請再確認一次";
  if (m.includes("email not confirmed"))
    return "信箱還沒驗證。請到信箱收驗證信，點了連結之後再回來登入";
  if (m.includes("user already registered") || m.includes("already been registered"))
    return "這個信箱已經註冊過了，請直接登入";
  if (m.includes("password should be at least"))
    return "密碼至少要 10 個字";
  if (m.includes("unable to validate email") || m.includes("invalid format"))
    return "信箱格式看起來不對";
  if (m.includes("rate limit") || m.includes("too many"))
    return "嘗試次數太多，請等幾分鐘再試";
  if (m.includes("signups not allowed"))
    return "目前沒有開放註冊，請聯絡負責人";
  return `登入失敗：${raw}`;
}

/**
 * 只允許站內相對路徑。
 * 不擋的話 /login?redirect=https://evil.com 會變成開放轉址，
 * 攻擊者可以拿我們的網域當跳板做釣魚。
 * `//evil.com` 也要擋——瀏覽器會當成 protocol-relative 的絕對網址。
 */
function safeRedirect(raw: string | undefined): string {
  // 預設值是 /account 而不是 /admin：這個登入頁的使用者絕大多數是學員，
  // 員工來的時候一定是被 middleware 從 /admin/* 導過來的，會帶著 ?redirect=。
  // 反過來設 /admin 的話，學員自己點「登入」會被丟到後台再被踢回首頁，
  // 看起來就像登入失敗。
  if (!raw) return "/account";
  if (!raw.startsWith("/")) return "/account";
  if (raw.startsWith("//")) return "/account";
  return raw;
}

export function LoginForm({
  redirect,
  initialError,
}: {
  redirect?: string;
  /** /auth/callback 換 session 失敗時會把原因帶回來 */
  initialError?: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(initialError ?? "");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);

  const target = safeRedirect(redirect);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setInfo("");
    setLoading(true);

    try {
      const supabase = createClient();

      if (mode === "register") {
        const { data, error: err } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            // 驗證信的連結＝這個網址＋?token_hash=…&type=signup&next=/account（模板帶的）。
            // 三站共用一組信件模板，網域要由各站自己帶回來，見 lib/auth/confirm-url.ts。
            // 不指定的話會退回 site_url——合併後那是小時光的網域，客人點信會跑到別的網站。
            emailRedirectTo: authConfirmUrl(window.location.origin),
          },
        });
        if (err) throw new Error(mapAuthError(err.message));

        if (data.session) {
          router.push(target);
          router.refresh();
        } else {
          // 有開信箱驗證時走這條：這時候還沒有 session
          setInfo(
            "註冊成功。我們寄了一封驗證信到你的信箱，點了裡面的連結之後再回來登入。",
          );
          setMode("login");
          setPassword("");
        }
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (err) throw new Error(mapAuthError(err.message));
        router.push(target);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "發生未預期的錯誤，請重試");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[460px]">
      <div className="mb-[24px] grid grid-cols-2 gap-[8px] rounded-pill bg-cream-100 p-[6px]">
        {(["login", "register"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setError("");
              setInfo("");
            }}
            aria-pressed={mode === m}
            className={`min-h-[48px] rounded-pill text-[17px] transition-colors duration-200 ${
              mode === m
                ? "bg-caramel-dk text-white"
                : "text-brown-500 hover:text-brown-900"
            }`}
          >
            {m === "login" ? "登入" : "第一次使用"}
          </button>
        ))}
      </div>

      {info && (
        <p
          role="status"
          className="mb-[20px] rounded-input bg-cream-100 px-[18px] py-[16px] text-[16px] leading-[1.8] text-brown-700"
        >
          {info}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mb-[20px] rounded-input border border-error px-[18px] py-[16px] text-[16px] leading-[1.8] text-error"
        >
          {error}
        </p>
      )}

      <form onSubmit={submit} className="space-y-[20px]">
        <Field
          label="電子信箱"
          name="email"
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={setEmail}
        />
        <Field
          label="密碼"
          name="password"
          type="password"
          required
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          value={password}
          onChange={setPassword}
          hint={mode === "register" ? "至少 10 個字" : undefined}
        />

        <Button
          type="submit"
          variant={loading ? "disabled" : "primary"}
          fullWidth
          disabled={loading}
          aria-busy={loading}
        >
          {loading ? "處理中…" : mode === "login" ? "登入" : "建立帳號"}
        </Button>
      </form>

      {/* 忘記密碼只在登入模式顯示：註冊模式下它沒有意義，
          而多一個看不懂的選項對長輩就是多一個卡住的地方。
          用 <Link> 而不是 <a>，切頁不用重新載入整個站。 */}
      {mode === "login" && (
        <p className="mt-[18px] text-center">
          <Link
            href="/forgot-password"
            className="inline-block min-h-[44px] py-[11px] text-[17px] text-caramel-dk underline underline-offset-4 hover:text-brown-900"
          >
            忘記密碼？
          </Link>
        </p>
      )}

      <p className="mt-[20px] text-center text-[16px] leading-[1.9] text-brown-500">
        登入有問題嗎？
        <a
          href={SITE.lineHref}
          target="_blank"
          rel="noopener noreferrer"
          className="-my-[7px] inline-block py-[11px] whitespace-nowrap text-brown-700 underline underline-offset-4 hover:text-caramel-dk"
        >
          用 LINE 問我們
          <span className="sr-only">（會開啟 LINE）</span>
        </a>
      </p>
    </div>
  );
}
