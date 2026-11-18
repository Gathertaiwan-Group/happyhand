import "server-only";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * 訂單的讀取查詢。
 *
 * 從 app/admin/orders/page.tsx 抽出來的 —— 原本整段鎖在 page component 裡，
 * 只有那一頁用得到。抽出來是為了讓 /api/mcp 用**同一份**查詢，而不是另寫一份
 * 條件稍微不一樣的（roster 那邊的教訓：報名名單只能有一個定義）。
 *
 * 讀取一律走 service role：orders 的 RLS 只開放 `auth.uid() = user_id` 的
 * select，而全站是訪客結帳（/api/orders 從不寫 user_id），用使用者自己的
 * client 查會是空的。**授權是呼叫端的責任** —— 這裡不做任何權限檢查。
 */

export type Db = ReturnType<typeof createServiceClient>;

/** 一次最多撈幾筆。超過的話呼叫端要明講，不可以靜默截斷。 */
export const ORDERS_LIMIT = 100;

export type OrderListRow = {
  id: string;
  order_no: string;
  status: string;
  payment_method: string | null;
  total: number;
  price_unverified: boolean | null;
  contact_name: string | null;
  contact_phone: string | null;
  created_at: string;
};

/**
 * 把搜尋字串洗成可以安全放進 PostgREST or= 運算式的內容。
 *
 * ⚠️ 這一段是必要的，不是保險。PostgREST 的 or= 是用逗號分隔條件、
 *    用小數點分隔「欄位.運算子.值」的**字串**語法，值沒有被參數化。
 *    使用者搜尋 `a,status.eq.paid` 就會多長出一個 OR 條件；
 *    搜尋 `*` 會變成萬用字元把整張表撈出來；
 *    括號會讓運算式解析失敗直接 500。
 *    所以這裡把所有在該語法裡有意義的字元換成空白。
 *
 * 🔴 抽出來的時候刻意把它移到 loadOrders() **裡面**呼叫。原本是 page.tsx
 *    自己先洗再傳進來，那表示任何新的呼叫端（例如 MCP）只要忘記洗一次，
 *    就直接把注入面打開。現在洗不洗由查詢自己保證，呼叫端漏不掉。
 *    重複呼叫是冪等的（第一次之後那些字元已經不存在）。
 */
