"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireCapability, adminErrorMessage, AdminAuthError } from "@/lib/admin/guard";
import { writeAudit } from "@/lib/admin/audit";
import { createServiceClient } from "@/lib/supabase/server";
import {
  SESSION_STATUS_LABEL,
  WAITLIST_STATUS_LABEL,
  toSessionStatus,
  toWaitlistStatus,
  type SessionStatus,
  type WaitlistStatus,
} from "./queries";
import { canTransitionSession, canTransitionWaitlist } from "./transitions";
import { addWaitlistCore } from "./waitlist-core";

/**
 * 場次報名管理的寫入動作。
 *
 * ⚠️ 每一支都自己呼叫一次 requireCapability()。
 *    app/admin/layout.tsx 的守衛只在 render 頁面時跑，
 *    server action 的 POST 不經過它 —— 少寫一行 = 任何登入者都能改。
 *
 * 回傳型別配合 components/admin/confirm-button.tsx：
 * 回 { error } 會顯示在按鈕下方，回 undefined 代表成功。
 * 刻意不 throw：throw 在 production build 會被 Next 轉成
 * 「An error occurred in the Server Components render」這種看不懂的字，
 * 好日子的員工看到只會再按一次。
 *
 * ⚠️ 這個檔案只能 export async function（`"use server"` 的限制）。
 *    狀態轉移白名單與檔名規則在 ./transitions.ts。
 */

export type ActionResult = { error?: string | null } | undefined;

function revalidateSession(sessionId: string) {
  revalidatePath("/admin/sessions");
  revalidatePath(`/admin/sessions/${sessionId}`);
}

/* --------------------------------------------------------------- 名額微調 */

/**
 * 微調某場次的已報名人數。
 *
 * 一律走 admin_adjust_seats() RPC，不自己 update：
 * 那支在函式裡 `select ... for update` 鎖住場次列再 clamp 到 [0, capacity]，
 * 從 JS 端做 read-then-write 的話兩個客服同時按就會少算一次；
 * 而且 workshop_sessions 上有 check (seats_taken <= capacity)，
 * 直接 update 撞到只會拿到一句 23514 的英文。
 */
export async function adjustSeats(sessionId: string, delta: number): Promise<ActionResult> {
  try {
    const staff = await requireCapability("sessions:status");

    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1) {
      return { error: "名額一次只能加減 1。" };
    }

    const db = createServiceClient();

    const { data: before, error: beforeError } = await db
      .from("workshop_sessions")
      .select("seats_taken, capacity, status")
      .eq("id", sessionId)
      .maybeSingle();
    if (beforeError) return { error: "讀取場次失敗，請重試一次。" };
    if (!before) return { error: "找不到這個場次。" };

    const { data, error } = await db.rpc("admin_adjust_seats", {
      p_session_id: sessionId,
      p_delta: delta,
    });
    if (error) {
      console.error("[admin/sessions] admin_adjust_seats 失敗", error.code, error.message);
      // 函式裡的 raise exception 用 PT404，message 已經是中文，可以直接顯示。
      return { error: error.message || "調整名額失敗，請重試一次。" };
    }

    // admin_adjust_seats 宣告 `returns public.workshop_sessions`（非 setof），
    // 實測 PostgREST 回的是單一物件。但 PostgREST 對內嵌／複合型別
    // 有時給物件有時給陣列，這裡跟 queries.ts 的 pickOne() 一樣做零成本保險。
    const raw = data as unknown;
    const after = (Array.isArray(raw) ? raw[0] : raw) as
      | { seats_taken: number; capacity: number; status: string }
      | null;
    const prev = before as unknown as { seats_taken: number; capacity: number; status: string };

    if (after && after.seats_taken === prev.seats_taken) {
      // RPC 會 clamp 到 [0, capacity]，超出範圍時它回原值而不報錯。
      // 這裡要把「按了沒事發生」翻成人話，不然使用者會一直按。
      return {
        error:
          delta > 0
            ? `已經達到名額上限 ${prev.capacity} 人，不能再加。`
            : "已經是 0 人，不能再減。",
      };
    }

    if (after) {
      await writeAudit(staff, {
        action: "session.adjust_seats",
        entity: "session",
        entityId: sessionId,
        summary: `場次已報名人數 ${prev.seats_taken} → ${after.seats_taken}（上限 ${after.capacity}）`,
        diff: {
          seats_taken: { from: prev.seats_taken, to: after.seats_taken },
          status: { from: prev.status, to: after.status },
        },
      });
    }

    revalidateSession(sessionId);
    return undefined;
  } catch (err) {
    console.error("[admin/sessions] adjustSeats 例外", err);
    return { error: adminErrorMessage(err) };
  }
}

/* --------------------------------------------------------------- 開關報名 */

