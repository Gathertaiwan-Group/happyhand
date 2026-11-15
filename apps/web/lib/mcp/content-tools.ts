import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { createMcpHandler } from "mcp-handler";

import { requireCapability, AdminAuthError, type Staff } from "@/lib/admin/guard";
import type { Capability } from "@/lib/admin/roles";
import { writeAudit } from "@/lib/admin/audit";
import { createServiceClient } from "@/lib/supabase/server";
import { MCP_PREVIEW_ACTION_PREFIX } from "@/lib/admin/mcp-pending";
import type { ActionOutcome } from "@/lib/admin/mcp-requests";
import { isMediaUrl, sniffImageFormat } from "@/lib/admin/media";
import { processImage, storeProcessedMedia, type ProcessFailure } from "@/lib/admin/media-image";
import { fetchRemoteImage, RemoteImageError } from "@/lib/admin/remote-image";
import { youTubeWatchUrl } from "@/lib/youtube";
import { formatTaipei, isoToTaipeiLocal } from "@/components/admin/datetime-field";
import {
  findSessionProductId,
  loadProductDetail,
  loadProductList,
  loadProductRow,
  loadProductRowBySlug,
  type ProductDetail,
} from "@/app/admin/products/queries";
import {
  BLOCK_KIND_LABEL,
  IDEMPOTENCY_KEY_RE,
  createProduct,
  createSession,
  normalizeBlock,
  normalizeLesson,
  pickAvailableSlug,
  productFieldsFromRow,
  saveBlocksCore,
  saveLessonsCore,
  slugBaseFor,
  updateProduct,
  updateSession,
  type ProductFields,
  type ProductPayloadKey,
  type SessionFields,
  type SessionPayloadKey,
} from "@/app/admin/products/mutations";
import { liveMutationCtx } from "@/app/admin/products/mutation-ctx";
import {
  BLOCK_KINDS,
  FORM_MESSAGES,
  PRODUCT_TYPES,
  PRODUCT_TYPE_LABEL,
  SESSION_FORMATS,
  SESSION_FORMAT_LABEL,
  SESSION_STATUS_CHOICES,
  SESSION_STATUS_LABEL,
  formatDuration,
  formatMoney,
  isValidSlug,
  joinDuration,
  type BlockRow,
  type LessonRow,
  type ProductRow,
  type ProductType,
  type SessionRow,
} from "@/app/admin/products/shared";
import type { SubmittedBlock } from "@/app/admin/products/block-plan";
import type { SubmittedLesson } from "@/app/admin/products/lesson-plan";

/**
 * MCP：新增與編輯課程／工作坊（業主用手機透過 Claude 在後台新增課程）。
 *
 * 由 app/api/mcp/route.ts 用一行 `registerContentTools(server, asMachine)` 註冊。
 *
 * ## 身分
 * 🔴 這個模組**不** import MCP_ACTOR、**不**呼叫 runAsMachine。每一支工具的整段
 *    （含預覽）都包在 route.ts 傳進來的 `run` 裡，在裡面才 requireCapability() ——
 *    route.ts 決定這次請求是機器身分還是（OAuth 之後）真人身分，這裡自動跟著走。
 *    getStaff() 被 React.cache() 包著，第一次呼叫必須已經在 run 的 scope 內，所以這個
 *    模組在 run 外面一律不碰 getStaff()／requireCapability()。
 *
 * ## 寫入規則（照小時光書店）
 *   · 所有寫入 dry_run 預設 true，預覽回 confirm_args；正式送出時原樣帶回（代稱、
 *     idempotency_key 在預覽就決定好，不會第二次重產）。
 *   · 建立類帶 idempotency_key：沒給就由預覽產生放進 confirm_args；dry_run=false 一定要有。
 *     做法見 app/admin/products/mutations.ts 的 findCreatedByKey()（稽核紀錄＋既有唯一約束，不開新表）。
 *   · 新建一律是草稿（is_published=false）。上架用既有的 publish_product。
 *   · 所有寫入都走 app/admin/products/mutations.ts —— 跟後台表單同一支函式，這裡不寫 SQL。
 *   · 預覽記 `mcp.preview.<工具>` 稽核；真正的寫入由 mutations.ts 記 product.create 等原本的稽核。
 *   · 不做：刪除商品、刪除場次。單元與內容區塊的刪除只在 allow_delete=true 時發生。
 */

/* ================================================================ 型別 */

type McpServer = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/**
 * route.ts 裡那一處包 runAsMachine 的統一函式（目前是 asMachine）。
 * fn 回 { error } → 它回 isError 的結果；回 { ok } → 它回成功訊息。
 */
export type RunAs = (fallbackOk: string, fn: () => Promise<ActionOutcome>) => Promise<ToolResult>;

/** 工具本體的結果。ok=false 的 error 會原樣給 AI 看。 */
type Out = { ok: true; data: unknown } | { ok: false; error: string };

/** 給 AI 看的輸入錯誤（訊息原樣回傳）。其他例外一律變成通用錯誤，不外洩內部訊息。 */
class ToolInputError extends Error {}

/* ================================================================ 共用 */

const MAX_TEXT = 200_000;

function jsonText(value: unknown): ToolResult {
  let text = JSON.stringify(value, null, 2);
  if (text.length > MAX_TEXT) {
    text =
      text.slice(0, MAX_TEXT) +
      `\n\n⚠️ 輸出超過 ${MAX_TEXT} 字已截斷，上面不是完整結果。請縮小查詢範圍再試一次。`;
  }
  return { content: [{ type: "text" as const, text }] };
}

/**
 * 在 run 的身分範圍內跑一支工具。
 *
 * 結構化的結果（新建的 id、預覽內容）從 closure 帶出來；錯誤交給 run 自己的錯誤格式。
 */
async function inScope(
  run: RunAs,
  cap: Capability,
  okLabel: string,
  body: (staff: Staff) => Promise<Out>,
): Promise<ToolResult> {
  let captured: Out | null = null;
  const res = await run(okLabel, async () => {
    let staff: Staff;
    try {
      staff = await requireCapability(cap);
    } catch (err) {
      if (err instanceof AdminAuthError) return { error: err.message };
      throw err;
    }
    try {
      captured = await body(staff);
    } catch (err) {
      if (err instanceof ToolInputError || err instanceof RemoteImageError) return { error: err.message };
      throw err;
    }
    if (!captured.ok) return { error: captured.error };
    return { ok: okLabel };
  });
  const out = captured as Out | null;
  if (out && out.ok) return jsonText(out.data);
  return res;
}

async function auditPreview(
  staff: Staff,
  tool: string,
  entity: string,
  entityId: string | null,
  ref: string,
  diff: Record<string, unknown>,
) {
  await writeAudit(staff, {
    action: `${MCP_PREVIEW_ACTION_PREFIX}${tool}`,
    entity,
    entityId,
    summary: `AI 透過 MCP 預覽「${tool}」：${ref}（只預覽，未執行）`,
    diff,
  });
}

function codeText(code: string): string {
  if (code === "idempotency_conflict") {
    return "這個 idempotency_key 已經用來建立過另一筆資料了，這次沒有建立。請重新用 dry_run=true 預覽一次（會產生新的 key），再把新的 confirm_args 送出。";
  }
  return FORM_MESSAGES[code]?.text ?? "儲存失敗，請重試一次。";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 商品 id（UUID）或網址代稱 → 那一列。 */
async function resolveProduct(ref: string): Promise<ProductRow> {
  const v = ref.trim();
  const db = createServiceClient();
  const row = UUID_RE.test(v)
    ? await loadProductRow(db, v)
    : isValidSlug(v)
      ? await loadProductRowBySlug(db, v)
      : null;
  if (!row) throw new ToolInputError(`找不到商品「${v.slice(0, 80)}」。請用 list_products 查 id 或網址代稱。`);
  return row;
}

function productRef(p: { title: string; type: ProductType; slug: string }) {
  return `${PRODUCT_TYPE_LABEL[p.type]}「${p.title}」（${p.slug}）`;
}

function siteOrigin(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || "https://happyhands.com.tw").replace(/\/+$/, "");
}

