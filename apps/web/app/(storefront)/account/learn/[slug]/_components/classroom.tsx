"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Check, Clock, Infinity as InfinityIcon } from "lucide-react";
import { formatClock } from "@/components/account/youtube-api";
import { LessonPlayer } from "./player";
import { LessonContent } from "./lesson-content";

/**
 * 上課教室。
 *
 * 版面照台灣四家平台的一致慣例：
 *   桌機 → 播放器在左（主區），單元列表在右側欄
 *   手機 → 播放器在上，單元列表在下方
 *
 * 為 60–75 歲客群改的地方：
 * ・單元列表字級 18px、每列高 ≥64px
 * ・目前播放的單元用「整列底色 + 左側粗色條 + 加粗字」，
 *   不是 Hahow 那樣只把文字變綠（遠看根本分不出來）
 * ・「下一堂課 →」是整寬大按鈕**而且帶課名文字**，不是只有箭頭
 * ・進度用完整句子，不用百分比也不用 3/12
 * ・沒有手動「標記完成」按鈕（台灣四家也都沒有，而且長輩不會去找它）
 *
 * 完成狀態存在 client state：播完當下就打勾，不用等重新整理。
 * server 那邊由 /api/progress 寫入，兩邊是各自獨立的 —— 就算網路寫入失敗，
 * 畫面也不會騙人太久（重新整理就會回到真實狀態）。
 */

export type ClassroomLesson = {
  id: string;
  title: string;
  durationSec: number | null;
  freePreview: boolean;
  completed: boolean;
  hasVideo: boolean;
};

export function Classroom({
  courseTitle,
  lessons,
  initialLessonId,
  watermark,
}: {
  courseTitle: string;
  lessons: ClassroomLesson[];
  initialLessonId: string;
  watermark: string | null;
}) {
  const [currentId, setCurrentId] = useState(initialLessonId);
  const [doneIds, setDoneIds] = useState<Set<string>>(
    () => new Set(lessons.filter((l) => l.completed).map((l) => l.id)),
  );

  const handleCompleted = useCallback((lessonId: string) => {
    setDoneIds((prev) => {
      if (prev.has(lessonId)) return prev;
      const next = new Set(prev);
      next.add(lessonId);
      return next;
    });
  }, []);

  const currentIndex = lessons.findIndex((l) => l.id === currentId);
  const current = lessons[currentIndex] ?? lessons[0];
  const next = currentIndex >= 0 ? lessons[currentIndex + 1] : undefined;

  const summary = useMemo(() => {
    const done = lessons.filter((l) => doneIds.has(l.id)).length;
    const left = lessons.length - done;
    if (done === 0) return `這門課有 ${lessons.length} 堂，還沒開始。`;
    if (left === 0) return `這門課 ${lessons.length} 堂你都上完了，隨時可以再看一次。`;
    return `你已經上完 ${done} 堂，還有 ${left} 堂。`;
  }, [lessons, doneIds]);

  if (!current) return null;

  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-[32px]">
      {/* --- 主區：播放器 --- */}
      <div className="min-w-0">
        <LessonPlayer
          key={current.id}
          lessonId={current.id}
          lessonTitle={current.title}
          watermark={watermark}
          onCompleted={handleCompleted}
        />

        {/* 文字說明、插圖、可下載的講義。三塊都空的話整區不出現。
            key 跟播放器一樣掛 current.id：換單元時要整個重來，
            不然會看到上一堂的內容停在畫面上。 */}
        <LessonContent key={`content-${current.id}`} lessonId={current.id} />

        {/* 「下一堂課」帶課名。長輩看不懂純箭頭，需要文字。 */}
        {next ? (
          <button
            type="button"
            onClick={() => {
              setCurrentId(next.id);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            className="mt-[20px] flex min-h-[64px] w-full items-center justify-between gap-[16px] rounded-card border-2 border-sand-400 px-[22px] py-[14px] text-left transition-colors hover:bg-cream-100"
          >
            <span>
              <span className="block text-[15px] text-brown-500">下一堂課</span>
              <span className="block text-[19px] text-brown-900">{next.title}</span>
            </span>
            <span aria-hidden="true" className="text-[24px] text-caramel-ink">
              →
            </span>
          </button>
        ) : (
          <div className="mt-[20px] rounded-card bg-cream-100 px-[22px] py-[20px]">
            <p className="t-body text-brown-900">
              這是最後一堂了，想複習就從單元清單挑一堂。
            </p>
          </div>
        )}
      </div>

      {/* --- 側欄：單元列表 --- */}
      <aside className="mt-[28px] lg:mt-0">
        <div className="lg:sticky lg:top-[100px]">
          <div className="rounded-card border border-sand-300 bg-white">
            <div className="border-b border-sand-300 px-[20px] py-[16px]">
              <h2 className="t-h3 text-brown-900">課程單元</h2>
              <p className="t-body-sm mt-[4px] text-brown-700">{summary}</p>
            </div>

            <ol className="flex flex-col">
              {lessons.map((lesson, index) => {
                const isCurrent = lesson.id === current.id;
                const isDone = doneIds.has(lesson.id);
                return (
                  <li key={lesson.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setCurrentId(lesson.id);
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                      aria-current={isCurrent ? "true" : undefined}
                      className={`flex min-h-[64px] w-full items-center gap-[12px] border-l-[5px] px-[16px] py-[12px] text-left transition-colors ${
                        isCurrent
                          ? "border-caramel-ink bg-cream-100 font-semibold text-brown-900"
                          : "border-transparent text-brown-700 hover:bg-cream-100"
                      }`}
                    >
                      {/* 打勾要大、要有底色。細線圖示長輩看不到。 */}
                      <span
                        aria-hidden="true"
                        className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full text-[16px] ${
                          isDone
                            ? "bg-[#3f6b4a] text-white"
                            : "border border-sand-400 text-brown-300"
                        }`}
                      >
                        {isDone ? <Check strokeWidth={2.6} className="h-[18px] w-[18px]" /> : index + 1}
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="block text-[18px] leading-snug">
                          {lesson.title}
                        </span>
                        <span className="mt-[2px] flex flex-wrap items-center gap-x-[8px] text-[15px] text-brown-500">
                          {lesson.durationSec ? (
                            <span className="inline-flex items-center gap-[4px]">
                              <Clock aria-hidden="true" strokeWidth={1.8} className="h-[15px] w-[15px]" />
                              <span className="sr-only">長度</span>
                              {formatClock(lesson.durationSec)}
                            </span>
                          ) : null}
                          {isDone && <span className="text-[#3f6b4a]">已上完</span>}
                          {!lesson.hasVideo && <span>影片準備中</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>

          <p className="t-body-sm mt-[16px] text-pretty text-brown-500">
            <InfinityIcon aria-hidden="true" strokeWidth={1.8} className="mr-[6px] inline h-[18px] w-[18px] align-[-3px] text-caramel-dk" />
            <span className="sr-only">{courseTitle}</span>
            不限次數・沒有觀看期限。
            <Link href="/account" className="ml-[4px] text-caramel-dk hover:underline">
              回我的學習
            </Link>
          </p>
        </div>
      </aside>
    </div>
  );
}
