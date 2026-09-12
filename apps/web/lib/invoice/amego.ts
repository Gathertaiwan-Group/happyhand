import "server-only";
import { createHash } from "node:crypto";

/**
 * Amego 電子發票 API client。
 *
 *   開立  POST {base}/json/c0401
 *   作廢  POST {base}/json/f0501
 *   反查  POST {base}/json/invoice_query
 *
 *   認證  form body { invoice: 賣方統編, data: <json>, time: <unix 秒>,
 *                     sign: md5(data + time + appKey) }
 *
 * 🔴 三件會讓人寫錯的事：
 *
 * 1. **每一個回應都是 HTTP 200**，成功失敗都一樣。唯一能判斷的是 body 裡的
 *    `code`。把 HTTP 狀態當成功失敗的依據，等於所有錯誤都被當成成功。
 *
 * 2. **簽章的 `data` 必須跟送出去的那一份是同一個字串**。先 JSON.stringify 一次、
 *    簽章與 body 共用同一個變數。序列化兩次的話鍵的順序可能不同，簽章就對不上，
 *    而 Amego 只會回一句 code 16「sign 驗證錯誤」，看不出是哪裡不同。
 *
 * 3. **作廢要打 f0501 不是 c0701**。c0701 是「註銷」（視同從未送達買方），
 *    f0501 才是「作廢」（已送達，必須留下作廢紀錄）。電子發票在 Amego 開立的
 *    當下就算已經數位送達買方了，所以退款一律要 f0501 —— 打錯會在 Amego 後台
 *    留下錯誤的稅務紀錄，而且事後不容易改。
 *
 * ⚠️ timeout 設 20 秒（Realreal 那套設 45 秒）。這裡短的原因是 Vercel 的函式有
 *    執行時間上限，設得比上限長沒有意義 —— 平台會先把整個 request 砍掉，連
 *    catch 都跑不到。被砍掉的那一刻如果 Amego 已經開了票，狀態就是「開出去了但
 *    沒記到」，這正是 lib/invoice/issue.ts 的 claim 機制要接住的情況。
 */

const AMEGO_OFFICIAL = "https://invoice-api.amego.tw";
const BASE_URL = (process.env.AMEGO_API_URL ?? AMEGO_OFFICIAL).replace(/\/+$/, "");
const TAX_ID = process.env.AMEGO_TAX_ID ?? "";
const APP_KEY = process.env.AMEGO_APP_KEY ?? "";

/**
 * 走固定出口 IP 代理時的通行證（apps/amego-proxy，跑在 Railway）。
 *
 * Amego 用來源 IP 白名單，而 Vercel 的出口 IP 是浮動的，所以正式站是把
 * AMEGO_API_URL 指到代理、由代理用固定 IP 打 Amego。
 *
 * ⚠️ 只在「確定不是直連 Amego」時才送這個標頭 —— 設錯 URL 的時候，我們的代理
 *    token 不該被送到第三方去。
 */
const PROXY_TOKEN = process.env.AMEGO_PROXY_TOKEN ?? "";
const VIA_PROXY = PROXY_TOKEN !== "" && BASE_URL !== AMEGO_OFFICIAL;

const REQUEST_TIMEOUT_MS = 20_000;

/** 沒有憑證就整條線關掉，跟 isBlackcatConfigured() 同一個模式。 */
export function isAmegoConfigured(): boolean {
  return TAX_ID.length > 0 && APP_KEY.length > 0;
}

/**
 * 這三個 code 是冪等設計的地基。
 *
 * 🔴 71 對 invoice_query 來說是「還沒開過」，是**正常結果不是錯誤**。
 *    把它當成查詢失敗的話，重試路徑會說「查不到，那就開吧」—— 正好是我們要防的事。
 *
 * 🔴 3040171 是 Amego 對 OrderId 做唯一性檢查的結果，是**正面的冪等訊號**：
 *    「這張訂單已經有發票了」。絕不可以當成一般失敗，要回頭查出來認回。
 */
export const AMEGO_OK = 0;
export const AMEGO_NOT_FOUND = 71;
export const AMEGO_DUPLICATE_ORDER = 3040171;

