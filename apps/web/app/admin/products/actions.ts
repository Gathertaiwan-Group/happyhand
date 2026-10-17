"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireCapability, adminErrorMessage, AdminAuthError } from "@/lib/admin/guard";
import { writeAudit, diffOf } from "@/lib/admin/audit";
import { createServiceClient } from "@/lib/supabase/server";
import { parseYouTubeId } from "@/lib/youtube";
import { taipeiLocalToIso, formatTaipei } from "@/components/admin/datetime-field";
import { applyLessonPlan, planLessonWrites, type SubmittedLesson } from "./lesson-plan";
import {
  applyBlockPlan,
  planBlockWrites,
  type SubmittedBlock,
} from "./block-plan";
import { checkProductDeletable, checkSessionDeletable, type CountClient } from "./guards";
import {
  PRODUCT_TYPES,
  PRODUCT_TYPE_LABEL,
  SESSION_STATUS_CHOICES,
  SESSION_STATUS_LABEL,
  isValidSlug,
  joinDuration,
  linesToArray,
  parseIntField,
  toSessionStatus,
  type ProductType,
  type SessionStatus,
  contentLinesToArray,
  toSessionFormat,
} from "./shared";

/**
 * 課程與工作坊的寫入動作。
 *
 * ⚠️ 每一支都自己呼叫一次 requireCapability("catalog:write")。
 *    app/admin/layout.tsx 的守衛只在 render 頁面時跑，server action 的 POST
 *    不經過它 —— 少寫一行，任何登入的一般會員都能改課程價格。
 *
 * ⚠️ 前台是 ISR（/、/courses、/workshops 都是 revalidate = 300），
 *    改完沒有 revalidatePath 的話客戶會盯著沒變的頁面說「你根本沒改」。
 *    所以每一支成功的寫入最後都會呼叫 revalidateStorefront()。
 *
 * ⚠️ 一律不要手寫 updated_at：那幾張表都有 `trg_*_updated_at` trigger
 *    （before update -> set_updated_at()），應用層再寫一次只會互相打架。
 */

export type ActionResult = { error?: string | null } | undefined;

/* ------------------------------------------------------------ 快取清除 */

/**
 * 前台所有會看到商品資料的路徑。
 *
 * 動態路由用 `("/courses/[slug]", "page")` 這個形式而不是拼真實 slug：
 * 改名時舊網址那一份也要打掉，拼字串只會清到新的那一個，
 * 舊網址會繼續從快取吐出已經不存在的頁面直到 300 秒過去。
 */
function revalidateStorefront() {
  revalidatePath("/");
  revalidatePath("/courses");
  revalidatePath("/courses/[slug]", "page");
  revalidatePath("/workshops");
  revalidatePath("/workshops/[slug]", "page");
}

function revalidateAdmin(productId?: string) {
  // 清單已經拆成兩頁，兩邊都要打掉 —— 一門線上課另開實體班的話它兩邊都在。
  revalidatePath("/admin/courses");
  revalidatePath("/admin/workshops");
  if (productId) revalidatePath(`/admin/products/${productId}`);
  revalidatePath("/admin");
}

/**
 * 這個類型的商品屬於哪一張清單。
 *
 * ⚠️ 這裡只看 type，跟清單頁「type 是工作坊**或**有場次」的收錄條件不同 ——
 *    那是刻意的：存檔後要回「一個」地方，而線上課另開實體班的那一門兩邊都在，
 *    回它的主身分（線上課程）才符合直覺。
 */
function listPathFor(type: string): string {
  return type === "workshop" ? "/admin/workshops" : "/admin/courses";
}

/* ------------------------------------------------------------ 新增／編輯 */

/**
 * 建立或更新一門課。
 *
 * 這支是 `<form action={upsertProduct}>` 直接呼叫的，回傳值沒有地方接
 * （要接就得把整張表單變成 client component 走 useActionState，
 * 那會為了錯誤訊息把整組 AdminField 拉進 client bundle）。
 * 所以結果一律用 redirect 帶一個短代碼回來，由頁面翻成中文。
 *
 * 取捨：驗證失敗時使用者剛打的字會不見。
 * 為了把這件事的發生率壓到最低，格式類的規則同時掛在 <input> 的
 * required / pattern / min 上，瀏覽器會在送出前就擋下來；
 * 真正會走到這裡的只剩「代稱重複」這種 server 才知道的情況。
 */
