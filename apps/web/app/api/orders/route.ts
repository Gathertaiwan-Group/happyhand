import { NextResponse } from "next/server";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { SITE } from "@/lib/site";
import { findOrCreateUser, generateSetupLink } from "@/lib/account/provision";
import { enqueueEmail, flushOutbox } from "@/lib/email/outbox";
import {
  accountSetupEmail,
  orderCreatedEmail,
  type EmailSessionInfo,
} from "@/lib/email/templates";
import { normalizeFormat } from "@/lib/session-format";
import { twDate, timeRange } from "@/lib/data";
import { createCreditOrder, isBlackcatConfigured } from "@/lib/payment/blackcat";
import {
  isCarrierType,
  normalizeInvoice,
  validateInvoice,
} from "@/lib/invoice/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/orders — 建立訂單
 *
 * 設計原則（很重要）：
 * 1. 金額一律由伺服器端重算，不信任前端送來的 priceSnapshot。
 *    查得到商品就用商品表的價格；查不到才退回前端價格並標記 price_unverified。
 * 2. DB 還沒接好（沒有 SUPABASE_SERVICE_ROLE_KEY）或寫入失敗時，不回 500。
 *    照樣發訂單編號、回 persisted: false，讓使用者走完流程（完成頁會請他用 LINE 確認），
 *    server 端 console.error 留下完整內容當作補救依據。
 * 3. 訂單一定要有主人：已登入就用 session 的 user，否則用客人填的 Email
 *    自動建帳號（見 lib/account/provision.ts）。綁不上也不擋單，
 *    由 claim_guest_orders() 與 backfill_order_user_ids() 事後補。
 */

/**
 * 🔴 這支 API 會用我們的名義寄信給請求裡指定的任意信箱，所以必須有防濫用。
 *    被腳本跑一輪的後果不只是這個站：寄件網域 gathertaiwan.com 是給樂其他專案
 *    共用的，信譽燒掉會讓 realreal、gather-landing 的信一起寄不出去，
 *    連 Supabase Auth 的驗證信也會死。
 *
 * 三道閘：
 *   A. setup 信只在「帳號是這一單新建的」時候寄（既有帳號不寄）
 *   B. email_outbox.dedupe_key 是 account_setup:<user_id> 且有 unique 約束，
 *      同一個信箱永遠只會對到同一個 user_id → 這輩子只寄得出一封
 *   C. 下面這兩道：單一 IP 的頻率，以及全站每小時 setup 信總量的斷路器
 *
 * ⚠️ IP 節流是 in-memory 的，Vercel 每個 instance 各有一份，擋得住單機腳本
 *    但擋不住分散來源。真正的斷路器是 SETUP_EMAIL_HOURLY_CAP（走 DB，跨 instance）。
 */
const IP_WINDOW_MS = 10 * 60_000;
const IP_MAX_ORDERS = 5;
const SETUP_EMAIL_HOURLY_CAP = 30;
const ipHits = new Map<string, number[]>();

function tooManyFromIp(ip: string): boolean {
  if (!ip) return false;
  const now = Date.now();
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  hits.push(now);
  ipHits.set(ip, hits);

  // 順手清掉沒在用的鍵，免得 instance 活久了記憶體一直長
  if (ipHits.size > 5000) {
    for (const [key, times] of ipHits) {
      if (times.every((t) => now - t >= IP_WINDOW_MS)) ipHits.delete(key);
    }
  }
  return hits.length > IP_MAX_ORDERS;
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  return forwarded.split(",")[0]?.trim() ?? "";
}

const PHONE_RE = /^09\d{8}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 去掉念出來或抄寫時會弄錯的字元（0/O、1/I/L、5/S、8/B、2/Z） */
const ORDER_NO_ALPHABET = "ACDEFGHJKMNPQRTUVWXY346789";

const PAYMENT_METHODS = new Set(["credit", "atm", "manual"]);

type Line = {
  slug: string;
  title: string;
  type: string;
  qty: number;
  unit_price: number;
  product_id: string | null;
  session_id: string | null;
  session_label: string | null;
  price_unverified: boolean;
};

