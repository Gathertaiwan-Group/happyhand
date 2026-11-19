/**
 * 訂單顯示用的字典。
 *
 * ⚠️ 刻意不 import app/admin/orders/shared.ts 的 ORDER_STATUS_LABELS。
 *    那一份的用詞是給員工看的（「待收款」「已收款」是會計視角），
 *    客人看到「待收款」會想「誰要收我的錢？」。同一個 status，
 *    兩邊本來就該有不同的說法，共用只會讓其中一邊講錯話。
 */

import { BANK_TRANSFER_TEXT } from "@/lib/site";

export const ORDER_STATUS_TEXT: Record<
  string,
  { tone: "ok" | "wait" | "muted" | "danger"; label: string }
> = {
  pending: { tone: "wait", label: "等待付款" },
  paid: { tone: "ok", label: "已完成" },
  cancelled: { tone: "muted", label: "已取消" },
  refunded: { tone: "muted", label: "已退款" },
};

const PAYMENT_LABEL: Record<string, string> = {
  credit: "信用卡",
  atm: "ATM 轉帳",
  manual: "請我們代訂",
};

export function paymentLabel(method: string | null): string {
  if (!method) return "尚未選擇付款方式";
  return PAYMENT_LABEL[method] ?? method;
}

/** 台北時間的「2026 年 8 月 10 日」。長輩讀得懂的完整寫法，不用 8/10。 */
export function formatOrderDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/** 場次時間：「2026 年 9 月 12 日（六）14:00」 */
export function formatSessionTime(iso: string | null): string {
  if (!iso) return "時間待確認";
  try {
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * 依付款方式給「接下來要做什麼」。
 *
 * 這幾句是待付款訂單頁上最重要的內容 —— 客人點進來就是想知道
 * 「那我現在該幹嘛」。刻意不寫「請至超商繳費」之類我們還沒接的流程。
 */
export const NEXT_STEP: Record<string, string> = {
  atm: `請匯到 ${BANK_TRANSFER_TEXT}。匯款後用 LINE 跟我們說一聲，我們對帳完成就會開通，大約一個工作天。`,
  credit:
    "線上刷卡還在開通中，我們會用 LINE 跟你確認付款方式。現在還沒有跟你收款，請放心。",
  manual:
    "這一筆是請我們代訂的。我們會用 LINE 跟你確認課程與付款方式，你也可以直接用 LINE 找我們。",
};
