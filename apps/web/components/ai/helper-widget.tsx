"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { SITE } from "@/lib/site";
import { useHelper } from "@/components/ai/helper-provider";
import { lockBodyScroll } from "@/lib/scroll-lock";

/**
 * 右下角 AI 小幫手。
 *
 * 設計上的三個前提：
 *   1. 客群 60–75 歲 → 字 17px 起跳、點擊區 44px 以上、不用圖示代替文字。
 *   2. **手機沒有浮動鈕**：入口在 SiteHeader 的漢堡抽屜底部（那裡本來就是求助區）。
 *      原本的浮動鈕會壓在 /account 的底部分頁列與課程卡上。
 *      桌機保留浮動鈕 —— 那裡沒有東西跟它搶位置。
 *   3. 小幫手不是必要功能 → 後端掛掉時它自己會說「用 LINE 問我們」，
 *      不會出現壞掉的轉圈圈或紅色錯誤。
 */

type Msg = { role: "user" | "model"; text: string };

const GREETING =
  "你好，我是快樂手的小幫手。想知道哪一門課適合你、怎麼上課、怎麼付款，都可以問我。";

const STARTERS = [
  "我沒有基礎可以學嗎？",
  "有哪些課程？",
  "最近的工作坊是什麼時候？",
  "可以怎麼付款？",
];

/** 一段對話一個 id，關掉分頁就換一段新的 */
function useSessionId() {
  const [id, setId] = useState("");
  useEffect(() => {
    try {
      const KEY = "happyhands.helper.session";
      let v = window.sessionStorage.getItem(KEY);
      if (!v) {
        v = crypto.randomUUID();
        window.sessionStorage.setItem(KEY, v);
      }
      setId(v);
    } catch {
      // 無痕模式等等讀不到 sessionStorage：照樣能聊，只是後台記錄不到
    }
  }, []);
  return id;
}

/**
 * 把回覆裡的網址變成可以點的連結。
 *
 * 🔴 只放行「本站網址」與「我們自己的 LINE」。模型有可能生出不存在的網址，
 *    或被對話內容誘導吐出外部連結；把那種東西渲染成可點的連結，等於幫忙
 *    把客人送去我們無法保證的地方。認不得的網址就當純文字顯示。
 */
function renderWithLinks(text: string) {
  const base = SITE.url.replace(/\/$/, "");
  const allowed = [base, SITE.lineHref];
  const parts = text.split(/(https?:\/\/[^\s，。、）)]+)/g);

  return parts.map((part, i) => {
    if (!/^https?:\/\//.test(part)) return <span key={i}>{part}</span>;
    const ok = allowed.some((a) => part === a || part.startsWith(`${a}/`));
    if (!ok) return <span key={i}>{part}</span>;

    const external = part.startsWith(SITE.lineHref);
    // 同站連結改成相對路徑：客人可能是從舊的 vercel.app 網址進來的，
    // 寫死正式網域會把他丟到另一個 origin（購物車在 localStorage，會不見）。
    const href = external ? part : part.slice(base.length) || "/";
    return (
      <a
        key={i}
        href={href}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        className="font-medium text-caramel-dk underline underline-offset-[3px]"
      >
        {external ? "用 LINE 問我們" : href}
      </a>
    );
  });
}