function str(v: unknown, max = 300) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function bad(message: string) {
  return NextResponse.json({ message }, { status: 400 });
}

/** HH-YYYYMMDD-XXXX（日期用台北時間） */
function makeOrderNo() {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .replaceAll("-", "");

  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const rand = Array.from(
    bytes,
    (b) => ORDER_NO_ALPHABET[b % ORDER_NO_ALPHABET.length],
  ).join("");

  return `HH-${ymd}-${rand}`;
}

export async function POST(request: Request) {
  // 節流放在最前面：擋掉的請求連 JSON 都不用解析。
  // 429 的文案要給人話＋出口，不能只回一個代碼——真的手滑連按的長輩會看到這句。
  if (tooManyFromIp(clientIp(request))) {
    return NextResponse.json(
      {
        message: `短時間內送出太多筆訂單了。請等十分鐘再試，或直接用 LINE 找我們：${SITE.lineHref}`,
      },
      { status: 429 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("訂單內容讀不到，請重新整理後再送一次。");
  }

  // ---------- 1. 驗證聯絡資料 ----------
  const name = str(body.name, 80);
  const phone = str(body.phone, 20).replace(/\D/g, "");
  const email = str(body.email, 160);
  const address = str(body.address, 300);
  const note = str(body.note, 1000);
  const payment = str(body.payment, 20);

  /**
   * 報名問題（工作坊才有）。
   * ⚠️ health_ack_at 存的是**時間**不是 boolean —— 那是法律上的告知同意證據，
   *    「什麼時候同意的」比「有沒有同意」更重要。
   */
  const intakeRaw = (body.intake ?? null) as Record<string, unknown> | null;
  const intake = intakeRaw
    ? {
        intake_experience: str(intakeRaw.experience, 40) || null,
        intake_goal: str(intakeRaw.goal, 2000) || null,
        intake_source: str(intakeRaw.source, 60) || null,
        health_ack_at: intakeRaw.healthAck === true ? new Date().toISOString() : null,
      }
    : {
        intake_experience: null,
        intake_goal: null,
        intake_source: null,
        health_ack_at: null,
      };

  /*
   * 發票的載具／統編。
   * 🔴 一定要在 server 再驗一次：前端的 InvoiceOptions 擋得住手滑，擋不住
   *    直接打這支 API。錯的載具送到 Amego 只會變成一列開不出來的失敗紀錄，
   *    而那時客人已經付完錢離開了。
   */
  const invoiceRaw = (body.invoice ?? null) as Record<string, unknown> | null;
  const invoiceInput = {
    carrierType: isCarrierType(invoiceRaw?.carrierType) ? invoiceRaw.carrierType : "cloud",
    carrierId: str(invoiceRaw?.carrierId, 64),
    taxId: str(invoiceRaw?.taxId, 8),
    title: str(invoiceRaw?.title, 60),
  } as const;
  const invoiceError = validateInvoice(invoiceInput);
  if (invoiceError) return bad(invoiceError.message);
  const normalized = normalizeInvoice(invoiceInput);
  const invoice = {
    invoice_carrier_type: normalized.carrierType,
    invoice_carrier_id: normalized.carrierId,
    invoice_tax_id: normalized.taxId,
    invoice_title: normalized.title,
  };

  if (!name) return bad("請填姓名。");
  if (!PHONE_RE.test(phone)) return bad("手機號碼是 09 開頭、總共 10 個數字。");
  if (!EMAIL_RE.test(email)) return bad("Email 格式看起來不太對，請再檢查一次。");

  const payment_method = PAYMENT_METHODS.has(payment) ? payment : "manual";

  // ---------- 2. 驗證品項 ----------
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) return bad("購物車是空的，請先選一門課再送出。");
  if (rawItems.length > 50) return bad("一次最多只能訂 50 個品項。");

  const parsed = rawItems.map((raw) => {
    const it = (raw ?? {}) as Record<string, unknown>;
    const qtyNum = Number(it.qty);
    const snapshotNum = Number(it.priceSnapshot);
    return {
      productId: str(it.productId, 100),
      slug: str(it.slug, 100),
      title: str(it.title, 200),
      type: str(it.type, 20),
      qty: Number.isFinite(qtyNum) ? Math.trunc(qtyNum) : NaN,
      snapshot: Number.isFinite(snapshotNum) ? Math.trunc(snapshotNum) : NaN,
      sessionId: str(it.sessionId, 100),
      sessionLabel: str(it.sessionLabel, 200),
    };
  });

  for (const it of parsed) {
    if (!it.slug && !it.productId) return bad("訂單內容不完整，請回購物車重新確認。");
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > 20)
      return bad("每個品項的數量請填 1 到 20 之間。");
  }

  // ---------- 3. 伺服器端重算金額 ----------
  const supabase = getServiceClient();
  const priceBook = await loadPriceBook(
    supabase,
    parsed.map((i) => i.slug).filter(Boolean),
  );

  // 資料庫連得上、卻查不到購物車裡的商品 → 那些商品已經下架或被刪掉了。
  // 這時候寧可拒單也不要用前端送來的價格成交（那是使用者可以改的）。
  // supabase 為 null 是「完全沒設定環境變數」的降級模式，走原本的
  // price_unverified 路徑，不在這裡擋。
  if (supabase) {
    const missing = parsed.filter((it) => !priceBook.has(it.slug));
    if (missing.length > 0) {
      return bad(
        `購物車裡有已經下架的課程（${missing.map((m) => m.title || m.slug).join("、")}），` +
          `請回購物車移除，或加我們的 LINE ${SITE.lineId}，我們幫你處理。`,
      );
    }
  }

  // 梯次價優先於商品價。要在算 lines 之前拿到。
  const sessionPrices = await loadSessionPrices(
    supabase,
    parsed.map((i) => i.sessionId).filter((id) => UUID_RE.test(id)),
  );

  const lines: Line[] = parsed.map((it) => {
    const known = priceBook.get(it.slug);
    const fallback =
      Number.isInteger(it.snapshot) && it.snapshot >= 0 ? it.snapshot : 0;
    // 🔴 用 ?? 不是 || —— 0 元是合法的梯次價（免費場次），|| 會把它當成沒設定。
    const sessionPrice = UUID_RE.test(it.sessionId)
      ? sessionPrices.get(it.sessionId)
      : undefined;
    return {
      slug: it.slug,
      title: it.title,
      type: it.type,
      qty: it.qty,
      unit_price: sessionPrice ?? (known ? known.price : fallback),
      product_id: known?.id ?? (UUID_RE.test(it.productId) ? it.productId : null),
      session_id: UUID_RE.test(it.sessionId) ? it.sessionId : null,
      session_label: it.sessionLabel || null,
      price_unverified: !known,
    };
  });

  // ---------- 3.5 工作坊名額檢查 ----------
  const capacityError = supabase
    ? await checkSessionCapacity(supabase, lines)
    : null;
  if (capacityError) return bad(capacityError);

  const total = lines.reduce((sum, l) => sum + l.unit_price * l.qty, 0);
  const price_unverified = lines.some((l) => l.price_unverified);
  const order_no = makeOrderNo();

  // ---------- 3.8 決定訂單的主人 ----------
  //
  // session 永遠優先於 Email 查表：人都登入了就用他的身分，
  // 而且這種情況不寄「設定密碼」信（他早就有密碼了）。
  const provisioned = supabase ? await resolveOrderOwner(email, name) : null;
  const userId = provisioned?.userId ?? null;

  // ---------- 4. 寫入（失敗不擋使用者） ----------
  const orderId = supabase
    ? await persist(supabase, {
        order_no,
        payment_method,
        total,
        price_unverified,
        user_id: userId,
        name,
        phone,
        email,
        address,
        note,
        lines,
        intake,
        invoice,
      })
    : null;
  const persisted = orderId !== null;

  // ---------- 5. 排寄信（不阻塞回應） ----------
  if (orderId) {
    after(async () => {
      await queueOrderEmails({
        orderId,
        order_no,
        email,
        name,
        total,
        payment_method,
        lines,
        provisioned,
      });
      await flushOutbox();
    });
  }

  if (!persisted) {
    // 這段 log 就是唯一的補救依據：訂單沒進 DB 時，客服只能靠它把訂單補回來。
    console.error(
      "[orders] 訂單沒有寫進資料庫，請人工補建",
      JSON.stringify({
        order_no,
        payment_method,
        total,
        price_unverified,
        contact: { name, phone, email, address, note },
        lines,
      }),
    );
  }

  // ---------- 6. 線上刷卡：跟黑貓 PAY 要一個付款網址 ----------
  //
  // 這一步**必須同步等**：客人要拿到 payment_url 才付得了錢。正常 1~2 秒。
  // 失敗不擋單 —— 訂單已經是 pending 存在資料庫裡，完成頁會請他用 LINE 聯絡，
  // 客服也能在後台看到這筆。跟本檔案開頭「DB 失敗不回 500」是同一個原則：
  // 寧可讓人工補救，也不要讓客人在結帳最後一步看到錯誤。
  let payment_url: string | null = null;
  if (orderId && payment_method === "credit" && isBlackcatConfigured()) {
    const detail =
      lines.map((l) => `${l.title} x${l.qty}`).join("、") || "快樂手線上課程";
    const created = await createCreditOrder({
      orderNo: order_no,
      amount: total,
      detail,
      apnUrl: `${SITE.url}/api/payments/blackcat/apn`,
      successUrl: `${SITE.url}/api/payments/blackcat/return`,
    });

    if (created.ok) {
      payment_url = created.url;
      // supabase 在沒設 service role key 時是 null；有 orderId 就一定有它，
      // 但 TS 不知道，而且這裡也不值得為了省一個判斷去斷言。
      const { error } = supabase
        ? await supabase
            .from("orders")
            .update({
              payment_provider: "blackcat",
              payment_url: created.url,
              updated_at: new Date().toISOString(),
            })
            .eq("id", orderId)
        : { error: null };
      if (error) {
        // 網址拿到了但沒存起來：客人這次付得了款，只是關掉分頁後無法重來。
        console.error("[orders] 付款網址寫入失敗", order_no, error.message);
      }
    } else {
      console.error("[orders] 建立付款單失敗", order_no, created.reason);
    }
  }

  // 這一單佔了工作坊的位子 → 讓 /workshops 立刻重新產生，
  // 否則剩餘名額最久要等 revalidate = 300 秒才反映。
  // （佔位「過期」那一側不需要處理，靠那 5 分鐘的 ISR 自然修正就好。）
  if (orderId && lines.some((l) => l.session_id)) {
    revalidatePath("/workshops");
  }

  return NextResponse.json({
    order_no,
    total,
    persisted,
    price_unverified,
    payment_url,
  });
}

