import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonClass } from "@/components/ui/button";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getMember } from "@/lib/account/guard";
import { maskEmail } from "@/lib/email/resend";
import { BackLink, LineButton } from "../../_components/shell";
import { Classroom, type ClassroomLesson } from "./_components/classroom";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "上課教室",
  robots: { index: false, follow: false },
};

/**
 * 上課教室。
 *
 * 授權完全交給 RLS：entitlements_select_own 這條 policy 本身就是檢查，
 * 查得到那一列就代表這是他自己的權限，不需要在這裡比對 user_id。
 *
 * ⚠️ 這一頁**刻意不撈 youtube_id**。
 *    撈了的話 12 堂課的影片 ID 會一次全部進 RSC payload（等於寫在 HTML 裡），
 *    未購買者只要看一眼原始碼就全拿走了。ID 由播放器在使用者真的要看那一堂時，
 *    去打 POST /api/lessons/[id]/video 才拿 —— 那一支就是 entitlement 的執行點。
 *    course_lessons 的欄位級 grant（20260810000006）讓這件事變成
 *    「就算寫錯也拿不到」而不是「靠自律」。
 *
 * 沒有權限時顯示購買 CTA 而不是 404：客人可能是從舊書籤或別人分享的連結進來的，
 * 直接 404 只會讓他覺得網站壞了。
 */
export default async function LearnPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ lesson?: string }>;
}) {
  const { slug } = await params;
  const { lesson: requestedLessonId } = await searchParams;

  const member = await getMember();
  if (!member) notFound(); // layout 已經導去 /login 了，這裡是保險

  const supabase = await createClient();

  // 1) 課程。products_select_owned（20260810000007）讓「買過但後來下架」
  //    的課照樣讀得到 —— 沒有那條 policy 的話，公司一下架課程，
  //    客人的教室就會 404 而且不會有任何錯誤訊息。
  const { data: product, error: productError } = await supabase
    .from("products")
    .select("id, slug, title, type")
    .eq("slug", slug)
    .maybeSingle();

  if (productError) {
    console.error("[learn] 讀取課程失敗", slug, productError.message);
  }
  if (!product) notFound();

  // 2) 權限
  const { data: entitlement } = await supabase
    .from("entitlements")
    .select("expires_at")
    .eq("product_id", product.id)
    .maybeSingle();

  const expiresAt = (entitlement?.expires_at as string | null) ?? null;
  const expired = expiresAt !== null && new Date(expiresAt).getTime() < Date.now();

  if (!entitlement || expired) {
    return <NoAccess title={product.title as string} slug={slug} expired={expired} />;
  }

  // 3) 單元。⚠️ 不含 youtube_id（見檔頭）。
  const { data: lessonRows, error: lessonError } = await supabase
    .from("course_lessons")
    .select("id, title, duration_sec, free_preview, sort_order")
    .eq("product_id", product.id)
    .order("sort_order", { ascending: true });

  if (lessonError) {
    console.error("[learn] 讀取單元失敗", slug, lessonError.message);
  }
  const rows = lessonRows ?? [];

  if (rows.length === 0) {
    return <NoLessons title={product.title as string} />;
  }

  // 4) 自己的進度
  const { data: progressRows } = await supabase
    .from("lesson_progress")
    .select("lesson_id, completed")
    .in(
      "lesson_id",
      rows.map((r) => r.id as string),
    );
  const completedIds = new Set(
    (progressRows ?? [])
      .filter((p) => p.completed)
      .map((p) => p.lesson_id as string),
  );

  // 5) 哪幾堂真的有影片。這一步要用 service role（youtube_id 沒 grant），
  //    但只回傳布林值 —— 讓側欄能標「影片準備中」，而不是讓客人點進去看到錯誤。
  const withVideo = await loadVideoAvailability(rows.map((r) => r.id as string));

  const lessons: ClassroomLesson[] = rows.map((row) => ({
    id: row.id as string,
    title: row.title as string,
    durationSec: (row.duration_sec as number | null) ?? null,
    freePreview: row.free_preview === true,
    completed: completedIds.has(row.id as string),
    hasVideo: withVideo.has(row.id as string),
  }));

  // 預設從第一個「還沒完成而且有影片」的單元開始；全完成就從第一堂。
  const requested = lessons.find((l) => l.id === requestedLessonId);
  const firstUnfinished = lessons.find((l) => !l.completed && l.hasVideo);
  const initial = requested ?? firstUnfinished ?? lessons[0]!;

  // 浮水印：遮罩後的 Email。技術上防不了盜錄（誠實講），但外流時追得到來源，
  // 也讓人知道「這是有記名的」。刻意不放完整 Email —— 那會把客人的個資
  // 燒進他自己截給朋友看的圖裡。
  const watermark = member.email ? maskEmail(member.email) : null;

  return (
    <>
      <div className="mb-[12px]">
        <BackLink href="/account" label="回我的學習" />
      </div>
      <h1 className="t-h1 mb-[20px] text-brown-900">{product.title as string}</h1>
      <Classroom
        courseTitle={product.title as string}
        lessons={lessons}
        initialLessonId={initial.id}
        watermark={watermark}
      />
    </>
  );
}

