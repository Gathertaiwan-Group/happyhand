import "server-only";
import { revalidatePath } from "next/cache";
import type { Staff } from "@/lib/admin/guard";
import { writeAudit } from "@/lib/admin/audit";
import { createServiceClient } from "@/lib/supabase/server";
import type { ChatMsg } from "@/lib/ai/chat-log";

/**
 * 小幫手諮詢紀錄：讀取清單、標記已處理／改回待處理的本體
 * （後台 /admin/inquiries 與 MCP 的 list_inquiries／mark_inquiry_* 共用）。
 *
 * 原本 setHandled 是 FormData + redirect 的 server action，MCP 拿不到結構化結果。
 * 2026-11-18 抽到這裡：後台 actions.ts 只剩權限檢查、FormData 轉換與 redirect，
 * 行為一字不變。
 *
 * 🔴 這個檔**不是** "use server"（理由同 app/admin/orders/account-core.ts）。
 */

export const INQUIRY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 與後台 ?msg= 代碼一一對應：ok → handled/reopened，其餘原樣。 */
export type SetHandledOutcome = { ok: true; id: string } | { ok: false; code: "bad_id" | "failed" };

/**
 * 標記已處理（handled=true）或改回待處理（false）。
 *
 * 例外（例如 service client 建不起來）一律往外丟，由呼叫端決定怎麼呈現
 * （後台原本的 catch 會把它變成 ?msg=denied）。
 */
export async function setInquiryHandledCore(
  staff: Staff,
  rawId: string,
  handled: boolean,
): Promise<SetHandledOutcome> {
  const id = String(rawId ?? "").trim();
  if (!INQUIRY_ID_RE.test(id)) return { ok: false, code: "bad_id" };

  const db = createServiceClient();
  if (!db) return { ok: false, code: "failed" };

  const { data, error } = await db
    .from("ai_chat_logs")
    .update({
      handled_at: handled ? new Date().toISOString() : null,
      // MCP 機器身分（靜態 token）的 id 是空字串，不是 auth.users 裡的人；handled_by 有外鍵，
      // 寫空字串會讓 uuid 轉型失敗。真人（後台、OAuth 負責人）的 id 一定非空，寫入值不變。
      handled_by: handled ? staff.id || null : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("id, contact_name, contact_email, session_id")
    .maybeSingle();

  if (error || !data) {
    console.error("[admin/inquiries] 更新失敗", error?.message);
    return { ok: false, code: "failed" };
  }

  await writeAudit(staff, {
    action: handled ? "inquiry.handled" : "inquiry.reopened",
    entity: "ai_chat_logs",
    entityId: data.id,
    // 🔴 摘要不寫 Email／電話：稽核紀錄的可見範圍跟諮詢紀錄不一樣
    //    （audit:read 是負責人、orders:read 是客服），
    //    把個資抄進稽核摘要等於繞過那道切分。
    summary: handled ? "標記諮詢已處理" : "把諮詢改回待處理",
  });

  revalidatePath("/admin/inquiries");
  revalidatePath("/admin");
  return { ok: true, id: data.id as string };
}

/* ================================================================ 讀取 */

/**
 * 給 MCP 的欄位：後台頁面**畫面上有顯示的**才給。
 * 🔴 頁面 select 了 user_ip、user_agent、handled_note、last_reply 但沒有顯示，這裡不給。
 */
const LIST_COLS =
  "id, created_at, contact_name, contact_email, contact_phone, contact_line, summary, first_question, intent, " +
  "has_contact, handled_at, message_count, messages";

export type InquiryView = "followup" | "handled" | "all";

export type InquiryRow = {
  id: string;
  created_at: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_line: string | null;
  summary: string | null;
  first_question: string | null;
  intent: string | null;
  has_contact: boolean;
  handled_at: string | null;
  message_count: number;
  messages: ChatMsg[];
};

/** 台北日期 YYYY-MM-DD → 那天 00:00（台北）的 ISO。格式不對回 null。 */
export function taipeiDayStart(day: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // 2026-02-31 這種日期 Date.UTC 會進位到 3 月，擋掉
  const back = new Date(utc);
  if (back.getUTCFullYear() !== Number(m[1]) || back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3])) {
    return null;
  }
  return new Date(utc - 8 * 60 * 60 * 1000).toISOString();
}

/**
 * 諮詢清單。followup（預設）＝後台「待跟進」同一個條件：has_contact 且 handled_at is null
 * （也就是 count_pending_inquiries() 的條件）。
 */
export async function loadInquiryList(
  db: ReturnType<typeof createServiceClient>,
  opts: { view: InquiryView; fromIso?: string | null; toIso?: string | null; limit: number },
): Promise<{ rows: InquiryRow[]; matched: number | null; pending: number | null }> {
  let q = db
    .from("ai_chat_logs")
    .select(LIST_COLS, { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(opts.limit);
  if (opts.view === "followup") q = q.eq("has_contact", true).is("handled_at", null);
  if (opts.view === "handled") q = q.not("handled_at", "is", null);
  if (opts.fromIso) q = q.gte("created_at", opts.fromIso);
  if (opts.toIso) q = q.lt("created_at", opts.toIso);

  const [{ data, error, count }, pending] = await Promise.all([q, db.rpc("count_pending_inquiries")]);
  if (error) throw new Error(error.message);
  return {
    rows: (data ?? []) as unknown as InquiryRow[],
    matched: typeof count === "number" ? count : null,
    pending: typeof pending.data === "number" ? pending.data : null,
  };
}

/** 單筆（預覽用）：只拿判斷與說明需要的欄位，不拿對話內容。 */
export async function loadInquiryBrief(
  db: ReturnType<typeof createServiceClient>,
  id: string,
): Promise<{ id: string; created_at: string; has_contact: boolean; handled_at: string | null; contact_name: string | null; summary: string | null; first_question: string | null } | null> {
  if (!INQUIRY_ID_RE.test(id)) return null;
  const { data, error } = await db
    .from("ai_chat_logs")
    .select("id, created_at, has_contact, handled_at, contact_name, summary, first_question")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as never) ?? null;
}
