import "server-only";
import { createHash } from "node:crypto";

/**
 * 黑貓 PAY（統一客樂得多元支付平台）線上刷卡 — COCS。
 * 規格：多元支付平台-WEBAPI介面規格 V1.28.2。
 *
 * 只實作線上刷卡。代收代付（ibon／ATM）的 cmd 是 CvsOrderAppend，這裡沒有。
 *
 * ⚠️ 這支檔案裡有**兩套完全不同的驗簽**，寫錯不會報錯只會驗不過：
 *
 *   1. 瀏覽器導回（success_url）的 `chk`
 *      MD5(hash_base + '$' + ... )   ← 用 $ 分隔，**含 hash_base**
 *
 *   2. APN 主動通知的 `checksum`
 *      MD5(api_id + ':' + trans_id + ':' + amount + ':' + status + ':' + nonce)
 *                                    ← 用 : 分隔，**不含 hash_base**，只有 5 個欄位
 *
 * ⚠️ 另一個大坑：APN 的 checksum 算的是 `amount`（繳款單金額）而不是實收金額。
 *    checksum 通過只證明「這則通知沒被竄改」，**不證明客人付對了錢**。
 *    規格 P35 注意事項 2 是紅字：「請技術要以實際繳款金額去判別這筆繳款應實收
 *    是否相符後才撥付商品給消費者」。金額比對在 APN route handler 裡做。
 */

const BASE_URL = (
  process.env.BLACKCAT_BASE_URL ?? "https://cocs.4128888card.com.tw"
).replace(/\/+$/, "");

const CUST_ID = process.env.BLACKCAT_CUST_ID ?? "";
const API_PASSWORD = process.env.BLACKCAT_API_PASSWORD ?? "";
const HASH_BASE = process.env.BLACKCAT_HASH_BASE ?? "";

/** 收單行。合約開通的是統一金流 PAYUNi（特店代號 CCAT…）。 */
const ACQUIRER_TYPE = process.env.BLACKCAT_ACQUIRER_TYPE ?? "payuni";

/**
 * 「取消交易 & 退刷密碼」。跟 API 密碼是**不同**的一組，在合約設定表上。
 *
 * ⚠️ 規格正文的欄位表裡沒有這一欄（全文搜「退刷」零命中），只有 P70 的退款
 *    範例出現過 `cust_password`。所以這個欄位名是從範例推的，不是從欄位表。
 *    第一次真的退款時要看回應確認；打錯的話會回 status != OK 而不是靜默失敗。
 */
const REFUND_PASSWORD = process.env.BLACKCAT_REFUND_PASSWORD ?? "";

const REQUEST_TIMEOUT_MS = 20_000;

/** 規格 P40：金額上限以合約規範為主，預設 100,000。 */
const MAX_ORDER_AMOUNT = 100_000;

export function isBlackcatConfigured(): boolean {
  return Boolean(CUST_ID && API_PASSWORD);
}

/** 退款／取消授權要另一組密碼，沒設就整個功能關掉。 */
export function canReverseCharge(): boolean {
  return isBlackcatConfigured() && Boolean(REFUND_PASSWORD);
}

/** hash_base 只有驗證瀏覽器導回時才需要，缺了不影響建單與 APN。 */
export function hasHashBase(): boolean {
  return Boolean(HASH_BASE);
}

function md5(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex");
}

/**
 * 台北時間的 yyyy-MM-dd HH:mm:ss。
 *
 * 規格所有 send_time 都是這個格式，而且明寫「必須為傳送時之最新時間」。
 * 用 en-CA + Asia/Taipei 湊出來，跟 api/orders/route.ts 產訂單編號的做法一致，
 * 不要用 toISOString()（那是 UTC，會差 8 小時，錯誤訊息會是「send_time 異常」）。
 */
