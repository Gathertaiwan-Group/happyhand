/**
 * 課程／工作坊後台的共用型別、標籤與驗證。
 *
 * 刻意純資料 + 純函式（零 IO、零 next/*、零 supabase）：
 * 頁面、server action 與 client 端的單元編輯器都 import 得動，
 * 驗證規則不會在三個地方各長各的。
 */

/* ------------------------------------------------------------ 商品類型 */

/**
 * ⚠️ products.type 是 Postgres enum `public.product_type`，不是 text + check。
 *    這裡的字串必須與 20260808000001_init.sql:38 的 enum 值一字不差，
 *    寫錯不會被 check 擋成中文訊息，而是 22P02 invalid input value。
 */
export const PRODUCT_TYPES = ["course", "workshop", "subscription"] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const PRODUCT_TYPE_LABEL: Record<ProductType, string> = {
  course: "線上課程",
  workshop: "工作坊",
  subscription: "訂閱制",
};

export function toProductType(value: string | null | undefined): ProductType {
  return (PRODUCT_TYPES as readonly string[]).includes(value ?? "")
    ? (value as ProductType)
    : "course";
}

/* ------------------------------------------------------------ 場次狀態 */

/**
 * workshop_sessions.status 是 text + check（不是 enum），
 * 但真正管這欄的是 trigger `trg_workshop_sessions_status`：
 * 只要寫入值是 open 或 full，`sync_workshop_session_status()` 會依
 * seats_taken >= capacity 直接覆寫成 full 或 open。
 * 所以「已額滿」是系統算出來的結果，不是人可以選的選項 —— 見 SESSION_STATUS_CHOICES。
 */
export const SESSION_STATUSES = ["open", "full", "closed", "cancelled"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  open: "開放報名",
  full: "已額滿",
  closed: "停止報名",
  cancelled: "已取消",
};

/** 人可以選的狀態。full 不在內：它由 trigger 依名額自動判定。 */
export const SESSION_STATUS_CHOICES = ["open", "closed", "cancelled"] as const;

export function toSessionStatus(value: string | null | undefined): SessionStatus {
  return (SESSION_STATUSES as readonly string[]).includes(value ?? "")
    ? (value as SessionStatus)
    : "open";
}

/* ------------------------------------------------------------------ 型別 */

export type ProductRow = {
  id: string;
  type: ProductType;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  price: number;
  compare_at_price: number | null;
  cover_url: string | null;
  is_published: boolean;
  is_featured: boolean;
  tags: string[];
  benefits: string[];
  sort_order: number;
  // 報名頁內容（migration 20260827000003）。留空前台就整塊不顯示。
  hero_lead: string | null;
  suitable_for: string[];
  not_suitable_for: string[];
  outcomes: string[];
  curriculum_online: string[];
  curriculum_onsite: string[];
  includes: string[];
  notes: string[];
  asks_intake: boolean;
};

export type LessonRow = {
  id: string;
  title: string;
  duration_sec: number | null;
  /** YouTube 影片 ID（11 碼）。影片改放 YouTube 之後 video_path 已停用。 */
  youtube_id: string | null;
  free_preview: boolean;
  body: string | null;
  sort_order: number;
  /** 巢狀撈進來的講義與插圖（見 app/admin/products/[id]/page.tsx 的 select） */
  lesson_materials?: {
    id: string;
    kind: "file" | "image";
    file_name: string;
    size_bytes: number;
    caption: string | null;
    sort_order: number;
  }[];
};

export type BlockRow = {
  id: string;
  kind: string;
  sort_order: number;
  title: string | null;
  body: string | null;
  meta: Record<string, unknown>;
};

export const BLOCK_KINDS = [
  "faq",
  "step",
  "info_row",
  "pricing",
  "feature",
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export type SessionRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  location: string | null;
  address: string | null;
  capacity: number;
  seats_taken: number;
  status: SessionStatus;
  // 梯次自己的名稱與價格（migration 20260827000003）
  title: string | null;
  summary: string | null;
  format: SessionFormat | null;
  /** null = 用 products.price。⚠️ 0 是合法價格，判斷時要用 != null 不能用 falsy */
  price: number | null;
  notes: string | null;
};