function getServiceClient() {
  if (
    !process.env.SUPABASE_SERVICE_ROLE_KEY ||
    !process.env.NEXT_PUBLIC_SUPABASE_URL
  ) {
    console.error("[orders] 缺少 Supabase 設定，這筆訂單只會回傳訂單編號");
    return null;
  }
  try {
    return createServiceClient();
  } catch (err) {
    console.error("[orders] 建立 service client 失敗", err);
    return null;
  }
}

type ServiceClient = ReturnType<typeof createServiceClient>;

/**
 * 工作坊名額檢查。
 *
 * 在此之前這支 API 完全不看名額 —— 場次標成「已額滿」照樣收得到訂單，
 * 客服要到標記收款那一刻才會發現人數對不上（那時候人已經付錢了）。
 *
 * 可用名額 = capacity − seats_taken − 尚未付款但已下單的數量
 *
 * 「尚未付款但已下單」要算進去：這站是 ATM／人工匯款，從下單到客服標記收款
 * 中間可能隔好幾天，那段時間位子已經被佔住了。
 *
 * ⚠️ 已知限制：這是「檢查後再寫入」，兩筆同時打進來仍可能雙雙通過
 * （中間沒有鎖）。要完全杜絕得走 reserve_seat() 那套 15 分鐘暫扣，
 * 那會改到整個結帳流程。以目前的規模（小班制、每月幾場）這個殘餘風險
 * 遠小於「完全不檢查」，而且客服在標記收款時還有第二道提示。
 */
