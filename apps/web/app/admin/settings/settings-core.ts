import type { Staff } from "@/lib/admin/guard";
import type { AuditInput } from "@/lib/admin/audit";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * 站台共用內容（講師介紹、健康聲明）的驗證與寫入核心。
 *
 * 後台 settings/actions.ts 與 MCP（lib/mcp/content-tools.ts）走同一支：
 * 輸入一律先轉成「跟表單同形狀的字串」再交給 normalize*()，兩邊的截斷、分段、
 * 連結格式規則才不會各長各的。
 *
 * 刻意零 next/*：revalidate 由呼叫端傳進來，單元測試可以換成假的。
 */

type Db = ReturnType<typeof createServiceClient>;

export type SettingsCtx = {
  db: Db;
  staff: Staff;
  audit: (staff: Staff, input: AuditInput) => Promise<void>;
  revalidate: () => void;
};

export type TeacherValue = {
  name: string;
  title: string;
  paragraphs: string[];
  credentials: string[];
  links: { label: string; href: string }[];
  photo_url: string | null;
};

export type HealthNoticeValue = { title: string; body: string };

/** 跟後台表單一樣的字串欄位 */
export type TeacherForm = {
  name: string;
  title: string;
  /** 段落用空行分段 */
  paragraphs: string;
  /** 一行一項 */
  credentials: string;
  /** 每行「標籤|網址」 */
  links: string;
  photo_url: string;
};

/** 一行一項的 textarea → 陣列 */
function lines(raw: string, max = 30, itemMax = 300): string[] {
  return String(raw ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, max)
    .map((l) => l.slice(0, itemMax));
}

/**
 * 連結清單。輸入格式是每行「標籤|網址」。
 *
 * 用 | 當分隔而不是空白：標籤裡本來就常常有空白
 *（「MOMOTV《今天大小事》居家保健分享」）。
 * 認不出格式的行**直接跳過而不是報錯** —— 這一欄是選填的補充資料，
 * 為了一行打錯就擋下整次儲存並不划算，但也不能把整行當標籤存進去。
 */
