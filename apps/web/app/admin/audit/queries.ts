import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { taipeiLocalToIso } from "@/components/admin/datetime-field";

/**
 * 稽核紀錄的讀取層與篩選條件解析。
 *
 * 兩件事值得先說清楚：
 *
 * 1. 篩選字串會被**白名單過濾**，不是逃逸。
 *    PostgREST 的 filter 語法裡 `,` `.` `(` `)` 都有意義，而 supabase-js 的
 *    .ilike() 不會幫你加引號 —— 直接把使用者輸入串進去，一個逗號就能改寫查詢。
 *    action / entity 在這個系統裡本來就只會是 `order.mark_paid` 這種
 *    小寫命名空間字串，所以直接限制字元集，讓不合法的輸入根本組不出語法。
 *
 * 2. 日期是**台北日期**，不是 UTC 日期。
 *    資料庫存 UTC，員工想的是「8/9 那天」。差 8 小時的話，8/9 早上 7 點的操作
 *    會被算進 8/8 —— 而且完全看不出來。所以這裡一律經過 taipeiLocalToIso()。
 */

export type Db = ReturnType<typeof createServiceClient>;

export const AUDIT_LIMIT = 200;

export type AuditRow = {
  id: number;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  summary: string;
  diff: Record<string, unknown> | null;
  createdAt: string;
};

export type AuditFilters = {
  /** "" = 全部 */
  entity: string;
  /** "" = 全部。子字串比對，打 `order.` 就能看整個家族。 */
  action: string;
  /** yyyy-mm-dd（台北日期），"" = 不限 */
  from: string;
  to: string;
};

export const EMPTY_FILTERS: AuditFilters = { entity: "", action: "", from: "", to: "" };

/**
 * 目前系統會寫出來的 entity 種類。
 * 認不得的值不會被丟掉，只是沒有中文標籤（見 entityLabel）。
 */
export const KNOWN_ENTITIES = [
  "order",
  "session",
  "waitlist",
  "product",
  "media",
  "staff",
  "staff_invite",
] as const;

const ENTITY_LABELS: Record<string, string> = {
  order: "訂單",
  session: "場次",
  waitlist: "候補",
  product: "課程／工作坊",
  media: "圖片素材",
  staff: "員工",
  staff_invite: "員工邀請",
};

export function entityLabel(entity: string): string {
  return ENTITY_LABELS[entity] ?? entity;
}

/** 角色代碼 → 中文。稽核存的是當下的角色字串，不保證還在 ROLES 裡。 */
const ACTOR_ROLE_LABELS: Record<string, string> = {
  owner: "負責人",
  editor: "內容編輯",
  support: "客服",
  customer: "一般會員",
};

export function actorRoleLabel(role: string | null): string {
  if (!role) return "（未記錄角色）";
  return ACTOR_ROLE_LABELS[role] ?? role;
}

/* -------------------------------------------------------------- 條件解析 */

/** action / entity 只可能是這種形狀，其餘一律視為輸入錯誤。 */
const TOKEN_PATTERN = /^[a-z0-9._-]{1,60}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type ParsedFilters = {
  filters: AuditFilters;
  fromIso: string;
  toIso: string;
  /** 被丟掉的條件，要顯示在畫面上而不是靜默忽略 */
  notes: string[];
  /**
   * 是否隱藏 AI（MCP）的預覽紀錄（action 以 mcp.preview. 開頭）。
   * 預覽不改任何資料，但 AI 每預覽一次就記一筆，會把真正的操作淹沒。
   * 「動作」條件裡有 preview 時才顯示它們。
   */
  hidePreviews: boolean;
};

