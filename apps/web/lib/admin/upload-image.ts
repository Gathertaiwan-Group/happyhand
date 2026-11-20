import {
  MEDIA_ALLOWED_MIME,
  MEDIA_MAX_BYTES,
  type MediaKind,
} from "@/lib/admin/media";

/**
 * 後台圖片上傳的 client helper（只給 components/admin/image-uploader.tsx 用）。
 *
 * ⚠️ 這支只跑在瀏覽器（用到 document / Image / canvas / fetch 相對路徑）。
 *    刻意不標 "use client"：它沒有 export 元件，
 *    標了反而會讓不小心從 server component import 的人拿到一個
 *    看不懂的 client reference 錯誤，而不是「document is not defined」。
 *
 * 真正的把關全部在 server（app/api/admin/uploads/route.ts）。
 * 這裡的檢查只是為了早點給出中文訊息，省掉一趟往返，不是安全措施。
 */

export type UploadedImage = {
  url: string;
  width: number;
  height: number;
  bytes: number;
};

/**
 * 上傳進度。分兩段是因為那真的是兩段：
 * 位元組送完之後，server 還要跑 sharp 解碼／縮放／轉 WebP，
 * 8MB 的照片在冷啟動的 function 上可能再等好幾秒。
 * 只做一條 0–100% 的進度條會在 100% 卡住不動，看起來像當掉。
 *
 * percent 為 null 代表瀏覽器算不出總長度（Content-Length 未知），顯示成不定量。
 */
export type UploadProgress =
  | { stage: "uploading"; percent: number | null }
  | { stage: "processing" };

/**
 * Vercel serverless function 的 request body 上限是 4.5MB，而且是在進到
 * route handler **之前**就被平台擋掉 —— 前端只會拿到一個 413 加一頁 HTML，
 * 我們自己寫的中文錯誤訊息根本沒機會執行。
 * 所以超過 4MB 的檔先在瀏覽器縮一次；4MB 以下維持原檔上傳，
 * 不多做一次 canvas 轉檔（canvas 的重取樣品質比 server 端的 sharp 差）。
 */
const PRESHRINK_THRESHOLD = 4 * 1024 * 1024;

/** 預縮後必須低於這個大小，否則再降一級品質重壓 */
const PRESHRINK_TARGET = 4 * 1024 * 1024;

/**
 * 預縮的長邊。刻意比 server 的 2000px 大一點：
 * 留一點餘裕讓 sharp 用它自己的 Lanczos 做最後一次縮放，
 * 直接在 canvas 縮到 2000 再送過去等於用比較差的演算法定案。
 */
const PRESHRINK_MAX_EDGE = 2560;

/**
 * 依序嘗試的編碼。WebP 排第一（有 alpha、同畫質下最小），
 * JPEG 是所有瀏覽器都一定支援的保底。
 *
 * ⚠️ canvas.toBlob() 遇到不支援的 type **不會報錯，會靜默改吐 PNG**。
 *    一張 2560px 照片的 PNG 可能比原始 JPEG 還大，直接把 4.5MB 上限撞穿。
 *    所以下面一定要檢查 blob.type，不能假設拿到的就是我們要的格式。
 */
const ENCODINGS = [
  { type: "image/webp", quality: 0.9 },
  { type: "image/jpeg", quality: 0.85 },
  { type: "image/jpeg", quality: 0.7 },
] as const;

