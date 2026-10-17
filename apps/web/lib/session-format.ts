/**
 * 場次的上課形式（實體／線上／混合）—— 給客人看的那一側。
 *
 * 後台用的是 app/admin/products/shared.ts 的 SESSION_FORMATS／toSessionFormat，
 * 那邊 null 代表「未指定」。這裡是前台、信件、AI 小幫手、會員頁共用的語意層，
 * 所有「這一場在哪裡上課」的文字都從這裡取 —— 不然很容易變成前台寫「線上」、
 * 提醒信卻照樣寄出台北教室的地址。
 *
 * 為什麼要有這一層：以前後台就能把場次設成「線上」，但前台、信件、AI 全都
 * 沒讀這個欄位。管理員選了線上、存成功了，網站上一個字都不會變，還照樣附
 * 台北教室的地圖、寫「你空手來就行」。
 *
 * 🔴 null（未指定）一律當實體。這個欄位加進來之前的場次全都是實體課，而且
 *    後台的預設值就是「未指定」—— 如果把 null 當成「不知道」而不顯示地點，
 *    每一場舊的實體課會突然沒有地址。
 */

export type SessionFormat = "onsite" | "online" | "hybrid";

export function normalizeFormat(v: unknown): SessionFormat {
  return v === "online" || v === "hybrid" ? v : "onsite";
}

/** 有沒有線上的成分（純線上或混合）。 */
export function hasOnline(f: SessionFormat): boolean {
  return f === "online" || f === "hybrid";
}

/** 場次旁邊的小標籤。實體不標 —— 那是預設，每一列都標只是雜訊。 */
export function formatTag(f: SessionFormat): string | null {
  if (f === "online") return "線上";
  if (f === "hybrid") return "線上＋實體";
  return null;
}

/**
 * 給客人看的「在哪裡上課」一句話。
 *
 * 純線上時**忽略 location** —— 管理員可能填「ON LINE」、可能留空，兩種都不該
 * 照印出來（留空的話以前會印成「・09:00–17:00」，前面少一截）。
 */
export function placeText(f: SessionFormat, location: string | null | undefined): string {
  const loc = location?.trim() ?? "";
  if (f === "online") return "線上上課";
  if (f === "hybrid") return loc ? `${loc}（也可以線上參加）` : "線上＋實體";
  return loc;
}

/**
 * 線上場次一定要附的一句話：連結怎麼來、沒收到怎麼辦。
 *
 * 🔴 這不是可有可無的承諾 —— 線上課沒有連結就上不了。系統目前還沒有地方存
 *    「只有付了錢的人看得到」的私密連結（workshop_sessions 對匿名開放讀取，
 *    塞進任何現有欄位都等於公開），所以連結由老師另外傳。這句話同時給客人一個
 *    「沒收到該怎麼辦」的出口，而不是讓他開課當天乾等。
 */
export const ONLINE_LINK_NOTE =
  "上課連結會在開課前用 Email 或 LINE 傳給你。開課前一天還沒收到的話，用 LINE 跟我們說。";
