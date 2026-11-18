import { createHash, randomUUID } from "node:crypto";
import type { Staff } from "@/lib/admin/guard";
import type { AuditInput } from "@/lib/admin/audit";
import type { createServiceClient } from "@/lib/supabase/server";
import { sniffImageFormat } from "@/lib/admin/media";
import {
  MATERIALS_BUCKET,
  MATERIAL_KIND_LABELS,
  MATERIAL_MAX_BYTES,
  MATERIAL_MAX_PER_LESSON,
  MATERIAL_MIME,
  extForMime,
  materialObjectPath,
  type MaterialKind,
} from "@/lib/admin/materials";

/**
 * 單元講義與插圖「新增」與「替換」的核心（後台 /api/admin/materials 與 MCP 共用同一支）。
 *
 * 刻意不 import next/*、不 import "server-only"：單元測試要能用假資料庫跑。
 * 授權（catalog:write）由呼叫端先做 —— route.ts 用 checkCapability、MCP 在 inScope 裡
 * requireCapability。這裡拿到的 staff 一律視為已授權。
 *
 * 🔴 這裡**沒有刪除**：
 *   · 新增失敗時收回「這一次剛上傳、還沒有任何資料列指向」的那個物件（避免孤兒），
 *     那不是使用者的資料。
 *   · 替換只把資料列改指向新上傳的物件；舊物件**留在 bucket 不刪**（私有 bucket，
 *     沒有資料列指向就沒有人拿得到簽章網址）。舊物件的路徑記在 lesson.material_replaced
 *     稽核的 previous_storage_path；後台「移除」只會刪目前那一份，不會清到這些舊版本。
 *
 * 防重送（MCP）：資料列 id 由 idempotency_key＋單元算出來（固定），物件路徑仍是亂數。
 *   重送撞到主鍵（23505）就讀回那一列當成「已經新增過」；收回的永遠是這一次自己剛上傳的
 *   亂數路徑，不可能刪到第一次成功的那一份。稽核寫入失敗也不影響（不靠稽核判斷）。
 */

type Db = ReturnType<typeof createServiceClient>;
type DbError = { code?: string; message: string } | null;

export type MaterialDeps = {
  db: Db;
  staff: Staff;
  audit: (staff: Staff, input: AuditInput) => Promise<void>;
};

export type MaterialOut = {
  id: string;
  kind: MaterialKind;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  caption: string | null;
  sort_order: number;
};

export type MaterialFailure = { ok: false; status: number; message: string };

/** 從檔頭判斷實際格式（不信副檔名、不信對方伺服器給的 Content-Type）。 */
export function sniffMaterialMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  ) {
    return "application/pdf";
  }
  const img = sniffImageFormat(bytes);
  if (img === "jpeg") return "image/jpeg";
  if (img === "png") return "image/png";
  if (img === "webp") return "image/webp";
  return null;
}

/** 依格式自動決定用途：PDF → 課程文件、圖片 → 課程圖片。 */
export function kindForMime(mime: string): MaterialKind | null {
  if (MATERIAL_MIME.file.includes(mime)) return "file";
  if (MATERIAL_MIME.image.includes(mime)) return "image";
  return null;
}

function fail(status: number, message: string): MaterialFailure {
  return { ok: false, status, message };
}

function checkFile(kind: MaterialKind, size: number, mime: string): MaterialFailure | null {
  if (size === 0) return fail(400, "這個檔案是空的，請換一個再試。");
  if (size > MATERIAL_MAX_BYTES) return fail(413, "檔案太大，單檔上限 20MB。");
  if (!MATERIAL_MIME[kind].includes(mime)) {
    return fail(
      400,
      kind === "file"
        ? "課程文件目前只收 PDF。Word 或 PowerPoint 請先另存成 PDF 再上傳。"
        : "圖片格式需為 JPEG、PNG 或 WebP。",
    );
  }
  return null;
}

/* ================================================================ 新增 */

export type AddMaterialInput = {
  lessonId: string;
  kind: MaterialKind;
  bytes: Buffer;
  mime: string;
  fileName: string;
  dryRun?: boolean;
  /** MCP 防重複送出：寫進 lesson.material_added 稽核的 diff，重送時查回當初那一份。 */
  idempotencyKey?: string;
  /** 稽核附加資訊（例如 MCP 的來源網址主機） */
  auditExtra?: Record<string, unknown>;
};

