/**
 * 圖片素材（Supabase Storage）的共用常數。
 *
 * 這支存在的唯一理由：**bucket 名稱的單一真相**。
 *
 * goodday 那邊 bucket 名 "product-images" 散落在三個地方 ——
 * route handler 的 `const BUCKET`、ImageUploader 的 `STORAGE_MARKER`、
 * 以及 server action `parseImagesField()` 用來比對的網址前綴。
 * 前兩處寫錯只是顯示怪怪的，第三處寫錯會**靜默丟棄既有圖片**
 * （比對不到前綴就當成「舊的外部圖床網址」整批濾掉），而且沒有任何錯誤訊息。
 * 所以這裡把 bucket 名、路徑規則、公開網址前綴全部收在一支。
 *
 * ⚠️ 除了這個檔案，其他任何檔案都不該再出現字串 "media" 當 bucket 名。
 *
 * 這支刻意「純資料、零 IO」（同 lib/admin/roles.ts 的理由）：
 * 不 import sharp、不 import supabase、不標 server-only，
 * 所以 components/admin/image-uploader.tsx 這個 client 元件也能直接 import。
 * 反過來說 —— **絕對不要**把 sharp 的處理函式搬進來，
 * 那會讓 sharp（原生模組）被打進 client bundle，build 直接爆。
 */

/** 對應 supabase/migrations/20260810000002_media_bucket.sql 建立的 public bucket */
export const MEDIA_BUCKET = "media";

/**
 * 稽核紀錄的 entity 值（audit_log.entity，見 lib/admin/audit.ts）。
 *
 * 值剛好也是 "media" 但**跟 bucket 名沒有關係**，兩者可以各自改。
 * 拉成常數是為了讓「除了這支之外沒有任何檔案出現字串 "media"」這條規則
 * 可以直接用 grep 機械檢查，不必每次人工判斷某個 hit 是不是 bucket 名：
 *
 *   grep -rn '"media"' apps --include='*.ts' --include='*.tsx'
 *   → 只應該出現在 lib/admin/media.ts
 */
export const MEDIA_AUDIT_ENTITY = "media";

/**
 * 上傳路徑的第一層目錄。白名單而不是自由字串：
 * kind 是使用者送上來的，直接串進路徑等於讓對方決定寫到哪裡
 * （`../`、以及未來若有其他 bucket 目錄的越權寫入）。
 */
export const MEDIA_KINDS = ["covers", "teachers", "hero"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MEDIA_KIND_LABELS: Record<MediaKind, string> = {
  covers: "課程封面",
  teachers: "老師照片",
  hero: "主視覺",
};

export function isMediaKind(value: unknown): value is MediaKind {
  return typeof value === "string" && (MEDIA_KINDS as readonly string[]).includes(value);
}

/* ---------------------------------------------------------------- 上傳限制 */

/**
 * 與 bucket 的 allowed_mime_types 同一組值（migration 20260810000002）。
 * 兩邊不一致的話，前端過得了、bucket 擋下來，使用者只會看到「上傳失敗」。
 */
export const MEDIA_ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;

/** <input type="file" accept> 用 */
export const MEDIA_ACCEPT = MEDIA_ALLOWED_MIME.join(",");

/** 與 bucket 的 file_size_limit 同一個值：8MB */
export const MEDIA_MAX_BYTES = 8 * 1024 * 1024;

/**
 * sharp 能解析出來的格式遠多於上面三種（TIFF、GIF、SVG、AVIF…）。
 * 只靠「sharp 解得開」當把關的話，`.svg` 改名成 `.jpg` 也會過。
 * 我們最後一律轉成 WebP 所以 SVG 的 XSS 風險其實不成立，
 * 但仍然明確擋掉：讓實際接受的格式跟 bucket policy 寫的一致，不要有隱形的第四種。
 */
export const MEDIA_ALLOWED_FORMATS = ["jpeg", "png", "webp"] as const;

/**
 * 解碼前的像素數上限（寬 × 高）。
 *
 * 檔案大小擋不住解壓縮炸彈：一張 8MB 的 PNG 可以解出 20000×20000，
 * 那是 4 億像素 × 4 bytes ≈ 1.6GB 記憶體，在 Vercel 上就是整個 function OOM。
 * 5000 萬像素（約 8600×5800）遠超過任何消費級相機，正常素材碰不到。
 */
export const MEDIA_MAX_PIXELS = 50_000_000;

/**
 * 輸出長邊上限。前台最大的用途是滿版主視覺，2000px 已足夠 retina，
 * 再大只是白佔流量與 next/image 的最佳化時間。
 */
export const MEDIA_MAX_EDGE = 2000;

/** WebP 品質。82 是照片類素材畫質／檔案大小的甜蜜點。 */
export const MEDIA_WEBP_QUALITY = 82;

/* ------------------------------------------------------------ 路徑與網址 */

/**
 * 物件路徑。一律 uuid 檔名、一律 .webp：
 * 不沿用原始檔名可以避開路徑穿越（../）、中文與空白檔名在 URL 的轉義問題，
 * 以及兩個員工同時傳 `IMG_0001.jpg` 互相覆蓋。原始檔名對前台沒有任何用處。
 */
export function mediaObjectPath(kind: MediaKind, id: string): string {
  return `${kind}/${id}.webp`;
}

/**
 * 公開網址前綴：`<supabase-url>/storage/v1/object/public/media/`
 *
 * public bucket 的這個端點不經 RLS，所以前台的 <Image> 直接指過來就好。
 * 環境變數沒設定時回空字串（而不是產生 `undefined/storage/...`）——
 * 讓 isMediaUrl() 一律回 false，比回一個永遠 404 的網址誠實。
 */
export function mediaPublicPrefix(): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return "";
  return `${base.replace(/\/+$/, "")}/storage/v1/object/public/${MEDIA_BUCKET}/`;
}

/**
 * 這個網址是不是我們自己 bucket 裡的圖。
 *
 * 用途是顯示層的分流，不是安全檢查：
 * next.config.ts 的 remotePatterns 只放行 *.supabase.co 的 public 路徑，
 * 把不在白名單內的網址丟給 next/image 會直接丟錯、連累整個後台頁面。
 * 所以 image-uploader 用這支決定「走 next/image 還是退回原生 <img>」。
 */
export function isMediaUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const prefix = mediaPublicPrefix();
  return prefix !== "" && url.startsWith(prefix);
}

/* ----------------------------------------------------------- magic bytes */

/**
 * 只看檔頭，認 JPEG／PNG／WebP 三種。其他一律 null。
 *
 * processImage() 的 sharp 才是真正的把關（它還要解得開、格式在白名單）；
 * 這一道是給「從網址抓／base64」這兩條沒有瀏覽器 MIME 可看的入口，
 * 在交給 libvips 解碼之前先擋掉 SVG／HTML／TIFF 這類東西 ——
 * libvips 讀得動 SVG，而 SVG 不該被任何一層當成「可能是圖片」去解析。
 */
export function sniffImageFormat(bytes: Uint8Array): "jpeg" | "png" | "webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}