export const SESSION_FORMATS = ["onsite", "online", "hybrid"] as const;
export type SessionFormat = (typeof SESSION_FORMATS)[number];
export const SESSION_FORMAT_LABEL: Record<SessionFormat, string> = {
  onsite: "實體",
  online: "線上",
  hybrid: "線上＋實體",
};
export const SESSION_FORMAT_CHOICES = SESSION_FORMATS.map((v) => ({
  value: v,
  label: SESSION_FORMAT_LABEL[v],
}));

export function toSessionFormat(v: unknown): SessionFormat | null {
  return (SESSION_FORMATS as readonly string[]).includes(String(v))
    ? (v as SessionFormat)
    : null;
}

/* -------------------------------------------------------------- slug 驗證 */

export const SLUG_PATTERN = "[a-z0-9-]+";
const SLUG_RE = /^[a-z0-9-]+$/;
export const SLUG_MAX = 80;

/**
 * 網址代稱驗證。
 *
 * 前台是 /courses/[slug]，而且 generateStaticParams() 會把 slug 直接當成路徑段落。
 * 中文可以存進資料庫，但網址會變成一長串 percent-encoding，
 * 貼到 LINE 上看起來像亂碼，客服也沒辦法用嘴巴念給客人聽。
 *
 * 同一份規則在三個地方生效：
 *   1. <input pattern={SLUG_PATTERN}>  —— 瀏覽器原生擋，零 JavaScript
 *   2. 這支 isValidSlug()              —— server action 再擋一次
 *   3. products_slug_key               —— 資料庫的唯一約束擋重複
 * 只做第 1 層等於沒做：表單可以繞過，server action 也接受直接 POST。
 */
export function isValidSlug(slug: string): boolean {
  if (!slug || slug.length > SLUG_MAX) return false;
  return SLUG_RE.test(slug);
}

/* ------------------------------------------------------- text[] 欄位處理 */

export const LIST_ITEM_MAX = 60;
export const LIST_LENGTH_MAX = 20;

/**
 * 內容區塊清單（適合對象、學習成果、課程大綱…）的上限。
 *
 * 刻意跟 tags / benefits 那組分開：那兩個在前台渲染成 pill，超過 60 字會破版；
 * 但課程大綱像「26 個安全能量鎖的位置與意義」這種條目，60 字很快就不夠用，
 * 配套清單也常常超過 20 項。
 */
export const CONTENT_ITEM_MAX = 200;
export const CONTENT_LENGTH_MAX = 40;

/**
 * 一行一項的 textarea -> text[]。
 * 去掉前後空白與空行；使用者按 Enter 留白行是很自然的排版習慣，
 * 直接存進去前台就會冒出空的標籤 pill。
 */
export function linesToArray(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, LIST_LENGTH_MAX)
    .map((line) => line.slice(0, LIST_ITEM_MAX));
}

/**
 * 內容區塊用的版本，上限放寬（見 CONTENT_ITEM_MAX 的說明）。
 *
 * ⚠️ 跟 linesToArray 一樣是**靜默截斷** —— 超過上限不會回錯誤給使用者。
 *    上限訂得夠寬是刻意的，因為一個字都不能少的長文應該放 product_blocks
 *    的 body（那裡沒有長度限制），不是塞進條列。
 */
export function contentLinesToArray(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, CONTENT_LENGTH_MAX)
    .map((line) => line.slice(0, CONTENT_ITEM_MAX));
}

/** text[] -> textarea 的預設值 */
export function arrayToLines(values: readonly string[] | null | undefined): string {
  return (values ?? []).join("\n");
}

/* ---------------------------------------------------------------- 時長 */

/** 秒 -> 分/秒兩格輸入框的預設值 */
export function splitDuration(sec: number | null | undefined): { min: number; sec: number } {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) {
    return { min: 0, sec: 0 };
  }
  const whole = Math.floor(sec);
  return { min: Math.floor(whole / 60), sec: whole % 60 };
}