async function checkSessionCapacity(
  supabase: ServiceClient,
  lines: Line[],
): Promise<string | null> {
  // 同一場次在購物車裡出現多次要合併計算
  const wanted = new Map<string, number>();
  for (const l of lines) {
    if (!l.session_id) continue;
    wanted.set(l.session_id, (wanted.get(l.session_id) ?? 0) + l.qty);
  }
  if (wanted.size === 0) return null;

  const ids = [...wanted.keys()];

  try {
    const { data: sessions, error } = await supabase
      .from("workshop_sessions")
      .select("id, capacity, seats_taken, status, starts_at")
      .in("id", ids);
    if (error) {
      console.error("[orders] 讀場次失敗，略過名額檢查", error.message);
      return null; // 讀不到就不擋，寧可讓客服事後處理也不要擋掉真的想報名的人
    }

    // 已下單但還沒付款、且還在佔位時效內的數量。
    //
    // 走 workshop_holds() RPC 而不是自己查 order_items，是為了跟前台顯示
    // （lib/data.ts → session-row.tsx）用**同一個定義**。這兩邊曾經各算各的：
    // 前台是 capacity - seats_taken，這裡是 capacity - seats_taken - 所有 pending，
    // 於是頁面說剩 4 位、結帳卻說滿了。
    //
    // 時效由 seat_hold_window()（目前 30 分鐘）決定 —— 沒有它的話，客人下單
    // 不付款就會把位子永遠佔住，而原本設計來回收的 seat_holds 表
    // 從來沒有被寫入過。
    const pending = new Map<string, number>();
    const { data: holdRows, error: holdError } =
      await supabase.rpc("workshop_holds");
    if (holdError) {
      console.error("[orders] workshop_holds 失敗，改用保守值", holdError.message);
    } else {
      for (const h of (holdRows ?? []) as {
        session_id: string;
        held: number;
      }[]) {
        if (ids.includes(h.session_id)) pending.set(h.session_id, h.held);
      }
    }

    for (const s of (sessions ?? []) as {
      id: string;
      capacity: number;
      seats_taken: number;
      status: string;
      starts_at: string;
    }[]) {
      const want = wanted.get(s.id) ?? 0;

      if (s.status === "cancelled") {
        return `這一場工作坊已經取消了，請回工作坊頁面看看其他場次，或加我們的 LINE ${SITE.lineId}，我們幫你安排。`;
      }
      if (s.status === "closed") {
        return `這一場工作坊已經停止報名了，請加我們的 LINE ${SITE.lineId}，我們幫你看看還有沒有位子。`;
      }
      /*
        🔴 已經開課的場次不能再收錢。

        前台（lib/data.ts）現在只列 starts_at 還沒到的場次，但那擋不住已經
        在購物車裡的：購物車存在 localStorage，上個月加進去的梯次今天照樣
        按得下去。這裡是最後一道，界線跟前台同一條（starts_at vs 現在）。

        select 從一開始就把 starts_at 撈出來了，只是沒有人用它。
      */
      if (new Date(s.starts_at).getTime() <= Date.now()) {
        return `這一場工作坊已經開課了，請回工作坊頁面看看其他場次，或加我們的 LINE ${SITE.lineId}，我們幫你安排。`;
      }

      const available = s.capacity - s.seats_taken - (pending.get(s.id) ?? 0);
      if (want > available) {
        return available <= 0
          ? `這一場工作坊的位子已經滿了。加我們的 LINE ${SITE.lineId} 可以登記候補，有人取消我們會通知你。`
          : `這一場工作坊只剩 ${available} 個位子，你選了 ${want} 個。請調整人數，或加我們的 LINE ${SITE.lineId}，我們幫你想辦法。`;
      }
    }

    // 購物車裡有場次 id 但資料庫查不到 → 那個場次被刪了
    const found = new Set((sessions ?? []).map((s: { id: string }) => s.id));
    if (ids.some((id) => !found.has(id))) {
      return `購物車裡有已經不存在的工作坊場次，請回工作坊頁面重新選一次。`;
    }

    return null;
  } catch (err) {
    console.error("[orders] 名額檢查例外，略過", err);
    return null;
  }
}