export async function upsertProduct(formData: FormData): Promise<void> {
  // 還沒讀到 type 之前的預設。真的走到成功路徑時會被下面依 type 覆寫。
  let destination = "/admin/courses";

  try {
    const staff = await requireCapability("catalog:write");

    const id = String(formData.get("id") ?? "").trim();
    const isNew = id === "";

    const typeRaw = String(formData.get("type") ?? "").trim();
    const slug = String(formData.get("slug") ?? "").trim();
    const title = String(formData.get("title") ?? "").trim();
    const subtitle = String(formData.get("subtitle") ?? "").trim();
    const description = String(formData.get("description") ?? "").trim();
    const coverUrl = String(formData.get("cover_url") ?? "").trim();
    const heroLead = String(formData.get("hero_lead") ?? "").trim();

    // ⚠️ 沒勾的 checkbox 根本不會出現在 FormData 裡，
    //    所以是比對 "on" 而不是 Boolean(...)。
    const isPublished = formData.get("is_published") === "on";
    const isFeatured = formData.get("is_featured") === "on";

    /*
      🔴 新增時失敗要把 type 帶回去。

      以前這裡是 `"/admin/products/new"`，沒有 `?type=`。新增頁靠 query 的 type
      決定預設類型，拿不到就回到「線上課程」—— 所以建工作坊時只要碰到任何一個
      驗證錯誤（最常見的是網址代稱撞名），回到頁面時類型下拉已經悄悄變成線上課程、
      標題變成「新增課程」。管理員重填一次按送出，**建出來的是一門線上課**，
      出現在 /admin/courses 而不是 /admin/workshops —— 從他的角度就是
      「我明明建了工作坊，清單裡找不到」。

      只在 type 是合法值時才帶，不要把使用者送來的任意字串反射回網址。
    */
    const failBase = isNew ? "/admin/products/new" : `/admin/products/${id}`;
    const failTo = (msg: string) => {
      const q = new URLSearchParams({ msg });
      if (isNew && (PRODUCT_TYPES as readonly string[]).includes(typeRaw)) {
        q.set("type", typeRaw);
      }
      return `${failBase}?${q}`;
    };

    if (!(PRODUCT_TYPES as readonly string[]).includes(typeRaw)) {
      destination = failTo("type_invalid");
      return;
    }
    const type = typeRaw as ProductType;

    if (!isValidSlug(slug)) {
      destination = failTo("slug_format");
      return;
    }
    if (!title) {
      destination = failTo("title_required");
      return;
    }

    const price = parseIntField(String(formData.get("price") ?? ""));
    if (price === undefined || price === null || price < 0) {
      destination = failTo("price_invalid");
      return;
    }

    const compareAt = parseIntField(String(formData.get("compare_at_price") ?? ""));
    if (compareAt === undefined) {
      destination = failTo("compare_invalid");
      return;
    }
    // products_compare_at_price_sane check (compare_at_price is null or >= price)。
    // 不先擋的話資料庫會回一句 23514 的英文，員工只會看到「儲存失敗」。
    if (compareAt !== null && compareAt < price) {
      destination = failTo("compare_invalid");
      return;
    }

    const sortOrder = parseIntField(String(formData.get("sort_order") ?? ""));
    if (sortOrder === undefined || sortOrder === null) {
      destination = failTo("sort_invalid");
      return;
    }

    const payload = {
      type,
      slug,
      title: title.slice(0, 200),
      subtitle: subtitle ? subtitle.slice(0, 200) : null,
      description: description ? description.slice(0, 4000) : null,
      price,
      compare_at_price: compareAt,
      cover_url: coverUrl ? coverUrl.slice(0, 500) : null,
      is_published: isPublished,
      is_featured: isFeatured,
      tags: linesToArray(String(formData.get("tags") ?? "")),
      benefits: linesToArray(String(formData.get("benefits") ?? "")),
      sort_order: sortOrder,

      // 報名頁內容。用 contentLinesToArray（40 項 × 200 字）而不是上面那個
      // linesToArray（20 項 × 60 字）—— 課程大綱條目用 60 字寫不完。
      hero_lead: heroLead ? heroLead.slice(0, 2000) : null,
      suitable_for: contentLinesToArray(String(formData.get("suitable_for") ?? "")),
      not_suitable_for: contentLinesToArray(
        String(formData.get("not_suitable_for") ?? ""),
      ),
      outcomes: contentLinesToArray(String(formData.get("outcomes") ?? "")),
      curriculum_online: contentLinesToArray(
        String(formData.get("curriculum_online") ?? ""),
      ),
      curriculum_onsite: contentLinesToArray(
        String(formData.get("curriculum_onsite") ?? ""),
      ),
      includes: contentLinesToArray(String(formData.get("includes") ?? "")),
      notes: contentLinesToArray(String(formData.get("notes") ?? "")),
      asks_intake: formData.get("asks_intake") === "on",
    };

    const db = createServiceClient();

    if (isNew) {
      const { data, error } = await db
        .from("products")
        .insert(payload)
        .select("id")
        .maybeSingle();

      if (error) {
        // 23505 = unique_violation，這裡只可能是 products_slug_key。
        destination =
          error.code === "23505"
            ? failTo("slug_taken")
            : failTo("failed");
        if (error.code !== "23505") {
          console.error("[admin/products] 建立商品失敗", error);
        }
        return;
      }

      const newId = (data as unknown as { id: string } | null)?.id ?? "";
      await writeAudit(staff, {
        action: "product.create",
        entity: "product",
        entityId: newId || null,
        summary: `新增${PRODUCT_TYPE_LABEL[type]}「${payload.title}」（${slug}）`,
        diff: { created: payload },
      });

      revalidateAdmin(newId);
      revalidateStorefront();
      destination = newId
        ? `/admin/products/${newId}?msg=created`
        : listPathFor(type);
      return;
    }

    const { data: before, error: beforeError } = await db
      .from("products")
      .select(
        "id, type, slug, title, subtitle, description, price, compare_at_price, cover_url, is_published, is_featured, tags, benefits, sort_order, hero_lead, suitable_for, not_suitable_for, outcomes, curriculum_online, curriculum_onsite, includes, notes, asks_intake",
      )
      .eq("id", id)
      .maybeSingle();

    if (beforeError) {
      console.error("[admin/products] 讀取商品失敗", beforeError);
      destination = failTo("failed");
      return;
    }
    if (!before) {
      destination = `${listPathFor(typeRaw)}?msg=notfound`;
      return;
    }

    const { error } = await db.from("products").update(payload).eq("id", id);
    if (error) {
      destination =
        error.code === "23505" ? failTo("slug_taken") : failTo("failed");
      if (error.code !== "23505") {
        console.error("[admin/products] 更新商品失敗", error);
      }
      return;
    }

    const prev = before as unknown as Record<string, unknown>;
    const diff = diffOf(prev, payload as unknown as Record<string, unknown>, [
      "type",
      "slug",
      "title",
      "subtitle",
      "description",
      "price",
      "compare_at_price",
      "cover_url",
      "is_published",
      "is_featured",
      "tags",
      "benefits",
      "sort_order",
      // 報名頁內容也要留稽核 —— 這些是對外文案，改錯了要查得到是誰改的
      "hero_lead",
      "suitable_for",
      "not_suitable_for",
      "outcomes",
      "curriculum_online",
      "curriculum_onsite",
      "includes",
      "notes",
      "asks_intake",
    ]);

    // 代稱換掉＝舊網址從此 404。稽核摘要要看得出來，
    // 之後客人反映連結壞掉時才查得到是誰在什麼時候改的。
    const slugChanged = prev.slug !== slug;
    await writeAudit(staff, {
      action: "product.update",
      entity: "product",
      entityId: id,
      summary: slugChanged
        ? `更新「${payload.title}」，網址代稱 ${String(prev.slug)} → ${slug}（舊網址將失效）`
        : `更新「${payload.title}」`,
      diff,
    });

    revalidateAdmin(id);
    revalidateStorefront();
    destination = `/admin/products/${id}?msg=saved`;
  } catch (err) {
    console.error("[admin/products] upsertProduct 例外", err);
    /*
      🔴 只有真的是權限問題才說「沒有權限」。

      以前這個 catch 不分青紅皂白一律回 `denied` —— 環境變數掛了、資料庫逾時、
      任何非預期的例外，畫面上都寫「你的帳號沒有編輯課程的權限」。owner 看到這句
      會去找人調權限，而真正壞的是系統。誤報的錯誤會把人送去找錯的人。
    */
    const code = err instanceof AdminAuthError ? "denied" : "failed";
    const id = String(formData.get("id") ?? "").trim();
    if (id) {
      destination = `/admin/products/${id}?msg=${code}`;
    } else {
      const q = new URLSearchParams({ msg: code });
      const t = String(formData.get("type") ?? "").trim();
      if ((PRODUCT_TYPES as readonly string[]).includes(t)) q.set("type", t);
      destination = `/admin/products/new?${q}`;
    }
  } finally {
    // redirect() 是靠丟例外實作的，寫在 try 裡會被自己的 catch 吃掉。
    redirect(destination);
  }
}