function publicUrlFor(p: { type: ProductType; slug: string }) {
  return `${siteOrigin()}/${p.type === "workshop" ? "workshops" : "courses"}/${p.slug}`;
}

function adminUrlFor(id: string) {
  return `${siteOrigin()}/admin/products/${id}`;
}

/* ============================================================== 參數 */

const WRITE = { readOnlyHint: false, openWorldHint: false } as const;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const DRY_RUN_ARG = z
  .boolean()
  .optional()
  .describe(
    "預設 true（省略也是 true）：只預覽會改什麼，不寫入任何資料。" +
      "向使用者說明預覽、取得同意後，把預覽回傳的 confirm_args 原樣當參數再呼叫一次（裡面已經是 dry_run=false）。",
  );

const DRY_RUN_NOTE =
  "【先預覽再執行】第一次呼叫（dry_run 省略或 true）只回預覽與 confirm_args，不寫入；" +
  "向使用者說明預覽、取得明確同意後，把 confirm_args 原樣當參數再呼叫一次才會寫入（執行前會重新檢查）。";

const PRODUCT_ARG = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe("商品 id（UUID）或網址代稱（slug），用 list_products 查得到");

const IDEMPOTENCY_ARG = z
  .string()
  .trim()
  .regex(IDEMPOTENCY_KEY_RE, "idempotency_key 請用 8–80 個英數字或 - _ . :")
  .optional()
  .describe(
    "防重複送出的識別碼。可以省略：預覽會自動產生一個放進 confirm_args。" +
      "正式送出（dry_run=false）一定要帶；同一個 key 重送不會再建一筆，會回當初建的那一筆。",
  );

const LIST_ARG = (what: string, max: number, itemMax: number) =>
  z.array(z.string().max(itemMax)).max(max).describe(`${what}（一項一個字串）`);

/** 商品的可編輯欄位（create 與 update 共用描述）。 */
const productContentShape = {
  subtitle: z.string().max(200).nullable().optional().describe("副標（一句話）"),
  description: z.string().max(4000).nullable().optional().describe("課程說明（列表卡片與頁首簡介）"),
  price: z.number().int().min(0).max(10_000_000).describe("售價（新台幣整數，免費填 0）"),
  compare_at_price: z
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .nullable()
    .optional()
    .describe("劃線原價（要 ≥ 售價；不顯示就省略或 null）"),
  cover_url: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .describe("封面圖網址：先用 upload_image_from_url 或 upload_image_base64 上傳，再填它回傳的 cover_url"),
  hero_lead: z.string().max(2000).nullable().optional().describe("報名頁引言（工作坊頁頂端的一段話）"),
  tags: LIST_ARG("標籤，例如「近期新課」「入門」（前台篩選晶片用；每項 60 字內，最多 20 項）", 20, 60).optional(),
  benefits: LIST_ARG("亮點／賣點（每項 60 字內，最多 20 項）", 20, 60).optional(),
  suitable_for: LIST_ARG("適合誰（工作坊頁）", 40, 200).optional(),
  not_suitable_for: LIST_ARG("不適合誰（工作坊頁）", 40, 200).optional(),
  outcomes: LIST_ARG("學完之後（工作坊頁）", 40, 200).optional(),
  curriculum_online: LIST_ARG("線上課程內容大綱（工作坊頁）", 40, 200).optional(),
  curriculum_onsite: LIST_ARG("實體課程內容大綱（工作坊頁）", 40, 200).optional(),
  includes: LIST_ARG("一次報名全部帶走（工作坊頁）", 40, 200).optional(),
  notes: LIST_ARG("來之前先知道（工作坊頁）", 40, 200).optional(),
  is_featured: z.boolean().optional().describe("首頁精選"),
  asks_intake: z.boolean().optional().describe("報名時要不要請學員填報名問卷"),
  sort_order: z.number().int().min(-100000).max(100000).optional().describe("排序（小的在前，預設 0）"),
};

const LIST_KEYS = [
  "tags",
  "benefits",
  "suitable_for",
  "not_suitable_for",
  "outcomes",
  "curriculum_online",
  "curriculum_onsite",
  "includes",
  "notes",
] as const;

const TEXT_KEYS = ["subtitle", "description", "cover_url", "hero_lead"] as const;

type ContentArgs = {
  subtitle?: string | null;
  description?: string | null;
  price?: number;
  compare_at_price?: number | null;
  cover_url?: string | null;
  hero_lead?: string | null;
  tags?: string[];
  benefits?: string[];
  suitable_for?: string[];
  not_suitable_for?: string[];
  outcomes?: string[];
  curriculum_online?: string[];
  curriculum_onsite?: string[];
  includes?: string[];
  notes?: string[];
  is_featured?: boolean;
  asks_intake?: boolean;
  sort_order?: number;
  title?: string;
  slug?: string;
};

/** 有給的欄位蓋到 base 上（base = 空白新商品或資料庫現值）。回傳蓋了哪些 payload 欄位。 */
function applyContentArgs(base: ProductFields, a: ContentArgs): { fields: ProductFields; keys: ProductPayloadKey[] } {
  const f = { ...base };
  const keys: ProductPayloadKey[] = [];
  if (a.title !== undefined) {
    f.title = a.title.trim();
    keys.push("title");
  }
  if (a.slug !== undefined) {
    f.slug = a.slug.trim();
    keys.push("slug");
  }
  for (const k of TEXT_KEYS) {
    if (a[k] !== undefined) {
      f[k] = (a[k] ?? "").trim();
      keys.push(k);
    }
  }
  for (const k of LIST_KEYS) {
    if (a[k] !== undefined) {
      f[k] = (a[k] ?? []).map((s) => s.replace(/[\r\n]+/g, " ").trim()).join("\n");
      keys.push(k);
    }
  }
  if (a.price !== undefined) {
    f.price = String(a.price);
    keys.push("price");
  }
  if (a.compare_at_price !== undefined) {
    f.compare_at_price = a.compare_at_price === null ? "" : String(a.compare_at_price);
    keys.push("compare_at_price");
  }
  if (a.sort_order !== undefined) {
    f.sort_order = String(a.sort_order);
    keys.push("sort_order");
  }
  if (a.is_featured !== undefined) {
    f.is_featured = a.is_featured;
    keys.push("is_featured");
  }
  if (a.asks_intake !== undefined) {
    f.asks_intake = a.asks_intake;
    keys.push("asks_intake");
  }
  return { fields: f, keys };
}

/**
 * 封面只收「我們自己 media bucket 的網址」或這門課原本的值。
 * 外部網址直接寫進 cover_url 會讓前台熱連結別人的圖（而且 next/image 不放行）。
 */
function checkCover(value: string, current: string | null) {
  if (!value || value === current || isMediaUrl(value)) return;
  throw new ToolInputError(
    "封面要先用 upload_image_from_url（有公開網址時）或 upload_image_base64 上傳到網站，再把它回傳的 cover_url 填進來。",
  );
}

function emptyProductFields(type: ProductType): ProductFields {
  return {
    type,
    slug: "",
    title: "",
    subtitle: "",
    description: "",
    cover_url: "",
    hero_lead: "",
    price: "",
    compare_at_price: "",
    sort_order: "0",
    tags: "",
    benefits: "",
    suitable_for: "",
    not_suitable_for: "",
    outcomes: "",
    curriculum_online: "",
    curriculum_onsite: "",
    includes: "",
    notes: "",
    // 🔴 新建一律草稿。上架只能走 publish_product。
    is_published: false,
    is_featured: false,
    asks_intake: false,
  };
}

/* ============================================================ 改價說明 */

function priceChangeLines(before: Record<string, unknown>, write: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if ("price" in write && before.price !== write.price) {
    lines.push(
      `售價：${formatMoney(before.price as number)} → ${formatMoney(write.price as number)}（左邊是目前售價，右邊是改完的新售價）`,
    );
  }
  if ("compare_at_price" in write && before.compare_at_price !== write.compare_at_price) {
    lines.push(
      `劃線原價：${before.compare_at_price == null ? "不顯示" : formatMoney(before.compare_at_price as number)} → ${
        write.compare_at_price == null ? "不顯示" : formatMoney(write.compare_at_price as number)
      }`,
    );
  }
  return lines;
}