function isAllowedMime(type: string): boolean {
  return (MEDIA_ALLOWED_MIME as readonly string[]).includes(type);
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * 在瀏覽器把過大的圖縮小。
 *
 * ⚠️ EXIF 方向：瀏覽器把 <img> 畫進 canvas 時已經套用過 EXIF Orientation
 *    （image-orientation: from-image 是現代瀏覽器的預設），
 *    而 canvas 輸出**不帶 EXIF**。所以預縮過的圖到了 server 端，
 *    sharp 的 .rotate() 會是 no-op —— 不會轉兩次。
 *    沒預縮的圖（4MB 以下）EXIF 完整保留，由 server 端負責轉正。
 */
async function preshrink(file: File): Promise<Blob> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("圖片載入失敗，請確認檔案沒有損毀。"));
      el.src = objectUrl;
    });

    const scale = Math.min(1, PRESHRINK_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("這個瀏覽器不支援圖片處理，請改用 Chrome 或 Safari。");
    ctx.drawImage(img, 0, 0, width, height);

    let smallest: Blob | null = null;
    for (const { type, quality } of ENCODINGS) {
      const blob = await toBlob(canvas, type, quality);
      // type 不對代表瀏覽器不支援這個編碼、偷偷改吐 PNG，這個結果不能用。
      if (!blob || !isAllowedMime(blob.type)) continue;
      if (blob.size <= PRESHRINK_TARGET) return blob;
      if (!smallest || blob.size < smallest.size) smallest = blob;
    }

    if (smallest) return smallest;
    throw new Error("圖片轉換失敗，請換一張圖或先用其他工具縮小再上傳。");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** 拿不到 JSON 時（平台層擋下來的錯誤只會回 HTML）依 status 給一句中文 */
function fallbackMessage(status: number): string {
  if (status === 413) return "圖片檔案太大，請換一張或先縮小再上傳。";
  if (status === 401) return "登入狀態已失效，請重新登入後再試。";
  if (status === 403) return "你的帳號沒有上傳圖片的權限。";
  if (status >= 500) return "伺服器忙碌中，請稍後再試一次。";
  return "上傳失敗，請稍後再試一次。";
}

type ServerReply = { url?: unknown; width?: unknown; height?: unknown; error?: unknown };

/**
 * 送出 multipart 並回報上傳進度。
 *
 * ⚠️ 這裡用 XMLHttpRequest 而不是 fetch，是為了 xhr.upload.onprogress。
 *    fetch 至今仍然沒有可用的「上傳」進度事件
 *    （ReadableStream body 要 duplex:"half"，而且只在 HTTP/2 的 Chrome 上動）。
 *    這是本專案唯一一處用 XHR 的地方，理由就這一個。
 */
function postForm(body: FormData, onProgress?: (p: UploadProgress) => void) {
  return new Promise<{ status: number; data: ServerReply | null }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/admin/uploads");
    // 讓瀏覽器直接幫我們 parse；不是 JSON（例如平台層擋下來回 HTML）時 response 會是 null，
    // 正好落進 fallbackMessage() 那條路。
    xhr.responseType = "json";

    xhr.upload.onprogress = (event) => {
      onProgress?.({
        stage: "uploading",
        percent: event.lengthComputable
          ? Math.min(99, Math.round((event.loaded / event.total) * 100))
          : null,
      });
    };
    // 位元組送完了，接下來是 server 在轉檔。
    xhr.upload.onload = () => onProgress?.({ stage: "processing" });

    xhr.onload = () => resolve({ status: xhr.status, data: (xhr.response ?? null) as ServerReply | null });
    xhr.onerror = () => reject(new Error("網路連線中斷，請確認網路後再試一次。"));
    xhr.ontimeout = () => reject(new Error("上傳逾時，請確認網路後再試一次。"));
    xhr.onabort = () => reject(new Error("上傳已取消。"));

    xhr.send(body);
  });
}

export async function uploadImage(
  file: File,
  kind: MediaKind,
  onProgress?: (progress: UploadProgress) => void,
  /** 手機上傳連結（/admin/upload?ref=…）的 ref；一般後台表單不帶。 */
  uploadRef?: string,
): Promise<UploadedImage> {
  if (!isAllowedMime(file.type)) throw new Error("圖片格式需為 JPEG、PNG 或 WebP。");
  if (file.size === 0) throw new Error("這個檔案是空的，請換一張再試。");
  if (file.size > MEDIA_MAX_BYTES) {
    throw new Error("圖片檔案太大，單張上限 8MB，請換一張或先縮小再上傳。");
  }

  const payload: Blob = file.size > PRESHRINK_THRESHOLD ? await preshrink(file) : file;

  const body = new FormData();
  body.append("kind", kind);
  if (uploadRef) body.append("ref", uploadRef);
  // 第三個參數（檔名）讓 server 端的 formData().get("file") 拿到 File 而不是 Blob。
  // 檔名本身不會被採用 —— server 一律改用 uuid，這裡只是為了讓稽核紀錄看得出原檔。
  body.append("file", payload, file.name || "upload");

  onProgress?.({ stage: "uploading", percent: 0 });
  const { status, data } = await postForm(body, onProgress);

  if (status < 200 || status >= 300) {
    throw new Error(
      typeof data?.error === "string" && data.error ? data.error : fallbackMessage(status),
    );
  }
  if (typeof data?.url !== "string" || !data.url) {
    throw new Error("上傳完成但沒有拿到圖片網址，請重新整理後確認。");
  }

  return {
    url: data.url,
    width: Number(data.width) || 0,
    height: Number(data.height) || 0,
    bytes: Number((data as { bytes?: unknown }).bytes) || 0,
  };
}
