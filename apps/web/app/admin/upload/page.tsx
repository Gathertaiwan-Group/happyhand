import type { Metadata } from "next";
import { requireCapability, adminErrorMessage } from "@/lib/admin/guard";
import { MEDIA_KIND_LABELS, isMediaKind } from "@/lib/admin/media";
import { SingleImageField } from "@/components/admin/image-uploader";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "上傳圖片" };

/**
 * /admin/upload?kind=covers&ref=<uuid> —— 手機傳照片給 AI 用的上傳頁。
 *
 * Claude 手機 App 沒辦法把相簿裡的照片原檔交給 MCP 工具，所以流程是：
 *   1. AI 呼叫 create_image_upload_link，拿到這一頁的網址給業主
 *   2. 業主在手機瀏覽器（已登入後台）點開、從相簿選照片上傳
 *   3. 業主回對話說「好了」，AI 呼叫 get_image_upload_result 依 ref 拿到圖片網址，再填進課程封面等欄位
 *
 * 授權與一般後台上傳相同（media:upload，真人登入 cookie）。檔名＝ref，同一個 ref 只能傳一次
 * （app/api/admin/uploads/route.ts）。這一頁本身不改任何課程資料。
 */

const REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function UploadLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; ref?: string }>;
}) {
  try {
    await requireCapability("media:upload");
  } catch (err) {
    return (
      <p className="rounded-card border border-line bg-panel px-4 py-6 text-[14px] text-ink-soft">
        {adminErrorMessage(err)}
      </p>
    );
  }

  const { kind, ref } = await searchParams;
  if (!isMediaKind(kind) || !ref || !REF_RE.test(ref)) {
    return (
      <p role="alert" className="rounded-card border border-line bg-panel px-4 py-6 text-[14px] text-ink-soft">
        這個上傳連結不完整或已經失效。請回到 AI 對話，請它重新產生一個上傳連結。
      </p>
    );
  }

  return (
    <div className="flex max-w-[640px] flex-col gap-6">
      <div>
        <h1 className="text-[20px] font-medium text-ink">上傳{MEDIA_KIND_LABELS[kind]}圖片</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">
          按下面的按鈕從手機相簿選一張照片。上傳完成後，回到 AI 對話跟它說「好了」，
          它就會把這張圖用在你指定的地方。這個連結只能上傳一次。
        </p>
      </div>

      <SingleImageField name="uploaded_url" label="選擇照片" kind={kind} uploadRef={ref.toLowerCase()} />
    </div>
  );
}