export function taipeiTimestamp(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return (
    `${get("year")}-${get("month")}-${get("day")} ` +
    `${get("hour")}:${get("minute")}:${get("second")}`
  );
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

interface CachedToken {
  token: string;
  /** epoch ms，已經扣掉安全邊際 */
  expiresAt: number;
}

let cached: CachedToken | null = null;

/**
 * 取得 Bearer token。
 *
 * 有效期規格自己講三種（內文 3 小時、欄位表 1 天、範例 86399 秒），
 * 但它同時指定了權威來源：「以 .expires 欄位表示的到期時間為主」。
 * 所以這裡讀 .expires，並提前 5 分鐘失效，避免在邊界上打到過期 token。
 *
 * 模組級快取。Serverless 每個 instance 各自持有，最壞情況是多取幾次 token，
 * 規格沒有頻率限制也沒有「不可重複取得」的規定。
 */
async function getToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.token;

  const body = new URLSearchParams({
    grant_type: "password",
    username: CUST_ID,
    password: API_PASSWORD,
  });

  const res = await fetch(`${BASE_URL}/Token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });

  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`取得 token 失敗：回應不是 JSON（HTTP ${res.status}）`);
  }

  const token = typeof json.access_token === "string" ? json.access_token : "";
  if (!token) {
    // 錯誤欄位規格寫大寫 Error，實際範例是小寫 error —— 兩個都收。
    const code = json.error ?? json.Error ?? `HTTP ${res.status}`;
    const desc = json.error_description ?? "";
    throw new Error(`取得 token 失敗：${String(code)} ${String(desc)}`.trim());
  }

  const expiresRaw = json[".expires"];
  let expiresAt = now + 30 * 60_000; // 讀不到就保守用 30 分鐘
  if (typeof expiresRaw === "string") {
    const parsed = Date.parse(expiresRaw.trim()); // 值是 GMT 字串，前面可能有空格
    if (Number.isFinite(parsed)) expiresAt = parsed;
  }
  cached = { token, expiresAt: expiresAt - 5 * 60_000 };
  return token;
}

/** 測試用：清掉 token 快取。 */
export function resetTokenCache(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// 建立刷卡訂單
// ---------------------------------------------------------------------------

export interface CreateCreditOrderInput {
  /** 我們的訂單編號，會當成 cust_order_no（規格要求三位數以上英數字或減號） */
  orderNo: string;
  amount: number;
  /** 商品明細。規格 P40 紅字「為符合政府法規必須填寫」，上限 500 字 */
  detail: string;
  /** APN 通知網址；不給就用黑貓 PAY 後台設定的預設值 */
  apnUrl?: string;
  /** 授權成功導回網址；不給就用後台設定 */
  successUrl?: string;
}

export type CreateCreditOrderResult =
  | { ok: true; url: string; custOrderNo: string }
  | { ok: false; reason: string };

/**
 * 契客新增刷卡訂單（cmd = CocsOrderAppend）。
 *
 * 成功會拿到一個 `url`，那是黑貓 PAY 的刷卡頁，把客人導過去就好。
 * 這支 API **不需要任何 checksum**，只靠 Bearer token。
 */
export async function createCreditOrder(
  input: CreateCreditOrderInput,
): Promise<CreateCreditOrderResult> {
  if (!isBlackcatConfigured()) {
    return { ok: false, reason: "金流未設定（缺 BLACKCAT_CUST_ID／密碼）" };
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    return { ok: false, reason: `金額不合法：${input.amount}` };
  }
  if (input.amount > MAX_ORDER_AMOUNT) {
    return { ok: false, reason: `金額超過上限 ${MAX_ORDER_AMOUNT}` };
  }

  let token: string;
  try {
    token = await getToken();
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }

  const payload: Record<string, unknown> = {
    cmd: "CocsOrderAppend",
    cust_id: CUST_ID,
    cust_order_no: input.orderNo,
    order_amount: input.amount,
    // 規格 P43 異常 9：不可包含 HTML tag。順手把角括號拿掉並截到 500。
    order_detail: input.detail.replace(/[<>]/g, "").slice(0, 500),
    acquirer_type: ACQUIRER_TYPE,
    send_time: taipeiTimestamp(),
  };
  if (input.apnUrl) payload.apn_url = input.apnUrl;
  if (input.successUrl) payload.success_url = input.successUrl;

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/Collect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 規格 P9 特別註明 Bearer 與 token 之間要有空格
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    return { ok: false, reason: `連線失敗：${(error as Error).message}` };
  }

  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: `回應不是 JSON（HTTP ${res.status}）` };
  }

  if (json.status !== "OK") {
    return { ok: false, reason: String(json.msg ?? `HTTP ${res.status}`) };
  }
  const url = typeof json.url === "string" ? json.url : "";
  if (!url) return { ok: false, reason: "回應成功但沒有刷卡網址" };

  return {
    ok: true,
    url,
    custOrderNo: String(json.cust_order_no ?? input.orderNo),
  };
}

// ---------------------------------------------------------------------------
// 訂單查詢
// ---------------------------------------------------------------------------

export type QueryOrderResult =
  | {
      ok: true;
      /** 已經拆過殼的欄位（見 unwrapQueryData）。呼叫端一律讀這個。 */
      data: Record<string, unknown>;
      /** 原始回應，整包留著寫進 payment_events 用。 */
      raw: Record<string, unknown>;
    }
  | { ok: false; reason: string };

/**
 * CocsOrderQuery 的回應形狀。
 *
 * 🔴 規格範例出現過兩種形狀（欄位直接放頂層／包在 data 裡），而我們手上還沒有
 *    一筆真實回應可以確定是哪一種。這件事本來是兩個呼叫端各自解讀的：
 *    reverseCharge() 寫了 `q.data.data ?? q.data` 的 fallback，APN 沒有。
 *    也就是說如果實際是「包起來」的那種，APN 會 100% 讀到 undefined、
 *    判成「未授權」、然後回 OK 停止重送 —— 每一筆線上刷卡都會被靜靜丟掉。
 *
 *    所以拆殼收斂到 queryOrder() 裡面做一次，呼叫端拿到的 data 永遠是拆好的，
 *    兩邊不可能再各說各話。
 */
function unwrapQueryData(json: Record<string, unknown>): Record<string, unknown> {
  const inner = json.data;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return json;
}

/**
 * 這筆交易「實際被授權／實際收到」多少錢。讀不到就回 null。
 *
 * 🔴 這支**絕對不可以**回退到 order_amount。
 *    order_amount 是我們自己在 CocsOrderAppend 送出去的數字，回查只是原樣念回來，
 *    永遠等於 orders.total。拿它跟 orders.total 比是恆真式 ——
 *    看起來在防、實際上什麼都沒擋，正好抵消掉規格 P35 紅字那條規則存在的理由。
 *    （這就是這支函式被拆出來的原因，不要為了「少一個 null 分支」把它加回去。）
 *
 * ✅ 欄位名已用真實交易驗證（2026-09-12，對照小時光書店同一家 COCS 的 8 則真實
 *    APN 與 3 則回查回應，含 B→O→E 完整時序與 Q 取消）：
 *
 *    APN body.payment_detail.pay_amount  ← 唯一的實收金額欄位，number，
 *                                          B/O/E 每一則都有，8 筆全部等於 body.amount
 *    回查（CocsOrderQuery）回應是**扁平的**，process_code 在頂層、是 number，
 *    裡面**沒有任何實收金額欄位**：order_amount / request_amount 都是我們送出去的
 *    數字念回來（Q 之後 request_amount 變 0）；grant_amount 只在 process_code=22
 *    才有值，而且是**扣掉手續費的撥付淨額**（amount − payment_detail.fee，約 2.2%），
 *    拿它比對會永遠不等於 orders.total。
 *
 * 🔴 所以只認 pay_amount。之前猜的 auth_amount / authorized_amount / trade_amount
 *    在真實回應裡都不存在，已移除；grant_amount 永遠不可以加進來。
 */
const PAID_AMOUNT_FIELDS = [
  "pay_amount", // 規格 P35 明寫、真實 APN 驗證過的實際繳款金額
] as const;

export function extractPaidAmount(
  ...sources: (Record<string, unknown> | null | undefined)[]
): number | null {
  for (const src of sources) {
    if (!src) continue;
    for (const key of PAID_AMOUNT_FIELDS) {
      const v = src[key];
      if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
      if (typeof v === "string" && v.trim() !== "") {
        const n = Number(v.trim().replace(/[",']/g, ""));
        if (Number.isFinite(n)) return Math.trunc(n);
      }
    }
  }
  return null;
}

/** 訂單查詢（cmd = CocsOrderQuery）。對帳與補救用。 */
export async function queryOrder(orderNo: string): Promise<QueryOrderResult> {
  if (!isBlackcatConfigured()) {
    return { ok: false, reason: "金流未設定" };
  }
  let token: string;
  try {
    token = await getToken();
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }

  try {
    const res = await fetch(`${BASE_URL}/api/Collect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        cmd: "CocsOrderQuery",
        cust_id: CUST_ID,
        cust_order_no: orderNo,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (json.status !== "OK") {
      return { ok: false, reason: String(json.msg ?? `HTTP ${res.status}`) };
    }
    return { ok: true, data: unwrapQueryData(json), raw: json };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

// ---------------------------------------------------------------------------
// 退款 / 取消授權
// ---------------------------------------------------------------------------

/**
 * 🔴 這兩件事在信用卡的世界裡是**不同**的操作，打錯會失敗：
 *
 *   取消授權（CocsOrderCancel）—— 銀行授權過但**還沒請款**。錢從來沒真的離開
 *     客人的帳戶，只是額度被凍住；取消之後凍結解除，對帳單上不會留下扣款。
 *   退款（CocsOrderRefund）—— **已經請款完成**，錢真的收了。退款是把錢送回去，
 *     客人的對帳單上會有一筆扣款和一筆退款。
 *
 * 用 process_code 判斷該用哪一個（規格附件 1）：
 *   15 授權完成      → 取消授權
 *   20 請求請款      ┐ 請款在途中，兩種都不能做。統一金流是每日 20:00 截止、
 *   21 請款作業中    ┘ 隔日中午請款完成，所以這段時間要等。
 *   22 請款完成      → 退款
 *
 * ⚠️ 猜錯的後果不是靜默失敗（會回 status != OK），但客服會看到一個看不懂的
 *    錯誤訊息然後以為系統壞了。所以一律先查再決定，不要讓呼叫端自己選。
 */

const PROCESS_CODE_LABEL: Record<number, string> = {
  15: "授權完成（尚未請款）",
  20: "請求請款中",
  21: "請款作業中",
  22: "請款完成",
};

export type ReverseChargeResult =
  | { ok: true; action: "cancelled" | "refunded"; note: string }
  | { ok: false; reason: string; canRetryLater: boolean };

async function collect(
  payload: Record<string, unknown>,
): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; reason: string }> {
  let token: string;
  try {
    token = await getToken();
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }

  try {
    const res = await fetch(`${BASE_URL}/api/Collect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: `回應不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}` };
    }
    if (json.status !== "OK") {
      return { ok: false, reason: String(json.msg ?? `HTTP ${res.status}`) };
    }
    return { ok: true, json };
  } catch (error) {
    return { ok: false, reason: `連線失敗：${(error as Error).message}` };
  }
}

/**
 * 把一筆已授權／已請款的交易退回去。
 *
 * 呼叫端只要說「這張訂單要退」，該用取消授權還是退款由這裡查了再決定。
 *
 * @param orderNo 我們的訂單編號（= cust_order_no）
 * @param amount  要退的金額。目前一律全額退 —— 部分退款要另外處理，因為
 *                部分退款之後訂單狀態不該是「已退款」，而現在的狀態機沒有
 *                「部分退款」這個狀態（admin/orders/shared.ts 只有四種）。
 */
export async function reverseCharge(
  orderNo: string,
  amount: number,
): Promise<ReverseChargeResult> {
  if (!isBlackcatConfigured()) {
    return { ok: false, reason: "金流未設定。", canRetryLater: false };
  }
  if (!REFUND_PASSWORD) {
    return {
      ok: false,
      reason:
        "沒有設定退刷密碼（BLACKCAT_REFUND_PASSWORD），無法自動退款。" +
        "請到黑貓 PAY 後台手動退，再回來標記訂單。",
      canRetryLater: false,
    };
  }

  // ── 1. 先查現在到哪一步 ────────────────────────────────────────────
  const q = await queryOrder(orderNo);
  if (!q.ok) {
    // 查不到就**不要動**。這時候發指令等於閉著眼睛操作真的錢。
    return { ok: false, reason: `查不到這筆交易的狀態（${q.reason}）`, canRetryLater: true };
  }

  // queryOrder() 已經拆過殼了，這裡不要再自己 fallback 一次。
  const processCode = Number(q.data.process_code);

  if (!Number.isFinite(processCode)) {
    return { ok: false, reason: "查詢回應裡沒有 process_code。", canRetryLater: true };
  }

  // ── 2. 依狀態選指令 ────────────────────────────────────────────────
  if (processCode === 20 || processCode === 21) {
    return {
      ok: false,
      reason:
        `這筆交易正在請款途中（${PROCESS_CODE_LABEL[processCode]}），現在沒辦法取消也沒辦法退款。` +
        "統一金流每天 20:00 截止、隔日中午請款完成，明天中午之後再退一次。",
      canRetryLater: true,
    };
  }

  if (processCode !== 15 && processCode !== 22) {
    return {
      ok: false,
      reason:
        `這筆交易的狀態是 ${processCode}，不是可以退的狀態` +
        "（可能已經退過、授權失敗或已逾期）。請到黑貓 PAY 後台確認。",
      canRetryLater: false,
    };
  }

  const isCancel = processCode === 15;

  const res = await collect({
    cmd: isCancel ? "CocsOrderCancel" : "CocsOrderRefund",
    cust_id: CUST_ID,
    cust_order_no: orderNo,
    // ⚠️ 欄位名從規格 P70 的範例推的，不在欄位表裡（見 REFUND_PASSWORD 的註解）
    cust_password: REFUND_PASSWORD,
    // 取消授權是整筆取消，不帶金額；退款要指定金額
    ...(isCancel ? {} : { refund_amount: Math.round(amount) }),
    send_time: taipeiTimestamp(),
  });

  if (!res.ok) {
    return {
      ok: false,
      reason: `${isCancel ? "取消授權" : "退款"}失敗：${res.reason}`,
      // 連線類的可以再試，業務類的再試也一樣
      canRetryLater: res.reason.startsWith("連線失敗"),
    };
  }

  return {
    ok: true,
    action: isCancel ? "cancelled" : "refunded",
    note: isCancel
      ? "這筆還沒請款，已經取消授權 —— 客人的對帳單上不會出現這筆扣款。"
      : `已送出退款 ${Math.round(amount)} 元。實際入帳時間依發卡行，通常 3～7 個工作天。`,
  };
}

// ---------------------------------------------------------------------------
// 驗簽
// ---------------------------------------------------------------------------

/**
 * APN 主動通知的 checksum。
 *
 *   MD5(api_id + ':' + trans_id + ':' + amount + ':' + status + ':' + nonce)
 *
 * 冒號分隔、**不含 hash_base**、只有這 5 個欄位。規格範例算出來是小寫十六進位，
 * 但文件沒明寫大小寫，所以比對時兩邊都轉小寫。
 *
 * `amount` 要用原樣的數字字串（不補零、不加千分位）—— 直接把收到的原始值
 * 轉成字串最保險，因為那就是對方拿去算的東西。
 */
export function verifyApnChecksum(input: {
  apiId: unknown;
  transId: unknown;
  amount: unknown;
  status: unknown;
  nonce: unknown;
  checksum: unknown;
}): boolean {
  const raw = [
    input.apiId,
    input.transId,
    input.amount,
    input.status,
    input.nonce,
  ]
    .map((v) => (v === null || v === undefined ? "" : String(v)))
    .join(":");
  const expected = md5(raw);
  const given = String(input.checksum ?? "").trim().toLowerCase();
  return given.length === 32 && expected === given;
}

/**
 * 瀏覽器導回（success_url）的 chk —— 授權**成功**版。
 *
 *   MD5(hash_base $ order_amount $ send_time $ ret $ acquire_time
 *       $ auth_code $ card_no $ notify_time $ cust_order_no)
 *
 * 注意順序不是欄位表的順序：send_time 在 ret 之前，cust_order_no 在最後。
 */
export function verifyReturnChkSuccess(q: {
  order_amount: string;
  send_time: string;
  ret: string;
  acquire_time: string;
  auth_code: string;
  card_no: string;
  notify_time: string;
  cust_order_no: string;
  chk: string;
}): boolean {
  if (!HASH_BASE) return false;
  const raw = [
    HASH_BASE,
    q.order_amount,
    q.send_time,
    q.ret,
    q.acquire_time,
    q.auth_code,
    q.card_no,
    q.notify_time,
    q.cust_order_no,
  ].join("$");
  return md5(raw) === (q.chk ?? "").trim().toLowerCase();
}

/**
 * 瀏覽器導回的 chk —— 授權**失敗**版（欄位比成功版少）。
 *
 *   MD5(hash_base $ order_amount $ send_time $ ret $ notify_time $ cust_order_no)
 *
 * ⚠️ 實務上我們大概收不到這個：規格 P48 明寫失敗轉址「僅玉山銀、中信銀可用，
 *    統一金流授權失敗後不會轉址，會停留在失敗結果頁」，而我們的收單行就是統一金流。
 *    留著是為了完整性，以及日後若換收單行不用重寫。
 */
export function verifyReturnChkFail(q: {
  order_amount: string;
  send_time: string;
  ret: string;
  notify_time: string;
  cust_order_no: string;
  chk: string;
}): boolean {
  if (!HASH_BASE) return false;
  const raw = [
    HASH_BASE,
    q.order_amount,
    q.send_time,
    q.ret,
    q.notify_time,
    q.cust_order_no,
  ].join("$");
  return md5(raw) === (q.chk ?? "").trim().toLowerCase();
}

/** APN 狀態碼（規格 P87-88）。 */
export const APN_STATUS = {
  AUTHORIZED: "B",
  CAPTURING: "O",
  CAPTURED: "E",
  AUTH_FAILED: "F",
  EXPIRED: "D",
  CAPTURE_FAILED: "P",
  REFUNDED: "M",
  REFUND_FAILED: "N",
  AUTH_CANCELLED: "Q",
  AUTH_CANCEL_FAILED: "R",
} as const;

/** 給後台顯示用的中文說明。 */
export const APN_STATUS_LABEL: Record<string, string> = {
  B: "授權完成",
  O: "請款作業中",
  E: "請款完成",
  F: "授權失敗",
  D: "訂單逾期",
  P: "請款失敗",
  M: "取消交易完成",
  N: "取消交易失敗",
  Q: "取消授權完成",
  R: "取消授權失敗",
  I: "開立發票通知",
  J: "開立發票折讓單號通知",
};