/* ============================================================ 唯讀輸出 */

function lessonOut(l: LessonRow) {
  return {
    id: l.id,
    position: l.sort_order,
    title: l.title,
    youtube_url: l.youtube_id ? youTubeWatchUrl(l.youtube_id) : null,
    duration: l.duration_sec == null ? null : formatDuration(l.duration_sec),
    free_preview: l.free_preview,
    body: l.body,
    materials: (l.lesson_materials ?? []).length,
  };
}

function sessionOut(s: SessionRow, productPrice: number) {
  return {
    id: s.id,
    starts_at: isoToTaipeiLocal(s.starts_at).replace("T", " "),
    ends_at: isoToTaipeiLocal(s.ends_at).replace("T", " "),
    timezone: "台北時間",
    title: s.title,
    summary: s.summary,
    format: s.format ? SESSION_FORMAT_LABEL[s.format] : null,
    format_code: s.format,
    location: s.location,
    address: s.address,
    capacity: s.capacity,
    seats_taken: s.seats_taken,
    status: s.status,
    status_label: SESSION_STATUS_LABEL[s.status],
    price: s.price,
    effective_price: s.price ?? productPrice,
    notes: s.notes,
  };
}

function blockOut(b: BlockRow) {
  const meta = (b.meta ?? {}) as { amount?: number; note?: string };
  return {
    id: b.id,
    position: b.sort_order,
    title: b.title,
    body: b.body,
    ...(b.kind === "pricing" ? { amount: meta.amount ?? null, note: meta.note ?? null } : {}),
  };
}

function detailOut(d: ProductDetail) {
  const p = d.product;
  const blocks: Record<string, unknown[]> = {};
  for (const k of BLOCK_KINDS) blocks[k] = d.blocks.filter((b) => b.kind === k).map(blockOut);
  return {
    id: p.id,
    type: p.type,
    type_label: PRODUCT_TYPE_LABEL[p.type],
    slug: p.slug,
    title: p.title,
    subtitle: p.subtitle,
    description: p.description,
    price: p.price,
    compare_at_price: p.compare_at_price,
    cover_url: p.cover_url,
    is_published: p.is_published,
    status_label: p.is_published ? "發布中（前台看得到）" : "草稿（前台看不到）",
    is_featured: p.is_featured,
    tags: p.tags,
    benefits: p.benefits,
    sort_order: p.sort_order,
    hero_lead: p.hero_lead,
    suitable_for: p.suitable_for,
    not_suitable_for: p.not_suitable_for,
    outcomes: p.outcomes,
    curriculum_online: p.curriculum_online,
    curriculum_onsite: p.curriculum_onsite,
    includes: p.includes,
    notes: p.notes,
    asks_intake: p.asks_intake,
    lessons: d.lessons.map(lessonOut),
    sessions: d.sessions.map((s) => sessionOut(s, p.price)),
    content_blocks: blocks,
    public_url: publicUrlFor(p),
    admin_url: adminUrlFor(p.id),
    note:
      p.type === "course"
        ? "線上課程頁目前只顯示標題、副標、說明、售價、封面、亮點與單元；報名頁內容與內容區塊填了會保存，但線上課程頁暫不顯示。"
        : undefined,
  };
}

/* ============================================================ 單元輸入 */

const LESSON_ITEM = z.object({
  id: z.string().uuid().optional().describe("既有單元的 id（get_product 查得到）。新的單元不要帶"),
  title: z.string().max(200).optional().describe("單元標題（新單元必填）"),
  youtube: z
    .string()
    .max(300)
    .nullable()
    .optional()
    .describe("YouTube 網址（watch?v=、youtu.be、shorts 都可以）或 11 碼影片 ID；null 或空字串＝清掉影片"),
  duration: z
    .string()
    .max(10)
    .nullable()
    .optional()
    .describe("時長「分:秒」例如 12:30；只寫數字當分鐘；null＝不顯示"),
  free_preview: z.boolean().optional().describe("免費試看"),
  body: z.string().max(8000).nullable().optional().describe("這一堂的文字說明（空一行分段）"),
});

type LessonArg = z.infer<typeof LESSON_ITEM>;

function parseDuration(raw: string, index: number): number | null {
  const t = raw.trim();
  if (!t) return null;
  const m = /^(\d{1,4})(?::(\d{1,2}))?$/.exec(t);
  if (!m || (m[2] !== undefined && Number(m[2]) > 59)) {
    throw new ToolInputError(`第 ${index + 1} 個單元的時長看不懂：「${t}」。請寫「分:秒」例如 12:30，或只寫分鐘數。`);
  }
  return joinDuration(m[1], m[2] ?? "0");
}

/** 單元參數 → SubmittedLesson。有 id 的：沒給的欄位沿用現值（null／空字串才是清掉）。 */
function lessonsFromArgs(items: LessonArg[], existing: LessonRow[]): SubmittedLesson[] {
  const byId = new Map(existing.map((l) => [l.id, l]));
  const seen = new Set<string>();
  return items.map((a, i) => {
    const cur = a.id ? byId.get(a.id) : undefined;
    if (a.id && !cur) throw new ToolInputError(`第 ${i + 1} 個單元的 id 不是這門課的單元。請先用 get_product 重新查一次。`);
    if (a.id) {
      if (seen.has(a.id)) throw new ToolInputError(`第 ${i + 1} 個單元的 id 重複出現。`);
      seen.add(a.id);
    }
    const n = normalizeLesson(i, {
      id: a.id ?? "",
      title: (a.title ?? cur?.title ?? "").trim(),
      youtube: a.youtube !== undefined ? (a.youtube ?? "").trim() : (cur?.youtube_id ?? ""),
      duration_sec: a.duration !== undefined ? parseDuration(a.duration ?? "", i) : (cur?.duration_sec ?? null),
      free_preview: a.free_preview ?? cur?.free_preview ?? false,
      body: a.body !== undefined ? (a.body ?? "") : (cur?.body ?? ""),
    });
    if ("error" in n) throw new ToolInputError(n.error);
    return n.lesson;
  });
}

/* ============================================================ 區塊輸入 */

const BLOCK_ITEM = z.object({
  id: z.string().uuid().optional().describe("既有區塊的 id（get_product 的 content_blocks 查得到）。新的不要帶"),
  title: z.string().max(300).optional().describe("標題（常見問題＝問題；資訊列＝項目；步驟＝步驟名稱）。新的必填"),
  body: z.string().max(4000).nullable().optional().describe("內文（常見問題＝回答；資訊列＝內容）"),
  amount: z.number().int().min(0).max(10_000_000).nullable().optional().describe("只有 pricing：金額"),
  note: z.string().max(300).nullable().optional().describe("只有 pricing：附註"),
});

type BlockArg = z.infer<typeof BLOCK_ITEM>;

function blocksFromArgs(kind: string, items: BlockArg[], existing: BlockRow[]): SubmittedBlock[] {
  const byId = new Map(existing.map((b) => [b.id, b]));
  const out: SubmittedBlock[] = [];
  const seen = new Set<string>();
  items.forEach((a, i) => {
    const cur = a.id ? byId.get(a.id) : undefined;
    if (a.id && !cur) {
      throw new ToolInputError(`第 ${i + 1} 筆的 id 不是這門課的「${BLOCK_KIND_LABEL[kind]}」。請先用 get_product 重新查一次。`);
    }
    if (a.id) {
      if (seen.has(a.id)) throw new ToolInputError(`第 ${i + 1} 筆的 id 重複出現。`);
      seen.add(a.id);
    }
    const meta = (cur?.meta ?? {}) as { amount?: number; note?: string };
    const amount = a.amount !== undefined ? a.amount : (meta.amount ?? null);
    const n = normalizeBlock(i, kind, {
      id: a.id ?? "",
      title: a.title ?? cur?.title ?? "",
      body: a.body !== undefined ? (a.body ?? "") : (cur?.body ?? ""),
      amount: amount === null || amount === undefined ? "" : String(amount),
      note: a.note !== undefined ? (a.note ?? "") : (meta.note ?? ""),
    });
    if ("skip" in n) {
      throw new ToolInputError(`第 ${i + 1} 筆的標題與內文都是空的。要刪掉它請從清單拿掉並加 allow_delete=true。`);
    }
    if ("error" in n) throw new ToolInputError(n.error);
    out.push(n.block);
  });
  return out;
}