/* ---------------------------------------------------------------- 上下架 */

export async function togglePublish(
  productId: string,
  next: boolean,
): Promise<ActionResult> {
  try {
    const staff = await requireCapability("catalog:write");
    const db = createServiceClient();

    const { data: before, error: beforeError } = await db
      .from("products")
      .select("id, title, is_published")
      .eq("id", productId)
      .maybeSingle();
    if (beforeError) return { error: "讀取課程失敗，請重試一次。" };
    if (!before) return { error: "找不到這門課，可能已經被其他同事刪除了。" };

    const row = before as unknown as { title: string; is_published: boolean };
    if (row.is_published === next) {
      return { error: next ? "這門課已經是發布中了。" : "這門課已經是草稿了。" };
    }

    const { error } = await db
      .from("products")
      .update({ is_published: next })
      .eq("id", productId);
    if (error) {
      console.error("[admin/products] 切換發布狀態失敗", error);
      return { error: "更新發布狀態失敗，請重試一次。" };
    }

    await writeAudit(staff, {
      action: next ? "product.publish" : "product.unpublish",
      entity: "product",
      entityId: productId,
      summary: `${next ? "發布" : "下架"}「${row.title}」`,
      diff: { is_published: { from: row.is_published, to: next } },
    });

    revalidateAdmin(productId);
    revalidateStorefront();
    return undefined;
  } catch (err) {
    console.error("[admin/products] togglePublish 例外", err);
    return { error: adminErrorMessage(err) };
  }
}