export async function setSessionStatus(
  sessionId: string,
  next: SessionStatus,
): Promise<ActionResult> {
  try {
    const staff = await requireCapability("sessions:status");

    const target = toSessionStatus(next);
    if (target === "full") {
      return { error: "「已額滿」由系統依名額自動判定，不能手動設定。" };
    }

    const db = createServiceClient();

    const { data: before, error: beforeError } = await db
      .from("workshop_sessions")
      .select("status, seats_taken, capacity")
      .eq("id", sessionId)
      .maybeSingle();
    if (beforeError) return { error: "讀取場次失敗，請重試一次。" };
    if (!before) return { error: "找不到這個場次。" };

    const current = toSessionStatus((before as unknown as { status: string }).status);
    if (current === target) {
      return { error: `這個場次已經是「${SESSION_STATUS_LABEL[target]}」了。` };
    }
    if (!canTransitionSession(current, target)) {
      return {
        error: `不能從「${SESSION_STATUS_LABEL[current]}」改成「${SESSION_STATUS_LABEL[target]}」。`,
      };
    }

    // 帶上 .eq("status", current)：上面的白名單檢查是拿「幾毫秒前讀到的狀態」判的。
    // 沒有這個條件的話，A 讀到 open、B 中間把場次改成 cancelled、A 再寫入 closed，
    // 就會繞過 cancelled ⇸ closed 這條不存在的轉移，而且稽核會記成
    // 「open → closed」這種與事實不符的紀錄。
    const { data: after, error } = await db
      .from("workshop_sessions")
      .update({ status: target })
      .eq("id", sessionId)
      .eq("status", current)
      .select("status")
      .maybeSingle();
    if (error) {
      console.error("[admin/sessions] 更新場次狀態失敗", error.code, error.message);
      return { error: "更新場次狀態失敗，請重試一次。" };
    }
    if (!after) {
      return { error: "這個場次剛剛被其他同事改過了，請重新整理後再試。" };
    }

    // trigger 可能把 open 立刻改回 full（人數已滿），據實記錄落地的值。
    const landed = toSessionStatus((after as unknown as { status: string }).status);

    await writeAudit(staff, {
      action: "session.set_status",
      entity: "session",
      entityId: sessionId,
      summary: `場次狀態 ${SESSION_STATUS_LABEL[current]} → ${SESSION_STATUS_LABEL[landed]}`,
      diff: { status: { from: current, to: landed } },
    });

    revalidateSession(sessionId);
    return undefined;
  } catch (err) {
    console.error("[admin/sessions] setSessionStatus 例外", err);
    return { error: adminErrorMessage(err) };
  }
}

/* ----------------------------------------------------------------- 候補 */

/**
 * 候補登記。
 *
 * 這支是 `<form action={...}>` 直接呼叫的，回傳值沒有地方接
 * （要接就得把整個面板變成 client component 走 useActionState，
 * 那會為了一行錯誤訊息把 AdminField 整組拉進 client bundle）。
 * 所以結果用 redirect 帶一個短代碼回明細頁，由頁面翻成中文顯示。
 * 只帶代碼不帶訊息內文，網址列不會出現客人的姓名電話。
 */
export async function addWaitlistEntry(sessionId: string, formData: FormData): Promise<void> {
  let outcome = "ok";

  try {
    const staff = await requireCapability("waitlist:write");

    // 本體在 ./waitlist-core.ts（MCP 的 add_waitlist_entry 共用同一支）。
    const result = await addWaitlistCore(staff, sessionId, {
      name: String(formData.get("name") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      email: String(formData.get("email") ?? ""),
      note: String(formData.get("note") ?? ""),
    });
    outcome = result.outcome;
  } catch (err) {
    console.error("[admin/sessions] addWaitlistEntry 例外", err);
    // 只有真的是權限問題才說「你沒有權限」。
    // createServiceClient() 在環境變數沒設時也會 throw 到這裡，
    // 一律回 denied 的話員工會跑去找負責人改角色，但真正壞掉的是伺服器設定。
    outcome = err instanceof AdminAuthError ? "denied" : "failed";
  }

  // redirect() 是靠丟例外實作的，必須在 try/catch 外面呼叫，
  // 否則會被上面的 catch 吃掉變成「denied」。
  redirect(`/admin/sessions/${sessionId}?wl=${outcome}#waitlist`);
}

/* --------------------------------------------------------- 候補狀態轉移 */

export async function setWaitlistStatus(
  entryId: string,
  sessionId: string,
  next: WaitlistStatus,
): Promise<ActionResult> {
  try {
    const staff = await requireCapability("waitlist:write");

    const target = toWaitlistStatus(next);
    const db = createServiceClient();

    const { data: before, error: beforeError } = await db
      .from("workshop_waitlist")
      .select("id, name, status")
      .eq("id", entryId)
      .maybeSingle();
    if (beforeError) return { error: "讀取候補資料失敗，請重試一次。" };
    if (!before) return { error: "找不到這筆候補紀錄，可能已經被其他同事刪除。" };

    const row = before as unknown as { id: string; name: string; status: string };
    const current = toWaitlistStatus(row.status);

    if (current === target) {
      return { error: `這筆已經是「${WAITLIST_STATUS_LABEL[target]}」了。` };
    }
    if (!canTransitionWaitlist(current, target)) {
      return {
        error: `不能從「${WAITLIST_STATUS_LABEL[current]}」改成「${WAITLIST_STATUS_LABEL[target]}」。`,
      };
    }

    // 帶上 .eq("status", current)：兩個客服同時處理同一筆時，
    // 慢的那個會更新到 0 列而不是把快的那個蓋掉。
    const { data: updated, error } = await db
      .from("workshop_waitlist")
      .update({ status: target })
      .eq("id", entryId)
      .eq("status", current)
      .select("id")
      .maybeSingle();
    if (error) {
      console.error("[admin/sessions] 更新候補狀態失敗", error);
      return { error: "更新候補狀態失敗，請重試一次。" };
    }
    if (!updated) {
      return { error: "這筆候補剛剛被其他同事改過了，請重新整理後再試。" };
    }

    await writeAudit(staff, {
      action: "waitlist.set_status",
      entity: "waitlist",
      entityId: entryId,
      summary: `候補「${row.name}」${WAITLIST_STATUS_LABEL[current]} → ${WAITLIST_STATUS_LABEL[target]}`,
      diff: { status: { from: current, to: target }, session_id: sessionId },
    });

    revalidateSession(sessionId);
    return undefined;
  } catch (err) {
    console.error("[admin/sessions] setWaitlistStatus 例外", err);
    return { error: adminErrorMessage(err) };
  }
}