type AmegoResponse = { code?: number; msg?: string; [k: string]: unknown };

async function amegoPost(path: string, payload: unknown): Promise<
  { ok: true; body: AmegoResponse } | { ok: false; reason: string }
> {
  if (!isAmegoConfigured()) {
    return { ok: false, reason: "Amego 未設定（缺 AMEGO_TAX_ID 或 AMEGO_APP_KEY）" };
  }

  // 🔴 只序列化一次，簽章與 body 共用。見檔頭第 2 點。
  const data = JSON.stringify(payload);
  const time = Math.floor(Date.now() / 1000);
  const sign = createHash("md5").update(data + String(time) + APP_KEY).digest("hex");

  const body = new URLSearchParams({
    invoice: TAX_ID, // 賣方統編，不是發票號碼
    data,
    time: String(time),
    sign,
  });

  let raw: string;
  let httpStatus: number;
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(VIA_PROXY ? { "x-proxy-token": PROXY_TOKEN } : {}),
      },
      body: body.toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    httpStatus = res.status;
    raw = await res.text();
  } catch (err) {
    // 傳輸層失敗：timeout、DNS、**IP 白名單被拒**。
    // 🔴 這明確**不等於**「沒開過」—— 見 queryByOrderId 的三態說明。
    return { ok: false, reason: `連線失敗：${describeFetchFailure(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `回應不是 JSON http=${httpStatus} ${raw.slice(0, 200)}` };
  }

  /*
    🔴 「解得開的 JSON」不等於「Amego 的回應」。走代理時，代理自己的
       {"error":"unauthorized"}（token 錯）、{"error":"path_not_allowed"}（白名單漏）
       或 WAF 的擋頁都是合法 JSON，但沒有 number 型別的 code。
       小時光踩過：這種回應被讀成 code=NaN，last_error 只剩「code=NaN」，
       五張發票卡了三天沒人看得出中繼回的其實是 404。
       這裡一律當傳輸層失敗（可重試），並把 http 狀態碼與內容帶進訊息。
  */
  const code = (parsed as { code?: unknown } | null)?.code;
  const codeIsNumeric =
    typeof code === "number" || (typeof code === "string" && /^\d+$/.test(code));
  if (!codeIsNumeric) {
    return { ok: false, reason: `非 Amego 回應 http=${httpStatus} body=${raw.slice(0, 200)}` };
  }

  return { ok: true, body: parsed as AmegoResponse };
}

/** Node 的 fetch 失敗時 err.message 只有 "fetch failed"，真正原因藏在 cause 裡。 */
function describeFetchFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const inner = cause instanceof Error ? cause.message : cause ? String(cause) : "";
  return inner ? `${err.message}（${inner}）` : err.message;
}

/* ------------------------------------------------------------------ 反查 */

export type QueryHit = {
  invoiceNumber: string;
  randomCode: string;
  totalAmount: number | null;
  /** wait 裡有 C0501 = 作廢已送出但還沒落地 */
  pendingVoid: boolean;
};

/**
 * 用 OrderId 反查 Amego 有沒有開過這張。**三態**，不是布林：
 *
 *   { ok: true,  hit: {...} }  已經開過了 → 認回來，不要再開
 *   { ok: true,  hit: null  }  確定還沒開過（code 71）→ 可以安全地開
 *   { ok: false, reason }      **不知道**（連線失敗、簽章錯…）
 *                              → 這跟「沒開過」完全不是同一件事，呼叫端不可以
 *                                據此開票，只能退回去靠 Amego 自己的 OrderId
 *                                唯一性擋（3040171）。
 *
 * 把第三種當成第二種，是整套冪等從「防重複」變成「製造重複」的那個 bug。
 */
export async function queryByOrderId(
  orderId: string,
): Promise<{ ok: true; hit: QueryHit | null } | { ok: false; reason: string }> {
  const res = await amegoPost("/json/invoice_query", {
    type: "order",
    order_id: orderId,
  });
  if (!res.ok) return res;

  const code = Number(res.body.code);

  // 查無資料 = 確定還沒開過。這是唯一可以讀成「可以安全地開」的 code。
  if (code === AMEGO_NOT_FOUND) return { ok: true, hit: null };

  if (code !== AMEGO_OK) {
    return { ok: false, reason: `反查失敗 code=${code} ${res.body.msg ?? ""}`.trim() };
  }

  const data = (res.body.data ?? {}) as Record<string, unknown>;
  const number = String(data.invoice_number ?? "");

  // code 0 卻沒有號碼不應該發生。把它當成「無法確認」而不是「沒開過」——
  // 後者會授權一次重開。
  if (!number) return { ok: false, reason: "code 0 但沒有 invoice_number" };

  const wait = Array.isArray(data.wait) ? (data.wait as Record<string, unknown>[]) : [];

  return {
    ok: true,
    hit: {
      invoiceNumber: number,
      randomCode: String(data.random_number ?? ""),
      totalAmount:
        data.total_amount === undefined || data.total_amount === null
          ? null
          : Number(data.total_amount),
      pendingVoid: wait.some((w) => String(w.invoice_type ?? "") === "C0501"),
    },
  };
}

/* ------------------------------------------------------------------ 開立 */

export type InvoiceItem = {
  name: string;
  qty: number;
  unitPrice: number;
};

export type IssueParams = {
  /** 對外訂單編號（HH-YYYYMMDD-XXXX），會顯示在 Amego 後台，也是冪等鍵 */
  orderNo: string;
  /** 實收金額（含稅）。明細加總會被調整成等於這個數字。 */
  totalAmount: number;
  items: InvoiceItem[];
  buyerEmail: string;
  /** 有值 = B2B 三聯式 */
  taxId: string | null;
  /** B2B 的抬頭 */
  title: string | null;
  carrierType: "cloud" | "phone" | "natural_person" | "love_code" | "b2b";
  carrierId: string | null;
};

export type IssueResult =
  | { ok: true; invoiceNumber: string; randomCode: string }
  | { ok: false; reason: string; duplicate: boolean; permanent: boolean };

/** 品名長度上限。Amego 沒有明講，抓一個保守值避免整筆被打回。 */
const ITEM_NAME_MAX = 80;

export async function issueInvoice(params: IssueParams): Promise<IssueResult> {
  const total = Math.round(params.totalAmount);
  if (!Number.isFinite(total) || total < 0) {
    return { ok: false, reason: `金額不合法：${params.totalAmount}`, duplicate: false, permanent: true };
  }

  const productItems: Record<string, unknown>[] = params.items.map((it) => ({
    // 品名截斷：order_items 沒有存品名，是 join products 拿的，長度不可控。
    Description: it.name.slice(0, ITEM_NAME_MAX) || "課程",
    Quantity: it.qty,
    UnitPrice: Math.round(it.unitPrice),
    Amount: Math.round(it.unitPrice) * it.qty,
    Remark: "",
    TaxType: "1",
  }));

  /*
    🔴 明細加總必須等於實收金額，否則 Amego 會退。
       權威金額是「客人實際付了多少」，不是明細算出來的 —— 差額補一列調整。
       這個站目前沒有折扣與運費，理論上不會有差額，但梯次自訂價、日後加折扣碼
       都可能造成，留著這一段比事後才發現便宜。
  */
  const itemsTotal = productItems.reduce((s, p) => s + (p.Amount as number), 0);
  const diff = total - itemsTotal;
  if (diff !== 0) {
    productItems.push({
      Description: "系統尾差調整",
      Quantity: 1,
      UnitPrice: diff,
      Amount: diff,
      Remark: "rounding",
      TaxType: "1",
    });
  }

  const isB2B = !!params.taxId;

  /*
    B2C 的稅額填 0、SalesAmount 就是含稅總額；只有 B2B（三聯式）才把稅拆出來。
    這是 Amego 對二聯／三聯的處理方式，不是我們自己的簡化。
  */
  const taxAmount = isB2B ? Math.round(total - total / 1.05) : 0;
  const salesAmount = total - taxAmount;

  const carrier: Record<string, unknown> = {};
  if (!isB2B) {
    if (params.carrierType === "love_code" && params.carrierId) {
      carrier.NPOBAN = params.carrierId;
    } else if (params.carrierType === "phone" && params.carrierId) {
      carrier.CarrierType = "3J0002"; // 手機條碼
      carrier.CarrierId1 = params.carrierId;
      carrier.CarrierId2 = params.carrierId;
    } else if (params.carrierType === "natural_person" && params.carrierId) {
      carrier.CarrierType = "CQ0001"; // 自然人憑證
      carrier.CarrierId1 = params.carrierId;
      carrier.CarrierId2 = params.carrierId;
    }
    // cloud → 不帶任何載具欄位 = Amego 雲端發票
  }

  const res = await amegoPost("/json/c0401", {
    // 🔴 一定要是對外訂單編號。它是 Amego 後台顯示的「訂單編號」，
    //    也是我們反查認回的唯一依據。
    OrderId: params.orderNo,
    BuyerIdentifier: isB2B ? params.taxId : "0000000000",
    BuyerName: params.title || (isB2B ? "公司" : "消費者"),
    BuyerEmailAddress: params.buyerEmail,
    ProductItem: productItems,
    SalesAmount: salesAmount,
    FreeTaxSalesAmount: 0,
    ZeroTaxSalesAmount: 0,
    TaxType: "1",
    TaxRate: 0.05,
    TaxAmount: taxAmount,
    TotalAmount: total,
    ...carrier,
  });

  if (!res.ok) {
    return { ok: false, reason: res.reason, duplicate: false, permanent: false };
  }

  const code = Number(res.body.code);

  if (code === AMEGO_DUPLICATE_ORDER) {
    // 正面訊號：這張訂單已經有發票了。呼叫端要回頭反查認回，不是重試。
    return {
      ok: false,
      reason: `OrderId 重複（${params.orderNo}）`,
      duplicate: true,
      permanent: false,
    };
  }

  if (code !== AMEGO_OK) {
    return {
      ok: false,
      reason: `開立失敗 code=${code} ${res.body.msg ?? ""}`.trim(),
      duplicate: false,
      // 這些是「重試一萬次還是同一個答案」的：資料錯，要人改。
      permanent: code === 16 || (code >= 3040000 && code < 3050000),
    };
  }

  const data = (res.body.data ?? res.body) as Record<string, unknown>;
  const invoiceNumber = String(data.invoice_number ?? "");
  if (!invoiceNumber) {
    return { ok: false, reason: "code 0 但沒有 invoice_number", duplicate: false, permanent: false };
  }

  return {
    ok: true,
    invoiceNumber,
    randomCode: String(data.random_number ?? ""),
  };
}

/* ------------------------------------------------------------------ 作廢 */

export async function voidInvoice(
  invoiceNumber: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Amego 收的是台北時間，而 server 跑在 UTC。自己加 8 小時，
  // 不要用 toLocaleString 之類的東西 —— 那會依 runtime 的 locale 變。
  const tw = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const cancelDate =
    `${tw.getUTCFullYear()}${p2(tw.getUTCMonth() + 1)}${p2(tw.getUTCDate())}`;
  const cancelTime =
    `${p2(tw.getUTCHours())}:${p2(tw.getUTCMinutes())}:${p2(tw.getUTCSeconds())}`;

  // ⚠️ body 是**陣列**不是物件。
  const res = await amegoPost("/json/f0501", [
    {
      CancelInvoiceNumber: invoiceNumber,
      CancelDate: cancelDate,
      CancelTime: cancelTime,
      CancelReason: reason.slice(0, 20) || "訂單取消",
    },
  ]);

  if (!res.ok) return res;

  const code = Number(res.body.code);
  if (code !== AMEGO_OK) {
    return { ok: false, reason: `作廢失敗 code=${code} ${res.body.msg ?? ""}`.trim() };
  }
  return { ok: true };
}

/** 給客人下載發票 PDF 的網址。 */
export function invoicePdfUrl(invoiceNumber: string): string {
  return `${BASE_URL}/invoice/pdf/${encodeURIComponent(invoiceNumber)}`;
}