/* ------------------------------------------------------------------ 刪除 */

/**
 * 刪除一門課。
 *
 * 🔴 order_items.product_id 是 `on delete restrict`。
 *    有人買過就刪不掉，資料庫會回 23503。不先擋的話員工看到的是
 *    「儲存失敗」而完全不知道原因，只會一直重按。
 *
 * 🔴 另外一個更陰險的路徑：products 刪掉會 cascade 掉它底下的
 *    workshop_sessions，而 order_items.session_id 是 `on delete set null`。
 *    也就是說如果某張訂單只有 session_id 指過來、product_id 是 null，
 *    restrict 擋不住，刪下去訂單還在但「報名的是哪一場」會靜靜地變成 null。
 *    所以這裡連場次的參照也一起查。
 */
export async function deleteProduct(productId: string): Promise<ActionResult> {
  // redirect 必須在 try/catch 外面（它靠丟例外實作），所以要先把「刪完回哪一頁」
  // 存出來 —— 那時候拿不到 row 了。
  let deletedListPath = "/admin/courses";

  try {
    const staff = await requireCapability("catalog:write");
    const db = createServiceClient();

    const { data: before, error: beforeError } = await db
      .from("products")
      .select("id, title, slug, type, is_published")
      .eq("id", productId)
      .maybeSingle();
    if (beforeError) return { error: "讀取課程失敗，請重試一次。" };
    if (!before) return { error: "找不到這門課，可能已經被其他同事刪除了。" };
    const row = before as unknown as {
      title: string;
      is_published: boolean;
      slug: string;
      type: string;
    };

    // 參照檢查抽在 ./guards.ts，驗收腳本跑的是同一支。
    // cast 的理由見 guards.ts 的 CountFilter 註解（supabase 的建構器泛型
    // 拿去比對結構型別會讓 tsc 爆 TS2589）。只在這一行銜接。
    const block = await checkProductDeletable(db as unknown as CountClient, productId, async (id) => {
      const { data, error } = await db
        .from("workshop_sessions")
        .select("id")
        .eq("product_id", id);
      if (error) throw new Error(error.message);
      return (data ?? []).map((row) => (row as unknown as { id: string }).id);
    });
    if (block.blocked) return { error: block.reason };

    const { error } = await db.from("products").delete().eq("id", productId);
    if (error) {
      // 23503 = foreign_key_violation。上面已經先查過，走到這裡代表
      // 查完到刪掉之間剛好有人下單（競態）。照樣要說人話。
      if (error.code === "23503") {
        return { error: "這門課已經有人買過，不能刪除。請改成下架。" };
      }
      console.error("[admin/products] 刪除商品失敗", error);
      return { error: "刪除失敗，請重試一次。" };
    }

    await writeAudit(staff, {
      action: "product.delete",
      entity: "product",
      entityId: productId,
      summary: `刪除「${row.title}」（${row.slug}）`,
      diff: { deleted: { title: row.title, slug: row.slug, was_published: row.is_published } },
    });

    revalidateAdmin(productId);
    revalidateStorefront();
    deletedListPath = listPathFor(row.type);
  } catch (err) {
    console.error("[admin/products] deleteProduct 例外", err);
    return { error: adminErrorMessage(err) };
  }

  // 成功才會走到這裡。redirect 要在 try/catch 外面，否則會被自己的 catch 吃掉。
  // 刪掉的是工作坊就回工作坊清單，否則回課程清單。
  redirect(`${deletedListPath}?msg=saved`);
}

/* ------------------------------------------------------------ 單元整批存 */

export type LessonSaveState = { error?: string; ok?: string } | null;

/**
 * 一次存下某門課的所有單元。
 *
 * 寫入計畫由 ./lesson-plan.ts 的 planLessonWrites() 算出來（純函式，
 * 驗收腳本跑的是同一支），這裡只負責照著計畫打資料庫。
 *
 * 🔴 兩階段搬移的原因見 lesson-plan.ts 的檔頭：
 *    unique (product_id, sort_order) 會在重排途中撞到，
 *    而 delete-then-insert 會經由 lesson_progress 的 cascade
 *    把所有學員的觀看進度洗掉。這裡全程 UPDATE，id 不變。
 */
