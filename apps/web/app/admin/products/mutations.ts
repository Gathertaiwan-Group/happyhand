import "server-only";
import type { Staff } from "@/lib/admin/guard";
import { diffOf, type AuditInput } from "@/lib/admin/audit";
import type { createServiceClient } from "@/lib/supabase/server";
import { parseYouTubeId } from "@/lib/youtube";
import { taipeiLocalToIso, formatTaipei } from "@/components/admin/datetime-field";
import { applyLessonPlan, planLessonWrites, type LessonPlan, type SubmittedLesson } from "./lesson-plan";
import { applyBlockPlan, planBlockWrites, type BlockPlan, type SubmittedBlock } from "./block-plan";
import { PRODUCT_COLUMNS } from "./queries";
import {
  PRODUCT_TYPES,
  PRODUCT_TYPE_LABEL,
  SESSION_STATUS_CHOICES,
  SESSION_STATUS_LABEL,
  contentLinesToArray,
  isValidSlug,
  linesToArray,
  parseIntField,
  toSessionFormat,
  toSessionStatus,
  type ProductRow,
  type ProductType,
  type SessionStatus,
} from "./shared";

/**
 * 課程／工作坊的「驗證＋寫入＋稽核」本體。
 *
 * 原本整段寫在 actions.ts 的 server action 裡，而 upsertProduct／upsertSession
 * 是 `Promise<void>` + redirect() 回報結果 —— MCP 拿不到結構化結果（新建的 id、
 * 錯誤代碼）。所以抽到這裡：
 *
 *   · 後台的 server action（actions.ts）＝ requireCapability → 把 FormData 翻成欄位 →
 *     呼叫這裡 → 把結果翻成原本的 redirect／{error|ok}。表單行為一字不變。
 *   · MCP（lib/mcp/content-tools.ts）＝ 在統一的身分包裝裡 requireCapability →
 *     把結構化參數翻成**同一組欄位** → 呼叫這裡。驗證規則、錯誤代碼、稽核摘要只有一份。
 *
 * 🔴 這個檔**不是** "use server"。那個指示會把每一支 export 的 async 函式變成可以從
 *    瀏覽器直接 POST 的端點，而這裡的函式不檢查權限（權限由呼叫端拿 Staff 進來）。
 *
 * dry_run：每一支寫入都收 `dryRun`。dryRun=true 時只做驗證與**讀取**，走到第一個
 *   insert／update／delete 之前就回傳「會寫什麼」。單元測試用「一寫入就 throw」的
 *   假資料庫證明這件事（mutations.test.ts）。
 *
 * ⚠️ 一律不要手寫 updated_at：那幾張表都有 `trg_*_updated_at` trigger。
 */

export type Db = ReturnType<typeof createServiceClient>;

export type MutationCtx = {
  db: Db;
  staff: Staff;
  audit: (staff: Staff, input: AuditInput) => Promise<void>;
  /** 清後台與前台快取（revalidatePath）。測試時換成空函式。 */
  revalidate: (productId?: string) => void;
};

type DbError = { code?: string; message: string } | null;

/* ================================================================ 冪等 */

/**
 * 用稽核紀錄當冪等表：建立成功時把 idempotency_key 寫進那一筆 `*.create` 稽核的 diff，
 * 之後同一個 key 再來就從稽核找回當初建的那一筆 —— 不開新表。
 *
 * 唯一的空窗是「insert 成功到稽核寫入」之間的幾毫秒；那段時間的重送會撞到
 * 資料庫既有的唯一約束（products_slug_key／workshop_sessions_product_starts_key，
 * MCP 的 confirm_args 固定了 slug／開始時間），撞到之後再查一次稽核。
 */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,80}$/;

export async function findCreatedByKey(
  db: Db,
  action: "product.create" | "session.create",
  key: string,
  /** 場次：限定同一門課（session.create 的 diff 有 product_id），換一門課重用 key 不會認到別門課的場次 */
  productId?: string,
): Promise<string | null> {
  let q = db
    .from("audit_log")
    .select("entity_id")
    .eq("action", action)
    .eq("diff->>idempotency_key", key);
  if (productId) q = q.eq("diff->>product_id", productId);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return ((data as unknown as { entity_id: string | null } | null)?.entity_id ?? null) || null;
}

/* ============================================================ 商品主檔 */

/**
 * 商品表單的欄位，**跟 FormData 同一個形狀**（數字與條列都還是字串）。
 * 後台與 MCP 都先翻成這個，再交給 validateProductFields() —— 這樣「售價填 abc」
 * 「原價比售價低」在兩邊得到的是同一個錯誤代碼。
 */
export type ProductFields = {
  type: string;
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  cover_url: string;
  hero_lead: string;
  price: string;
  compare_at_price: string;
  sort_order: string;
  /** 一行一項 */
  tags: string;
  benefits: string;
  suitable_for: string;
  not_suitable_for: string;
  outcomes: string;
  curriculum_online: string;
  curriculum_onsite: string;
  includes: string;
  notes: string;
  is_published: boolean;
  is_featured: boolean;
  asks_intake: boolean;
};