/** idempotency_key＋單元 → 固定的資料列 id（UUID 形狀，version 位元設成 5）。 */
export function materialIdForKey(lessonId: string, key: string): string {
  const h = createHash("sha256").update(`lesson_material:${lessonId}:${key}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const MATERIAL_COLUMNS = "id, kind, file_name, mime_type, size_bytes, caption, sort_order";

/**
 * 這個 key 之前新增過嗎（唯讀）。回當初那一份；之後在後台被移除了就回 removed=true。
 * MCP 在下載檔案之前先問：重送時不必再抓一次、來源失效也不會誤報失敗。
 */
export async function findMaterialReplay(
  db: Db,
  lessonId: string,
  key: string,
): Promise<{ material: MaterialOut; removed: boolean; diff: Record<string, unknown> | null } | null> {
  const id = materialIdForKey(lessonId, key);
  const { data: row } = (await db.from("lesson_materials").select(MATERIAL_COLUMNS).eq("id", id).maybeSingle()) as {
    data: unknown;
  };
  const { data: auditRow, error } = (await db
    .from("audit_log")
    .select("entity_id, diff")
    .eq("action", "lesson.material_added")
    .eq("entity_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()) as { data: unknown; error: DbError };
  if (error) throw new Error(error.message);
  const diff = ((auditRow as { diff?: Record<string, unknown> | null } | null)?.diff ?? null) || null;
  if (row) return { material: row as MaterialOut, removed: false, diff };
  if (auditRow) {
    return {
      material: { id, kind: "file", file_name: "（這份檔案之後已在後台移除）", mime_type: "", size_bytes: 0, caption: null, sort_order: 0 },
      removed: true,
      diff,
    };
  }
  return null;
}

export type AddMaterialResult =
  | MaterialFailure
  | {
      ok: true;
      dryRun: boolean;
      replayed?: boolean;
      lesson: { id: string; title: string; product_id: string | null };
      /** dryRun 時是「會建立的那一份」（id 為空字串） */
      material: MaterialOut;
    };

export async function addLessonMaterial(deps: MaterialDeps, input: AddMaterialInput): Promise<AddMaterialResult> {
  const { db } = deps;
  const bad = checkFile(input.kind, input.bytes.byteLength, input.mime);
  if (bad) return bad;

  // 這一堂真的存在嗎（也順便擋掉亂送 lesson_id）
  const { data: lessonRaw } = (await db
    .from("course_lessons")
    .select("id, title, product_id")
    .eq("id", input.lessonId)
    .maybeSingle()) as { data: unknown };
  const lesson = lessonRaw as { id: string; title: string; product_id: string | null } | null;
  if (!lesson) return fail(404, "找不到這個單元，請重新整理後再試一次。");

  if (input.idempotencyKey) {
    const prior = await findMaterialReplay(db, input.lessonId, input.idempotencyKey);
    if (prior) return { ok: true, dryRun: !!input.dryRun, replayed: true, lesson, material: prior.material };
  }

  const { data: existing } = (await db
    .from("lesson_materials")
    .select("sort_order")
    .eq("lesson_id", input.lessonId)
    .eq("kind", input.kind)
    .order("sort_order", { ascending: false })
    .limit(1)) as { data: unknown };

  const nextSort = (((existing as { sort_order?: number }[] | null)?.[0]?.sort_order as number | undefined) ?? 0) + 1;
  if (nextSort > MATERIAL_MAX_PER_LESSON) {
    return fail(400, `一堂課最多 ${MATERIAL_MAX_PER_LESSON} 份，請先移除用不到的。`);
  }

  // 原始檔名只拿來顯示。截長度避免有人用超長檔名撐爆後台版面。
  const fileName = (input.fileName || "未命名").slice(0, 200);
  const preview: MaterialOut = {
    id: "",
    kind: input.kind,
    file_name: fileName,
    mime_type: input.mime,
    size_bytes: input.bytes.byteLength,
    caption: null,
    sort_order: nextSort,
  };
  if (input.dryRun) return { ok: true, dryRun: true, lesson, material: preview };

  // MCP 帶 key 時 id 固定（重送撞主鍵）；物件路徑一律亂數（收回時只會收到這一次的）。
  const id = input.idempotencyKey ? materialIdForKey(input.lessonId, input.idempotencyKey) : randomUUID();
  const path = materialObjectPath(input.lessonId, randomUUID(), extForMime(input.mime));

  const { error: upErr } = (await db.storage
    .from(MATERIALS_BUCKET)
    .upload(path, input.bytes, { contentType: input.mime, upsert: false })) as { error: DbError };
  if (upErr) {
    console.error("[admin/materials] 存檔失敗", upErr.message);
    return fail(500, "檔案存不進去，請重試一次。");
  }

  const { data: row, error: insErr } = (await db
    .from("lesson_materials")
    .insert({
      id,
      lesson_id: input.lessonId,
      kind: input.kind,
      storage_path: path,
      file_name: fileName,
      mime_type: input.mime,
      size_bytes: input.bytes.byteLength,
      sort_order: nextSort,
    })
    .select(MATERIAL_COLUMNS)
    .single()) as { data: unknown; error: DbError };

  if (insErr || !row) {
    // 資料列建不起來就把「這一次剛上傳」的檔案收回去（亂數路徑，不會是別人的檔）。
    await db.storage.from(MATERIALS_BUCKET).remove([path]);
    if (insErr?.code === "23505" && input.idempotencyKey) {
      // 同一個 key 的另一個請求先成功了：回那一份，不算失敗。
      const prior = await findMaterialReplay(db, input.lessonId, input.idempotencyKey);
      if (prior) return { ok: true, dryRun: false, replayed: true, lesson, material: prior.material };
    }
    console.error("[admin/materials] 建立資料失敗", insErr?.message);
    return fail(500, "儲存失敗，請重試一次。");
  }
  const material = row as MaterialOut;

  await deps.audit(deps.staff, {
    action: "lesson.material_added",
    entity: "lesson_materials",
    entityId: material.id,
    summary: `為單元「${lesson.title}」新增${MATERIAL_KIND_LABELS[input.kind]}：${material.file_name}`,
    ...(input.idempotencyKey || input.auditExtra
      ? {
          diff: {
            ...(input.auditExtra ?? {}),
            ...(input.idempotencyKey
              ? { idempotency_key: input.idempotencyKey, lesson_id: input.lessonId, product_id: lesson.product_id }
              : {}),
          },
        }
      : {}),
  });

  return { ok: true, dryRun: false, lesson, material };
}

/* ================================================================ 替換 */

export type ReplaceMaterialInput = {
  materialId: string;
  bytes: Buffer;
  mime: string;
  fileName?: string;
  dryRun?: boolean;
  auditExtra?: Record<string, unknown>;
};

export type ReplaceMaterialResult =
  | MaterialFailure
  | {
      ok: true;
      dryRun: boolean;
      lesson: { id: string; title: string; product_id: string | null };
      before: MaterialOut;
      after: MaterialOut;
    };

/**
 * 換掉一份講義／插圖的檔案內容（同一個 id、同一個位置；學員端看到的就是新檔）。
 * 用途（文件／圖片）不能換：PDF 只能換成 PDF，圖片只能換成圖片。
 */
export async function replaceLessonMaterial(
  deps: MaterialDeps,
  input: ReplaceMaterialInput,
): Promise<ReplaceMaterialResult> {
  const { db } = deps;
  const { data: raw } = (await db
    .from("lesson_materials")
    .select("id, lesson_id, kind, file_name, mime_type, size_bytes, caption, sort_order, storage_path")
    .eq("id", input.materialId)
    .maybeSingle()) as { data: unknown };
  const cur = raw as (MaterialOut & { lesson_id: string; storage_path: string }) | null;
  if (!cur) return fail(404, "找不到這份檔案，可能已經在後台被移除了。");

  const bad = checkFile(cur.kind, input.bytes.byteLength, input.mime);
  if (bad) {
    if (bad.status === 400 && kindForMime(input.mime)) {
      return fail(
        400,
        cur.kind === "file"
          ? "原本是 PDF 課程文件，只能換成另一份 PDF。要加圖片請用新增。"
          : "原本是課程圖片，只能換成 JPEG、PNG 或 WebP 圖片。要加 PDF 請用新增。",
      );
    }
    return bad;
  }

  const { data: lessonRaw } = (await db
    .from("course_lessons")
    .select("id, title, product_id")
    .eq("id", cur.lesson_id)
    .maybeSingle()) as { data: unknown };
  const lesson = (lessonRaw as { id: string; title: string; product_id: string | null } | null) ?? {
    id: cur.lesson_id,
    title: "（未知單元）",
    product_id: null,
  };

  const fileName = (input.fileName || cur.file_name || "未命名").slice(0, 200);
  const before: MaterialOut = {
    id: cur.id,
    kind: cur.kind,
    file_name: cur.file_name,
    mime_type: cur.mime_type,
    size_bytes: cur.size_bytes,
    caption: cur.caption,
    sort_order: cur.sort_order,
  };
  const after: MaterialOut = { ...before, file_name: fileName, mime_type: input.mime, size_bytes: input.bytes.byteLength };
  if (input.dryRun) return { ok: true, dryRun: true, lesson, before, after };

  // 新物件用新的檔名：舊物件不覆蓋、不刪除（見檔頭說明）。
  const path = materialObjectPath(cur.lesson_id, randomUUID(), extForMime(input.mime));
  const { error: upErr } = (await db.storage
    .from(MATERIALS_BUCKET)
    .upload(path, input.bytes, { contentType: input.mime, upsert: false })) as { error: DbError };
  if (upErr) {
    console.error("[admin/materials] 替換存檔失敗", upErr.message);
    return fail(500, "檔案存不進去，請重試一次。");
  }

  const { data: updated, error: updErr } = (await db
    .from("lesson_materials")
    .update({ storage_path: path, file_name: fileName, mime_type: input.mime, size_bytes: input.bytes.byteLength })
    .eq("id", cur.id)
    .select("id")) as { data: unknown[] | null; error: DbError };
  if (!updErr && (updated ?? []).length === 0) {
    // 預檢之後、替換之前，這份附件剛好在後台被移除了。
    await db.storage.from(MATERIALS_BUCKET).remove([path]);
    return fail(404, "找不到這份檔案，可能剛在後台被移除了。沒有替換任何東西。");
  }
  if (updErr) {
    // 資料列沒改成功 → 收回這一次剛上傳的新檔；舊檔原封不動，學員端照舊。
    await db.storage.from(MATERIALS_BUCKET).remove([path]);
    console.error("[admin/materials] 替換資料失敗", updErr.message);
    return fail(500, "替換失敗，原本的檔案沒有變動。請重試一次。");
  }

  await deps.audit(deps.staff, {
    action: "lesson.material_replaced",
    entity: "lesson_materials",
    entityId: cur.id,
    summary: `替換單元「${lesson.title}」的${MATERIAL_KIND_LABELS[cur.kind]}：${cur.file_name} → ${fileName}`,
    diff: {
      ...(input.auditExtra ?? {}),
      file_name: { from: cur.file_name, to: fileName },
      size_bytes: { from: cur.size_bytes, to: input.bytes.byteLength },
      // 舊物件沒有刪除，留路徑方便需要時找回
      previous_storage_path: cur.storage_path,
    },
  });

  return { ok: true, dryRun: false, lesson, before, after };
}

/* ================================================================ 預檢（唯讀） */

/** 單元存在嗎。MCP 在下載檔案之前先問，id 打錯就不必先抓一個 20MB 的檔。 */
export async function lessonExists(db: Db, lessonId: string): Promise<boolean> {
  const { data } = (await db.from("course_lessons").select("id").eq("id", lessonId).maybeSingle()) as { data: unknown };
  return !!data;
}

/** 附件存在嗎（同上）。 */
export async function materialExists(db: Db, materialId: string): Promise<boolean> {
  const { data } = (await db.from("lesson_materials").select("id").eq("id", materialId).maybeSingle()) as {
    data: unknown;
  };
  return !!data;
}
