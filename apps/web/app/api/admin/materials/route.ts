import { NextResponse } from "next/server";
import { checkCapability } from "@/lib/admin/guard";
import { writeAudit } from "@/lib/admin/audit";
import { createServiceClient } from "@/lib/supabase/server";
import { addLessonMaterial } from "@/lib/admin/lesson-material-store";
import {
  MATERIALS_BUCKET,
  MATERIAL_KIND_LABELS,
  MATERIAL_MAX_BYTES,
  isMaterialKind,
  type MaterialKind,
} from "@/lib/admin/materials";

/**
 * 單元講義與插圖的上傳／刪除。
 *
 * 🔴 course-materials 是**私有** bucket，而且 storage.objects 沒有任何 policy
 *    （見 migration 20260828000001）—— 也就是 anon / authenticated 既寫不進去
 *    也讀不到。這支 route handler 是整條上傳鏈唯一的授權關卡，這裡漏掉就等於全開。
 *
 * 這是 fetch 端點不是頁面：權限不足回 403 JSON 不 redirect
 * （同 /api/admin/uploads 的理由：前端 fetch 拿到一坨登入頁 HTML 只會
 *  JSON.parse 失敗，看不出真正的原因）。
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string, status: number) {
  return NextResponse.json({ message }, { status });
}

/* ------------------------------------------------------------------ 上傳 */

export async function POST(request: Request) {
  // 講義是課程內容，跟改課程同一個能力。support 拿不到 catalog:write。
  const staff = await checkCapability("catalog:write");
  if (!staff) return fail("你的帳號沒有編輯課程內容的權限。", 403);

  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    console.error("[admin/materials] 無法解析 multipart", err);
    return fail("上傳內容無法解析，請重新選擇檔案再試一次。", 400);
  }

  const lessonId = String(form.get("lesson_id") ?? "").trim();
  if (!UUID_RE.test(lessonId)) {
    return fail("請先儲存這個單元，再上傳檔案。", 400);
  }

  const rawKind = form.get("kind");
  if (!isMaterialKind(rawKind)) {
    // kind 決定允許的格式，一定要走白名單
    return fail("檔案用途不正確，請重新整理後再試一次。", 400);
  }
  const kind: MaterialKind = rawKind;

  const file = form.get("file");
  if (!(file instanceof File)) return fail("沒有收到檔案，請重新選擇。", 400);
  // 大小在讀進記憶體之前先擋一次（核心函式會再擋一次，訊息相同）
  if (file.size > MATERIAL_MAX_BYTES) {
    return fail("檔案太大，單檔上限 20MB。", 413);
  }

  const db = createServiceClient();
  if (!db) return fail("儲存服務暫時無法使用，請稍後再試。", 503);

  // 驗證、存檔、建資料列、稽核都在 lib/admin/lesson-material-store.ts（MCP 也走同一支）
  const r = await addLessonMaterial(
    { db, staff, audit: writeAudit },
    {
      lessonId,
      kind,
      bytes: Buffer.from(await file.arrayBuffer()),
      mime: file.type,
      fileName: file.name,
    },
  );
  if (!r.ok) return fail(r.message, r.status);

  return NextResponse.json({ material: r.material }, { headers: { "Cache-Control": "no-store" } });
}

/* ------------------------------------------------------------------ 刪除 */

export async function DELETE(request: Request) {
  const staff = await checkCapability("catalog:write");
  if (!staff) return fail("你的帳號沒有編輯課程內容的權限。", 403);

  let body: { id?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail("請求格式不正確。", 400);
  }
  const id = String(body.id ?? "").trim();
  if (!UUID_RE.test(id)) return fail("找不到這個檔案。", 400);

  const db = createServiceClient();
  if (!db) return fail("儲存服務暫時無法使用，請稍後再試。", 503);

  const { data: row } = await db
    .from("lesson_materials")
    .select("id, kind, file_name, storage_path")
    .eq("id", id)
    .maybeSingle();
  if (!row) return fail("這個檔案已經不在了。", 404);

  // 先刪資料列再刪檔案：反過來的話，檔案刪掉但資料列還在，
  // 學員端會看到一個點了會壞掉的下載按鈕。
  const { error: delErr } = await db.from("lesson_materials").delete().eq("id", id);
  if (delErr) {
    console.error("[admin/materials] 刪除資料失敗", delErr.message);
    return fail("移除失敗，請重試一次。", 500);
  }
  const { error: rmErr } = await db.storage
    .from(MATERIALS_BUCKET)
    .remove([row.storage_path as string]);
  if (rmErr) {
    // 資料列已經沒了，學員端看不到它；bucket 裡留一個孤兒檔不影響任何人。
    console.error("[admin/materials] 檔案刪除失敗（已成孤兒）", rmErr.message);
  }

  await writeAudit(staff, {
    action: "lesson.material_removed",
    entity: "lesson_materials",
    entityId: id,
    summary: `移除${MATERIAL_KIND_LABELS[row.kind as MaterialKind]}：${row.file_name}`,
  });

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