/* ============================================================ 場次輸入 */

const TAIPEI_TIME_ARG = (what: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/, "時間格式請用 YYYY-MM-DD HH:mm（台北時間）")
    .describe(`${what}，台北時間，格式 YYYY-MM-DD HH:mm，例如 2026-12-06 14:00`);

const sessionContentShape = {
  location: z.string().max(200).nullable().optional().describe("地點名稱，例如「台北・好日子教室」；線上課可寫「線上（Google Meet）」"),
  address: z.string().max(300).nullable().optional().describe("地址"),
  capacity: z.number().int().min(0).max(100000).describe("名額"),
  price: z
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .nullable()
    .optional()
    .describe("這一梯的價格（新台幣整數）。省略或 null＝用課程售價；0＝免費"),
  format: z.enum(SESSION_FORMATS).nullable().optional().describe("上課形式：onsite 實體／online 線上／hybrid 線上＋實體"),
  title: z.string().max(200).nullable().optional().describe("梯次名稱，例如「12 月週末班」"),
  summary: z.string().max(300).nullable().optional().describe("梯次摘要（一兩句）"),
  notes: z.string().max(300).nullable().optional().describe("補充說明"),
};

type SessionArgs = {
  starts_at?: string;
  ends_at?: string;
  location?: string | null;
  address?: string | null;
  capacity?: number;
  price?: number | null;
  format?: (typeof SESSION_FORMATS)[number] | null;
  title?: string | null;
  summary?: string | null;
  notes?: string | null;
  status?: (typeof SESSION_STATUS_CHOICES)[number];
};

function sessionFieldsFromRow(s: SessionRow): SessionFields {
  return {
    starts_at: isoToTaipeiLocal(s.starts_at),
    ends_at: isoToTaipeiLocal(s.ends_at),
    capacity: String(s.capacity),
    status: s.status,
    location: s.location ?? "",
    address: s.address ?? "",
    title: s.title ?? "",
    summary: s.summary ?? "",
    notes: s.notes ?? "",
    price: s.price === null ? "" : String(s.price),
    format: s.format ?? "",
  };
}

function applySessionArgs(base: SessionFields, a: SessionArgs): { fields: SessionFields; keys: SessionPayloadKey[] } {
  const f = { ...base };
  const keys: SessionPayloadKey[] = [];
  const text = ["location", "address", "title", "summary", "notes"] as const;
  if (a.starts_at !== undefined) {
    f.starts_at = a.starts_at;
    keys.push("starts_at");
  }
  if (a.ends_at !== undefined) {
    f.ends_at = a.ends_at;
    keys.push("ends_at");
  }
  for (const k of text) {
    if (a[k] !== undefined) {
      f[k] = (a[k] ?? "").trim();
      keys.push(k);
    }
  }
  if (a.capacity !== undefined) {
    f.capacity = String(a.capacity);
    keys.push("capacity");
  }
  if (a.price !== undefined) {
    f.price = a.price === null ? "" : String(a.price);
    keys.push("price");
  }
  if (a.format !== undefined) {
    f.format = a.format ?? "";
    keys.push("format");
  }
  if (a.status !== undefined) {
    f.status = a.status;
    keys.push("status");
  }
  return { fields: f, keys };
}

function sessionPreviewOut(p: { starts_at: string; ends_at: string } & Record<string, unknown>, productPrice: number) {
  return {
    starts_at: formatTaipei(p.starts_at),
    ends_at: formatTaipei(p.ends_at),
    timezone: "台北時間",
    title: p.title ?? null,
    summary: p.summary ?? null,
    format: p.format ? SESSION_FORMAT_LABEL[p.format as keyof typeof SESSION_FORMAT_LABEL] : "未指定",
    location: p.location ?? null,
    address: p.address ?? null,
    capacity: p.capacity,
    price:
      p.price == null
        ? `用課程售價 ${formatMoney(productPrice)}`
        : formatMoney(p.price as number),
    notes: p.notes ?? null,
  };
}

/* ============================================================== 圖片 */

const BASE64_MAX_BYTES = 2 * 1024 * 1024;
/** 原檔 2MB → base64 4×ceil(2MB/3) 字。外加一點空白／換行的寬限。 */
const BASE64_MAX_CHARS = 4 * Math.ceil(BASE64_MAX_BYTES / 3) + 4096;
const REMOTE_MAX_BYTES = 8 * 1024 * 1024;

const IMAGE_GUIDE =
  "【封面圖怎麼上傳】上傳只會把圖存進網站的圖片空間，不會改任何頁面；拿到 cover_url 之後要再用 create_product／update_product 填進 cover_url 才會換封面。" +
  "伺服器會跟後台上傳一樣處理：只收 JPEG／PNG／WebP，依 EXIF 轉正、縮到長邊 2000px、轉成 WebP。" +
  "圖片有公開 https 網址 → upload_image_from_url；只能把圖片轉成 base64 放進參數 → upload_image_base64（原檔 2MB 以內）。" +
  "⚠️ 使用者在手機 App 貼進對話的相簿照片，AI 不一定拿得到原始檔案（官方沒有保證能把附件交給工具）。" +
  "拿不到時請請使用者改用：①把照片放到雲端相簿／雲端硬碟並開成公開連結，再用 upload_image_from_url；或 ②到後台 /admin 的課程編輯頁直接上傳封面。";

function imageFailText(reason: ProcessFailure): string {
  switch (reason) {
    case "format":
      return "這個檔案不是 JPEG／PNG／WebP 圖片，請換一張再試。";
    case "toolarge":
      return "圖片的尺寸太大（超過 5000 萬像素），請先縮小再上傳。";
    default:
      return "圖片內容無法解析，請確認檔案沒有損毀，或換一張再試。";
  }
}

async function processBytes(bytes: Buffer) {
  // 先看 magic bytes 再交給 libvips：SVG／HTML 這類東西連解析都不給它解析。
  if (!sniffImageFormat(bytes)) throw new ToolInputError("這不是 JPEG／PNG／WebP 圖片（檔頭不符），請換一張。");
  const r = await processImage(bytes);
  if (!r.ok) throw new ToolInputError(imageFailText(r.reason));
  return r.image;
}

/* ============================================================ 註冊 */

