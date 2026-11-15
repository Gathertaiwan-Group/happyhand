import "server-only";
import { revalidatePath } from "next/cache";
import type { Staff } from "@/lib/admin/guard";
import { writeAudit } from "@/lib/admin/audit";
import { createServiceClient } from "@/lib/supabase/server";
import type { MutationCtx } from "./mutations";

/**
 * 正式環境的 MutationCtx：service client + writeAudit + revalidatePath。
 *
 * 跟 mutations.ts 分開放，是為了讓 mutations.ts 可以在單元測試裡換成假資料庫，
 * 不必把 next/cache 拉進 node --test。
 */

/**
 * 前台所有會看到商品資料的路徑。
 *
 * ⚠️ 前台是 ISR（/、/courses、/workshops 都是 revalidate = 300），
 *    改完沒有 revalidatePath 的話客戶會盯著沒變的頁面說「你根本沒改」。
 *
 * 動態路由用 `("/courses/[slug]", "page")` 這個形式而不是拼真實 slug：
 * 改名時舊網址那一份也要打掉，拼字串只會清到新的那一個，
 * 舊網址會繼續從快取吐出已經不存在的頁面直到 300 秒過去。
 */
export function revalidateStorefront() {
  revalidatePath("/");
  revalidatePath("/courses");
  revalidatePath("/courses/[slug]", "page");
  revalidatePath("/workshops");
  revalidatePath("/workshops/[slug]", "page");
}

export function revalidateAdmin(productId?: string) {
  // 清單已經拆成兩頁，兩邊都要打掉 —— 一門線上課另開實體班的話它兩邊都在。
  revalidatePath("/admin/courses");
  revalidatePath("/admin/workshops");
  if (productId) revalidatePath(`/admin/products/${productId}`);
  revalidatePath("/admin");
}

export function liveMutationCtx(staff: Staff): MutationCtx {
  // 用到才建：原本的 action 是驗證通過之後才 createServiceClient()，
  // 環境變數壞掉時「先回驗證錯誤還是先回儲存失敗」的順序要跟以前一樣。
  let client: MutationCtx["db"] | null = null;
  return {
    get db() {
      client ??= createServiceClient();
      return client;
    },
    staff,
    audit: writeAudit,
    revalidate: (productId) => {
      revalidateAdmin(productId);
      revalidateStorefront();
    },
  };
}