/** `<form action={upsertProduct}>` 送上來的 FormData → 欄位。 */
export function productFieldsFromForm(formData: FormData): ProductFields {
  const text = (k: string) => String(formData.get(k) ?? "").trim();
  const raw = (k: string) => String(formData.get(k) ?? "");
  return {
    type: text("type"),
    slug: text("slug"),
    title: text("title"),
    subtitle: text("subtitle"),
    description: text("description"),
    cover_url: text("cover_url"),
    hero_lead: text("hero_lead"),
    price: raw("price"),
    compare_at_price: raw("compare_at_price"),
    sort_order: raw("sort_order"),
    tags: raw("tags"),
    benefits: raw("benefits"),
    suitable_for: raw("suitable_for"),
    not_suitable_for: raw("not_suitable_for"),
    outcomes: raw("outcomes"),
    curriculum_online: raw("curriculum_online"),
    curriculum_onsite: raw("curriculum_onsite"),
    includes: raw("includes"),
    notes: raw("notes"),
    // ⚠️ 沒勾的 checkbox 根本不會出現在 FormData 裡，
    //    所以是比對 "on" 而不是 Boolean(...)。
    is_published: formData.get("is_published") === "on",
    is_featured: formData.get("is_featured") === "on",
    asks_intake: formData.get("asks_intake") === "on",
  };
}

/** 資料庫的一列 → 欄位（MCP「只改有給的欄位」用它當底）。 */
export function productFieldsFromRow(row: ProductRow): ProductFields {
  const lines = (v: readonly string[] | null | undefined) => (v ?? []).join("\n");
  return {
    type: row.type,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle ?? "",
    description: row.description ?? "",
    cover_url: row.cover_url ?? "",
    hero_lead: row.hero_lead ?? "",
    price: String(row.price),
    compare_at_price: row.compare_at_price === null ? "" : String(row.compare_at_price),
    sort_order: String(row.sort_order),
    tags: lines(row.tags),
    benefits: lines(row.benefits),
    suitable_for: lines(row.suitable_for),
    not_suitable_for: lines(row.not_suitable_for),
    outcomes: lines(row.outcomes),
    curriculum_online: lines(row.curriculum_online),
    curriculum_onsite: lines(row.curriculum_onsite),
    includes: lines(row.includes),
    notes: lines(row.notes),
    is_published: row.is_published,
    is_featured: row.is_featured,
    asks_intake: row.asks_intake,
  };
}