export function sanitizeSearch(raw: string): string {
  return raw
    .replace(/[,.()*%\\"'`:<>=!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function loadOrders({
  status,
  paymentMethod,
  search,
}: {
  status: string;
  paymentMethod: string;
  search: string;
}): Promise<{ rows: OrderListRow[]; matched: number | null; error: string }> {
  const empty = { rows: [] as OrderListRow[], matched: null };

  let supabase: Db;
  try {
    supabase = createServiceClient();
  } catch (err) {
    console.error("[admin/orders] service client 建立失敗", err);
    return { ...empty, error: "資料庫連線未設定，請聯絡工程師檢查伺服器環境變數。" };
  }

  try {
    // count: "exact" 是為了知道「有沒有被 LIMIT 截掉」。
    // 沒有它就只能靠「剛好回 100 筆」來猜，剛好 100 筆的時候會猜錯。
    let query = supabase
      .from("orders")
      .select(
        "id, order_no, status, payment_method, total, price_unverified, contact_name, contact_phone, created_at",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .limit(ORDERS_LIMIT);

    if (status) query = query.eq("status", status);
    if (paymentMethod) query = query.eq("payment_method", paymentMethod);

    const safe = sanitizeSearch(search ?? "");
    if (safe) {
      query = query.or(`order_no.ilike.%${safe}%,contact_phone.ilike.%${safe}%`);
    }

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);

    return {
      rows: (data ?? []) as OrderListRow[],
      matched: typeof count === "number" ? count : null,
      error: "",
    };
  } catch (err) {
    console.error("[admin/orders] 訂單查詢失敗", err);
    return { ...empty, error: "訂單讀取失敗。" };
  }
}

export type OrderItemRow = {
  productTitle: string | null;
  sessionId: string | null;
  unitPrice: number;
  qty: number;
  /** 場次資訊（後台訂單頁「品項」區塊顯示的那幾項）。沒有場次是 null。 */
  session: {
    startsAt: string | null;
    endsAt: string | null;
    location: string | null;
    address: string | null;
  } | null;
};

export type OrderDetail = {
  id: string;
  orderNo: string;
  status: string;
  paymentMethod: string | null;
  total: number;
  priceUnverified: boolean | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  /** 寄送地址（後台訂單頁「聯絡資訊」有顯示） */
  shippingAddress: string | null;
  /** 客人下單時的備註 */
  note: string | null;
  /** 綁定的會員帳號 id。給程式判斷用，MCP 不回傳給 AI。 */
  userId: string | null;
  /** 發票載具／統編（後台訂單頁「電子發票」區塊有顯示） */
  invoiceRequest: {
    carrierType: string | null;
    carrierId: string | null;
    taxId: string | null;
    title: string | null;
  };
  items: OrderItemRow[];
  invoice: {
    status: string;
    invoiceNumber: string | null;
    randomCode: string | null;
    issuedAt: string | null;
    voidedAt: string | null;
    retryCount: number | null;
    lastError: string | null;
  } | null;
};

/**
 * 單筆訂單明細。可以用訂單編號（HH-…）或 UUID 查。
 *
 * 為什麼接受訂單編號：客服與客人之間講的是 `HH-20260831-AHM4`，沒有人會報
 * UUID。要求呼叫端先查一次 id 只是把同一件事做兩趟。
 */
export async function loadOrderDetail(
  db: Db,
  orderNoOrId: string,
): Promise<OrderDetail | null> {
  const key = orderNoOrId.trim();
  if (!key) return null;

  // UUID 走 id，其餘一律當訂單編號。用 eq 不用 ilike —— 這裡不做模糊比對，
  // 模糊比對是 loadOrders 的事。
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);

  const { data, error } = await db
    .from("orders")
    .select(
      "id, order_no, status, payment_method, total, price_unverified, paid_at, created_at, updated_at," +
        " user_id, contact_name, contact_phone, contact_email, shipping_address, note," +
        " invoice_carrier_type, invoice_carrier_id, invoice_tax_id, invoice_title," +
        " order_items(unit_price, qty, session_id, products(title), workshop_sessions(starts_at, ends_at, location, address))," +
        " invoices(status, invoice_number, random_code, issued_at, voided_at, retry_count, last_error)",
    )
    .eq(isUuid ? "id" : "order_no", key)
    .maybeSingle();

  if (error) {
    console.error("[admin/orders] 訂單明細查詢失敗", error.message);
    return null;
  }
  if (!data) return null;

  // PostgREST 的型別推導碰到多層內嵌會推出 GenericStringError，先過 unknown。
  const row = data as unknown as Record<string, unknown>;

  /** PostgREST 的內嵌關聯有時是物件、有時是陣列（同 sessions/queries.ts 的處理） */
  const pickOne = <T,>(value: T | T[] | null | undefined): T | null =>
    Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

  type SessionEmbed = { starts_at: string | null; ends_at: string | null; location: string | null; address: string | null };
  const items = ((row.order_items ?? []) as Record<string, unknown>[]).map((it) => {
    const session = pickOne(it.workshop_sessions as SessionEmbed | SessionEmbed[] | null);
    return {
      productTitle:
        (pickOne(it.products as { title: string } | { title: string }[] | null)?.title) ??
        null,
      sessionId: (it.session_id as string | null) ?? null,
      unitPrice: Number(it.unit_price ?? 0),
      qty: Number(it.qty ?? 0),
      session: session
        ? {
            startsAt: session.starts_at ?? null,
            endsAt: session.ends_at ?? null,
            location: session.location ?? null,
            address: session.address ?? null,
          }
        : null,
    };
  });

  const inv = pickOne(
    row.invoices as Record<string, unknown> | Record<string, unknown>[] | null,
  );

  return {
    id: String(row.id),
    orderNo: String(row.order_no),
    status: String(row.status),
    paymentMethod: (row.payment_method as string | null) ?? null,
    total: Number(row.total ?? 0),
    priceUnverified: (row.price_unverified as boolean | null) ?? null,
    paidAt: (row.paid_at as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: (row.updated_at as string | null) ?? null,
    contactName: (row.contact_name as string | null) ?? null,
    contactPhone: (row.contact_phone as string | null) ?? null,
    contactEmail: (row.contact_email as string | null) ?? null,
    shippingAddress: (row.shipping_address as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    userId: (row.user_id as string | null) ?? null,
    invoiceRequest: {
      carrierType: (row.invoice_carrier_type as string | null) ?? null,
      carrierId: (row.invoice_carrier_id as string | null) ?? null,
      taxId: (row.invoice_tax_id as string | null) ?? null,
      title: (row.invoice_title as string | null) ?? null,
    },
    items,
    invoice: inv
      ? {
          status: String(inv.status),
          invoiceNumber: (inv.invoice_number as string | null) ?? null,
          randomCode: (inv.random_code as string | null) ?? null,
          issuedAt: (inv.issued_at as string | null) ?? null,
          voidedAt: (inv.voided_at as string | null) ?? null,
          retryCount: (inv.retry_count as number | null) ?? null,
          lastError: (inv.last_error as string | null) ?? null,
        }
      : null,
  };
}

/* ------------------------------------------------------ 綁定的帳號與已開通課程 */

export type OrderAccountLink = {
  /** 綁定帳號的登入 Email（可能跟訂單聯絡 Email 不同）。沒綁或讀不到是 null。 */
  accountEmail: string | null;
  /** 這張訂單開給這個帳號的課 */
  entitlements: { productId: string; title: string; expiresAt: string | null }[];
};

/**
 * 「訂單 → 帳號 → 已開通課程」這條鏈。後台訂單頁（loadAccountInfo）與 MCP 的 get_order 共用。
 *
 * 帳號 Email 用 getUserById 單筆查，不用 admin/staff 那支 loadUserEmailIndex()
 * ——後者會把全站帳號掃一遍建索引，這裡只要一個人。
 *
 * 任何一步失敗都只記 log、回空值：這是輔助資訊，壞掉不該讓整頁（或整個工具）掛掉。
 */
export async function loadOrderAccountLink(
  db: Db,
  orderId: string,
  userId: string | null,
): Promise<OrderAccountLink> {
  let accountEmail: string | null = null;
  if (userId) {
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (error) {
      console.error("[admin/orders] 讀取帳號失敗", userId, error.message);
    } else {
      accountEmail = data.user?.email ?? null;
    }
  }

  let entitlements: OrderAccountLink["entitlements"] = [];
  if (userId) {
    const { data, error } = await db
      .from("entitlements")
      .select("product_id, expires_at, products(title)")
      .eq("user_id", userId)
      .eq("order_id", orderId);

    if (error) {
      console.error("[admin/orders] 讀取開通紀錄失敗", orderId, error.message);
    } else {
      entitlements = (data ?? []).map((row) => {
        const raw = row.products as { title: string | null } | { title: string | null }[] | null;
        const product = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
        return {
          productId: row.product_id as string,
          title: product?.title ?? "（商品已刪除）",
          expiresAt: (row.expires_at as string | null) ?? null,
        };
      });
    }
  }

  return { accountEmail, entitlements };
}