/**
 * 商品價格表。**只認資料庫**。
 *
 * 舊版會先鋪 lib/content.ts 的靜態價格再讓 DB 覆蓋。那在還沒有後台的時候
 * 是合理的保險，但現在後台可以改價了，靜態價就變成一顆定時炸彈：
 * 商品下架或改價之後，靜態價仍然查得到，於是會用一個過期的金額真的收錢。
 *
 * 查不到就是查不到，讓呼叫端拒單 —— 少賣一筆的代價遠低於收錯錢。
 */
/**
 * 各梯次自己的價格。
 *
 * 🔴 同一門工作坊的不同梯次價格可以差很多（客戶現有站上從 1,200 到 12,800 都有），
 *    所以 workshop_sessions.price 有值時**優先於** products.price。
 *    漏掉這一支就是照商品定價收錢 —— 客人選了 1,200 的梯次卻被扣 12,000。
 *
 * null 代表這一梯沒有自訂價，回退商品價。**0 是合法價格**（免費場次），
 * 所以呼叫端一定要用 `??` 而不是 `||` 來取值。
 */
async function loadSessionPrices(
  supabase: ServiceClient | null,
  sessionIds: string[],
) {
  const prices = new Map<string, number>();
  const wanted = [...new Set(sessionIds.filter(Boolean))];
  if (!supabase || wanted.length === 0) return prices;

  try {
    const { data, error } = await supabase
      .from("workshop_sessions")
      .select("id,price")
      .in("id", wanted);
    if (error) {
      // 讀不到就回退商品價。不擋單 —— 但要留 log，因為金額可能不是客人看到的那個。
      console.error("[orders] 讀場次價格失敗，改用商品定價", error.message);
      return prices;
    }
    for (const row of (data ?? []) as { id: string; price: number | null }[]) {
      if (typeof row.price === "number") prices.set(row.id, row.price);
    }
  } catch (err) {
    console.error("[orders] 讀場次價格例外", err);
  }
  return prices;
}

