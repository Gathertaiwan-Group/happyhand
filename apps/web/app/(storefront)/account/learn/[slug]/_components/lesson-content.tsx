"use client";

import { useEffect, useState } from "react";
import { SITE } from "@/lib/site";
import { Download } from "lucide-react";

/**
 * 影片下方的課程內容：文字說明、插圖、可下載的講義。
 *
 * 🔴 為什麼要打 API 而不是讓 server 頁面直接帶下來：
 *    講義與插圖存在**私有** bucket，網址是短效期的簽章網址，只有
 *    /api/lessons/[id]/materials 在驗過 entitlement 之後才發得出來。
 *    這跟影片 ID 是同一道付費牆的兩個出口（授權共用 lib/account/lesson-access.ts）。
 *
 * 文字（body）也一起從那支回：它同樣是賣出去的內容，走同一道門就只有
 * 一個判斷要維護。
 *
 * ⚠️ 圖片用原生 <img> 不用 next/image：簽章網址每次都不一樣（帶 token），
 *    next/image 會把每一個當成新來源重新最佳化，快取永遠打不中，
 *    而且網址過期後最佳化後的圖也跟著壞掉。
 */

type Material = {
  id: string;
  kind: "file" | "image";
  fileName: string;
  sizeBytes: number;
  caption: string | null;
  url: string;
};

type State =
  | { status: "loading" }
  | { status: "ready"; body: string | null; materials: Material[] }
  | { status: "error"; message: string };

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function LessonContent({ lessonId }: { lessonId: string }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    (async () => {
      try {
        const res = await fetch(`/api/lessons/${lessonId}/materials`, {
          method: "POST",
        });
        const data = (await res.json()) as {
          body?: string | null;
          materials?: Material[];
          message?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setState({
            status: "error",
            message: data.message ?? "課程內容讀不出來，請重新整理一次。",
          });
          return;
        }
        setState({
          status: "ready",
          body: data.body ?? null,
          materials: data.materials ?? [],
        });
      } catch {
        if (!cancelled) {
          setState({
            status: "error",
            message: "連線好像不太穩，重新整理一次就好。",
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lessonId]);

  if (state.status === "loading") {
    // 不放骨架動畫：這一區常常是空的（老師沒填），骨架閃一下再消失
    // 反而像壞掉。安靜等就好。
    return null;
  }

  if (state.status === "error") {
    return (
      <p
        role="alert"
        className="mt-[24px] rounded-card bg-cream-100 px-[16px] py-[14px] text-[17px] text-brown-700"
      >
        {state.message}
        <br />
        還是不行的話用 LINE {SITE.lineId} 跟我們說一聲。
      </p>
    );
  }

  const paragraphs = (state.body ?? "")
    // 容忍 CRLF：存檔時已經正規化成 LF，但先前存進去的舊資料還是 \r\n。
    // 只靠 /\n{2,}/ 的話那些會整篇擠成一段。
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const images = state.materials.filter((m) => m.kind === "image");
  const files = state.materials.filter((m) => m.kind === "file");

  // 三塊都空的話整區不出現，不要留一個空標題
  if (paragraphs.length === 0 && images.length === 0 && files.length === 0) {
    return null;
  }

  return (
    <div className="mt-[28px] flex flex-col gap-[24px]">
      {paragraphs.length > 0 && (
        <div className="flex flex-col gap-[14px]">
          {paragraphs.map((p, i) => (
            // whitespace-pre-line：段落內的單行換行也要保留，
            // 老師常常用換行來斷句，不是每一次換行都想分段。
            <p
              key={i}
              className="t-body whitespace-pre-line text-pretty text-brown-700"
            >
              {p}
            </p>
          ))}
        </div>
      )}

      {images.length > 0 && (
        <ul className="flex flex-col gap-[16px]">
          {images.map((m) => (
            <li key={m.id}>
              {/* eslint-disable-next-line @next/next/no-img-element -- 簽章網址不能走 next/image，見檔頭 */}
              <img
                src={m.url}
                alt={m.caption || m.fileName}
                loading="lazy"
                className="w-full rounded-card"
              />
              {m.caption && (
                <p className="t-caption mt-[8px] text-brown-500">{m.caption}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {files.length > 0 && (
        <section
          aria-labelledby={`materials-${lessonId}`}
          className="rounded-card bg-cream-100 p-[20px]"
        >
          <h3
            id={`materials-${lessonId}`}
            className="t-h3 text-brown-900"
          >
            這一堂的課程文件
          </h3>
          <ul className="mt-[12px] flex flex-col gap-[10px]">
            {files.map((m) => (
              <li key={m.id}>
                {/* 簽章網址是站外的 storage host，要自己帶 rel。
                    下載屬性由 server 端簽的時候就設好了（?download=檔名）。 */}
                <a
                  href={m.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-[56px] items-center gap-[12px] rounded-input bg-white px-[16px] text-[17px] text-brown-900 transition-colors duration-200 hover:text-caramel-dk"
                >
                  <DownloadIcon className="h-[20px] w-[20px] shrink-0 text-caramel-ink" />
                  <span className="min-w-0 flex-1">{m.fileName}</span>
                  <span className="shrink-0 text-[15px] text-brown-500">
                    {formatBytes(m.sizeBytes)}
                  </span>
                  <span className="sr-only">（會下載檔案）</span>
                </a>
              </li>
            ))}
          </ul>
          <p className="t-caption mt-[12px] text-brown-500">
            連結有時效，失效就重新整理頁面。
          </p>
        </section>
      )}
    </div>
  );
}

function DownloadIcon({ className = "" }: { className?: string }) {
  return <Download aria-hidden="true" strokeWidth={1.8} className={className} />;
}
