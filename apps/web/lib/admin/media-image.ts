import "server-only";
import sharp from "sharp";
import type { Staff } from "@/lib/admin/guard";
import type { AuditInput } from "@/lib/admin/audit";
import type { createServiceClient } from "@/lib/supabase/server";
import {
  MEDIA_ALLOWED_FORMATS,
  MEDIA_AUDIT_ENTITY,
  MEDIA_BUCKET,
  MEDIA_KIND_LABELS,
  MEDIA_MAX_EDGE,
  MEDIA_MAX_PIXELS,
  MEDIA_WEBP_QUALITY,
  mediaObjectPath,
  type MediaKind,
} from "@/lib/admin/media";

/**
 * 後台圖片的「驗證＋正規化」與「存進 media bucket」。
 *
 * 原本整段寫在 app/api/admin/uploads/route.ts。抽出來是為了讓 MCP 的
 * upload_image_from_url／upload_image_base64 走**同一支** —— 同一套格式白名單、
 * 解壓縮炸彈防護、EXIF 轉正、縮到長邊 2000、一律轉 WebP、uuid 檔名、同一個 bucket。
 *
 * 🔴 bucket 名稱不可改（products.cover_url 存的是完整 public URL，見 lib/admin/media.ts）。
 */

export type ProcessedImage = {
  buffer: Buffer;
  width: number;
  height: number;
  bytes: number;
};

/** 處理失敗的原因。分開回報才有辦法給出不同的中文訊息。 */
export type ProcessFailure = "undecodable" | "format" | "toolarge";

export type ProcessResult =
  | { ok: true; image: ProcessedImage }
  | { ok: false; reason: ProcessFailure; detail?: string };

/**
 * 驗證 + 正規化一張圖。**這支是整個把關的核心**，刻意跟 HTTP 層分開，
 * 讓它可以被單獨餵資料測試（見驗收腳本）。
 *
 * ⚠️ 為什麼不能只看副檔名或 file.type：
 *    兩者都是瀏覽器依副檔名猜的，把 `report.pdf` 改名成 `report.jpg`
 *    就會得到 file.type === "image/jpeg"，MIME 檢查完全形同虛設。
 *    真正的把關是「sharp 解析得出中繼資料，而且格式在白名單內」。
 *
 * 順序也是刻意的：
 *   1. metadata() 只讀檔頭，不解碼 → 解壓縮炸彈在這裡就被擋下來，
 *      不會先吃掉 1.6GB 記憶體才發現太大。
 *   2. rotate() 依 EXIF 轉正。手機直拍的照片 EXIF Orientation=6，
 *      不轉正的話上傳完在網頁上是躺著的，而且客戶會以為是我們弄壞的。
 *   3. resize(fit: "inside", withoutEnlargement: true) 只縮不放。
 *      沒有 withoutEnlargement 的話，一張 400px 的老照片會被放大成 2000px
 *      的糊圖，檔案還變大。
 *   4. 一律轉 WebP：省流量，而且輸出格式固定就不必再擔心輸入格式的怪東西
 *      （EXIF、ICC、動畫幀、SVG 內嵌 script）被原封不動傳到前台。
 */
export async function processImage(input: Buffer): Promise<ProcessResult> {
  let meta;
  try {
    meta = await sharp(input, { limitInputPixels: MEDIA_MAX_PIXELS }).metadata();
  } catch (err) {
    // 解不開就不是圖片。改過副檔名的 PDF / ZIP / 純文字都會落在這裡。
    console.error("[admin/uploads] sharp 無法解析輸入", err);
    return { ok: false, reason: "undecodable" };
  }

  if (!meta.width || !meta.height) return { ok: false, reason: "undecodable" };

  if (!(MEDIA_ALLOWED_FORMATS as readonly string[]).includes(meta.format ?? "")) {
    // sharp 解得開 TIFF / GIF / SVG / AVIF，但那些不在 bucket 的 allowed_mime_types 裡。
    return { ok: false, reason: "format", detail: meta.format };
  }

  if (meta.width * meta.height > MEDIA_MAX_PIXELS) {
    return { ok: false, reason: "toolarge" };
  }

  try {
    const { data, info } = await sharp(input, { limitInputPixels: MEDIA_MAX_PIXELS })
      .rotate()
      .resize({
        width: MEDIA_MAX_EDGE,
        height: MEDIA_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: MEDIA_WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });

    return {
      ok: true,
      image: { buffer: data, width: info.width, height: info.height, bytes: info.size },
    };
  } catch (err) {
    console.error("[admin/uploads] sharp 轉檔失敗", err);
    return { ok: false, reason: "undecodable" };
  }
}

/* ------------------------------------------------------------ 存進 bucket */

type Db = ReturnType<typeof createServiceClient>;

/**
 * 把 processImage() 的結果存進 media bucket 並記一筆 media.upload 稽核。
 *
 * auditExtra 會併進稽核的 diff（後台記原始檔名，MCP 記來源網址的主機）。
 * 失敗回 { ok: false }，細節走 console.error —— 呼叫端各自決定給使用者哪一句話。
 */
export async function storeProcessedMedia(
  db: Db,
  staff: Staff,
  audit: (staff: Staff, input: AuditInput) => Promise<void>,
  kind: MediaKind,
  image: ProcessedImage,
  id: string,
  auditExtra: Record<string, unknown> = {},
): Promise<{ ok: true; url: string; path: string } | { ok: false }> {
  const path = mediaObjectPath(kind, id);
  const { error } = await db.storage.from(MEDIA_BUCKET).upload(path, image.buffer, {
    contentType: "image/webp",
    // uuid 檔名不可能撞，upsert:false 讓「萬一撞到」變成錯誤而不是靜默覆蓋別人的圖。
    upsert: false,
  });
  if (error) {
    console.error("[admin/uploads] storage 上傳失敗", error);
    return { ok: false };
  }

  const { data: pub } = db.storage.from(MEDIA_BUCKET).getPublicUrl(path);

  // writeAudit() 永不 throw，所以稽核掛了不影響上傳結果。
  await audit(staff, {
    action: "media.upload",
    entity: MEDIA_AUDIT_ENTITY,
    entityId: path,
    summary: `上傳${MEDIA_KIND_LABELS[kind]}圖片 ${path}（${image.width}×${image.height}）`,
    diff: {
      kind,
      path,
      width: image.width,
      height: image.height,
      bytes: image.bytes,
      ...auditExtra,
    },
  });

  return { ok: true, url: pub.publicUrl, path };
}
