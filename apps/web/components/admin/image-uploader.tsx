"use client";

import Image from "next/image";
import { useId, useState, type ChangeEvent, type JSX } from "react";
import { AdminFieldLabel } from "@/components/admin/admin-field";
import { MEDIA_ACCEPT, isMediaUrl, type MediaKind } from "@/lib/admin/media";
import { uploadImage, type UploadProgress } from "@/lib/admin/upload-image";

/**
 * 單張圖片欄位。
 *
 * ⚠️ 刻意**不是** goodday 的 ImageUploader。
 *    那支是多圖 + 上下移排序 + 每張 alt + parseImagesField() 反序列化，
 *    因為 goodday 的 products.images 是 jsonb 陣列。
 *    快樂手的 products.cover_url 是單一 text 欄位（migration 20260808000001），
 *    每個實體只有一張圖 —— 把那整套搬過來等於為了一個 text 欄位維護
 *    一組 JSON 序列化協定，而且序列化格式寫錯是**靜默丟圖**。
 *    這裡只做一件事：一個 URL 進、一個 URL 出。
 *
 * 給表單作者：
 *   <form action={saveProduct}>
 *     <SingleImageField name="cover_url" label="課程封面" kind="covers"
 *                       defaultUrl={product.cover_url} />
 *   </form>
 *
 *   server action 端 `formData.get("cover_url")` 一定拿得到字串，
 *   **沒有圖的時候是空字串 ""，不是 null**（hidden input 永遠存在）。
 *   要寫回資料庫前記得自己轉：`const cover = String(fd.get("cover_url") ?? "") || null;`
 */

export type SingleImageFieldProps = {
  /** 送出時的欄位名，例如 "cover_url" */
  name: string;
  label: string;
  kind: MediaKind;
  /** 手機上傳連結頁（app/admin/upload）用：上傳時帶 ref，檔名＝ref。一般表單不要帶。 */
  uploadRef?: string;
  defaultUrl?: string | null;
  hint?: string;
  /**
   * 要歸屬到哪一張表單。
   * 這個欄位不一定放在 <form> 元素裡面 —— 課程編輯頁把欄位照前台順序攤在
   * 頁面各處，靠原生的 form 屬性歸隊。沒傳就是「用最近的祖先 form」。
   */
  form?: string;
  wrapperClassName?: string;
};

const DEFAULT_HINT =
  "支援 JPEG／PNG／WebP，單張上限 8MB。上傳後會自動轉為 WebP 並縮到長邊 2000px。";

function progressLabel(progress: UploadProgress): string {
  if (progress.stage === "processing") return "處理中…";
  return progress.percent === null ? "上傳中…" : `上傳中 ${progress.percent}%`;
}