export async function saveLessons(
  productId: string,
  _prev: LessonSaveState,
  formData: FormData,
): Promise<LessonSaveState> {
  try {
    const staff = await requireCapability("catalog:write");

    const count = Number(formData.get("lesson_count") ?? "0");
    if (!Number.isInteger(count) || count < 0 || count > 200) {
      return { error: "單元數量不正確，請重新整理後再試。" };
    }

    const submitted: SubmittedLesson[] = [];
    for (let i = 0; i < count; i += 1) {
      // 用「索引命名」而不是同名多值 + getAll()：
      // 沒勾的 checkbox 不會出現在 FormData，用 getAll() 對齊會整排錯位，
      // 第 3 課的「可試看」會跑到第 5 課身上。
      const title = String(formData.get(`lessons.${i}.title`) ?? "").trim();
      if (!title) {
        return { error: `第 ${i + 1} 個單元沒有填標題。` };
      }

      // 員工貼的是整條 YouTube 網址（他們不會知道什麼叫「影片 ID」），
      // 存進資料庫的是 11 碼 ID。
      //
      // ⚠️ 認不出來的字串**不要默默當成沒填**。那會變成
      //    「後台看起來有填、學員點播放卻說沒有影片」，而且沒有人查得出原因。
      //    寧可擋下整次儲存並回一句人話。
      const rawUrl = String(formData.get(`lessons.${i}.youtube_url`) ?? "").trim();
      const youtubeId = rawUrl ? parseYouTubeId(rawUrl) : null;
      if (rawUrl && !youtubeId) {
        return {
          error:
            `第 ${i + 1} 個單元的 YouTube 網址看不懂：「${rawUrl.slice(0, 60)}」。` +
            "請從 YouTube 影片頁的網址列整條複製過來（watch?v=、youtu.be 都可以）。",
        };
      }

      submitted.push({
        id: String(formData.get(`lessons.${i}.id`) ?? "").trim(),
        title: title.slice(0, 200),
        duration_sec: joinDuration(
          String(formData.get(`lessons.${i}.min`) ?? ""),
          String(formData.get(`lessons.${i}.sec`) ?? ""),
        ),
        youtube_id: youtubeId,
        free_preview: formData.get(`lessons.${i}.free_preview`) === "on",
        // 🔴 先把 CRLF 正規化成 LF。HTML 規格規定 textarea 送出時換行一律
        //    變成 \r\n，而渲染端是用「連續兩個換行」分段 —— \r\n\r\n 的兩個
        //    \n 中間夾著 \r，任何 /\n{2,}/ 都切不開，整篇會擠成一大段。
        //    這個 bug 不會有任何錯誤訊息，只會讓排版看起來「怪怪的」。
        // 8000 字約 4 頁 A4，夠寫一堂課的說明；再長就該做成講義 PDF。
        body:
          String(formData.get(`lessons.${i}.body`) ?? "")
            .replace(/\r\n?/g, "\n")
            .trim()
            .slice(0, 8000) || null,
      });
    }

    const db = createServiceClient();

    const { data: existingRaw, error: existingError } = await db
      .from("course_lessons")
      .select("id, sort_order")
      .eq("product_id", productId)
      .order("sort_order");
    if (existingError) {
      console.error("[admin/products] 讀取單元失敗", existingError);
      return { error: "讀取現有單元失敗，請重試一次。" };
    }
    const existing = (existingRaw ?? []) as unknown as { id: string; sort_order: number }[];

    const plan = planLessonWrites(existing, submitted);

    if (plan.unknownIds.length > 0) {
      return {
        error: "這份單元清單已經過期（有單元被其他同事刪掉了），請重新整理後再存一次。",
      };
    }

    // 實際寫入（刪除 -> PARK -> 寫回目標位置 -> 新增）交給 applyLessonPlan()。
    // 那四步的順序本身就是正確性的一部分，抽在 lesson-plan.ts 裡，
    // 驗收腳本才能跑到同一段程式碼而不是一份複製品。
    const failure = await applyLessonPlan(db, productId, plan);
    if (failure) {
      console.error("[admin/products] 寫入單元失敗", failure.stage, failure.message);
      const MESSAGES: Record<typeof failure.stage, string> = {
        delete: "刪除單元失敗，請重試一次。",
        park: "重新排序失敗，請重新整理後再試一次。",
        update: "儲存單元失敗，請重新整理後再試一次。",
        insert: "新增單元失敗，請重新整理後再試一次。",
      };
      return { error: MESSAGES[failure.stage] };
    }

    await writeAudit(staff, {
      action: "lesson.save",
      entity: "product",
      entityId: productId,
      summary: `更新單元清單：共 ${submitted.length} 個單元（新增 ${plan.insert.length}、刪除 ${plan.deleteIds.length}）`,
      diff: {
        total: submitted.length,
        inserted: plan.insert.length,
        deleted: plan.deleteIds.length,
        order: plan.update.map((row) => ({ id: row.id, sort_order: row.sort_order })),
      },
    });

    revalidateAdmin(productId);
    revalidateStorefront();
    return { ok: `已儲存 ${submitted.length} 個單元。` };
  } catch (err) {
    console.error("[admin/products] saveLessons 例外", err);
    return { error: adminErrorMessage(err) };
  }
}

