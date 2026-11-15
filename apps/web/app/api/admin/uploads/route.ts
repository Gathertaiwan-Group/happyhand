import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { checkCapability } from "@/lib/admin/guard";
import { writeAudit } from "@/lib/admin/audit";
import { createServiceClient } from "@/lib/supabase/server";
import {
  MEDIA_ALLOWED_MIME,
  MEDIA_MAX_BYTES,
  isMediaKind,
  type MediaKind,
} from "@/lib/admin/media";
import { processImage, storeProcessedMedia, type ProcessFailure } from "@/lib/admin/media-image";

/**
 * 後台圖片上傳。
 *
 * media bucket 的 storage.objects **刻意沒有任何寫入 policy**
 * （見 supabase/migrations/20260810000002_media_bucket.sql），
 * 也就是說 anon / authenticated 都寫不進去，寫入只能靠 service role。
 * 所以這支 route handler 是整條上傳鏈唯一的授權關卡 —— 這裡漏掉就等於全開。
 *
 * 這是 fetch 端點不是頁面：權限不足回 **403 JSON，不 redirect**
 * （同 api/admin/sessions/[id]/roster.csv/route.ts 的理由：
 *  前端 fetch 拿到一坨登入頁 HTML 只會 JSON.parse 失敗，看不出真正的原因）。
 * 未登入的情況更早就被 middleware.ts 攔成 401 JSON。
 */

// sharp 是原生模組，只跑得動 node runtime。少了這行會被排進 edge runtime 直接爆。
export const runtime = "nodejs";
// 8MB 的圖解碼 + 縮放 + 轉檔，在冷啟動的 Vercel function 上可能要十幾秒。
export const maxDuration = 30;

/* ------------------------------------------------------------------ 錯誤 */

/**
 * 錯誤一律回中文，而且是「使用者能據此行動」的中文。
 *
 * ⚠️ 絕對不要把 sharp / supabase 的原始錯誤訊息塞進 error 欄位：
 *    一來後台使用者是好日子的員工，看到 "Input buffer contains unsupported
 *    image format" 只會截圖來問；二來那些訊息偶爾會帶出路徑之類的內部資訊。
 *    要除錯的細節走 console.error 進 Vercel log。
 */
function fail(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/* ---------------------------------------------------------------- 影像處理 */

// 驗證＋正規化（processImage）與存進 bucket（storeProcessedMedia）抽到
// lib/admin/media-image.ts，MCP 的 upload_image_* 走同一支。這裡的 HTTP 行為不變。
export type { ProcessedImage, ProcessFailure, ProcessResult } from "@/lib/admin/media-image";

function messageFor(reason: ProcessFailure): string {
  switch (reason) {
    case "format":
      return "這個檔案不是 JPEG／PNG／WebP 圖片，請換一張再試。";
    case "toolarge":
      return "圖片的尺寸太大（超過 5000 萬像素），請先縮小再上傳。";
    default:
      return "圖片內容無法解析，請確認檔案沒有損毀，或換一張再試。";
  }
}

/* ------------------------------------------------------------------ POST */

export async function POST(request: Request) {
  const staff = await checkCapability("media:upload");
  if (!staff) {
    return fail("你的帳號沒有上傳圖片的權限。", 403);
  }

  let form: FormData;
  try {
    // 原生 multipart。用 base64 包 JSON 的話傳輸量會膨脹 33%，
    // 8MB 的照片變成 10.7MB，Vercel 4.5MB 的 body 上限更容易撞到。
    form = await request.formData();
  } catch (err) {
    console.error("[admin/uploads] 無法解析 multipart", err);
    return fail("上傳內容無法解析，請重新選擇檔案再試一次。", 400);
  }

  const rawKind = form.get("kind");
  if (!isMediaKind(rawKind)) {
    // kind 會直接變成 storage 路徑的第一層目錄，一定要走白名單。
    return fail("圖片用途不正確，請重新整理後再試一次。", 400);
  }
  const kind: MediaKind = rawKind;

  const file = form.get("file");
  if (!(file instanceof File)) return fail("沒有收到檔案，請重新選擇。", 400);
  if (file.size === 0) return fail("這個檔案是空的，請換一張再試。", 400);
  if (file.size > MEDIA_MAX_BYTES) {
    return fail("圖片檔案太大，單張上限 8MB，請換一張或先縮小再上傳。", 413);
  }
  if (!(MEDIA_ALLOWED_MIME as readonly string[]).includes(file.type)) {
    // 這層只是省下讀整個檔的成本；真正的把關在 processImage()。
    return fail("圖片格式需為 JPEG、PNG 或 WebP。", 400);
  }

  const result = await processImage(Buffer.from(await file.arrayBuffer()));
  if (!result.ok) {
    console.error("[admin/uploads] 圖片被拒絕", {
      reason: result.reason,
      detail: result.detail,
      declaredType: file.type,
      bytes: file.size,
    });
    return fail(messageFor(result.reason), 400);
  }
  const image = result.image;

  if (image.bytes > MEDIA_MAX_BYTES) {
    // bucket 的 file_size_limit 也是 8MB，先擋下來才給得出清楚的訊息，
    // 否則使用者只會看到一句沒頭沒尾的「上傳失敗」。
    return fail("圖片壓縮後仍然超過 8MB，請換一張再試。", 413);
  }

  let db;
  try {
    db = createServiceClient();
  } catch (err) {
    console.error("[admin/uploads] service client 建立失敗", err);
    return fail("伺服器設定不完整，請聯絡工程師。", 500);
  }

  const stored = await storeProcessedMedia(db, staff, writeAudit, kind, image, randomUUID(), {
    // 原始檔名只是給人回想「我傳的是哪張」，截短避免有人用超長檔名塞爆稽核表。
    originalName: file.name.slice(0, 120),
    originalBytes: file.size,
  });
  if (!stored.ok) {
    return fail("圖片上傳失敗，請稍後再試一次。", 502);
  }

  return NextResponse.json({
    url: stored.url,
    width: image.width,
    height: image.height,
    bytes: image.bytes,
  });
}