export function parseLinks(raw: string): { label: string; href: string }[] {
  return lines(raw, 20, 500)
    .map((line) => {
      const i = line.indexOf("|");
      if (i <= 0) return null;
      const label = line.slice(0, i).trim();
      const href = line.slice(i + 1).trim();
      if (!label || !/^https?:\/\//i.test(href)) return null;
      return { label: label.slice(0, 120), href: href.slice(0, 500) };
    })
    .filter((v): v is { label: string; href: string } => v !== null);
}

/** 姓名空白回 null（呼叫端回「請填講師姓名」）。 */
export function normalizeTeacher(f: TeacherForm): TeacherValue | null {
  const name = String(f.name ?? "").trim();
  if (!name) return null;
  return {
    name: name.slice(0, 120),
    title: String(f.title ?? "").trim().slice(0, 200),
    // 段落用空行分段：一般人打字就是這樣分段的
    paragraphs: String(f.paragraphs ?? "")
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((p) => p.slice(0, 2000)),
    credentials: lines(String(f.credentials ?? "")),
    links: parseLinks(String(f.links ?? "")),
    photo_url: String(f.photo_url ?? "").trim() || null,
  };
}

/** 現值 → 表單字串（MCP 只改有給的欄位時當底） */
export function teacherToForm(v: Partial<TeacherValue> | null | undefined): TeacherForm {
  return {
    name: v?.name ?? "",
    title: v?.title ?? "",
    paragraphs: (v?.paragraphs ?? []).join("\n\n"),
    credentials: (v?.credentials ?? []).join("\n"),
    links: (v?.links ?? []).map((l) => `${l.label}|${l.href}`).join("\n"),
    photo_url: v?.photo_url ?? "",
  };
}

export function normalizeHealthNotice(f: { title: string; body: string }): HealthNoticeValue {
  return {
    title: String(f.title ?? "").trim().slice(0, 120) || "健康聲明",
    body: String(f.body ?? "").trim().slice(0, 4000),
  };
}

export async function loadSiteSettings(db: Db): Promise<{
  teacher: Partial<TeacherValue> | null;
  health_notice: Partial<HealthNoticeValue> | null;
}> {
  const { data, error } = (await db
    .from("site_settings")
    .select("key, value")
    .in("key", ["teacher", "health_notice"])) as {
    data: { key: string; value: unknown }[] | null;
    error: { message: string } | null;
  };
  if (error) throw new Error(error.message);
  const byKey = new Map((data ?? []).map((r) => [r.key, r.value]));
  return {
    teacher: (byKey.get("teacher") as Partial<TeacherValue> | undefined) ?? null,
    health_notice: (byKey.get("health_notice") as Partial<HealthNoticeValue> | undefined) ?? null,
  };
}

export type SaveSettingResult = { ok: true; dryRun: boolean } | { ok: false; code: "failed" };

async function upsertSetting(ctx: SettingsCtx, key: string, value: unknown): Promise<boolean> {
  const { error } = (await ctx.db
    .from("site_settings")
    .upsert({ key, value }, { onConflict: "key" })) as { error: { message: string } | null };
  if (error) {
    console.error(`[admin/settings] 儲存 ${key} 失敗`, error.message);
    return false;
  }
  return true;
}

export async function saveTeacherCore(
  ctx: SettingsCtx,
  value: TeacherValue,
  opts: { dryRun?: boolean } = {},
): Promise<SaveSettingResult> {
  if (opts.dryRun) return { ok: true, dryRun: true };
  if (!(await upsertSetting(ctx, "teacher", value))) return { ok: false, code: "failed" };
  await ctx.audit(ctx.staff, {
    action: "settings.teacher",
    entity: "site_settings",
    entityId: "teacher",
    summary: `更新講師介紹（${value.name}）`,
    diff: { teacher: value },
  });
  ctx.revalidate();
  return { ok: true, dryRun: false };
}

export async function saveHealthNoticeCore(
  ctx: SettingsCtx,
  value: HealthNoticeValue,
  opts: { dryRun?: boolean } = {},
): Promise<SaveSettingResult> {
  if (opts.dryRun) return { ok: true, dryRun: true };
  if (!(await upsertSetting(ctx, "health_notice", value))) return { ok: false, code: "failed" };
  await ctx.audit(ctx.staff, {
    action: "settings.health_notice",
    entity: "site_settings",
    entityId: "health_notice",
    summary: "更新健康聲明",
    diff: { health_notice: value },
  });
  ctx.revalidate();
  return { ok: true, dryRun: false };
}

/* ------------------------------------------------------------ 常見問題 */

/** site_settings.faq 的原始值；沒有這一列回 null（前台用預設）。 */
export async function loadFaqSetting(db: Db): Promise<unknown | null> {
  const { data, error } = (await db
    .from("site_settings")
    .select("value")
    .eq("key", "faq")
    .maybeSingle()) as { data: { value: unknown } | null; error: { message: string } | null };
  if (error) throw new Error(error.message);
  return data?.value ?? null;
}

/** 寫入常見問題。value 必須已經過 lib/faq.ts 的 validateFaq()。 */
export async function saveFaqCore(
  ctx: SettingsCtx,
  value: { groups: { title: string; items: { q: string; a: string }[] }[] },
): Promise<SaveSettingResult> {
  if (!(await upsertSetting(ctx, "faq", value))) return { ok: false, code: "failed" };
  const questions = value.groups.reduce((n, g) => n + g.items.length, 0);
  await ctx.audit(ctx.staff, {
    action: "settings.faq",
    entity: "site_settings",
    entityId: "faq",
    summary: `更新常見問題（${value.groups.length} 組、${questions} 題）`,
    diff: { faq: value },
  });
  ctx.revalidate();
  return { ok: true, dryRun: false };
}
