/**
 * 課程頁專用的時間格式化。
 * 設計稿用 `14:32` 這種冒號格式，但樂齡族看中文比較清楚，
 * 依需求改為「12 分 00 秒」。
 */

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/**
 * 單元時長：`12 分鐘`、`12 分 30 秒`、`1 小時 05 分`。
 * 2026-11-18：以前一律印到秒（「10 分 00 秒」），整數分鐘時那個「00 秒」只是雜訊；
 * 超過一小時也不必精確到秒。
 */
export function formatDuration(sec: number) {
  const total = Math.max(0, Math.round(sec));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} 小時 ${pad(minutes)} 分`;
  if (seconds === 0) return `${minutes} 分鐘`;
  return `${minutes} 分 ${pad(seconds)} 秒`;
}

/** 課程總長：`6 小時 40 分` / `48 分` */
export function formatTotalDuration(secs: number[]) {
  const totalMinutes = Math.floor(secs.reduce((a, b) => a + b, 0) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours} 小時 ${minutes} 分`;
  return `${minutes} 分`;
}