/** 分/秒 -> 秒。兩格都空白時回 null（course_lessons.duration_sec 可為 null）。 */
export function joinDuration(minRaw: string, secRaw: string): number | null {
  const minText = minRaw.trim();
  const secText = secRaw.trim();
  if (minText === "" && secText === "") return null;
  const min = Number(minText || "0");
  const sec = Number(secText || "0");
  if (!Number.isFinite(min) || !Number.isFinite(sec) || min < 0 || sec < 0) return null;
  return Math.floor(min) * 60 + Math.floor(sec);
}

/** 顯示用：90 -> "1:30"，null -> "—" */
export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "—";
  const { min, sec: rest } = splitDuration(sec);
  return `${min}:${String(rest).padStart(2, "0")}`;
}

/* ---------------------------------------------------------------- 金額 */

export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `NT$ ${value.toLocaleString("en-US")}`;
}

/**
 * 表單來的整數。空字串回 null（給 compare_at_price 這種可為 null 的欄位）。
 * 認不得的輸入回 undefined，呼叫端要當成驗證失敗，不要當成 0 ——
 * 把「abc」默默存成 0 元會變成免費的課。
 */
export function parseIntField(raw: string): number | null | undefined {
  const text = raw.trim();
  if (text === "") return null;
  if (!/^-?\d+$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

/* ------------------------------------------------------- searchParams */

export function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** 白名單，不在名單內一律回空字串（＝不篩選） */
export function pickOne(value: string | string[] | undefined, allowed: readonly string[]): string {
  const raw = firstValue(value);
  return allowed.includes(raw) ? raw : "";
}

/* --------------------------------------------------------- 表單回饋訊息 */

/**
 * server action 驗證失敗時是用 redirect 帶一個短代碼回來，由頁面翻成中文。
 *
 * 為什麼不把訊息文字直接放進網址：一來網址會很醜，
 * 二來那等於讓任何人都能構造一個顯示任意文字的後台畫面（釣魚）。
 * 只認這張表裡的代碼，認不得的一律當成沒有訊息。
 */
export const FORM_MESSAGES: Record<string, { tone: "ok" | "warn"; text: string }> = {
  saved: { tone: "ok", text: "已儲存。" },
  created: { tone: "ok", text: "課程已建立。可以繼續在下面編輯單元或場次。" },
  lessons_saved: { tone: "ok", text: "單元已儲存。" },
  session_saved: { tone: "ok", text: "場次已儲存。" },

  denied: { tone: "warn", text: "你的帳號沒有編輯課程的權限。" },
  notfound: { tone: "warn", text: "找不到這門課，可能已經被其他同事刪除了。" },
  slug_format: {
    tone: "warn",
    text: "網址代稱只能用小寫英文、數字與連字號（-），例如 jsj-beginner。",
  },
  slug_taken: { tone: "warn", text: "這個網址代稱已經有別的課在用了，請換一個。" },
  title_required: { tone: "warn", text: "請填課程名稱。" },
  price_invalid: { tone: "warn", text: "售價請填 0 或正整數，不要有逗號或小數點。" },
  compare_invalid: {
    tone: "warn",
    text: "原價必須大於或等於售價（原價是用來劃線顯示的），或留空不顯示。",
  },
  sort_invalid: { tone: "warn", text: "排序請填整數。" },
  type_invalid: { tone: "warn", text: "課程類型不正確。" },
  session_time_invalid: { tone: "warn", text: "請填正確的開始與結束時間，結束必須晚於開始。" },
  session_capacity_invalid: { tone: "warn", text: "名額請填 0 或正整數。" },
  session_price_invalid: {
    tone: "warn",
    text: "這一梯的價格請填 0 或正整數，或留空表示用課程定價。",
  },
  session_duplicate: {
    tone: "warn",
    text: "這門課已經有一場相同開始時間的場次了，同一時間不能開兩場。",
  },
  session_notfound: { tone: "warn", text: "找不到這個場次，可能已經被其他同事刪除了。" },
  failed: { tone: "warn", text: "儲存失敗，請重試一次。若持續失敗請截圖回報。" },
};

export function messageFor(code: string): { tone: "ok" | "warn"; text: string } | null {
  return FORM_MESSAGES[code] ?? null;
}
