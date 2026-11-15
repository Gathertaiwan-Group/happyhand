import type { createServiceClient } from "@/lib/supabase/server";
import {
  toProductType,
  toSessionStatus,
  type BlockRow,
  type LessonRow,
  type ProductRow,
  type ProductType,
  type SessionRow,
} from "./shared";

/**
 * 課程／工作坊的讀取查詢。
 *
 * 原本寫在三個頁面裡（courses/page.tsx、workshops/page.tsx、products/[id]/page.tsx），
 * 抽出來是為了讓 MCP 的 list_products／get_product 讀的是**同一支查詢** ——
 * 不然 AI 看到的「這門課有哪些單元」跟後台畫面會是兩套各自維護的 select。
 *
 * 全部收一個 service client 當參數、零 next/*：頁面、route handler 與單元測試都呼叫得動。
 * 授權**不在這裡**：呼叫端自己 requireCapability("catalog:read")。
 */

type Db = ReturnType<typeof createServiceClient>;

/** products 的完整欄位（編輯頁與 updateProduct 的 before 用同一串）。 */
export const PRODUCT_COLUMNS =
  "id, type, slug, title, subtitle, description, price, compare_at_price, cover_url, is_published, is_featured, tags, benefits, sort_order, hero_lead, suitable_for, not_suitable_for, outcomes, curriculum_online, curriculum_onsite, includes, notes, asks_intake";

/* ------------------------------------------------------------ 清單 */

export type ProductListRow = {
  id: string;
  type: ProductType;
  slug: string;
  title: string;
  price: number;
  is_published: boolean;
  sort_order: number;
  lessonCount: number;
  sessionCount: number;
};

/**
 * 商品清單（含單元數與場次數）。
 *
 * course_lessons(count) / workshop_sessions(count) 是 PostgREST 的
 * 內嵌聚合，一次往返就拿到每門課的單元數與場次數。
 */
export async function loadProductList(
  db: Db,
  opts: { types: readonly ProductType[]; published?: boolean },
): Promise<ProductListRow[]> {
  let query = db
    .from("products")
    .select(
      "id, type, slug, title, price, is_published, sort_order, course_lessons(count), workshop_sessions(count)",
    )
    .in("type", [...opts.types])
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (opts.published !== undefined) query = query.eq("is_published", opts.published);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  type Raw = {
    id: string;
    type: string;
    slug: string;
    title: string;
    price: number;
    is_published: boolean;
    sort_order: number;
    course_lessons: { count: number }[] | null;
    workshop_sessions: { count: number }[] | null;
  };

  return ((data ?? []) as unknown as Raw[]).map((raw) => ({
    id: raw.id,
    type: toProductType(raw.type),
    slug: raw.slug,
    title: raw.title,
    price: raw.price,
    is_published: raw.is_published,
    sort_order: raw.sort_order,
    lessonCount: raw.course_lessons?.[0]?.count ?? 0,
    sessionCount: raw.workshop_sessions?.[0]?.count ?? 0,
  }));
}

/* ------------------------------------------------------- 工作坊清單 */

export type WorkshopProductRaw = {
  id: string;
  type: string;
  slug: string;
  title: string;
  price: number;
  is_published: boolean;
  workshop_sessions:
    | {
        id: string;
        starts_at: string;
        ends_at: string;
        location: string | null;
        capacity: number;
        seats_taken: number;
        status: string;
      }[]
    | null;
};

/**
 * 全部商品 + 內嵌的場次（場次本身的欄位）。
 *
 * 只是原始資料：哪些算「工作坊」（type 是 workshop **或** 有場次）、
 * 過去場次怎麼篩，由 workshops/page.tsx 決定 —— 那段判準跟
 * products/[id]/page.tsx 的 showSessions 綁在一起，留在頁面上。
 */
export async function loadWorkshopProducts(db: Db): Promise<WorkshopProductRaw[]> {
  const { data, error } = await db
    .from("products")
    .select(
      "id, type, slug, title, price, is_published, sort_order, " +
        "workshop_sessions(id, starts_at, ends_at, location, capacity, seats_taken, status)",
    )
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as WorkshopProductRaw[];
}

/* ------------------------------------------------------------ 明細 */

export type ProductDetail = {
  product: ProductRow;
  lessons: LessonRow[];
  sessions: SessionRow[];
  blocks: BlockRow[];
};

/** 只讀 products 一列。找不到回 null。 */
export async function loadProductRow(db: Db, id: string): Promise<ProductRow | null> {
  const { data, error } = await db.from("products").select(PRODUCT_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const raw = data as unknown as ProductRow & { type: string };
  return { ...raw, type: toProductType(raw.type) };
}

/**
 * 一門課的完整內容：主檔 + 單元（含講義插圖）+ 場次 + 內容區塊。
 * 找不到回 null（呼叫端決定是 notFound() 還是回一句話）。
 */
export async function loadProductDetail(db: Db, id: string): Promise<ProductDetail | null> {
  const product = await loadProductRow(db, id);
  if (!product) return null;

  const [lessonResult, sessionResult, blockResult] = await Promise.all([
    db
      .from("course_lessons")
      .select(
        "id, title, duration_sec, youtube_id, free_preview, body, sort_order, " +
          // 講義與插圖一次撈進來，不要讓每個 LessonEditor 的列各自 fetch
          // 一次（27 堂課就是 27 個請求）。
          "lesson_materials(id, kind, file_name, size_bytes, caption, sort_order)",
      )
      .eq("product_id", id)
      .order("sort_order", { ascending: true }),
    db
      .from("workshop_sessions")
      .select(
        "id, starts_at, ends_at, location, address, capacity, seats_taken, status, title, summary, format, price, notes",
      )
      .eq("product_id", id)
      .order("starts_at", { ascending: true }),
    db
      .from("product_blocks")
      .select("id, kind, sort_order, title, body, meta")
      .eq("product_id", id)
      .order("kind", { ascending: true })
      .order("sort_order", { ascending: true }),
  ]);

  if (lessonResult.error) throw new Error(lessonResult.error.message);
  if (sessionResult.error) throw new Error(sessionResult.error.message);
  if (blockResult.error) throw new Error(blockResult.error.message);

  return {
    product,
    lessons: (lessonResult.data ?? []) as unknown as LessonRow[],
    blocks: (blockResult.data ?? []) as unknown as BlockRow[],
    sessions: ((sessionResult.data ?? []) as unknown as (SessionRow & { status: string })[]).map(
      (row) => ({ ...row, status: toSessionStatus(row.status) }),
    ),
  };
}

/** 用網址代稱找一門課（MCP 讓使用者用代稱指定商品）。找不到回 null。 */
export async function loadProductRowBySlug(db: Db, slug: string): Promise<ProductRow | null> {
  const { data, error } = await db.from("products").select(PRODUCT_COLUMNS).eq("slug", slug).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const raw = data as unknown as ProductRow & { type: string };
  return { ...raw, type: toProductType(raw.type) };
}

/** 場次屬於哪一門課。找不到回 null。 */
export async function findSessionProductId(db: Db, sessionId: string): Promise<string | null> {
  const { data, error } = await db
    .from("workshop_sessions")
    .select("product_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as { product_id: string } | null)?.product_id ?? null;
}
