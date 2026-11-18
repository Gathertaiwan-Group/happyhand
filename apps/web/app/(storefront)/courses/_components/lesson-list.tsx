"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { Lesson } from "@/lib/content";
import { loadYouTubeApi, type YTPlayer } from "@/components/account/youtube-api";
import { formatDuration } from "./format";

const INITIAL_COUNT = 4;

/**
 * 單元列表 accordion（設計稿 365–383 桌機、431–445 手機）
 * 預設顯示 4 堂，其餘收在「展開其餘 N 堂」後面。
 *
 * 「可試看」的單元原本只是一顆沒有作用的標籤 —— 看得到吃不到，
 * 對轉換率是負面的。現在它是真的可以按的按鈕，就地展開播放器。
 *
 * 試看走的是**跟正式課程完全同一支** endpoint（/api/lessons/[id]/video），
 * 只是那支對 free_preview = true 的單元不查 entitlement。
 * 另外開一支公開的 endpoint 會變成第二個要維護的權限邊界，
 * 而權限邊界只要有兩個，遲早會有一個忘記更新。
 */
export function LessonList({ lessons }: { lessons: Lesson[] }) {
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const listId = useId();

  const rest = Math.max(0, lessons.length - INITIAL_COUNT);
  const visible = open ? lessons : lessons.slice(0, INITIAL_COUNT);

  return (
    <div className="mt-[14px] border-t border-sand-300 md:mt-[18px]">
      <ol id={listId}>
        {visible.map((lesson, i) => {
          const canPreview = Boolean(lesson.free_preview && lesson.id);
          const isPlaying = playing === lesson.id;

          return (
            <li
              key={lesson.id ?? `${lesson.title}-${i}`}
              className="border-b border-sand-300"
            >
              <div className="flex items-center justify-between gap-[12px] px-[20px] py-[18px] md:px-[24px] md:py-[20px]">
                <div className="flex min-w-0 flex-1 items-center gap-[10px] md:gap-[14px]">
                  <span
                    aria-hidden
                    className="shrink-0 font-serif text-[16px] text-brown-500 md:text-[18px]"
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-[10px] gap-y-[6px]">
                    <span className="text-[17px] leading-[1.5] text-brown-900 md:text-[18px]">
                      {lesson.title}
                    </span>
                    {canPreview ? (
                      <button
                        type="button"
                        onClick={() =>
                          setPlaying(isPlaying ? null : (lesson.id ?? null))
                        }
                        aria-expanded={isPlaying}
                        className="-my-[7px] inline-flex min-h-[44px] items-center rounded-pill bg-caramel-dk px-[14px] py-[4px] text-[16px] leading-[1.4] text-white transition-opacity hover:opacity-90"
                      >
                        {isPlaying ? "收起試看" : "免費試看 ▶"}
                      </button>
                    ) : lesson.free_preview ? (
                      <span className="rounded-pill bg-caramel-dk px-[12px] py-[4px] text-[16px] leading-[1.4] text-white">
                        可試看
                      </span>
                    ) : null}
                  </span>
                </div>
                <span className="shrink-0 text-[16px] text-brown-500">
                  {formatDuration(lesson.duration_sec)}
                </span>
              </div>

              {isPlaying && lesson.id && (
                <div className="px-[20px] pb-[20px] md:px-[24px]">
                  <PreviewPlayer lessonId={lesson.id} />
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {rest > 0 ? (
        <div className="text-center">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={listId}
            className="inline-flex min-h-[56px] items-center gap-[8px] px-[12px] text-[17px] text-brown-900 transition-colors duration-200 hover:text-caramel-dk"
          >
            <span className="border-b border-caramel pb-[4px]">
              {open ? "收合單元列表" : `展開其餘 ${rest} 堂`}
            </span>
            <span
              aria-hidden
              className="text-caramel-ink transition-transform duration-200"
              style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
            >
              ▾
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 試看播放器。
 *
 * 比教室裡那支簡單很多：不記進度（試看的人多半還沒有帳號）、
 * 不做續播、不放浮水印。
 */
function PreviewPlayer({ lessonId }: { lessonId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setVideoId(null);

    fetch(`/api/lessons/${lessonId}/video`, { method: "POST" })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as {
          videoId?: string;
          message?: string;
        };
        if (cancelled) return;
        if (!res.ok || !body.videoId) {
          setError(body.message ?? "影片讀不到，請重新整理後再試一次。");
          return;
        }
        setVideoId(body.videoId);
      })
      .catch(() => {
        if (!cancelled) setError("影片讀不到，請重新整理後再試一次。");
      });

    return () => {
      cancelled = true;
    };
  }, [lessonId]);

  useEffect(() => {
    if (!videoId) return;
    let cancelled = false;
    let player: YTPlayer | null = null;

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !mountRef.current) return;
        player = new YT.Player(mountRef.current, {
          host: "https://www.youtube-nocookie.com",
          videoId,
          playerVars: {
            rel: 0,
            playsinline: 1,
            cc_lang_pref: "zh-Hant",
            enablejsapi: 1,
            origin: window.location.origin,
          },
        });
      })
      .catch(() => {
        if (!cancelled) setError("播放器載入失敗，請檢查網路後重新整理。");
      });

    return () => {
      cancelled = true;
      try {
        player?.destroy();
      } catch {
        // iframe 已被移除時 destroy 會丟錯，忽略
      }
    };
  }, [videoId]);

  return (
    // [&_iframe]:… 見 account/learn 的 player.tsx：YT.Player 會把掛載的 div
    // 換成帶固定寬高的 iframe，不強制撐滿的話播放器會縮在角落。
    <div className="relative aspect-video w-full overflow-hidden rounded-card bg-brown-900 [&_iframe]:absolute [&_iframe]:inset-0 [&_iframe]:h-full [&_iframe]:w-full">
      {videoId ? (
        <div ref={mountRef} className="h-full w-full" />
      ) : (
        <div className="flex h-full items-center justify-center px-[20px] text-center">
          <p
            role={error ? "alert" : undefined}
            className="text-[17px] leading-relaxed text-white/85"
          >
            {error ?? "影片載入中…"}
          </p>
        </div>
      )}
    </div>
  );
}