/* ------------------------------------------------------------------ 場次 */

/**
 * 新增或更新一個場次。
 *
 * ⚠️ 這裡刻意完全不碰 seats_taken。那個數字歸結帳流程（reserve_seat /
 *    commit_seat_hold）與 /admin/sessions 的 admin_adjust_seats() 管，
 *    在課程編輯頁順手改它會直接和實際報名人數打架。
 *
 * ⚠️ 送上來的是台北牆上時間字串（"2026-09-12T14:00"），
 *    datetime-field 不會偷偷幫忙轉時區，所以這裡必須自己
 *    taipeiLocalToIso() 之後才寫進 timestamptz 欄位。
 */
export async function upsertSession(productId: string, formData: FormData): Promise<void> {
  let destination = `/admin/products/${productId}`;

  try {
    const staff = await requireCapability("catalog:write");

    const sessionId = String(formData.get("session_id") ?? "").trim();
    const startsAt = taipeiLocalToIso(String(formData.get("starts_at") ?? ""));
    const endsAt = taipeiLocalToIso(String(formData.get("ends_at") ?? ""));

    if (!startsAt || !endsAt || new Date(endsAt) <= new Date(startsAt)) {
      destination = `/admin/products/${productId}?msg=session_time_invalid#sessions`;
      return;
    }

    const capacity = parseIntField(String(formData.get("capacity") ?? ""));
    if (capacity === undefined || capacity === null || capacity < 0) {
      destination = `/admin/products/${productId}?msg=session_capacity_invalid#sessions`;
      return;
    }

    const statusRaw = String(formData.get("status") ?? "").trim();
    const status: SessionStatus = (SESSION_STATUS_CHOICES as readonly string[]).includes(
      statusRaw,
    )
      ? (statusRaw as SessionStatus)
      : "open";

    const location = String(formData.get("location") ?? "").trim();
    const address = String(formData.get("address") ?? "").trim();

    const sessionTitle = String(formData.get("title") ?? "").trim();
    const sessionSummary = String(formData.get("summary") ?? "").trim();
    const sessionNotes = String(formData.get("notes") ?? "").trim();
    const sessionPrice = parseIntField(String(formData.get("price") ?? ""));
    if (sessionPrice === undefined || (sessionPrice !== null && sessionPrice < 0)) {
      destination = `/admin/products/${productId}?msg=session_price_invalid#sessions`;
      return;
    }

    const payload = {
      starts_at: startsAt,
      ends_at: endsAt,
      location: location ? location.slice(0, 200) : null,
      address: address ? address.slice(0, 300) : null,
      capacity,
      status,
      title: sessionTitle ? sessionTitle.slice(0, 200) : null,
      summary: sessionSummary ? sessionSummary.slice(0, 300) : null,
      format: toSessionFormat(formData.get("format")),
      // ⚠️ 留空 = null = 用課程定價。0 是合法價格（免費場次），
      //    所以這裡用 parseIntField 的 null/undefined 區分，不能用 falsy 判斷。
      price: sessionPrice ?? null,
      notes: sessionNotes ? sessionNotes.slice(0, 300) : null,
    };

    const db = createServiceClient();

    if (sessionId === "") {
      const { data, error } = await db
        .from("workshop_sessions")
        .insert({ ...payload, product_id: productId })
        .select("id, status")
        .maybeSingle();
      if (error) {
        // 23505 = workshop_sessions_product_starts_key
        destination =
          error.code === "23505"
            ? `/admin/products/${productId}?msg=session_duplicate#sessions`
            : `/admin/products/${productId}?msg=failed#sessions`;
        if (error.code !== "23505") console.error("[admin/products] 新增場次失敗", error);
        return;
      }
      const created = data as unknown as { id: string; status: string } | null;
      await writeAudit(staff, {
        action: "session.create",
        entity: "session",
        entityId: created?.id ?? null,
        summary: `新增場次 ${formatTaipei(startsAt)}（${payload.location ?? "未填地點"}，名額 ${capacity}）`,
        diff: { product_id: productId, ...payload, landed_status: created?.status },
      });
    } else {
      const { data: before, error: beforeError } = await db
        .from("workshop_sessions")
        .select("id, starts_at, ends_at, location, address, capacity, status, seats_taken")
        .eq("id", sessionId)
        .eq("product_id", productId)
        .maybeSingle();
      if (beforeError) {
        console.error("[admin/products] 讀取場次失敗", beforeError);
        destination = `/admin/products/${productId}?msg=failed#sessions`;
        return;
      }
      if (!before) {
        destination = `/admin/products/${productId}?msg=session_notfound#sessions`;
        return;
      }
      const prev = before as unknown as Record<string, unknown>;

      // 名額不能砍到比已經報名的人數還少：
      // workshop_sessions_not_oversold check (seats_taken <= capacity) 會擋，
      // 但擋出來是 23514 的英文。先在這裡翻成人話。
      const seatsTaken = Number(prev.seats_taken ?? 0);
      if (capacity < seatsTaken) {
        destination = `/admin/products/${productId}?msg=session_capacity_invalid#sessions`;
        return;
      }

      const { data: after, error } = await db
        .from("workshop_sessions")
        .update(payload)
        .eq("id", sessionId)
        .select("status")
        .maybeSingle();
      if (error) {
        destination =
          error.code === "23505"
            ? `/admin/products/${productId}?msg=session_duplicate#sessions`
            : `/admin/products/${productId}?msg=failed#sessions`;
        if (error.code !== "23505") console.error("[admin/products] 更新場次失敗", error);
        return;
      }

      // trigger sync_workshop_session_status() 可能把 open 立刻改成 full
      // （人數已滿）。據實記錄真正落地的值，不要記我們「以為」寫進去的。
      const landed = toSessionStatus(
        (after as unknown as { status: string } | null)?.status ?? status,
      );

      await writeAudit(staff, {
        action: "session.update",
        entity: "session",
        entityId: sessionId,
        summary: `更新場次 ${formatTaipei(startsAt)}（${SESSION_STATUS_LABEL[landed]}，名額 ${capacity}）`,
        diff: diffOf(prev, { ...payload, status: landed } as unknown as Record<string, unknown>, [
          "starts_at",
          "ends_at",
          "location",
          "address",
          "capacity",
          "status",
        ]),
      });
    }

    revalidateAdmin(productId);
    revalidateStorefront();
    destination = `/admin/products/${productId}?msg=session_saved#sessions`;
  } catch (err) {
    console.error("[admin/products] upsertSession 例外", err);
    // 同 upsertProduct：只有權限錯誤才說沒有權限，其他一律是儲存失敗。
    const code = err instanceof AdminAuthError ? "denied" : "failed";
    destination = `/admin/products/${productId}?msg=${code}#sessions`;
  } finally {
    redirect(destination);
  }
}