async function loadPriceBook(supabase: ServiceClient | null, slugs: string[]) {
  const wanted = new Set(slugs);
  const book = new Map<string, { id: string | null; price: number }>();

  if (!supabase || wanted.size === 0) return book;

  try {
    const { data, error } = await supabase
      .from("products")
      .select("id,slug,price")
      .in("slug", [...wanted]);
    if (error) {
      console.error("[orders] 讀 products 失敗", error.message);
      return book;
    }
    for (const row of (data ?? []) as {
      id: string;
      slug: string;
      price: number;
    }[]) {
      if (typeof row.price === "number") {
        book.set(row.slug, { id: row.id, price: row.price });
      }
    }
  } catch (err) {
    console.error("[orders] 讀 products 例外", err);
  }

  return book;
}

/**
 * 寫入 orders + order_items。
 * orders 先試「含聯絡資料」的完整欄位；若 schema 還沒有那些欄位（PGRST204 / 42703），
 * 退回 STACK.md §3 定義的基本欄位再試一次，兩次都不行才放棄。
 */
async function persist(
  supabase: ServiceClient,
  o: {
    order_no: string;
    payment_method: string;
    total: number;
    price_unverified: boolean;
    user_id: string | null;
    name: string;
    phone: string;
    email: string;
    address: string;
    note: string;
    lines: Line[];
    intake: {
      intake_experience: string | null;
      intake_goal: string | null;
      intake_source: string | null;
      health_ack_at: string | null;
    };
    invoice: {
      invoice_carrier_type: string;
      invoice_carrier_id: string | null;
      invoice_tax_id: string | null;
      invoice_title: string | null;
    };
  },
) {
  const base = {
    order_no: o.order_no,
    status: "pending",
    payment_method: o.payment_method,
    total: o.total,
  };

  // 欄位名對照過線上 orders 表（contact_* 而不是 customer_*）
  //
  // user_id 一次就寫進去，不做 insert-then-update：中間任何一步失敗都會留下
  // 一筆沒有主人的訂單，而那正是我們要消滅的狀態。綁不到就是 null，
  // 交給 claim_guest_orders() / backfill_order_user_ids() 補。
  const rich = {
    ...base,
    user_id: o.user_id,
    contact_name: o.name,
    contact_phone: o.phone,
    contact_email: o.email,
    shipping_address: o.address || null,
    note: o.note || null,
    price_unverified: o.price_unverified,
    // 報名問題（工作坊才會有值）。放在 rich 而不是 base：
    // base 是「連 contact_* 都寫不進去時」的退路，那種情況下這幾欄更不可能寫得進去。
    ...o.intake,
    /*
      發票的載具／統編。同樣放在 rich 不放 base。
      ⚠️ 掉到 base 那條退路的訂單會沒有載具資料，開票時 carrier_type 會是 null
         → issue.ts 視同 cloud（雲端發票）。這是刻意的：寧可開一張雲端發票
         讓客人事後歸戶，也不要因為載具寫不進去就整張訂單開不成。
    */
    ...o.invoice,
  };

  let orderId: string | null = null;

  for (const row of [rich, base]) {
    const { data, error } = await supabase
      .from("orders")
      .insert(row)
      .select("id")
      .single();

    if (!error && data?.id) {
      orderId = data.id as string;
      if (row === base) {
        // 退回基本欄位＝聯絡資料沒進 DB，只能靠這行 log 找回來
        console.error(
          "[orders] orders 表沒有聯絡資料欄位，只寫入基本欄位；聯絡方式請人工補上",
          JSON.stringify({
            order_no: o.order_no,
            contact: {
              name: o.name,
              phone: o.phone,
              email: o.email,
              address: o.address,
              note: o.note,
            },
          }),
        );
      }
      break;
    }
    console.error("[orders] 寫入 orders 失敗", o.order_no, error?.message);
  }

  if (!orderId) return false;

  const { error: itemsError } = await supabase.from("order_items").insert(
    o.lines.map((l) => ({
      order_id: orderId,
      product_id: l.product_id,
      session_id: l.session_id,
      unit_price: l.unit_price,
      qty: l.qty,
    })),
  );

  if (itemsError) {
    console.error(
      "[orders] order_items 寫入失敗，訂單只有主檔沒有明細",
      o.order_no,
      orderId,
      itemsError.message,
    );
    return null;
  }

  return orderId;
}