export function HelperWidget() {
  const pathname = usePathname();
  const sessionId = useSessionId();

  // open 住在 provider，SiteHeader 的抽屜也要能打開它。其餘 state 留在這裡
  // —— draft 若上移，使用者每敲一個字整個前台樹都要重算 context。
  const { open, available, openHelper, closeHelper } = useHelper();
  const [msgs, setMsgs] = useState<Msg[]>([{ role: "model", text: GREETING }]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);

  // 新訊息捲到底
  useEffect(() => {
    bodyRef.current?.scrollTo({
      top: bodyRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [msgs, open]);

  // 開啟時：手機鎖背景捲動（桌機面板只佔右下角，不必鎖）、focus 到輸入框、Esc 關閉
  useEffect(() => {
    if (!open) return;
    // 共用的計數式鎖，不要自己存 prev ——
    // SiteHeader 的抽屜也在鎖，自存 prev 會把它的 "hidden" 記下來。見 lib/scroll-lock.ts
    const unlock = window.matchMedia("(max-width: 767px)").matches
      ? lockBodyScroll()
      : null;
    inputRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeHelper();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unlock?.();
      window.removeEventListener("keydown", onKey);
    };
    // closeHelper 在 provider 裡用 useCallback 包過，identity 穩定，不會讓這段反覆重跑
  }, [open, closeHelper]);

  /**
   * 關閉後把焦點還給當初叫出它的那顆按鈕，鍵盤使用者不會迷路。
   *
   * 🔴 wasOpen 這道不能省。open 初始就是 false，沒有它的話**每一次前台頁面
   *    載入焦點都會被搶到浮動鈕上**，鍵盤使用者一按 Tab 就直接跳出頁面。
   *    preventScroll 讓它看起來沒事，但 document.activeElement 是真的被改了。
   *
   * 🔴 判斷可見性不可以用 offsetParent —— 浮動鈕是 position:fixed，
   *    它的 offsetParent 永遠是 null。用 matchMedia。
   */
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    if (window.matchMedia("(min-width: 768px)").matches) {
      fabRef.current?.focus({ preventScroll: true });
    } else {
      // 手機沒有浮動鈕，焦點還給漢堡鈕
      document.getElementById("site-menu-button")?.focus({ preventScroll: true });
    }
  }, [open]);

  /**
   * 這一頁在 768–1279px 有沒有固定底部列會跟浮動鈕打架。
   *
   * 目前只有 /account/*：AccountBottomNav 是 lg:hidden（1280 以下都在），
   * 而 MobileActionBar / CourseBuyBar 都是 md:hidden（768 以上都不在），
   * 剛好跟浮動鈕的 md:flex 錯開。
   *
   * 88px = 60px 列高 + 1px 上框線 + 27px 呼吸。
   * 沒有這一段的話，900px 寬時浮動鈕會正好蓋掉「我的資料」那一格的右半 ——
   * 是真的擋到可點區域，不只是視覺重疊。
   */
  const overBottomNav =
    pathname === "/account" || pathname.startsWith("/account/");

  const send = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean || busy) return;

      // 先把使用者訊息放上去（樂觀更新），畫面立刻有反應
      const next: Msg[] = [...msgs, { role: "user", text: clean }];
      setMsgs(next);
      setDraft("");
      setBusy(true);

      try {
        const res = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            // 開場白是前端寫死的，不要送進模型上下文佔 token
            messages: next.filter((m, i) => !(i === 0 && m.role === "model")),
          }),
        });
        const data = (await res.json()) as { ok?: boolean; reply?: string };
        setMsgs((m) => [
          ...m,
          {
            role: "model",
            text:
              data.reply ||
              `不好意思，我這邊出了點問題。你可以用 LINE ${SITE.lineId} 直接問我們。`,
          },
        ]);
      } catch {
        setMsgs((m) => [
          ...m,
          {
            role: "model",
            text: `連線好像不太穩。你可以用 LINE ${SITE.lineId} 直接問我們，我們會盡快回覆。`,
          },
        ]);
      } finally {
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy, msgs, sessionId],
  );

  if (!available) return null;

  return (
    <>
      {/* 浮動鈕。手機（<768）不出現，入口在漢堡抽屜裡。 */}
      {!open && (
        <button
          ref={fabRef}
          type="button"
          aria-haspopup="dialog"
          onClick={openHelper}
          aria-label="有問題？問小幫手"
          className={`fixed right-[16px] z-40 hidden h-[76px] w-[76px] flex-col items-center justify-center gap-[2px] rounded-[24px] bg-caramel-ink text-[16px] leading-[1.3] font-medium text-white shadow-[0_6px_20px_rgba(74,53,36,0.28)] transition-colors duration-200 hover:bg-caramel-dk md:flex ${
            overBottomNav
              ? "bottom-[calc(88px+env(safe-area-inset-bottom))] lg:bottom-[20px]"
              : "bottom-[20px]"
          }`}
        >
          <ChatIcon className="h-[24px] w-[24px] shrink-0" />
          <span aria-hidden="true">問小幫手</span>
        </button>
      )}

      {open && (
        <>
          {/* 手機是全螢幕面板，桌機不需要遮罩，但要有一層擋住誤點 */}
          <div
            className="fixed inset-0 z-40 bg-brown-900/25 md:hidden"
            onClick={() => closeHelper()}
            aria-hidden="true"
          />

          <section
            role="dialog"
            aria-modal="true"
            aria-label="快樂手小幫手"
            className="fixed inset-x-0 bottom-0 top-0 z-50 flex flex-col bg-cream-100 md:inset-auto md:right-[28px] md:bottom-[28px] md:top-auto md:h-[600px] md:max-h-[calc(100vh-80px)] md:w-[400px] md:rounded-card md:border md:border-sand-300 md:shadow-[0_16px_48px_rgba(74,53,36,0.24)]"
          >
            <header className="flex items-center gap-[12px] border-b border-sand-300 bg-white px-[16px] py-[14px] md:rounded-t-card">
              <ChatIcon className="h-[22px] w-[22px] shrink-0 text-caramel-ink" />
              <div className="min-w-0 flex-1">
                <p className="text-[17px] font-medium text-brown-900">快樂手小幫手</p>
                <p className="text-[14px] text-brown-500">
                  由 AI 回答，複雜的問題會請真人接手
                </p>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={() => closeHelper()}
                aria-label="關閉小幫手"
                className="-mr-[8px] flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full text-[20px] text-brown-500 transition-colors duration-200 hover:bg-cream-400 hover:text-brown-900"
              >
                ✕
              </button>
            </header>

            <div
              ref={bodyRef}
              className="flex-1 overflow-y-auto px-[16px] py-[16px]"
            >
              <ul className="flex flex-col gap-[12px]">
                {msgs.map((m, i) => (
                  <li
                    key={i}
                    className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
                  >
                    <p
                      className={
                        m.role === "user"
                          ? "max-w-[85%] whitespace-pre-wrap rounded-card bg-caramel-ink px-[14px] py-[10px] text-[17px] leading-[1.7] text-white"
                          : "max-w-[90%] whitespace-pre-wrap rounded-card bg-white px-[14px] py-[10px] text-[17px] leading-[1.7] text-brown-900"
                      }
                    >
                      {m.role === "model" ? renderWithLinks(m.text) : m.text}
                    </p>
                  </li>
                ))}
              </ul>

              {/* 讀屏軟體要聽得到新回覆。
                  ⚠️ 只唸小幫手的話，不要唸 msgs 的最後一則 —— 那樣會把使用者
                  自己剛打完的字再唸一次給他聽。 */}
              <p role="status" aria-live="polite" className="sr-only">
                {busy
                  ? "小幫手正在回覆"
                  : ([...msgs].reverse().find((m) => m.role === "model")?.text ?? "")}
              </p>

              {busy && (
                <p className="mt-[12px] text-[15px] text-brown-300" aria-hidden="true">
                  小幫手正在想…
                </p>
              )}

              {/* 只有第一次（還沒問過任何問題）才給建議問題 */}
              {msgs.length === 1 && !busy && (
                <div className="mt-[16px] flex flex-col gap-[8px]">
                  <p className="text-[15px] text-brown-500">可以這樣問：</p>
                  {STARTERS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void send(s)}
                      className="min-h-[44px] rounded-input border border-sand-400 bg-white px-[14px] py-[10px] text-left text-[17px] text-brown-900 transition-colors duration-200 hover:border-caramel-ink hover:bg-cream-400"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send(draft);
              }}
              className="flex items-end gap-[8px] border-t border-sand-300 bg-white px-[12px] pb-[calc(12px+env(safe-area-inset-bottom))] pt-[12px] md:rounded-b-card md:pb-[12px]"
            >
              <label htmlFor="helper-input" className="sr-only">
                想問什麼都可以
              </label>
              <input
                ref={inputRef}
                id="helper-input"
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={800}
                autoComplete="off"
                placeholder="想問什麼都可以…"
                disabled={busy}
                className="min-h-[48px] flex-1 rounded-input border border-sand-400 bg-white px-[14px] text-[17px] text-brown-900 placeholder:text-brown-300 focus:border-caramel-ink focus:outline-none disabled:bg-cream-400"
              />
              <button
                type="submit"
                disabled={busy || !draft.trim()}
                className="min-h-[48px] shrink-0 rounded-input bg-caramel-ink px-[18px] text-[17px] font-medium text-white transition-colors duration-200 hover:bg-caramel-dk disabled:bg-sand-400"
              >
                送出
              </button>
            </form>
          </section>
        </>
      )}
    </>
  );
}

function ChatIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}