export type ProductPayload = {
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

export type ProductPayloadKey = keyof ProductPayload;

/** 稽核 diff 的欄位清單（順序即稽核頁的顯示順序）。 */
export const PRODUCT_DIFF_KEYS: readonly ProductPayloadKey[] = [
  "type",
  "slug",
  "title",
  "subtitle",
  "description",
  "price",
  "compare_at_price",
  "cover_url",
  "is_published",
  "is_featured",
  "tags",
  "benefits",
  "sort_order",
  // 報名頁內容也要留稽核 —— 這些是對外文案，改錯了要查得到是誰改的
  "hero_lead",
  "suitable_for",
  "not_suitable_for",
  "outcomes",
  "curriculum_online",
  "curriculum_onsite",
  "includes",
  "notes",
  "asks_intake",
];

/** 錯誤代碼 = shared.ts 的 FORM_MESSAGES key（後台用它組 ?msg=）。 */
export type ProductErrorCode =
  | "type_invalid"
  | "slug_format"
  | "title_required"
  | "price_invalid"
  | "compare_invalid"
  | "sort_invalid"
  | "slug_taken"
  | "notfound"
  | "failed"
  /** 只有 MCP（帶 idempotency_key）會遇到：這個 key 已經用來建立過「別的」商品 */
  | "idempotency_conflict";

export function validateProductFields(
  f: ProductFields,
): { ok: false; code: ProductErrorCode } | { ok: true; payload: ProductPayload } {
  if (!(PRODUCT_TYPES as readonly string[]).includes(f.type)) return { ok: false, code: "type_invalid" };
  const type = f.type as ProductType;

  if (!isValidSlug(f.slug)) return { ok: false, code: "slug_format" };
  if (!f.title) return { ok: false, code: "title_required" };

  const price = parseIntField(f.price);
  if (price === undefined || price === null || price < 0) return { ok: false, code: "price_invalid" };

  const compareAt = parseIntField(f.compare_at_price);
  if (compareAt === undefined) return { ok: false, code: "compare_invalid" };
  // products_compare_at_price_sane check (compare_at_price is null or >= price)。
  // 不先擋的話資料庫會回一句 23514 的英文，員工只會看到「儲存失敗」。
  if (compareAt !== null && compareAt < price) return { ok: false, code: "compare_invalid" };

  const sortOrder = parseIntField(f.sort_order);
  if (sortOrder === undefined || sortOrder === null) return { ok: false, code: "sort_invalid" };

  return {
    ok: true,
    payload: {
      type,
      slug: f.slug,
      title: f.title.slice(0, 200),
      subtitle: f.subtitle ? f.subtitle.slice(0, 200) : null,
      description: f.description ? f.description.slice(0, 4000) : null,
      price,
      compare_at_price: compareAt,
      cover_url: f.cover_url ? f.cover_url.slice(0, 500) : null,
      is_published: f.is_published,
      is_featured: f.is_featured,
      tags: linesToArray(f.tags),
      benefits: linesToArray(f.benefits),
      sort_order: sortOrder,

      // 報名頁內容。用 contentLinesToArray（40 項 × 200 字）而不是上面那個
      // linesToArray（20 項 × 60 字）—— 課程大綱條目用 60 字寫不完。
      hero_lead: f.hero_lead ? f.hero_lead.slice(0, 2000) : null,
      suitable_for: contentLinesToArray(f.suitable_for),
      not_suitable_for: contentLinesToArray(f.not_suitable_for),
      outcomes: contentLinesToArray(f.outcomes),
      curriculum_online: contentLinesToArray(f.curriculum_online),
      curriculum_onsite: contentLinesToArray(f.curriculum_onsite),
      includes: contentLinesToArray(f.includes),
      notes: contentLinesToArray(f.notes),
      asks_intake: f.asks_intake,
    },
  };
}

export type CreateProductResult =
  | { error: ProductErrorCode; type?: ProductType }
  | {
      error?: undefined;
      ok: true;
      dryRun: boolean;
      /** dryRun 時為空字串 */
      id: string;
      type: ProductType;
      payload: ProductPayload;
      /** 同一個 idempotency_key 已經建過 —— 這次沒有新建，id 是當初那一筆 */
      replayed?: boolean;
      /** replayed 時：資料庫裡當初那一筆的實際內容 */
      existing?: Record<string, unknown>;
    };

/** 這個代稱有沒有人在用（唯讀）。 */
export async function slugInUse(db: Db, slug: string): Promise<boolean> {
  const { data, error } = await db.from("products").select("id").eq("slug", slug).limit(1);
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/**
 * 同一個 key 找到當初建的那一筆之後，讀出**實際那一列**並比對代稱：
 * 代稱一樣才算「同一個請求重送」；不一樣代表 key 被拿去建另一門課了，要擋下來，
 * 不能回「已建立」讓人以為第二門課也建好了。
 */
async function replayProduct(
  db: Db,
  priorId: string,
  payload: ProductPayload,
): Promise<{ ok: true; existing: Record<string, unknown> } | { ok: false }> {
  const { data, error } = (await db.from("products").select(PRODUCT_COLUMNS).eq("id", priorId).maybeSingle()) as {
    data: unknown;
    error: DbError;
  };
  if (error) throw new Error(error.message);
  const row = data as Record<string, unknown> | null;
  if (!row || row.slug !== payload.slug) return { ok: false };
  return { ok: true, existing: row };
}

export async function createProduct(
  ctx: MutationCtx,
  fields: ProductFields,
  opts: { dryRun?: boolean; idempotencyKey?: string } = {},
): Promise<CreateProductResult> {
  const v = validateProductFields(fields);
  if (!v.ok) return { error: v.code };
  const payload = v.payload;
  const type = payload.type;
  const key = opts.idempotencyKey;

  if (key) {
    const prior = await findCreatedByKey(ctx.db, "product.create", key);
    if (prior) {
      const rp = await replayProduct(ctx.db, prior, payload);
      if (!rp.ok) return { error: "idempotency_conflict", type };
      return { ok: true, dryRun: !!opts.dryRun, id: prior, type, payload, replayed: true, existing: rp.existing };
    }
  }

  if (opts.dryRun) {
    // 預覽也要給出跟正式送出同一個答案：代稱被佔走的話現在就講。
    if (await slugInUse(ctx.db, payload.slug)) return { error: "slug_taken", type };
    return { ok: true, dryRun: true, id: "", type, payload };
  }

  const { data, error } = (await ctx.db.from("products").insert(payload).select("id").maybeSingle()) as {
    data: unknown;
    error: DbError;
  };

  if (error) {
    // 23505 = unique_violation，這裡只可能是 products_slug_key。
    if (error.code === "23505") {
      if (key) {
        const prior = await findCreatedByKey(ctx.db, "product.create", key);
        if (prior) {
          const rp = await replayProduct(ctx.db, prior, payload);
          if (!rp.ok) return { error: "idempotency_conflict", type };
          return { ok: true, dryRun: false, id: prior, type, payload, replayed: true, existing: rp.existing };
        }
      }
      return { error: "slug_taken", type };
    }
    console.error("[admin/products] 建立商品失敗", error);
    return { error: "failed", type };
  }

  const newId = (data as { id: string } | null)?.id ?? "";
  await ctx.audit(ctx.staff, {
    action: "product.create",
    entity: "product",
    entityId: newId || null,
    summary: `新增${PRODUCT_TYPE_LABEL[type]}「${payload.title}」（${payload.slug}）`,
    diff: key ? { created: payload, idempotency_key: key } : { created: payload },
  });

  ctx.revalidate(newId);
  return { ok: true, dryRun: false, id: newId, type, payload };
}

export type UpdateProductResult =
  | { error: ProductErrorCode }
  | {
      error?: undefined;
      ok: true;
      dryRun: boolean;
      id: string;
      before: Record<string, unknown>;
      /** 實際會寫入的欄位（onlyKeys 時只有那幾個） */
      write: Partial<ProductPayload>;
      payload: ProductPayload;
      diff: Record<string, { from: unknown; to: unknown }> | null;
      slugChanged: boolean;
    };

/**
 * 更新一門課。
 *
 * onlyKeys：只寫入這幾個欄位（MCP 的「只改有給的欄位」）。驗證仍然跑整組合併後的值，
 *   但沒指定的欄位不寫回去 —— 不然「AI 讀到的舊值」會蓋掉這中間別人剛改的內容，
 *   例如同事剛按了上架，AI 改個副標就把 is_published 寫回 false。
 *   後台表單不帶 onlyKeys（表單本來就是整張送出），行為不變。
 */
export async function updateProduct(
  ctx: MutationCtx,
  id: string,
  fields: ProductFields,
  opts: { dryRun?: boolean; onlyKeys?: readonly ProductPayloadKey[] } = {},
): Promise<UpdateProductResult> {
  const v = validateProductFields(fields);
  if (!v.ok) return { error: v.code };
  const payload = v.payload;

  const { data: before, error: beforeError } = (await ctx.db
    .from("products")
    .select(PRODUCT_COLUMNS)
    .eq("id", id)
    .maybeSingle()) as { data: unknown; error: DbError };

  if (beforeError) {
    console.error("[admin/products] 讀取商品失敗", beforeError);
    return { error: "failed" };
  }
  if (!before) return { error: "notfound" };

  const keys = opts.onlyKeys ? PRODUCT_DIFF_KEYS.filter((k) => opts.onlyKeys!.includes(k)) : PRODUCT_DIFF_KEYS;
  const write: Partial<ProductPayload> = opts.onlyKeys
    ? (Object.fromEntries(keys.map((k) => [k, payload[k]])) as Partial<ProductPayload>)
    : payload;

  const prev = before as Record<string, unknown>;
  const diff = diffOf(prev, write as Record<string, unknown>, keys as readonly string[]);
  // 代稱換掉＝舊網址從此 404。稽核摘要要看得出來，
  // 之後客人反映連結壞掉時才查得到是誰在什麼時候改的。
  const slugChanged = prev.slug !== payload.slug;

  if (opts.dryRun) {
    return { ok: true, dryRun: true, id, before: prev, write, payload, diff, slugChanged };
  }

  const { error } = (await ctx.db.from("products").update(write).eq("id", id)) as { error: DbError };
  if (error) {
    if (error.code !== "23505") console.error("[admin/products] 更新商品失敗", error);
    return { error: error.code === "23505" ? "slug_taken" : "failed" };
  }

  await ctx.audit(ctx.staff, {
    action: "product.update",
    entity: "product",
    entityId: id,
    summary: slugChanged
      ? `更新「${payload.title}」，網址代稱 ${String(prev.slug)} → ${payload.slug}（舊網址將失效）`
      : `更新「${payload.title}」`,
    diff,
  });

  ctx.revalidate(id);
  return { ok: true, dryRun: false, id, before: prev, write, payload, diff, slugChanged };
}

/* ================================================================ 單元 */

/**
 * 一個單元的原始輸入 → SubmittedLesson，或一句中文錯誤。
 * 後台表單（索引命名的 FormData）與 MCP（結構化陣列）共用，錯誤訊息一字不差。
 *
 * index 是 0 起算，訊息裡顯示成「第 index+1 個」。
 */
export function normalizeLesson(
  index: number,
  raw: {
    id: string;
    /** 已 trim */
    title: string;
    /** 已 trim；整條 YouTube 網址或 11 碼 ID */
    youtube: string;
    duration_sec: number | null;
    free_preview: boolean;
    body: string;
  },
): { error: string } | { lesson: SubmittedLesson } {
  if (!raw.title) return { error: `第 ${index + 1} 個單元沒有填標題。` };

  // 員工貼的是整條 YouTube 網址（他們不會知道什麼叫「影片 ID」），
  // 存進資料庫的是 11 碼 ID。
  //
  // ⚠️ 認不出來的字串**不要默默當成沒填**。那會變成
  //    「後台看起來有填、學員點播放卻說沒有影片」，而且沒有人查得出原因。
  //    寧可擋下整次儲存並回一句人話。
  const youtubeId = raw.youtube ? parseYouTubeId(raw.youtube) : null;
  if (raw.youtube && !youtubeId) {
    return {
      error:
        `第 ${index + 1} 個單元的 YouTube 網址看不懂：「${raw.youtube.slice(0, 60)}」。` +
        "請從 YouTube 影片頁的網址列整條複製過來（watch?v=、youtu.be 都可以）。",
    };
  }

  return {
    lesson: {
      id: raw.id,
      title: raw.title.slice(0, 200),
      duration_sec: raw.duration_sec,
      youtube_id: youtubeId,
      free_preview: raw.free_preview,
      // 🔴 先把 CRLF 正規化成 LF。HTML 規格規定 textarea 送出時換行一律
      //    變成 \r\n，而渲染端是用「連續兩個換行」分段 —— \r\n\r\n 的兩個
      //    \n 中間夾著 \r，任何 /\n{2,}/ 都切不開，整篇會擠成一大段。
      // 8000 字約 4 頁 A4，夠寫一堂課的說明；再長就該做成講義 PDF。
      body: raw.body.replace(/\r\n?/g, "\n").trim().slice(0, 8000) || null,
    },
  };
}

export const LESSON_MAX = 200;

export type SaveLessonsResult =
  | { error: string }
  | { error?: undefined; ok: string; dryRun: boolean; plan: LessonPlan };

/**
 * 一次存下某門課的所有單元。
 *
 * 寫入計畫由 ./lesson-plan.ts 的 planLessonWrites() 算出來，
 * 🔴 兩階段搬移的原因見 lesson-plan.ts 的檔頭：
 *    unique (product_id, sort_order) 會在重排途中撞到，
 *    而 delete-then-insert 會經由 lesson_progress 的 cascade
 *    把所有學員的觀看進度洗掉。這裡全程 UPDATE，id 不變。
 *
 * allowDelete=false：清單沒列到的既有單元**不刪**，直接擋下（MCP 預設）。
 *   刪單元會連帶刪掉學員在那一堂的觀看進度，不能是「AI 只送了新的那一堂」的副作用。
 */
export async function saveLessonsCore(
  ctx: MutationCtx,
  productId: string,
  submitted: readonly SubmittedLesson[],
  opts: { dryRun?: boolean; allowDelete?: boolean } = {},
): Promise<SaveLessonsResult> {
  if (submitted.length > LESSON_MAX) return { error: "單元數量不正確，請重新整理後再試。" };

  const { data: existingRaw, error: existingError } = (await ctx.db
    .from("course_lessons")
    .select("id, sort_order")
    .eq("product_id", productId)
    .order("sort_order")) as { data: unknown; error: DbError };
  if (existingError) {
    console.error("[admin/products] 讀取單元失敗", existingError);
    return { error: "讀取現有單元失敗，請重試一次。" };
  }
  const existing = (existingRaw ?? []) as { id: string; sort_order: number }[];

  const plan = planLessonWrites(existing, submitted);

  if (plan.unknownIds.length > 0) {
    return {
      error: "這份單元清單已經過期（有單元被其他同事刪掉了），請重新整理後再存一次。",
    };
  }

  if (opts.allowDelete === false && plan.deleteIds.length > 0) {
    return {
      error:
        `這次送出的清單少了 ${plan.deleteIds.length} 個既有單元，會把它們刪掉（連同學員在那幾堂的觀看進度，無法復原）。` +
        "要保留請把既有單元（含 id）一起放進清單；確定要刪除請加 allow_delete=true。",
    };
  }

  const okMessage = `已儲存 ${submitted.length} 個單元。`;
  if (opts.dryRun) return { ok: okMessage, dryRun: true, plan };

  // 實際寫入（刪除 -> PARK -> 寫回目標位置 -> 新增）交給 applyLessonPlan()。
  const failure = await applyLessonPlan(ctx.db, productId, plan);
  if (failure) {
    console.error("[admin/products] 寫入單元失敗", failure.stage, failure.message);
    const MESSAGES: Record<typeof failure.stage, string> = {
      delete: "刪除單元失敗，請重試一次。",
      park: "重新排序失敗，請重新整理後再試一次。",
      update: "儲存單元失敗，請重新整理後再試一次。",
      insert: "新增單元失敗，請重新整理後再試一次。",
    };
    return { error: MESSAGES[failure.stage] };
  }

  await ctx.audit(ctx.staff, {
    action: "lesson.save",
    entity: "product",
    entityId: productId,
    summary: `更新單元清單：共 ${submitted.length} 個單元（新增 ${plan.insert.length}、刪除 ${plan.deleteIds.length}）`,
    diff: {
      total: submitted.length,
      inserted: plan.insert.length,
      deleted: plan.deleteIds.length,
      order: plan.update.map((row) => ({ id: row.id, sort_order: row.sort_order })),
    },
  });

  ctx.revalidate(productId);
  return { ok: okMessage, dryRun: false, plan };
}

/* ================================================================ 場次 */

/** 場次表單的欄位（同 FormData 的形狀）。時間是台北牆上時間 "2026-09-12T14:00"。 */
export type SessionFields = {
  starts_at: string;
  ends_at: string;
  capacity: string;
  status: string;
  location: string;
  address: string;
  title: string;
  summary: string;
  notes: string;
  price: string;
  format: unknown;
};

export function sessionFieldsFromForm(formData: FormData): SessionFields {
  return {
    starts_at: String(formData.get("starts_at") ?? ""),
    ends_at: String(formData.get("ends_at") ?? ""),
    capacity: String(formData.get("capacity") ?? ""),
    status: String(formData.get("status") ?? "").trim(),
    location: String(formData.get("location") ?? "").trim(),
    address: String(formData.get("address") ?? "").trim(),
    title: String(formData.get("title") ?? "").trim(),
    summary: String(formData.get("summary") ?? "").trim(),
    notes: String(formData.get("notes") ?? "").trim(),
    price: String(formData.get("price") ?? ""),
    format: formData.get("format"),
  };
}

export type SessionPayload = {
  starts_at: string;
  ends_at: string;
  location: string | null;
  address: string | null;
  capacity: number;
  status: SessionStatus;
  title: string | null;
  summary: string | null;
  format: ReturnType<typeof toSessionFormat>;
  price: number | null;
  notes: string | null;
};

export type SessionPayloadKey = keyof SessionPayload;

export type SessionErrorCode =
  | "session_time_invalid"
  | "session_capacity_invalid"
  | "session_price_invalid"
  | "session_duplicate"
  | "session_notfound"
  | "failed"
  /** 只有 MCP（帶 idempotency_key）會遇到：這個 key 已經用來新增過「別的」場次 */
  | "idempotency_conflict";

/**
 * ⚠️ 送上來的是台北牆上時間字串，datetime-field 不會偷偷幫忙轉時區，
 *    所以這裡必須自己 taipeiLocalToIso() 之後才寫進 timestamptz 欄位。
 */
export function validateSessionFields(
  f: SessionFields,
): { ok: false; code: SessionErrorCode } | { ok: true; payload: SessionPayload } {
  const startsAt = taipeiLocalToIso(f.starts_at);
  const endsAt = taipeiLocalToIso(f.ends_at);
  if (!startsAt || !endsAt || new Date(endsAt) <= new Date(startsAt)) {
    return { ok: false, code: "session_time_invalid" };
  }

  const capacity = parseIntField(f.capacity);
  if (capacity === undefined || capacity === null || capacity < 0) {
    return { ok: false, code: "session_capacity_invalid" };
  }

  const status: SessionStatus = (SESSION_STATUS_CHOICES as readonly string[]).includes(f.status)
    ? (f.status as SessionStatus)
    : "open";

  const sessionPrice = parseIntField(f.price);
  if (sessionPrice === undefined || (sessionPrice !== null && sessionPrice < 0)) {
    return { ok: false, code: "session_price_invalid" };
  }

  return {
    ok: true,
    payload: {
      starts_at: startsAt,
      ends_at: endsAt,
      location: f.location ? f.location.slice(0, 200) : null,
      address: f.address ? f.address.slice(0, 300) : null,
      capacity,
      status,
      title: f.title ? f.title.slice(0, 200) : null,
      summary: f.summary ? f.summary.slice(0, 300) : null,
      format: toSessionFormat(f.format),
      // ⚠️ 留空 = null = 用課程定價。0 是合法價格（免費場次），
      //    所以這裡用 parseIntField 的 null/undefined 區分，不能用 falsy 判斷。
      price: sessionPrice ?? null,
      notes: f.notes ? f.notes.slice(0, 300) : null,
    },
  };
}

export type CreateSessionResult =
  | { error: SessionErrorCode }
  | {
      error?: undefined;
      ok: true;
      dryRun: boolean;
      id: string;
      payload: SessionPayload;
      landedStatus?: string;
      replayed?: boolean;
      existing?: Record<string, unknown>;
    };

/** 同 replayProduct：讀出當初那一場，開始時間一樣才算同一個請求重送。 */
async function replaySession(
  db: Db,
  priorId: string,
  productId: string,
  payload: SessionPayload,
): Promise<{ ok: true; existing: Record<string, unknown> } | { ok: false }> {
  const { data, error } = (await db
    .from("workshop_sessions")
    .select("id, product_id, starts_at, ends_at, location, address, capacity, status, title, summary, format, price, notes")
    .eq("id", priorId)
    .maybeSingle()) as { data: unknown; error: DbError };
  if (error) throw new Error(error.message);
  const row = data as Record<string, unknown> | null;
  if (
    !row ||
    row.product_id !== productId ||
    new Date(String(row.starts_at)).getTime() !== new Date(payload.starts_at).getTime()
  ) {
    return { ok: false };
  }
  return { ok: true, existing: row };
}

/**
 * 新增一個場次。
 *
 * ⚠️ 這裡刻意完全不碰 seats_taken。那個數字歸結帳流程與 admin_adjust_seats() 管。
 */
export async function createSession(
  ctx: MutationCtx,
  productId: string,
  fields: SessionFields,
  opts: { dryRun?: boolean; idempotencyKey?: string } = {},
): Promise<CreateSessionResult> {
  const v = validateSessionFields(fields);
  if (!v.ok) return { error: v.code };
  const payload = v.payload;
  const key = opts.idempotencyKey;

  if (key) {
    const prior = await findCreatedByKey(ctx.db, "session.create", key, productId);
    if (prior) {
      const rp = await replaySession(ctx.db, prior, productId, payload);
      if (!rp.ok) return { error: "idempotency_conflict" };
      return { ok: true, dryRun: !!opts.dryRun, id: prior, payload, replayed: true, existing: rp.existing };
    }
  }

  if (opts.dryRun) {
    // workshop_sessions_product_starts_key：同一門課同一個開始時間只能有一場。
    const { data, error } = (await ctx.db
      .from("workshop_sessions")
      .select("id")
      .eq("product_id", productId)
      .eq("starts_at", payload.starts_at)
      .limit(1)) as { data: unknown[] | null; error: DbError };
    if (error) throw new Error(error.message);
    if ((data ?? []).length > 0) return { error: "session_duplicate" };
    return { ok: true, dryRun: true, id: "", payload };
  }

  const { data, error } = (await ctx.db
    .from("workshop_sessions")
    .insert({ ...payload, product_id: productId })
    .select("id, status")
    .maybeSingle()) as { data: unknown; error: DbError };
  if (error) {
    // 23505 = workshop_sessions_product_starts_key
    if (error.code === "23505") {
      if (key) {
        const prior = await findCreatedByKey(ctx.db, "session.create", key, productId);
        if (prior) {
          const rp = await replaySession(ctx.db, prior, productId, payload);
          if (!rp.ok) return { error: "idempotency_conflict" };
          return { ok: true, dryRun: false, id: prior, payload, replayed: true, existing: rp.existing };
        }
      }
      return { error: "session_duplicate" };
    }
    console.error("[admin/products] 新增場次失敗", error);
    return { error: "failed" };
  }
  const created = data as { id: string; status: string } | null;
  await ctx.audit(ctx.staff, {
    action: "session.create",
    entity: "session",
    entityId: created?.id ?? null,
    summary: `新增場次 ${formatTaipei(payload.starts_at)}（${payload.location ?? "未填地點"}，名額 ${payload.capacity}）`,
    diff: key
      ? { product_id: productId, ...payload, landed_status: created?.status, idempotency_key: key }
      : { product_id: productId, ...payload, landed_status: created?.status },
  });

  ctx.revalidate(productId);
  return { ok: true, dryRun: false, id: created?.id ?? "", payload, landedStatus: created?.status };
}

export type UpdateSessionResult =
  | { error: SessionErrorCode }
  | {
      error?: undefined;
      ok: true;
      dryRun: boolean;
      id: string;
      before: Record<string, unknown>;
      write: Partial<SessionPayload>;
      payload: SessionPayload;
      landedStatus?: SessionStatus;
    };

const SESSION_WRITE_KEYS: readonly SessionPayloadKey[] = [
  "starts_at",
  "ends_at",
  "location",
  "address",
  "capacity",
  "status",
  "title",
  "summary",
  "format",
  "price",
  "notes",
];

/**
 * 更新一個場次。onlyKeys 的意義同 updateProduct（MCP 只寫有給的欄位）。
 */
export async function updateSession(
  ctx: MutationCtx,
  productId: string,
  sessionId: string,
  fields: SessionFields,
  opts: { dryRun?: boolean; onlyKeys?: readonly SessionPayloadKey[] } = {},
): Promise<UpdateSessionResult> {
  const v = validateSessionFields(fields);
  if (!v.ok) return { error: v.code };
  const payload = v.payload;

  const { data: before, error: beforeError } = (await ctx.db
    .from("workshop_sessions")
    .select("id, starts_at, ends_at, location, address, capacity, status, seats_taken, title, summary, format, price, notes")
    .eq("id", sessionId)
    .eq("product_id", productId)
    .maybeSingle()) as { data: unknown; error: DbError };
  if (beforeError) {
    console.error("[admin/products] 讀取場次失敗", beforeError);
    return { error: "failed" };
  }
  if (!before) return { error: "session_notfound" };
  const prev = before as Record<string, unknown>;

  // 名額不能砍到比已經報名的人數還少：
  // workshop_sessions_not_oversold check (seats_taken <= capacity) 會擋，
  // 但擋出來是 23514 的英文。先在這裡翻成人話。
  const seatsTaken = Number(prev.seats_taken ?? 0);
  if (payload.capacity < seatsTaken) return { error: "session_capacity_invalid" };

  const write: Partial<SessionPayload> = opts.onlyKeys
    ? (Object.fromEntries(
        SESSION_WRITE_KEYS.filter((k) => opts.onlyKeys!.includes(k)).map((k) => [k, payload[k]]),
      ) as Partial<SessionPayload>)
    : payload;

  if (opts.dryRun) return { ok: true, dryRun: true, id: sessionId, before: prev, write, payload };

  const { data: after, error } = (await ctx.db
    .from("workshop_sessions")
    .update(write)
    .eq("id", sessionId)
    .select("status")
    .maybeSingle()) as { data: unknown; error: DbError };
  if (error) {
    if (error.code !== "23505") console.error("[admin/products] 更新場次失敗", error);
    return { error: error.code === "23505" ? "session_duplicate" : "failed" };
  }

  // trigger sync_workshop_session_status() 可能把 open 立刻改成 full
  // （人數已滿）。據實記錄真正落地的值，不要記我們「以為」寫進去的。
  const landed = toSessionStatus((after as { status: string } | null)?.status ?? payload.status);

  await ctx.audit(ctx.staff, {
    action: "session.update",
    entity: "session",
    entityId: sessionId,
    summary: `更新場次 ${formatTaipei(payload.starts_at)}（${SESSION_STATUS_LABEL[landed]}，名額 ${payload.capacity}）`,
    // 2026-11-15 起連梯次名稱、摘要、形式、價格、補充說明也記：MCP 也改得到這些欄位，
    // 「誰把這一梯從 3600 改成 2800」要查得到。只增不減。
    diff: diffOf(prev, { ...payload, status: landed } as unknown as Record<string, unknown>, [
      "starts_at",
      "ends_at",
      "location",
      "address",
      "capacity",
      "status",
      "title",
      "summary",
      "format",
      "price",
      "notes",
    ]),
  });

  ctx.revalidate(productId);
  return { ok: true, dryRun: false, id: sessionId, before: prev, write, payload, landedStatus: landed };
}

/* ======================================================= 內容區塊（FAQ 等） */

/** 每種區塊的中文名，錯誤訊息用得到。 */
export const BLOCK_KIND_LABEL: Record<string, string> = {
  faq: "常見問題",
  step: "學習路徑",
  info_row: "報名資訊",
  pricing: "費用方案",
  feature: "特色說明",
};

export const BLOCK_MAX = 100;

/**
 * 一列區塊的原始輸入 → SubmittedBlock／跳過（整列空白＝想刪掉它）／一句中文錯誤。
 * 後台表單與 MCP 共用，錯誤訊息一字不差。
 */
export function normalizeBlock(
  index: number,
  kind: string,
  raw: { id: string; title: string; body: string; amount: string; note: string },
): { skip: true } | { error: string } | { block: SubmittedBlock } {
  const label = BLOCK_KIND_LABEL[kind] ?? kind;
  const title = raw.title.trim();
  const body = raw.body.trim();

  // 整列都空白就當作使用者想刪掉它，不要存一列空的進去。
  if (!title && !body) return { skip: true };
  if (!title) return { error: `第 ${index + 1} 個${label}沒有填標題。` };

  // pricing 額外帶金額與附註；其他 kind 的 meta 保持空物件。
  const meta: Record<string, unknown> = {};
  if (kind === "pricing") {
    const amountRaw = raw.amount.trim();
    if (amountRaw) {
      const amount = Number(amountRaw);
      if (!Number.isInteger(amount) || amount < 0) {
        return { error: `第 ${index + 1} 個${label}的金額請填 0 或正整數。` };
      }
      meta.amount = amount;
    }
    const note = raw.note.trim();
    if (note) meta.note = note.slice(0, 300);
  }

  return {
    block: {
      id: raw.id.trim(),
      title: title.slice(0, 300),
      body: body ? body.slice(0, 4000) : null,
      meta,
    },
  };
}

export type SaveBlocksResult =
  | { error: string }
  | { error?: undefined; ok: string; dryRun: boolean; plan: BlockPlan };

/**
 * 儲存某一種內容區塊（一次一個 kind）。
 *
 * 排序走 block-plan.ts 的 PARK→FINAL —— product_blocks 有
 * `unique (product_id, kind, sort_order)`，逐筆改成目標值一定會撞 23505。
 */
export async function saveBlocksCore(
  ctx: MutationCtx,
  productId: string,
  kind: string,
  submitted: readonly SubmittedBlock[],
  opts: { dryRun?: boolean; allowDelete?: boolean } = {},
): Promise<SaveBlocksResult> {
  const label = BLOCK_KIND_LABEL[kind];
  if (!label) return { error: "區塊類型不正確，請重新整理後再試。" };
  if (submitted.length > BLOCK_MAX) return { error: `${label}的數量不正確，請重新整理後再試。` };

  const { data: existingRaw, error: readError } = (await ctx.db
    .from("product_blocks")
    .select("id, sort_order")
    .eq("product_id", productId)
    .eq("kind", kind)
    .order("sort_order")) as { data: unknown; error: DbError };
  if (readError) {
    console.error("[admin/products] 讀內容區塊失敗", readError.message);
    return { error: "讀取現有內容失敗，請重試一次。" };
  }

  const existing = (existingRaw ?? []) as { id: string; sort_order: number }[];
  const plan = planBlockWrites(existing, submitted);

  // 樂觀鎖：送上來的 id 資料庫找不到 = 有人在你編輯的時候刪了它。
  // 這時候整批擋下，不要只寫一半。
  if (plan.unknownIds.length > 0) {
    return {
      error: `有${label}在你編輯的時候被其他同事刪掉了。請重新整理頁面再改一次。`,
    };
  }

  if (opts.allowDelete === false && plan.deleteIds.length > 0) {
    return {
      error:
        `這次送出的清單少了 ${plan.deleteIds.length} 筆既有的${label}，會把它們刪掉。` +
        "要保留請把既有的（含 id）一起放進清單；確定要刪除請加 allow_delete=true。",
    };
  }

  const okMessage = `已儲存 ${submitted.length} 筆${label}。`;
  if (opts.dryRun) return { ok: okMessage, dryRun: true, plan };

  const failure = await applyBlockPlan(ctx.db, productId, kind, plan);
  if (failure) {
    const stageText = {
      delete: "刪除舊資料",
      park: "調整順序（第一階段）",
      final: "寫入內容",
      insert: "新增資料",
    }[failure.stage];
    console.error("[admin/products] 內容區塊寫入失敗", kind, failure.stage);
    return { error: `儲存${label}時在「${stageText}」失敗，請重試一次。` };
  }

  await ctx.audit(ctx.staff, {
    action: "product.blocks",
    entity: "product",
    entityId: productId,
    summary: `更新${label}（共 ${submitted.length} 筆）`,
    diff: {
      kind,
      count: submitted.length,
      deleted: plan.deleteIds.length,
      inserted: plan.insert.length,
    },
  });

  ctx.revalidate(productId);
  return { ok: okMessage, dryRun: false, plan };
}

/* ================================================================ 代稱 */

/**
 * 沒給代稱時自動產生（業主在手機上不會打網址代稱）。
 *
 * 標題裡有 3 個字以上的英數字就用它（「JSJ 讀脈入門」→ jsj）；全中文的標題轉不出
 * 好念的英文，就用「類型-台北日期」（workshop-20261115）。撞名依序加 -2、-3…
 * 結果一定符合 isValidSlug()（[a-z0-9-]、≤ 80 字）。
 */
export function slugBaseFor(title: string, type: ProductType, now: Date = new Date()): string {
  const ascii = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  if (ascii.replace(/-/g, "").length >= 3) return ascii;
  const taipei = new Date(now.getTime() + 8 * 60 * 60_000);
  const ymd =
    `${taipei.getUTCFullYear()}` +
    `${String(taipei.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(taipei.getUTCDate()).padStart(2, "0")}`;
  return `${type}-${ymd}`;
}

/** base、base-2、base-3… 第一個沒人用的（唯讀）。 */
export async function pickAvailableSlug(db: Db, base: string): Promise<string> {
  const { data, error } = await db
    .from("products")
    .select("slug")
    .or(`slug.eq.${base},slug.like.${base}-%`);
  if (error) throw new Error(error.message);
  const taken = new Set(((data ?? []) as { slug: string }[]).map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("找不到可用的網址代稱");
}