export function SingleImageField({
  name,
  label,
  kind,
  uploadRef,
  defaultUrl,
  hint,
  form,
  wrapperClassName = "",
}: SingleImageFieldProps): JSX.Element {
  const [url, setUrl] = useState<string>(defaultUrl ?? "");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string>("");

  const fieldId = useId();
  const inputId = `${fieldId}-file`;
  const hintId = `${fieldId}-hint`;
  const statusId = `${fieldId}-status`;
  const busy = progress !== null;

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // 立刻清空 input：不清的話連續選同一個檔案不會觸發 change，
    // 使用者會以為「按了沒反應」。
    event.target.value = "";
    if (!file) return;

    setError("");
    setProgress({ stage: "uploading", percent: 0 });
    try {
      const uploaded = await uploadImage(file, kind, setProgress, uploadRef);
      setUrl(uploaded.url);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "上傳失敗，請稍後再試一次。");
    } finally {
      setProgress(null);
    }
  }

  function handleRemove() {
    // ⚠️ 只清空欄位值，**不去刪 storage 裡的檔案**。這是刻意的：
    //    (1) 使用者可能按了移除卻沒按儲存，檔案刪了但資料庫還指著它 → 前台破圖。
    //    (2) 同一張圖可能被別的實體共用（複製課程時直接沿用封面）。
    //    誤刪線上圖的代價（前台立刻破圖、原檔可能已經找不到）遠高於
    //    bucket 裡留幾個沒人指到的孤兒檔（都是縮過的 WebP，量級很小）。
    //    真的要清理應該是另一支「找出沒被引用的檔案」的排程，不是這個按鈕。
    setUrl("");
    setError("");
  }

  return (
    <div className={wrapperClassName}>
      <AdminFieldLabel htmlFor={inputId}>{label}</AdminFieldLabel>

      {/*
        非受控表單的橋接點。
        上傳結果只活在這個元件的 useState 裡，用 hidden input 寫回 DOM，
        送出時 <form action={serverAction}> 會自然把它序列化進 FormData ——
        父表單不需要改成受控，也不用把 state 提上去。
      */}
      <input type="hidden" name={name} value={url} form={form} readOnly />

      <div className="flex flex-col gap-3 admin:flex-row admin:items-start">
        {/* 預覽框固定 16:9：前台的課程頁與工作坊頁都是 aspect-[16/9]
            （courses/[slug]/page.tsx:99、workshops/[slug]/page.tsx:126），
            用同樣的比例預覽，員工才看得出「上面那行字會不會被切掉」。
            ⚠️ 前台改比例的話這裡要跟著改，不然後台預覽會騙人。 */}
        <div
          className={`relative aspect-[16/9] w-full shrink-0 overflow-hidden rounded-input border admin:w-[420px] ${
            url ? "border-line-strong bg-panel" : "border-line-input border-dashed bg-panel"
          }`}
        >
          {url ? (
            isMediaUrl(url) ? (
              /* sizes 要跟上面的框寬一致，不然 Next 會挑錯尺寸的圖塞進框裡 ——
                 這一格的用途正是「看得出字會不會被切」，糊掉就沒意義了。 */
              <Image
                src={url}
                alt=""
                fill
                sizes="(min-width: 1024px) 420px, 100vw"
                className="object-cover"
              />
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element -- 非本站 bucket 的網址
                 不在 next.config.ts 的 remotePatterns 內，交給 <Image> 會直接丟錯、
                 連累整個後台頁面。這條路徑只可能出現在手動改過資料庫的資料上。 */
              <img src={url} alt="" className="h-full w-full object-cover" />
            )
          ) : (
            <span className="absolute inset-0 flex items-center justify-center text-[13px] text-ink-soft">
              尚未設定圖片
            </span>
          )}

          {busy && (
            // 上傳中蓋一層，讓「正在換圖」這件事在預覽框上看得見，
            // 而不是只有下面的按鈕文字在變。
            <span className="absolute inset-0 flex items-center justify-center bg-paper/80 text-[13px] font-medium text-accent-ink">
              {progressLabel(progress)}
            </span>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {/*
              檔案 input 本體用 sr-only 而不是 hidden：
              hidden 的 input 拿不到焦點，鍵盤使用者就只剩「用 ref 模擬 click」那條路
              （goodday 就是這樣做的）。sr-only 讓它保有原生的鍵盤與讀屏行為，
              外觀交給下面那顆當成按鈕的 <label>，焦點框用 peer-focus-visible 補回來。
            */}
            <input
              id={inputId}
              type="file"
              accept={MEDIA_ACCEPT}
              className="peer sr-only"
              disabled={busy}
              onChange={handleFile}
              aria-describedby={`${statusId} ${hintId}`}
            />
            <label
              htmlFor={inputId}
              className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-input border border-line-input bg-paper px-4 text-[14px] font-medium text-ink transition-colors hover:bg-panel peer-focus-visible:outline-[3px] peer-focus-visible:outline-caramel peer-focus-visible:outline-offset-2 peer-disabled:cursor-not-allowed peer-disabled:opacity-55 admin:min-h-10"
            >
              {busy ? progressLabel(progress) : url ? "換一張圖片" : "選擇圖片上傳"}
            </label>

            {url && (
              <button
                type="button" // ⚠️ 少了這行會變成 submit，按「移除」直接送出整張表單
                onClick={handleRemove}
                disabled={busy}
                className="inline-flex min-h-11 items-center justify-center rounded-input border border-danger bg-paper px-4 text-[14px] font-medium text-danger transition-colors hover:bg-danger hover:text-paper disabled:cursor-not-allowed disabled:opacity-55 admin:min-h-10"
              >
                移除
              </button>
            )}
          </div>

          {/* 狀態用 role="status"：上傳完成不該打斷讀屏使用者正在讀的內容 */}
          <p id={statusId} role="status" className="text-[13px] leading-snug text-ink-soft">
            {busy ? progressLabel(progress) : url ? "已設定圖片。" : "尚未設定圖片。"}
          </p>

          <p id={hintId} className="text-[13px] leading-snug text-ink-soft">
            {hint ?? DEFAULT_HINT}
          </p>

          {error && (
            // 失敗一定要看得見。後台使用者不會開 DevTools，
            // console.error 對他們等於沒有訊息，只會再按一次。
            <p role="alert" className="text-[13px] leading-snug text-danger">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