/**
 * 刪除一個場次。
 *
 * 🔴 order_items.session_id 是 `on delete set null`，不是 restrict。
 *    刪下去資料庫不會吭聲，但訂單會變成「有人付了錢報名，可是不知道是哪一場」。
 *    這種資料一旦壞掉沒有辦法還原（沒有其他欄位記得場次）。
 *    所以只要有任何訂單明細指向這一場就不給刪，請他改成「已取消」——
 *    取消會保留紀錄，前台也看得出來這場不辦了。
 */
export async function deleteSession(
  sessionId: string,
  productId: string,
): Promise<ActionResult> {
  try {
    const staff = await requireCapability("catalog:write");
    const db = createServiceClient();

    const { data: before, error: beforeError } = await db
      .from("workshop_sessions")
      .select("id, starts_at, location, status")
      .eq("id", sessionId)
      .eq("product_id", productId)
      .maybeSingle();
    if (beforeError) return { error: "讀取場次失敗，請重試一次。" };
    if (!before) return { error: "找不到這個場次，可能已經被其他同事刪除了。" };
    const row = before as unknown as { starts_at: string; location: string | null };

    // 已付款／未付款兩種訊息都在 ./guards.ts，驗收腳本跑的是同一支。
    const block = await checkSessionDeletable(db as unknown as CountClient, sessionId);
    if (block.blocked) return { error: block.reason };

    const { error } = await db.from("workshop_sessions").delete().eq("id", sessionId);
    if (error) {
      console.error("[admin/products] 刪除場次失敗", error);
      return { error: "刪除場次失敗，請重試一次。" };
    }

    await writeAudit(staff, {
      action: "session.delete",
      entity: "session",
      entityId: sessionId,
      summary: `刪除場次 ${formatTaipei(row.starts_at)}（${row.location ?? "未填地點"}）`,
      diff: { product_id: productId, starts_at: row.starts_at },
    });

    revalidateAdmin(productId);
    revalidateStorefront();
    return undefined;
  } catch (err) {
    console.error("[admin/products] deleteSession 例外", err);
    return { error: adminErrorMessage(err) };
  }
}