/* ------------------------------------------------------------- 訂單的主人 */

type Provisioned = { userId: string; created: boolean };

/**
 * 已登入就用 session 的身分；否則用客人填的 Email 找帳號或建一個。
 *
 * 回 null 代表這次沒能綁定 —— **訂單照樣要成立**。這一步失敗是自癒的：
 * claim_guest_orders()（登入即認領）與 backfill_order_user_ids()（worker
 * 每小時）都會用 contact_email 把它補回來。
 */
async function resolveOrderOwner(
  email: string,
  name: string,
): Promise<Provisioned | null> {
  try {
    const session = await createClient();
    const { data } = await session.auth.getUser();
    if (data.user?.id) {
      // created: false → 不寄「設定密碼」信。人都登入了，他有密碼。
      return { userId: data.user.id, created: false };
    }
  } catch {
    // 沒有 cookie 或環境變數不全都會走到這裡，當作訪客往下走
  }

  return findOrCreateUser(email, name);
}

/* --------------------------------------------------------------- 排寄信 */

/** 全站每小時的「設定密碼」信上限。跨 instance 的斷路器，見檔頭第 3 段。 */
async function setupEmailQuotaLeft(): Promise<boolean> {
  try {
    const db = createServiceClient();
    const since = new Date(Date.now() - 60 * 60_000).toISOString();
    const { count, error } = await db
      .from("email_outbox")
      .select("id", { count: "exact", head: true })
      .like("dedupe_key", "account_setup:%")
      .gte("created_at", since);

    if (error) {
      // 查不到就保守放行：這道閘是斷路器不是主要防線（主要防線是 dedupe_key
      // 的 unique），因為查詢失敗就完全不寄信，代價比較大。
      console.error("[orders] setup 信配額查詢失敗，這次放行", error.message);
      return true;
    }
    if ((count ?? 0) >= SETUP_EMAIL_HOURLY_CAP) {
      console.error(
        `[orders] 🔴 一小時內已排入 ${count} 封設定密碼信，超過上限 ${SETUP_EMAIL_HOURLY_CAP}，暫停寄送。請檢查是否被濫用。`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error("[orders] setup 信配額例外，這次放行", err);
    return true;
  }
}

/**
 * 這些場次的上課時間與地點，給確認信用。
 *
 * 🔴 只認資料庫。購物車帶上來的 `session_label` 是客戶端字串，客人改得動，
 *    而這封信是他唯一會收到的「哪天去哪裡」—— 寫錯就是白跑一趟。
 *
 * 查不到就回空 Map，信照寄（少了上課資訊總比整封不寄好）。這支跑在 after()
 * 裡，任何失敗都不該影響已經成立的訂單。
 */
async function loadSessionDetails(
  sessionIds: readonly string[],
): Promise<Map<string, EmailSessionInfo>> {
  const out = new Map<string, EmailSessionInfo>();
  const wanted = [...new Set(sessionIds.filter(Boolean))];
  if (wanted.length === 0) return out;

  try {
    const db = createServiceClient();
    if (!db) return out;
    const { data, error } = await db
      .from("workshop_sessions")
      .select("id,starts_at,ends_at,location,address,format")
      .in("id", wanted);
    if (error) {
      console.error("[orders] 讀場次明細失敗，確認信將不含上課資訊", error.message);
      return out;
    }
    for (const row of (data ?? []) as {
      id: string;
      starts_at: string;
      ends_at: string;
      location: string | null;
      address: string | null;
      format: string | null;
    }[]) {
      const { month, day, weekday } = twDate(row.starts_at);
      const m = month.replace(/\s+/g, "").replace(/月+$/, "月");
      const d = day.replace(/日+$/, "");
      out.set(row.id, {
        when: `${m}${d}日（${weekday}）${timeRange(row.starts_at, row.ends_at)}`,
        location: row.location,
        address: row.address,
        // 線上場次不寄地址（見 templates.ts）。未指定 = 實體。
        format: normalizeFormat(row.format),
      });
    }
  } catch (err) {
    console.error("[orders] 讀場次明細例外", err);
  }
  return out;
}

async function queueOrderEmails(input: {
  orderId: string;
  order_no: string;
  email: string;
  name: string;
  total: number;
  payment_method: string;
  lines: Line[];
  provisioned: Provisioned | null;
}) {
  // 1. 訂單成立通知
  const sessionInfo = await loadSessionDetails(
    input.lines.flatMap((l) => (l.session_id ? [l.session_id] : [])),
  );
  await enqueueEmail({
    dedupeKey: `order_created:${input.orderId}`,
    ...orderCreatedEmail({
      to: input.email,
      name: input.name,
      orderNo: input.order_no,
      total: input.total,
      paymentMethod: input.payment_method,
      items: input.lines.map((l) => ({
        title: l.title,
        qty: l.qty,
        session: l.session_id ? (sessionInfo.get(l.session_id) ?? null) : null,
      })),
    }),
  });

  // 2. 設定密碼信 —— 只在帳號是這一單新建的時候寄（閘 A）
  if (!input.provisioned?.created) return;

  // SETUP_EMAIL_ON=paid 可以把這封信改成「客服標記收款時才寄」。
  // 那等於把寄信放進客服的迴圈裡，濫用可能性歸零，是出事當天的緊急開關。
  if ((process.env.SETUP_EMAIL_ON ?? "order") !== "order") return;

  if (!(await setupEmailQuotaLeft())) return;

  const link = await generateSetupLink(input.email);
  if (!link) return;

  const orderDate = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "long",
    day: "numeric",
  }).format(new Date());

  await enqueueEmail({
    // 綁 user_id 而不是 order_id：同一個人第二次下單不該再收一次設定密碼信。
    // 這個 unique 鍵就是閘 B。
    dedupeKey: `account_setup:${input.provisioned.userId}`,
    ...accountSetupEmail({
      to: input.email,
      name: input.name,
      link,
      orderNo: input.order_no,
      orderDate,
    }),
  });
}
