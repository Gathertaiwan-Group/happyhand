import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import type { Staff } from "@/lib/admin/guard";

/**
 * 後台稽核紀錄。
 *
 * 為什麼是應用層顯式呼叫而不是 DB trigger：
 * 後台一律以 service role 寫入，trigger 裡的 auth.uid() 是 null，
 * 記出來的會是「有人改了某一列」而不是「王小明把 HH-… 標成已收款」。
 * 對客服糾紛來說前者沒有用。
 *
 * 代價：漏寫 writeAudit() 就沒紀錄。每一支有寫入的 server action 都要記得呼叫。
 */

export type AuditInput = {
  /** 動詞，用 `實體.動作`，例如 order.mark_paid、product.publish、staff.invite */
  action: string;
  /** 實體種類，例如 order / product / session / staff */
  entity: string;
  entityId?: string | null;
  /** 給人看的一句話，會直接顯示在 /admin/audit */
  summary: string;
  /** 給機器看的前後值，只放真的有變動的欄位 */
  diff?: Record<string, unknown> | null;
};

/**
 * 寫一筆稽核。
 *
 * ⚠️ 刻意永不 throw：業務操作已經成功了，不該因為稽核寫失敗就對使用者報錯
 *    （那會讓人以為操作沒生效而重按一次）。失敗時大聲 console.error，
 *    Vercel 的 log 撈得到。
 */
export async function writeAudit(staff: Staff, input: AuditInput): Promise<void> {
  try {
    const supabase = createServiceClient();
    const { error } = await supabase.from("audit_log").insert({
      /*
        🔴 空字串要寫成 null。actor_id 有 FK 指向 auth.users，而機器身分
           （MCP）不是一個人、沒有帳號。塞假值會違反外鍵，而這支刻意永不
           throw —— 結果會是「退款成功但稽核完全沒留下」。
      */
      actor_id: staff.id === "" ? null : staff.id,
      actor_email: staff.email,
      // 機器做的就寫 "mcp"，稽核頁才分得出來是人按的還是 AI 按的。
      actor_role: staff.via ?? staff.role,
      action: input.action,
      entity: input.entity,
      entity_id: input.entityId ?? null,
      summary: input.summary,
      diff: input.diff ?? null,
    });
    if (error) {
      console.error("[audit] 寫入失敗", input.action, error.message);
    }
  } catch (err) {
    console.error("[audit] 寫入例外", input.action, err);
  }
}

/**
 * 算出 before/after 之間真正有變動的欄位。
 * 用來餵 AuditInput.diff —— 整包塞進去會讓稽核頁充滿沒變的欄位。
 */
export function diffOf<T extends Record<string, unknown>>(
  before: T | null | undefined,
  after: T,
  fields: readonly (keyof T)[],
): Record<string, { from: unknown; to: unknown }> | null {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of fields) {
    const from = before?.[f];
    const to = after[f];
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      out[String(f)] = { from: from ?? null, to: to ?? null };
    }
  }
  return Object.keys(out).length ? out : null;
}
