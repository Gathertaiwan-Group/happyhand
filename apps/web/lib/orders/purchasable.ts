import { SITE } from "@/lib/site";

/**
 * 下單前的「這些東西現在能不能賣」檢查，以及伺服器端的價格表。
 *
 * 🔴 為什麼要有這一支（2026-11-15）：
 *    /api/orders 原本用 slug 查 products 拿價格時**沒有看 is_published**，
 *    查場次價格時也沒有看場次屬於哪一門課。而 service role 不受 RLS 限制，
 *    所以草稿商品照樣查得到、照樣成交：
 *      · MCP 新建的課程一律是草稿，沒給代稱時會自動產生 workshop-20261115
 *        這種很好猜的 slug；
 *      · 直接打 /api/orders 帶這個 slug（或把草稿商品的場次 id 掛在任一門
 *        已上架課程底下），就能用業主還沒定案的價格下單、刷卡、
 *        付款後 grant_entitlements_for_order 也照樣開通（它不看 is_published）。
 *
 *    現在的規則，全部以資料庫為準、不信任前端：
 *      1. 每一個品項的 slug 都要查得到，而且 products.is_published = true
 *      2. 帶了場次的品項，場次必須存在，而且 workshop_sessions.product_id
 *         必須就是這個品項的商品（= 已上架的那一門）
 *      3. 查詢失敗一律拒單（fail closed）：少賣一筆的代價遠低於收錯錢
 *
 *    已經放在購物車（localStorage）裡、後來被下架的商品，送出時一樣會被擋。
 */

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 只用到 supabase-js 的這一小段，測試可以餵假的 */
export type PurchasableDb = {
  from(table: string): {
    select(columns: string): {
      in(
        column: string,
        values: readonly string[],
      ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
    };
  };
};

export type PurchasableItem = {
  slug: string;
  title: string;
  /** 不是 UUID 就視為沒選場次（跟 /api/orders 原本的規則一樣） */
  sessionId: string;
};

export type PriceBook = Map<string, { id: string; price: number }>;

export type PurchasableResult =
  | { ok: true; priceBook: PriceBook; sessionPrices: Map<string, number> }
  | { ok: false; message: string };

const LINE = () => `加我們的 LINE ${SITE.lineId}，我們幫你處理`;

export function notForSaleMessage(names: string[]): string {
  return `這門課目前沒有開放購買（${names.join("、")}）。請回購物車移除，或${LINE()}。`;
}

export async function checkPurchasable(
  db: PurchasableDb,
  items: readonly PurchasableItem[],
): Promise<PurchasableResult> {
  const unavailable = (): PurchasableResult => ({
    ok: false,
    message: `現在暫時無法確認課程資料，請稍後再試一次，或${LINE()}。`,
  });

  // ---------- 1. 商品：要存在，而且已上架 ----------
  const slugs = [...new Set(items.map((i) => i.slug).filter(Boolean))];
  const priceBook: PriceBook = new Map();
  const published = new Set<string>();

  if (slugs.length > 0) {
    try {
      const { data, error } = await db
        .from("products")
        .select("id,slug,price,is_published")
        .in("slug", slugs);
      if (error) {
        console.error("[orders] 讀 products 失敗", error.message);
        return unavailable();
      }
      for (const row of (Array.isArray(data) ? data : []) as {
        id: string;
        slug: string;
        price: unknown;
        is_published: unknown;
      }[]) {
        if (typeof row.price !== "number") continue;
        priceBook.set(row.slug, { id: row.id, price: row.price });
        // 只認嚴格的 true：null／undefined（欄位沒撈到）都當作沒上架
        if (row.is_published === true) published.add(row.slug);
      }
    } catch (err) {
      console.error("[orders] 讀 products 例外", err);
      return unavailable();
    }
  }

  const missing = items.filter((it) => !priceBook.has(it.slug));
  if (missing.length > 0) {
    return {
      ok: false,
      message:
        `購物車裡有已經下架的課程（${missing.map((m) => m.title || m.slug || "未命名").join("、")}），` +
        `請回購物車移除，或${LINE()}。`,
    };
  }

  const drafts = items.filter((it) => !published.has(it.slug));
  if (drafts.length > 0) {
    return {
      ok: false,
      message: notForSaleMessage([...new Set(drafts.map((d) => d.title || d.slug))]),
    };
  }

  // ---------- 2. 場次：要存在，而且屬於這一行的（已上架）商品 ----------
  const sessionPrices = new Map<string, number>();
  const withSession = items.filter((it) => UUID_RE.test(it.sessionId));
  const ids = [...new Set(withSession.map((it) => it.sessionId))];
  if (ids.length === 0) return { ok: true, priceBook, sessionPrices };

  const owner = new Map<string, string>();
  try {
    const { data, error } = await db
      .from("workshop_sessions")
      .select("id,price,product_id")
      .in("id", ids);
    if (error) {
      // 以前這裡讀不到會「回退商品價」繼續成交；現在場次歸屬也靠這一查，
      // 讀不到就無法確認場次是不是草稿商品的，只能拒單。
      console.error("[orders] 讀場次失敗", error.message);
      return unavailable();
    }
    for (const row of (Array.isArray(data) ? data : []) as {
      id: string;
      price: unknown;
      product_id: string;
    }[]) {
      owner.set(row.id, row.product_id);
      // null = 這一梯沒有自訂價，回退商品價。0 是合法價格（免費場次）。
      if (typeof row.price === "number") sessionPrices.set(row.id, row.price);
    }
  } catch (err) {
    console.error("[orders] 讀場次例外", err);
    return unavailable();
  }

  for (const it of withSession) {
    const productId = owner.get(it.sessionId);
    if (productId === undefined) {
      return {
        ok: false,
        message: "購物車裡有已經不存在的工作坊場次，請回工作坊頁面重新選一次。",
      };
    }
    if (productId !== priceBook.get(it.slug)?.id) {
      // 場次掛在別的商品底下 —— 正常的購物車不會發生（加入購物車時 slug 與
      // 場次來自同一門課），只有手動拼請求才會。那個商品可能是草稿。
      return { ok: false, message: notForSaleMessage([it.title || it.slug]) };
    }
  }

  return { ok: true, priceBook, sessionPrices };
}