export function registerContentTools(server: McpServer, run: RunAs): void {
  /* ---------------------------------------------------------- 唯讀 */

  server.registerTool(
    "list_products",
    {
      title: "課程與工作坊清單",
      description:
        "列出線上課程、工作坊、訂閱制（含草稿）。回傳 id、網址代稱、名稱、售價、是否上架、單元數與場次數。" +
        "之後用 get_product 看單一商品的完整內容。",
      inputSchema: z.object({
        type: z.enum(PRODUCT_TYPES).optional().describe("只看某一類：course 線上課程／workshop 工作坊／subscription 訂閱制"),
        published: z.boolean().optional().describe("true 只看上架中、false 只看草稿；省略＝全部"),
      }),
      annotations: READ_ONLY,
    },
    async ({ type, published }) =>
      inScope(run, "catalog:read", "已讀取。", async () => {
        const rows = await loadProductList(createServiceClient(), {
          types: type ? [type] : PRODUCT_TYPES,
          published,
        });
        return {
          ok: true,
          data: {
            products: rows.map((r) => ({
              id: r.id,
              type: r.type,
              type_label: PRODUCT_TYPE_LABEL[r.type],
              slug: r.slug,
              title: r.title,
              price: r.price,
              is_published: r.is_published,
              status_label: r.is_published ? "發布中" : "草稿",
              lessons: r.lessonCount,
              sessions: r.sessionCount,
            })),
            total: rows.length,
          },
        };
      }),
  );

  server.registerTool(
    "get_product",
    {
      title: "單一課程／工作坊完整內容",
      description:
        "看一門課或工作坊的完整內容：主檔欄位、封面、線上課單元（含 id）、工作坊場次（台北時間，含 id）、" +
        "內容區塊（常見問題、學習路徑、報名資訊、費用方案、特色說明，含 id）。改單元、場次、區塊前先用這支查 id。",
      inputSchema: z.object({ product: PRODUCT_ARG }),
      annotations: READ_ONLY,
    },
    async ({ product }) =>
      inScope(run, "catalog:read", "已讀取。", async () => {
        const row = await resolveProduct(product);
        const d = await loadProductDetail(createServiceClient(), row.id);
        if (!d) return { ok: false, error: "找不到這門課，可能剛被刪除了。" };
        return { ok: true, data: detailOut(d) };
      }),
  );

  /* ---------------------------------------------------------- 商品 */

  server.registerTool(
    "create_product",
    {
      title: "新增課程或工作坊（草稿，先預覽）",
      description:
        "建立一門線上課程（type=course）、工作坊（workshop）或訂閱制（subscription）。一律建成草稿，前台看不到；" +
        "內容都填好之後用 publish_product 上架。網址代稱（slug）可以省略：預覽會自動產生一個合法且沒人用的代稱（撞名自動加 -2、-3）。" +
        "建好之後：線上課用 set_lessons 加單元；工作坊用 create_session 加場次；常見問題等用 set_content_blocks；封面先上傳圖片再用 update_product 填 cover_url。" +
        DRY_RUN_NOTE,
      inputSchema: z.object({
        type: z.enum(PRODUCT_TYPES).describe("course 線上課程／workshop 工作坊／subscription 訂閱制"),
        title: z.string().trim().min(1).max(200).describe("名稱"),
        slug: z
          .string()
          .trim()
          .max(80)
          .regex(/^[a-z0-9-]+$/, "網址代稱只能用小寫英文、數字與連字號（-）")
          .optional()
          .describe("網址代稱（/courses/<slug>）。可省略，預覽會自動產生"),
        ...productContentShape,
        idempotency_key: IDEMPOTENCY_ARG,
        dry_run: DRY_RUN_ARG,
      }),
      annotations: { ...WRITE, destructiveHint: false, idempotentHint: true },
    },
    async (args) =>
      inScope(run, "catalog:write", "已建立。", async (staff) => {
        const dryRun = args.dry_run !== false;
        const db = createServiceClient();

        if (!dryRun && (!args.slug || !args.idempotency_key)) {
          return {
            ok: false,
            error: "正式建立需要預覽回傳的 confirm_args（裡面有決定好的 slug 與 idempotency_key）。請先用 dry_run=true 預覽一次，再把 confirm_args 原樣送出。",
          };
        }

        const slug = args.slug ?? (await pickAvailableSlug(db, slugBaseFor(args.title, args.type)));
        const key = args.idempotency_key ?? `mcp-${randomUUID()}`;
        checkCover((args.cover_url ?? "").trim(), null);

        const { fields } = applyContentArgs(emptyProductFields(args.type), { ...args, slug });
        const ctx = liveMutationCtx(staff);
        const r = await createProduct(ctx, fields, { dryRun, idempotencyKey: key });
        if (r.error) {
          return {
            ok: false,
            error:
              r.error === "slug_taken" && !args.slug
                ? codeText(r.error)
                : r.error === "slug_taken"
                  ? `${codeText(r.error)}（${slug}）。可以換一個，或不帶 slug 讓系統自動產生。`
                  : codeText(r.error),
          };
        }

        // 重送（replayed）時顯示資料庫裡當初那一筆的實際內容，不是這次送來的參數。
        const src = (r.replayed && r.existing ? r.existing : r.payload) as typeof r.payload;
        const shown = {
          type: PRODUCT_TYPE_LABEL[r.type],
          title: src.title,
          slug: src.slug,
          public_url_after_publish: publicUrlFor({ type: r.type, slug: src.slug }),
          price: formatMoney(src.price),
          compare_at_price: src.compare_at_price == null ? "不顯示" : formatMoney(src.compare_at_price),
          subtitle: src.subtitle,
          description: src.description,
          cover_url: src.cover_url,
          tags: src.tags,
          benefits: src.benefits,
          status: src.is_published ? "發布中" : "草稿（前台看不到，之後用 publish_product 上架）",
        };

        if (r.dryRun) {
          if (r.replayed) {
            return {
              ok: true,
              data: {
                dry_run: true,
                executed: false,
                already_created: true,
                product_id: r.id,
                message: "這個 idempotency_key 已經建立過商品了，不會再建一筆。請用 get_product 查看。",
              },
            };
          }
          await auditPreview(staff, "create_product", "product", null, productRef(r.payload), {
            will_execute: true,
            slug: r.payload.slug,
            idempotency_key: key,
          });
          const { dry_run: _omit, ...rest } = args;
          void _omit;
          return {
            ok: true,
            data: {
              dry_run: true,
              executed: false,
              preview: shown,
              slug_auto_generated: !args.slug,
              confirm_args: { ...rest, slug, idempotency_key: key, dry_run: false },
              next_step:
                "這只是預覽，還沒有建立。請把 preview 念給使用者確認，取得同意後把 confirm_args 原樣當參數再呼叫一次 create_product。",
            },
          };
        }

        return {
          ok: true,
          data: {
            executed: true,
            already_created: r.replayed === true,
            product_id: r.id,
            message: r.replayed
              ? "這個 idempotency_key 之前已經建立過，沒有重複建立。以下是當初那一筆。"
              : `已建立${PRODUCT_TYPE_LABEL[r.type]}「${r.payload.title}」（草稿）。`,
            product: shown,
            admin_url: adminUrlFor(r.id),
            next_steps:
              r.type === "workshop"
                ? "用 create_session 加場次、set_content_blocks 加常見問題等；都好了用 publish_product 上架。"
                : "用 set_lessons 加單元；都好了用 publish_product 上架。",
          },
        };
      }),
  );

  server.registerTool(
    "update_product",
    {
      title: "編輯課程或工作坊（先預覽）",
      description:
        "修改一門課／工作坊的內容。只改有給的欄位，沒給的維持原樣；文字欄位給 null 或空字串＝清空，清單欄位給 []＝清空。" +
        "改售價時預覽會寫出「目前售價 → 新售價」。改網址代稱會讓舊網址失效。不能用這支上下架（請用 publish_product／unpublish_product）。" +
        DRY_RUN_NOTE,
      inputSchema: z.object({
        product: PRODUCT_ARG,
        title: z.string().trim().min(1).max(200).optional().describe("名稱"),
        slug: z
          .string()
          .trim()
          .max(80)
          .regex(/^[a-z0-9-]+$/, "網址代稱只能用小寫英文、數字與連字號（-）")
          .optional()
          .describe("新的網址代稱（舊網址會失效，非必要不要改）"),
        ...productContentShape,
        price: productContentShape.price.optional(),
        dry_run: DRY_RUN_ARG,
      }),
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
    },
    async (args) =>
      inScope(run, "catalog:write", "已更新。", async (staff) => {
        const dryRun = args.dry_run !== false;
        const row = await resolveProduct(args.product);
        const { product: _p, dry_run: _d, ...content } = args;
        void _p;
        void _d;
        const { fields, keys } = applyContentArgs(productFieldsFromRow(row), content);
        if (keys.length === 0) return { ok: false, error: "沒有要改的欄位。請至少給一個欄位。" };
        if (content.cover_url !== undefined) checkCover((content.cover_url ?? "").trim(), row.cover_url);

        const r = await updateProduct(liveMutationCtx(staff), row.id, fields, { dryRun, onlyKeys: keys });
        if (r.error) return { ok: false, error: codeText(r.error) };

        const changes = r.diff ?? {};
        const priceLines = priceChangeLines(r.before, r.write as Record<string, unknown>);
        const warnings: string[] = [];
        if (r.slugChanged) warnings.push(`網址代稱 ${String(r.before.slug)} → ${r.payload.slug}：舊網址會失效（分享出去的連結會 404）。`);
        let sessionPrices: string[] | undefined;
        if ("price" in r.write && r.before.price !== r.write.price) {
          warnings.push("改售價不會影響已經下單的訂單。");
          // 場次價格留空＝用課程售價，所以改售價等於同時改了這些場次的實際售價。逐場列出來。
          const d = await loadProductDetail(createServiceClient(), row.id);
          const upcoming = (d?.sessions ?? []).filter((s) => new Date(s.ends_at).getTime() > Date.now());
          sessionPrices = upcoming.map((s) =>
            s.price == null
              ? `${formatTaipei(s.starts_at)} 場：${formatMoney(r.before.price as number)} → ${formatMoney(r.write.price as number)}（這一場用課程售價，會跟著變）`
              : `${formatTaipei(s.starts_at)} 場：維持 ${formatMoney(s.price)}（這一場有自己的價格，不受影響）`,
          );
          if (sessionPrices.length === 0) sessionPrices = undefined;
        }

        if (r.dryRun) {
          await auditPreview(staff, "update_product", "product", row.id, productRef(row), {
            will_execute: Object.keys(changes).length > 0,
            fields: keys,
          });
          return {
            ok: true,
            data: {
              dry_run: true,
              executed: false,
              target: productRef(row),
              price_change: priceLines.length ? priceLines : undefined,
              session_prices: sessionPrices,
              changes: Object.keys(changes).length ? changes : "跟現在的內容一樣，沒有要改的地方。",
              warnings: warnings.length ? warnings : undefined,
              confirm_args: { ...args, product: row.id, dry_run: false },
              next_step:
                "這只是預覽，還沒有改。請把 changes（改價請逐字念出 price_change）告訴使用者，取得同意後把 confirm_args 原樣當參數再呼叫一次。",
            },
          };
        }

        return {
          ok: true,
          data: {
            executed: true,
            product_id: row.id,
            message: `已更新「${r.payload.title}」。`,
            price_change: priceLines.length ? priceLines : undefined,
            session_prices: sessionPrices,
            changes,
            warnings: warnings.length ? warnings : undefined,
          },
        };
      }),
  );

  /* ---------------------------------------------------------- 單元 */

  server.registerTool(
    "set_lessons",
    {
      title: "設定線上課單元（整批，先預覽）",
      description:
        "整批設定一門線上課的單元，**清單順序就是上課順序**。既有單元要帶 id（get_product 查得到），沒給的欄位沿用現值；新單元不帶 id。" +
        "要在最後加一堂：把既有單元（只帶 id 也可以）照原順序放進清單，再把新的一堂接在後面。" +
        "清單沒列到的既有單元會被刪除（連同學員在那一堂的觀看進度，無法復原），所以預設會擋下，要刪請加 allow_delete=true。" +
        "預覽會列出新增、修改、刪除、順序變動。" +
        DRY_RUN_NOTE,
      inputSchema: z.object({
        product: PRODUCT_ARG,
        lessons: z.array(LESSON_ITEM).max(200).describe("全部單元，依上課順序"),
        allow_delete: z.boolean().optional().describe("清單沒列到的既有單元要不要刪除。預設 false（擋下）"),
        dry_run: DRY_RUN_ARG,
      }),
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
    },
    async (args) =>
      inScope(run, "catalog:write", "已儲存單元。", async (staff) => {
        const dryRun = args.dry_run !== false;
        const row = await resolveProduct(args.product);
        const d = await loadProductDetail(createServiceClient(), row.id);
        if (!d) return { ok: false, error: "找不到這門課，可能剛被刪除了。" };

        const submitted = lessonsFromArgs(args.lessons, d.lessons);
        const r = await saveLessonsCore(liveMutationCtx(staff), row.id, submitted, {
          dryRun,
          allowDelete: args.allow_delete === true,
        });
        if (r.error !== undefined) return { ok: false, error: r.error };

        const byId = new Map(d.lessons.map((l) => [l.id, l]));
        const added = r.plan.insert.map((l) => `第 ${l.sort_order} 堂（新）「${l.title}」`);
        const removed = r.plan.deleteIds.map((id) => `「${byId.get(id)?.title ?? id}」`);
        const modified: string[] = [];
        const moved: string[] = [];
        for (const u of r.plan.update) {
          const cur = byId.get(u.id);
          if (!cur) continue;
          const diffs: string[] = [];
          if (cur.title !== u.title) diffs.push(`標題「${cur.title}」→「${u.title}」`);
          if (cur.youtube_id !== u.youtube_id) diffs.push(`影片 ${cur.youtube_id ?? "無"} → ${u.youtube_id ?? "無"}`);
          if (cur.duration_sec !== u.duration_sec) diffs.push(`時長 ${formatDuration(cur.duration_sec)} → ${formatDuration(u.duration_sec)}`);
          if (cur.free_preview !== u.free_preview) diffs.push(u.free_preview ? "改成免費試看" : "取消免費試看");
          if ((cur.body ?? null) !== u.body) diffs.push("文字說明有改");
          if (diffs.length) modified.push(`「${u.title}」：${diffs.join("、")}`);
          if (cur.sort_order !== u.sort_order) moved.push(`「${u.title}」第 ${cur.sort_order} → 第 ${u.sort_order} 堂`);
        }
        const summary = { added, modified, removed, reordered: moved, total_after: submitted.length };
        const warnings: string[] = [];
        if (row.type !== "course") warnings.push(`這是${PRODUCT_TYPE_LABEL[row.type]}，單元只會出現在線上課程的上課頁。`);
        if (removed.length) warnings.push("刪除單元會一併刪除學員在那幾堂的觀看進度，無法復原。");
        const noVideo = submitted.filter((l) => !l.youtube_id).map((l) => `「${l.title}」`);
        if (noVideo.length) warnings.push(`這些單元沒有影片，學員點進去會看不到影片：${noVideo.join("、")}`);

        if (r.dryRun) {
          await auditPreview(staff, "set_lessons", "product", row.id, productRef(row), {
            will_execute: true,
            added: added.length,
            modified: modified.length,
            removed: removed.length,
          });
          return {
            ok: true,
            data: {
              dry_run: true,
              executed: false,
              target: productRef(row),
              summary,
              warnings: warnings.length ? warnings : undefined,
              confirm_args: { ...args, product: row.id, dry_run: false },
              next_step: "這只是預覽，還沒有儲存。請把 summary 告訴使用者，取得同意後把 confirm_args 原樣當參數再呼叫一次。",
            },
          };
        }
        return { ok: true, data: { executed: true, message: r.ok, summary } };
      }),
  );

  /* ---------------------------------------------------------- 場次 */

  server.registerTool(
    "create_session",
    {
      title: "新增工作坊場次（先預覽）",
      description:
        "替工作坊（或另開實體班的線上課）加一個場次。時間一律台北時間。" +
        "新場次不會直接對外開放：商品還是草稿時，場次是「開放報名」，跟著商品上架一起生效；" +
        "商品已經上架時，新場次先設成「停止報名」，確認無誤後用 update_session 把 status 改成 open。" +
        DRY_RUN_NOTE,
      inputSchema: z.object({
        product: PRODUCT_ARG,
        starts_at: TAIPEI_TIME_ARG("開始時間"),
        ends_at: TAIPEI_TIME_ARG("結束時間"),
        ...sessionContentShape,
        idempotency_key: IDEMPOTENCY_ARG,
        dry_run: DRY_RUN_ARG,
      }),
      annotations: { ...WRITE, destructiveHint: false, idempotentHint: true },
    },
    async (args) =>
      inScope(run, "catalog:write", "已新增場次。", async (staff) => {
        const dryRun = args.dry_run !== false;
        if (!dryRun && !args.idempotency_key) {
          return {
            ok: false,
            error: "正式新增需要預覽回傳的 confirm_args（裡面有 idempotency_key）。請先用 dry_run=true 預覽一次。",
          };
        }
        const row = await resolveProduct(args.product);
        const key = args.idempotency_key ?? `mcp-${randomUUID()}`;
        // 新建不直接對外：已上架的商品，新場次先停止報名。
        const status = row.is_published ? "closed" : "open";
        const base: SessionFields = {
          starts_at: "",
          ends_at: "",
          capacity: "",
          status,
          location: "",
          address: "",
          title: "",
          summary: "",
          notes: "",
          price: "",
          format: "",
        };
        const { fields } = applySessionArgs(base, { ...args, status: undefined });
        fields.status = status;

        const r = await createSession(liveMutationCtx(staff), row.id, fields, { dryRun, idempotencyKey: key });
        if (r.error) return { ok: false, error: codeText(r.error) };

        const shown = {
          product: productRef(row),
          // 重送時顯示當初那一場的實際內容
          ...sessionPreviewOut(
            (r.replayed && r.existing ? r.existing : r.payload) as typeof r.payload,
            row.price,
          ),
          status: SESSION_STATUS_LABEL[
            ((r.replayed && r.existing ? r.existing.status : r.payload.status) as keyof typeof SESSION_STATUS_LABEL) ?? "open"
          ] ?? String(r.payload.status),
          status_reason: row.is_published
            ? "商品已上架，新場次先停止報名；確認後用 update_session 設 status=open 才會開放。"
            : "商品還是草稿，場次跟著商品上架一起開放。",
        };

        if (r.dryRun) {
          if (r.replayed) {
            return {
              ok: true,
              data: { dry_run: true, executed: false, already_created: true, session_id: r.id, message: "這個 idempotency_key 已經新增過場次了，不會再新增。" },
            };
          }
          await auditPreview(staff, "create_session", "product", row.id, `${productRef(row)} ${shown.starts_at}`, {
            will_execute: true,
            idempotency_key: key,
          });
          const { dry_run: _d, ...rest } = args;
          void _d;
          return {
            ok: true,
            data: {
              dry_run: true,
              executed: false,
              preview: shown,
              confirm_args: { ...rest, product: row.id, idempotency_key: key, dry_run: false },
              next_step: "這只是預覽，還沒有新增。請把 preview 告訴使用者，取得同意後把 confirm_args 原樣當參數再呼叫一次。",
            },
          };
        }
        return {
          ok: true,
          data: {
            executed: true,
            already_created: r.replayed === true,
            session_id: r.id,
            message: r.replayed ? "這個 idempotency_key 之前已經新增過，沒有重複新增。" : "已新增場次。",
            session: { ...shown, status: r.landedStatus ? SESSION_STATUS_LABEL[r.landedStatus as keyof typeof SESSION_STATUS_LABEL] ?? r.landedStatus : shown.status },
          },
        };
      }),
  );

  server.registerTool(
    "update_session",
    {
      title: "編輯工作坊場次（先預覽）",
      description:
        "修改一個場次。只改有給的欄位。status：open 開放報名／closed 停止報名／cancelled 已取消（「已額滿」由系統依名額自動判定，不能手動設）。" +
        "名額不能低於已報名人數。取消場次不會自動退款或通知已報名的人。不能刪除場次。" +
        DRY_RUN_NOTE,
      inputSchema: z.object({
        session_id: z.string().uuid().describe("場次 id（get_product 的 sessions 查得到）"),
        starts_at: TAIPEI_TIME_ARG("開始時間").optional(),
        ends_at: TAIPEI_TIME_ARG("結束時間").optional(),
        ...sessionContentShape,
        capacity: sessionContentShape.capacity.optional(),
        status: z.enum(SESSION_STATUS_CHOICES).optional().describe("open 開放報名／closed 停止報名／cancelled 已取消"),
        dry_run: DRY_RUN_ARG,
      }),
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
    },
    async (args) =>
      inScope(run, "catalog:write", "已更新場次。", async (staff) => {
        const dryRun = args.dry_run !== false;
        const db = createServiceClient();
        const productId = await findSessionProductId(db, args.session_id);
        if (!productId) return { ok: false, error: codeText("session_notfound") };
        const d = await loadProductDetail(db, productId);
        const cur = d?.sessions.find((s) => s.id === args.session_id);
        if (!d || !cur) return { ok: false, error: codeText("session_notfound") };

        const { session_id: _s, dry_run: _d, ...content } = args;
        void _s;
        void _d;
        const { fields, keys } = applySessionArgs(sessionFieldsFromRow(cur), content);
        if (keys.length === 0) return { ok: false, error: "沒有要改的欄位。請至少給一個欄位。" };

        const r = await updateSession(liveMutationCtx(staff), productId, cur.id, fields, { dryRun, onlyKeys: keys });
        if (r.error) {
          return {
            ok: false,
            error:
              r.error === "session_capacity_invalid" && args.capacity !== undefined && args.capacity < cur.seats_taken
                ? `名額不能低於已報名人數（目前已報名 ${cur.seats_taken} 人）。`
                : codeText(r.error),
          };
        }

        const before = sessionPreviewOut(
          { ...cur, starts_at: cur.starts_at, ends_at: cur.ends_at } as unknown as { starts_at: string; ends_at: string } & Record<string, unknown>,
          d.product.price,
        ) as Record<string, unknown>;
        const after = sessionPreviewOut(r.payload, d.product.price) as Record<string, unknown>;
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const k of Object.keys(after)) {
          if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changes[k] = { from: before[k], to: after[k] };
        }
        if (keys.includes("status") && cur.status !== r.payload.status) {
          changes.status = { from: SESSION_STATUS_LABEL[cur.status], to: SESSION_STATUS_LABEL[r.payload.status] };
        }
        const warnings: string[] = [];
        if (keys.includes("price") && cur.price !== r.payload.price) {
          warnings.push(
            `這一梯價格：${cur.price == null ? `用課程售價 ${formatMoney(d.product.price)}` : formatMoney(cur.price)} → ${
              r.payload.price == null ? `用課程售價 ${formatMoney(d.product.price)}` : formatMoney(r.payload.price)
            }。已下單的訂單不受影響。`,
          );
        }
        if (r.payload.status === "cancelled" && cur.status !== "cancelled" && cur.seats_taken > 0) {
          warnings.push(`這一場已有 ${cur.seats_taken} 人報名。取消場次不會自動退款或通知他們，需要另外處理。`);
        }
        if (r.payload.status === "open" && cur.status !== "open" && cur.status !== "full" && !d.product.is_published) {
          warnings.push("商品還是草稿，場次開放了前台也還看不到；要對外請用 publish_product 上架。");
        }

        if (r.dryRun) {
          await auditPreview(staff, "update_session", "session", cur.id, `${productRef(d.product)} ${formatTaipei(cur.starts_at)}`, {
            will_execute: Object.keys(changes).length > 0,
            fields: keys,
          });
          return {
            ok: true,
            data: {
              dry_run: true,
              executed: false,
              target: `${productRef(d.product)} ${formatTaipei(cur.starts_at)} 場`,
              changes: Object.keys(changes).length ? changes : "跟現在一樣，沒有要改的地方。",
              warnings: warnings.length ? warnings : undefined,
              confirm_args: { ...args, dry_run: false },
              next_step: "這只是預覽，還沒有改。請把 changes 告訴使用者，取得同意後把 confirm_args 原樣當參數再呼叫一次。",
            },
          };
        }
        return {
          ok: true,
          data: {
            executed: true,
            message: "已更新場次。",
            changes,
            landed_status: r.landedStatus ? SESSION_STATUS_LABEL[r.landedStatus] : undefined,
            warnings: warnings.length ? warnings : undefined,
          },
        };
      }),
  );

  /* ---------------------------------------------------------- 區塊 */

  server.registerTool(
    "set_content_blocks",
    {
      title: "設定報名頁內容區塊（整批，先預覽）",
      description:
        "整批設定工作坊報名頁的某一種內容區塊，**清單順序就是顯示順序**。kind：faq 常見問題／step 學習路徑／info_row 報名前先確認（項目：內容）／" +
        "pricing 費用方案（可帶 amount 金額與 note 附註）／feature 陪伴機制。一次只設定一種 kind。" +
        "既有的帶 id（get_product 查得到），沒給的欄位沿用現值；新的不帶 id。清單沒列到的既有項目會被刪除，預設擋下，要刪請加 allow_delete=true。" +
        "（線上課程頁目前不顯示這些區塊。）" +
        DRY_RUN_NOTE,
      inputSchema: z.object({
        product: PRODUCT_ARG,
        kind: z.enum(BLOCK_KINDS).describe("faq／step／info_row／pricing／feature"),
        blocks: z.array(BLOCK_ITEM).max(100).describe("這一種區塊的全部項目，依顯示順序"),
        allow_delete: z.boolean().optional().describe("清單沒列到的既有項目要不要刪除。預設 false（擋下）"),
        dry_run: DRY_RUN_ARG,
      }),
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
    },
    async (args) =>
      inScope(run, "catalog:write", "已儲存內容區塊。", async (staff) => {
        const dryRun = args.dry_run !== false;
        const row = await resolveProduct(args.product);
        const d = await loadProductDetail(createServiceClient(), row.id);
        if (!d) return { ok: false, error: "找不到這門課，可能剛被刪除了。" };
        const existing = d.blocks.filter((b) => b.kind === args.kind);
        const submitted = blocksFromArgs(args.kind, args.blocks, existing);

        const r = await saveBlocksCore(liveMutationCtx(staff), row.id, args.kind, submitted, {
          dryRun,
          allowDelete: args.allow_delete === true,
        });
        if (r.error !== undefined) return { ok: false, error: r.error };

        const byId = new Map(existing.map((b) => [b.id, b]));
        const summary = {
          kind: BLOCK_KIND_LABEL[args.kind],
          added: r.plan.insert.map((b) => `「${b.title}」`),
          modified: r.plan.update
            .filter((u) => {
              const cur = byId.get(u.id);
              return cur && (cur.title !== u.title || (cur.body ?? null) !== u.body || JSON.stringify(cur.meta ?? {}) !== JSON.stringify(u.meta));
            })
            .map((u) => `「${u.title}」`),
          removed: r.plan.deleteIds.map((id) => `「${byId.get(id)?.title ?? id}」`),
          total_after: submitted.length,
          items_after: submitted.map((b, i) => ({ position: i + 1, title: b.title, body: b.body, ...b.meta })),
        };

        if (r.dryRun) {
          await auditPreview(staff, "set_content_blocks", "product", row.id, `${productRef(row)} ${BLOCK_KIND_LABEL[args.kind]}`, {
            will_execute: true,
            kind: args.kind,
            added: summary.added.length,
            removed: summary.removed.length,
          });
          return {
            ok: true,
            data: {
              dry_run: true,
              executed: false,
              target: productRef(row),
              summary,
              confirm_args: { ...args, product: row.id, dry_run: false },
              next_step: "這只是預覽，還沒有儲存。請把 summary 告訴使用者，取得同意後把 confirm_args 原樣當參數再呼叫一次。",
            },
          };
        }
        return { ok: true, data: { executed: true, message: r.ok, summary } };
      }),
  );

  /* ---------------------------------------------------------- 圖片 */

  server.registerTool(
    "upload_image_from_url",
    {
      title: "從網址上傳封面圖（先預覽）",
      description:
        "從一個公開 https 網址抓圖（JPEG／PNG／WebP，8MB 以內），存進網站的圖片空間，回傳可以直接填進 cover_url 的網址。" +
        "dry_run=true（預設）只抓下來檢查、回報尺寸，不存。" +
        IMAGE_GUIDE,
      inputSchema: z.object({
        url: z.string().trim().max(2000).describe("圖片的公開 https 網址"),
        dry_run: DRY_RUN_ARG,
      }),
      annotations: { ...WRITE, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, dry_run }) =>
      inScope(run, "media:upload", "已上傳。", async (staff) => {
        const dryRun = dry_run !== false;
        const fetched = await fetchRemoteImage(url, REMOTE_MAX_BYTES);
        const image = await processBytes(fetched.bytes);
        const host = new URL(fetched.finalUrl).hostname;
        const info = { width: image.width, height: image.height, bytes: image.bytes, format: "webp" };

        if (dryRun) {
          await auditPreview(staff, "upload_image_from_url", "media", null, `來源 ${host}`, {
            will_execute: true,
            source_host: host,
            ...info,
          });
          return {
            ok: true,
            data: {
              dry_run: true,
              executed: false,
              check: "圖片檢查通過",
              processed: info,
              confirm_args: { url, dry_run: false },
              next_step: "這只是檢查，還沒有存。取得同意後把 confirm_args 原樣當參數再呼叫一次，會回傳 cover_url。",
            },
          };
        }

        const stored = await storeProcessedMedia(createServiceClient(), staff, writeAudit, "covers", image, randomUUID(), {
          source: "mcp_url",
          source_host: host,
        });
        if (!stored.ok) return { ok: false, error: "圖片上傳失敗，請稍後再試一次。" };
        return {
          ok: true,
          data: {
            executed: true,
            cover_url: stored.url,
            ...info,
            next_step: "把 cover_url 用 update_product（或 create_product）填進 cover_url 才會換封面。",
          },
        };
      }),
  );

  server.registerTool(
    "upload_image_base64",
    {
      title: "上傳封面圖（base64）",
      description:
        "給只能把圖片轉成文字放進參數的情況：data 放圖片的 base64（可以帶 data:image/...;base64, 開頭），原檔上限 2MB。" +
        "伺服器檢查檔頭（真的是 JPEG／PNG／WebP）後處理並存進網站，回傳可以直接填進 cover_url 的網址。" +
        "⚠️ 呼叫即上傳（沒有 dry_run）：上傳本身不改任何頁面，而且避免把整張圖送兩次。" +
        IMAGE_GUIDE,
      inputSchema: z.object({
        data: z.string().min(16).max(BASE64_MAX_CHARS + 100).describe("圖片的 base64"),
        file_name: z.string().max(120).optional().describe("原始檔名（只記在稽核，方便回想是哪張）"),
      }),
      annotations: { ...WRITE, destructiveHint: false, idempotentHint: false },
    },
    async ({ data, file_name }) =>
      inScope(run, "media:upload", "已上傳。", async (staff) => {
        const b64 = data.replace(/^data:image\/[a-z+.-]+;base64,/i, "").replace(/\s+/g, "");
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
          return { ok: false, error: "data 不是正確的 base64。" };
        }
        if (b64.length > 4 * Math.ceil(BASE64_MAX_BYTES / 3)) {
          return { ok: false, error: "圖片超過 2MB。請先壓縮（長邊 2000px 以內的 JPEG 通常不到 1MB），或改用 upload_image_from_url。" };
        }
        const bytes = Buffer.from(b64, "base64");
        if (bytes.byteLength === 0 || bytes.byteLength > BASE64_MAX_BYTES) {
          return { ok: false, error: "圖片是空的或超過 2MB。" };
        }
        const image = await processBytes(bytes);
        const stored = await storeProcessedMedia(createServiceClient(), staff, writeAudit, "covers", image, randomUUID(), {
          source: "mcp_base64",
          // 🔴 稽核不記 base64 內容，只記檔名與大小。
          originalName: (file_name ?? "").slice(0, 120) || null,
          originalBytes: bytes.byteLength,
        });
        if (!stored.ok) return { ok: false, error: "圖片上傳失敗，請稍後再試一次。" };
        return {
          ok: true,
          data: {
            executed: true,
            cover_url: stored.url,
            width: image.width,
            height: image.height,
            bytes: image.bytes,
            next_step: "把 cover_url 用 update_product（或 create_product）填進 cover_url 才會換封面。",
          },
        };
      }),
  );
}