/**
 * 哪些單元有影片。
 *
 * 只回 id 的集合，**不回 youtube_id** —— 這個函式的回傳值會進 RSC payload。
 */
async function loadVideoAvailability(lessonIds: string[]): Promise<Set<string>> {
  if (lessonIds.length === 0) return new Set();
  try {
    const admin = createServiceClient();
    const { data, error } = await admin
      .from("course_lessons")
      .select("id, youtube_id")
      .in("id", lessonIds);

    if (error) {
      console.error("[learn] 檢查影片失敗", error.message);
      // 查不到就當作「都有影片」：讓人點進去由 /api/lessons/[id]/video
      // 回真正的原因，比整排標成「準備中」誤導人好。
      return new Set(lessonIds);
    }
    return new Set(
      (data ?? [])
        .filter((row) => Boolean(row.youtube_id))
        .map((row) => row.id as string),
    );
  } catch (err) {
    console.error("[learn] service client 失敗", err);
    return new Set(lessonIds);
  }
}

function NoAccess({
  title,
  slug,
  expired,
}: {
  title: string;
  slug: string;
  expired: boolean;
}) {
  return (
    <>
      <div className="mb-[12px]">
        <BackLink href="/account" label="回我的學習" />
      </div>
      <div className="rounded-card border border-sand-400 bg-cream-100 px-[22px] py-[30px] md:px-[40px] md:py-[40px]">
        <h1 className="t-h2 text-brown-900">
          {expired ? "這門課的觀看期限到了" : "你還沒有這門課"}
        </h1>
        <p className="t-body mt-[14px] text-pretty text-brown-700">
          {expired
            ? `《${title}》想繼續看，用 LINE 跟我們說。`
            : `《${title}》還不在你的課程裡。買了卻看到這頁？多半是登入信箱跟下單時不同，LINE 報名字我們幫你查。`}
        </p>
        <div className="mt-[24px] flex flex-col gap-[12px] sm:flex-row">
          {!expired && (
            <Link
              href={`/courses/${slug}`}
              className={buttonClass({
                variant: "primary",
                size: "lg",
                fullWidth: true,
                className: "sm:w-auto",
              })}
            >
              看看這門課
            </Link>
          )}
          <LineButton />
        </div>
      </div>
    </>
  );
}

function NoLessons({ title }: { title: string }) {
  return (
    <>
      <div className="mb-[12px]">
        <BackLink href="/account" label="回我的學習" />
      </div>
      <div className="rounded-card border border-sand-400 bg-cream-100 px-[22px] py-[30px] md:px-[40px] md:py-[40px]">
        <h1 className="t-h2 text-brown-900">{title}</h1>
        <p className="t-body mt-[14px] text-pretty text-brown-700">
          內容準備中，好了會用 LINE 通知你。
        </p>
        <div className="mt-[24px]">
          <LineButton />
        </div>
      </div>
    </>
  );
}
