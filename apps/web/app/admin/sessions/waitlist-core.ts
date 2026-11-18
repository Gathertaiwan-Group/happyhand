import "server-only";
import { revalidatePath } from "next/cache";
import type { Staff } from "@/lib/admin/guard";
import { writeAudit } from "@/lib/admin/audit";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * 新增候補的本體（後台場次頁的表單與 MCP 的 add_waitlist_entry 共用）。
 *
 * 原本整段在 actions.ts 的 addWaitlistEntry 裡（FormData + redirect），2026-11-18 抽到這裡：
 *   · 後台 action ＝ requireCapability → FormData 轉欄位 → 呼叫這裡 → 把 outcome 變成原本的
 *     ?wl=<outcome> redirect。行為一字不變。
 *   · MCP ＝ 在統一的身分包裝裡 requireCapability → 呼叫這裡（多帶 dryRun／idempotencyKey）。
 *
 * 🔴 這個檔**不是** "use server"（理由同 app/admin/orders/account-core.ts）。
 *
 * ## 冪等（不開新表）
 * 跟 app/admin/products/mutations.ts 的 findCreatedByKey 同一招：建立成功時把 idempotency_key
 * 寫進那一筆 waitlist.create 稽核的 diff，同一個 key 再來就從稽核找回當初那一筆。
 * 只有 MCP 會帶 key；後台表單不帶，稽核 diff 跟以前一模一樣。
 * ⚠️ 殘餘空窗：insert 成功到稽核寫入之間的幾毫秒內重送，會多一筆（這張表沒有可以撞的唯一約束）。
 */

export type WaitlistInput = { name: string; phone: string; email: string; note: string };

export type AddWaitlistOutcome = "ok" | "missing" | "toolong" | "nosession" | "failed";

export type AddWaitlistResult = {
  outcome: AddWaitlistOutcome;
  /** 新建（或冪等重送時找回）的候補 id */
  id?: string | null;
  /** 同一個 idempotency_key 之前已經建過（這次沒有再建） */
  replayed?: boolean;
  /** dryRun：驗證都過了，但沒有寫入 */
  dryRun?: boolean;
  /** 驗證後實際會寫入的欄位（trim 過） */
  values?: { name: string; phone: string; email: string | null; note: string | null };
};

type Db = ReturnType<typeof createServiceClient>;

/** 找「這個 key 在這一場建過的候補」。找不到回 null。 */
export async function findWaitlistByKey(db: Db, sessionId: string, key: string): Promise<string | null> {
  const { data, error } = await db
    .from("audit_log")
    .select("entity_id")
    .eq("action", "waitlist.create")
    .eq("diff->>idempotency_key", key)
    .eq("diff->>session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return ((data as unknown as { entity_id: string | null } | null)?.entity_id ?? null) || null;
}

export async function addWaitlistCore(
  staff: Staff,
  sessionId: string,
  input: WaitlistInput,
  opts: { dryRun?: boolean; idempotencyKey?: string } = {},
): Promise<AddWaitlistResult> {
  const name = String(input.name ?? "").trim();
  const phone = String(input.phone ?? "").trim();
  const email = String(input.email ?? "").trim();
  const note = String(input.note ?? "").trim();

  if (!name || !phone) return { outcome: "missing" };
  if (name.length > 60 || phone.length > 40) return { outcome: "toolong" };

  const db = createServiceClient();

  const { data: session, error: sessionError } = await db
    .from("workshop_sessions")
    .select("id")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError || !session) return { outcome: "nosession" };

  const values = { name, phone, email: email || null, note: note || null };

  if (opts.idempotencyKey) {
    const existing = await findWaitlistByKey(db, sessionId, opts.idempotencyKey);
    if (existing) return { outcome: "ok", id: existing, replayed: true, dryRun: opts.dryRun === true, values };
  }
  if (opts.dryRun) return { outcome: "ok", dryRun: true, values };

  const { data, error } = await db
    .from("workshop_waitlist")
    .insert({
      session_id: sessionId,
      name,
      phone,
      email: email || null,
      note: note || null,
      status: "waiting",
      // MCP 機器身分（靜態 token）的 id 是空字串；created_by 有外鍵指向 auth.users，
      // 空字串會讓 uuid 轉型失敗。真人（後台、OAuth 負責人）的 id 一定非空，寫入值不變。
      created_by: staff.id || null,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // ⚠️ 只記 code 與 message，**不要**把 error 整包丟進 log。
    // 這支的 insert payload 是姓名＋電話＋Email；Postgres 的 check / not-null
    // 違規訊息會帶 `DETAIL: Failing row contains (…)`，PostgREST 會把它放進
    // error.details 一路傳回來 —— 整包記下去等於把客人個資寫進 Vercel log。
    console.error("[admin/sessions] 候補登記失敗", error.code, error.message);
    return { outcome: "failed" };
  }

  const id = (data as unknown as { id: string } | null)?.id ?? null;
  await writeAudit(staff, {
    action: "waitlist.create",
    entity: "waitlist",
    entityId: id,
    // 稽核摘要留姓名是刻意的：這張表就是要回答「誰在什麼時候登記了誰」。
    // 電話不放進 summary，需要時查 workshop_waitlist 本表。
    summary: `候補登記：${name}`,
    diff: {
      session_id: sessionId,
      has_email: Boolean(email),
      has_note: Boolean(note),
      // 只有 MCP 帶 key；後台表單的稽核 diff 跟以前一樣三個欄位。
      ...(opts.idempotencyKey ? { idempotency_key: opts.idempotencyKey } : {}),
    },
  });
  revalidateSession(sessionId);
  return { outcome: "ok", id, values };
}

/** 與 actions.ts 的 revalidateSession 相同的兩條路徑。 */
function revalidateSession(sessionId: string) {
  revalidatePath("/admin/sessions");
  revalidatePath(`/admin/sessions/${sessionId}`);
}