/* ------------------------------------------------------- 內容區塊（FAQ 等） */

export type BlockSaveState = { error?: string | null; ok?: string | null } | null;

/** 每種區塊的中文名，錯誤訊息用得到。 */
const BLOCK_KIND_LABEL: Record<string, string> = {
  faq: "常見問題",
  step: "學習路徑",
  info_row: "報名資訊",
  pricing: "費用方案",
  feature: "特色說明",
};

/**
 * 儲存某一種內容區塊（一次一個 kind）。
 *
 * 排序走 block-plan.ts 的 PARK→FINAL —— product_blocks 有
 * `unique (product_id, kind, sort_order)`，逐筆改成目標值一定會撞 23505。
 *
 * ⚠️ 跟 saveLessons 一樣用「索引命名」而不是同名多值 + getAll()：
 *    空欄位在 FormData 裡的行為不一致，用 getAll() 對齊會整排錯位。
 */
export async function saveBlocks(
  productId: string,
  kind: string,
  _prev: BlockSaveState,
  formData: FormData,
): Promise<BlockSaveState> {
  try {
    const staff = await requireCapability("catalog:write");

    if (!BLOCK_KIND_LABEL[kind]) {
      return { error: "區塊類型不正確，請重新整理後再試。" };
    }
    const label = BLOCK_KIND_LABEL[kind];

    const count = Number(formData.get("block_count") ?? "0");
    if (!Number.isInteger(count) || count < 0 || count > 100) {
      return { error: `${label}的數量不正確，請重新整理後再試。` };
    }

    const submitted: SubmittedBlock[] = [];
    for (let i = 0; i < count; i += 1) {
      const title = String(formData.get(`blocks.${i}.title`) ?? "").trim();
      const body = String(formData.get(`blocks.${i}.body`) ?? "").trim();

      // 整列都空白就當作使用者想刪掉它，不要存一列空的進去。
      if (!title && !body) continue;

      if (!title) {
        return { error: `第 ${i + 1} 個${label}沒有填標題。` };
      }

      // pricing 額外帶金額與附註；其他 kind 的 meta 保持空物件。
      const meta: Record<string, unknown> = {};
      if (kind === "pricing") {
        const amountRaw = String(formData.get(`blocks.${i}.amount`) ?? "").trim();
        if (amountRaw) {
          const amount = Number(amountRaw);
          if (!Number.isInteger(amount) || amount < 0) {
            return { error: `第 ${i + 1} 個${label}的金額請填 0 或正整數。` };
          }
          meta.amount = amount;
        }
        const note = String(formData.get(`blocks.${i}.note`) ?? "").trim();
        if (note) meta.note = note.slice(0, 300);
      }

      submitted.push({
        id: String(formData.get(`blocks.${i}.id`) ?? "").trim(),
        title: title.slice(0, 300),
        body: body ? body.slice(0, 4000) : null,
        meta,
      });
    }

    const db = createServiceClient();

    const { data: existingRaw, error: readError } = await db
      .from("product_blocks")
      .select("id, sort_order")
      .eq("product_id", productId)
      .eq("kind", kind)
      .order("sort_order");
    if (readError) {
      console.error("[admin/products] 讀內容區塊失敗", readError.message);
      return { error: "讀取現有內容失敗，請重試一次。" };
    }

    const existing = (existingRaw ?? []) as { id: string; sort_order: number }[];
    const plan = planBlockWrites(existing, submitted);

    // 樂觀鎖：送上來的 id 資料庫找不到 = 有人在你編輯的時候刪了它。
    // 這時候整批擋下，不要只寫一半。
    if (plan.unknownIds.length > 0) {
      return {
        error: `有${label}在你編輯的時候被其他同事刪掉了。請重新整理頁面再改一次。`,
      };
    }

    const failure = await applyBlockPlan(db, productId, kind, plan);
    if (failure) {
      const stageText = {
        delete: "刪除舊資料",
        park: "調整順序（第一階段）",
        final: "寫入內容",
        insert: "新增資料",
      }[failure.stage];
      console.error("[admin/products] 內容區塊寫入失敗", kind, failure.stage);
      return { error: `儲存${label}時在「${stageText}」失敗，請重試一次。` };
    }

    await writeAudit(staff, {
      action: "product.blocks",
      entity: "product",
      entityId: productId,
      summary: `更新${label}（共 ${submitted.length} 筆）`,
      diff: {
        kind,
        count: submitted.length,
        deleted: plan.deleteIds.length,
        inserted: plan.insert.length,
      },
    });

    revalidateAdmin(productId);
    revalidateStorefront();
    return { ok: `已儲存 ${submitted.length} 筆${label}。` };
  } catch (err) {
    console.error("[admin/products] saveBlocks 例外", err);
    return { error: adminErrorMessage(err) };
  }
}
