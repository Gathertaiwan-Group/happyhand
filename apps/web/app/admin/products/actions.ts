"use server";

import { redirect } from "next/navigation";
import { requireCapability, adminErrorMessage, AdminAuthError } from "@/lib/admin/guard";
import { writeAudit } from "@/lib/admin/audit";
import { createServiceClient } from "@/lib/supabase/server";
import { joinDuration } from "./shared";
import type { SubmittedLesson } from "./lesson-plan";
import type { SubmittedBlock } from "./block-plan";
import { checkProductDeletable, checkSessionDeletable, type CountClient } from "./guards";
import { PRODUCT_TYPES } from "./shared";
import {
  BLOCK_KIND_LABEL,
  createProduct,
  createSession,
  normalizeBlock,
  normalizeLesson,
  productFieldsFromForm,
  saveBlocksCore,
  saveLessonsCore,
  sessionFieldsFromForm,
  updateProduct,
  updateSession,
} from "./mutations";
import { liveMutationCtx, revalidateAdmin, revalidateStorefront } from "./mutation-ctx";
import { formatTaipei } from "@/components/admin/datetime-field";

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
 *
 * 2026-11-15：upsertProduct／saveLessons／upsertSession／saveBlocks 的
 *   「驗證＋寫入＋稽核」抽到 ./mutations.ts（MCP 也呼叫同一支）。這裡只剩
 *   權限檢查、把 FormData 翻成欄位、把結果翻回原本的 redirect／{error|ok}。
 *   錯誤代碼、redirect 目的地、?type= 的保留規則都沒有變。
 */

export type ActionResult = { error?: string | null } | undefined;

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
    const fields = productFieldsFromForm(formData);
    const typeRaw = fields.type;

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

    const ctx = liveMutationCtx(staff);

    if (isNew) {
      const r = await createProduct(ctx, fields);
      if (r.error) {
        destination = failTo(r.error);
        return;
      }
      destination = r.id ? `/admin/products/${r.id}?msg=created` : listPathFor(r.type);
      return;
    }

    const r = await updateProduct(ctx, id, fields);
    if (r.error) {
      destination =
        r.error === "notfound" ? `${listPathFor(typeRaw)}?msg=notfound` : failTo(r.error);
      return;
    }
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
      const n = normalizeLesson(i, {
        id: String(formData.get(`lessons.${i}.id`) ?? "").trim(),
        title: String(formData.get(`lessons.${i}.title`) ?? "").trim(),
        youtube: String(formData.get(`lessons.${i}.youtube_url`) ?? "").trim(),
        duration_sec: joinDuration(
          String(formData.get(`lessons.${i}.min`) ?? ""),
          String(formData.get(`lessons.${i}.sec`) ?? ""),
        ),
        free_preview: formData.get(`lessons.${i}.free_preview`) === "on",
        body: String(formData.get(`lessons.${i}.body`) ?? ""),
      });
      if ("error" in n) return { error: n.error };
      submitted.push(n.lesson);
    }

    const r = await saveLessonsCore(liveMutationCtx(staff), productId, submitted);
    if (r.error !== undefined) return { error: r.error };
    return { ok: r.ok };
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
    const fields = sessionFieldsFromForm(formData);
    const ctx = liveMutationCtx(staff);

    const r =
      sessionId === ""
        ? await createSession(ctx, productId, fields)
        : await updateSession(ctx, productId, sessionId, fields);
    if (r.error) {
      destination = `/admin/products/${productId}?msg=${r.error}#sessions`;
      return;
    }

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

/**
 * 儲存某一種內容區塊（一次一個 kind）。寫入本體在 ./mutations.ts 的 saveBlocksCore()。
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
      const n = normalizeBlock(i, kind, {
        id: String(formData.get(`blocks.${i}.id`) ?? ""),
        title: String(formData.get(`blocks.${i}.title`) ?? ""),
        body: String(formData.get(`blocks.${i}.body`) ?? ""),
        amount: String(formData.get(`blocks.${i}.amount`) ?? ""),
        note: String(formData.get(`blocks.${i}.note`) ?? ""),
      });
      if ("skip" in n) continue;
      if ("error" in n) return { error: n.error };
      submitted.push(n.block);
    }

    const r = await saveBlocksCore(liveMutationCtx(staff), productId, kind, submitted);
    if (r.error !== undefined) return { error: r.error };
    return { ok: r.ok };
  } catch (err) {
    console.error("[admin/products] saveBlocks 例外", err);
    return { error: adminErrorMessage(err) };
  }
}
