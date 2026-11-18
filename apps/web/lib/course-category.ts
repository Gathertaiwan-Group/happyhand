/**
 * 前台的課程分類：預錄課程／線上直播／線下工作坊（業主 2026-11-18 定的三類）。
 *
 * 🔴 分類一律從「商品型態 + 場次的 format」算出來，不看後台的自由文字標籤。
 *    標籤是人手打的，寫錯是常態（例如線上直播課被標成「線上課程」、
 *    沒有任何場次的工作坊標成「線上課程」）。分類要是跟著標籤走，
 *    篩選鈕、卡片、導覽三個地方就會各說各話。
 *
 * 規則：
 *   - 預錄課程：type = course 或 subscription（買了就能看、可以回放）。
 *     course 就算另外掛了場次（例如讀脈入門課的混合班）仍然是預錄課程，
 *     那些場次照常出現在 /workshops 的場次列表裡。
 *   - 線上直播：type = workshop，且場次有 online 或 hybrid。
 *   - 線下工作坊：type = workshop，且場次有 onsite（含 null，見 session-format.ts）或 hybrid。
 *   - hybrid 兩類都算；一場都沒有的 workshop 歸線下工作坊（與 null 當實體同一個預設）。
 *
 * 場次用哪幾場來判斷見 lib/data.ts 的 sessionFormatsOf()。
 */
import type { ProductType } from "@/lib/content";
import { hasOnline, type SessionFormat } from "@/lib/session-format";

export type CourseCategory = "recorded" | "live" | "onsite";

export const CATEGORY_ORDER: CourseCategory[] = ["recorded", "live", "onsite"];

export const CATEGORY_LABEL: Record<CourseCategory, string> = {
  recorded: "預錄課程",
  live: "線上直播",
  onsite: "線下工作坊",
};

/**
 * 導覽列／頁尾的三個入口。
 *
 * 舊網址 /courses、/workshops 不變（也不轉址），只多帶一個篩選參數，
 * 由頁面上的篩選鈕在瀏覽器端套用 —— 伺服器不讀 searchParams，
 * 兩頁維持靜態 + ISR，不會因為多了參數變成每次請求都重算。
 */
export const CATEGORY_HREF: Record<CourseCategory, string> = {
  recorded: "/courses?cat=recorded",
  live: "/workshops?format=online",
  onsite: "/workshops?format=onsite",
};

/** 一門課屬於哪幾類。hybrid 的工作坊會同時回 live 與 onsite。 */
export function categoriesOf(p: {
  type: ProductType;
  sessionFormats?: SessionFormat[];
}): CourseCategory[] {
  if (p.type !== "workshop") return ["recorded"];
  const formats = p.sessionFormats ?? [];
  const cats: CourseCategory[] = [];
  if (formats.some(hasOnline)) cats.push("live");
  // 沒有任何場次 → 線下工作坊（null 當實體的同一個預設）
  if (formats.length === 0 || formats.some((f) => f !== "online")) {
    cats.push("onsite");
  }
  return cats;
}

/** 一個場次屬於哪幾類（/workshops 的篩選用）。 */
export function sessionCategories(f: SessionFormat): CourseCategory[] {
  if (f === "online") return ["live"];
  if (f === "hybrid") return ["live", "onsite"];
  return ["onsite"];
}

/**
 * 後台自由標籤裡「代表分類」的字眼。卡片上的分類由型態產生，
 * 這些字眼如果還照印，就會出現「線上直播・線上課程」這種自相矛盾的組合。
 * 比對前會去掉引號、標點與空白（實際資料有「「線上課程」」「線上課程，」這種寫法）。
 */
const CATEGORY_WORDS = new Set([
  "線上課程",
  "線上課",
  "預錄課程",
  "預錄課",
  "錄影課",
  "工作坊",
  "實體工作坊",
  "實體課",
  "實體課程",
  "線下工作坊",
  "線上直播",
  "直播",
  "直播課",
  "訂閱",
  "訂閱制",
]);

function normalizeTag(t: string): string {
  return t.replace(/[\s「」『』"'“”‘’，,。.、；;：:]/g, "");
}

export function isCategoryTag(tag: string): boolean {
  return CATEGORY_WORDS.has(normalizeTag(tag));
}

/** 卡片上的小標籤：分類（由型態產生）+ 其餘不是分類字眼的自由標籤。 */
export function cardTagLine(p: {
  type: ProductType;
  tags: string[];
  sessionFormats?: SessionFormat[];
}): string {
  const cats = categoriesOf(p).map((c) => CATEGORY_LABEL[c]);
  const rest = p.tags.filter((t) => t.trim() && !isCategoryTag(t));
  return [...cats, ...rest].join("・");
}

/**
 * 網址參數 → 篩選類別。新舊寫法都吃：
 *   ?cat=recorded|live|onsite（新）
 *   ?type=course|subscription|workshop（舊型態名；workshop 沒辦法再細分，回 null 顯示全部）
 *   ?format=online|onsite|hybrid（/workshops 用的寫法）
 */
export function categoryFromParams(
  get: (key: string) => string | null,
): CourseCategory | null {
  const cat = get("cat");
  if (cat === "recorded" || cat === "live" || cat === "onsite") return cat;
  const format = get("format");
  if (format === "online" || format === "live") return "live";
  if (format === "onsite" || format === "offline") return "onsite";
  const type = get("type");
  if (type === "course" || type === "subscription") return "recorded";
  return null;
}