export function parseAuditFilters(params: {
  entity?: string;
  action?: string;
  from?: string;
  to?: string;
}): ParsedFilters {
  const notes: string[] = [];
  const filters: AuditFilters = { ...EMPTY_FILTERS };

  const entity = (params.entity ?? "").trim().toLowerCase();
  if (entity) {
    if (TOKEN_PATTERN.test(entity)) filters.entity = entity;
    else notes.push("「對象」的條件格式不對，已忽略。");
  }

  const action = (params.action ?? "").trim().toLowerCase();
  if (action) {
    if (TOKEN_PATTERN.test(action)) filters.action = action;
    else
      notes.push(
        "「動作」只能填英數字、句點、底線與減號（例如 order 或 session.set_status），已忽略。",
      );
  }

  const from = (params.from ?? "").trim();
  if (from) {
    if (DATE_PATTERN.test(from)) filters.from = from;
    else notes.push("開始日期格式不對，已忽略。");
  }

  const to = (params.to ?? "").trim();
  if (to) {
    if (DATE_PATTERN.test(to)) filters.to = to;
    else notes.push("結束日期格式不對，已忽略。");
  }

  // 台北當天 00:00 起、23:59:59 止。taipeiLocalToIso() 認不得的日期（例如 2/30）
  // 會回空字串，等同「這個條件不成立」，不會靜默變成別的日期。
  let fromIso = filters.from ? taipeiLocalToIso(`${filters.from}T00:00`) : "";
  let toIso = filters.to ? taipeiLocalToIso(`${filters.to}T23:59:59`) : "";

  if (filters.from && !fromIso) {
    notes.push("開始日期不存在，已忽略。");
    filters.from = "";
  }
  if (filters.to && !toIso) {
    notes.push("結束日期不存在，已忽略。");
    filters.to = "";
  }

  if (fromIso && toIso && fromIso > toIso) {
    // 兩個都保留但交換，比丟掉其中一個更接近使用者的意思。
    notes.push("開始日期比結束日期晚，已自動對調。");
    [filters.from, filters.to] = [filters.to, filters.from];
    [fromIso, toIso] = [toIso, fromIso];
    // 對調後兩端的時分秒也要跟著換回「當日 00:00 / 23:59:59」
    fromIso = taipeiLocalToIso(`${filters.from}T00:00`);
    toIso = taipeiLocalToIso(`${filters.to}T23:59:59`);
  }

  const hidePreviews = !filters.action.includes("preview");

  return { filters, fromIso, toIso, notes, hidePreviews };
}

export function hasAnyFilter(filters: AuditFilters): boolean {
  return Boolean(filters.entity || filters.action || filters.from || filters.to);
}

/* ------------------------------------------------------------------ 查詢 */

type AuditDbRow = {
  id: number;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  summary: string;
  diff: unknown;
  created_at: string;
};

export type AuditResult = {
  rows: AuditRow[];
  /** 符合條件的總筆數（不受 limit 影響）。查不到時是 null。 */
  total: number | null;
  error: string | null;
};

export async function loadAuditLog(
  db: Db,
  parsed: ParsedFilters,
): Promise<AuditResult> {
  let query = db
    .from("audit_log")
    .select(
      "id, actor_email, actor_role, action, entity, entity_id, summary, diff, created_at",
      { count: "exact" },
    )
    // (created_at desc) 有索引，這是這張表最常見的查法
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(AUDIT_LIMIT);

  if (parsed.filters.entity) query = query.eq("entity", parsed.filters.entity);
  // 子字串比對：打 `session` 會同時看到 session.create / session.set_status。
  // 上面的 TOKEN_PATTERN 已經保證這裡不會有 % _ , . 以外的語法字元。
  if (parsed.filters.action) query = query.ilike("action", `%${parsed.filters.action}%`);
  // AI 預覽紀錄（mcp.preview.<工具名>）預設不列，見 ParsedFilters.hidePreviews。
  if (parsed.hidePreviews) query = query.not("action", "like", "mcp.preview.%");
  if (parsed.fromIso) query = query.gte("created_at", parsed.fromIso);
  if (parsed.toIso) query = query.lte("created_at", parsed.toIso);

  const { data, error, count } = await query;

  if (error) {
    console.error("[admin/audit] 查詢失敗", error.code, error.message);
    return {
      rows: [],
      total: null,
      error: "讀取稽核紀錄失敗，請重試一次。詳細錯誤已記在伺服器 log。",
    };
  }

  const rows = ((data ?? []) as AuditDbRow[]).map((row) => ({
    id: row.id,
    actorEmail: row.actor_email,
    actorRole: row.actor_role,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    summary: row.summary,
    diff:
      row.diff && typeof row.diff === "object" && !Array.isArray(row.diff)
        ? (row.diff as Record<string, unknown>)
        : null,
    createdAt: row.created_at,
  }));

  return { rows, total: count ?? null, error: null };
}
