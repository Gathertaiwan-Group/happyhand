"use server";

import { writeAudit } from "@/lib/admin/audit";
import { APPROVAL_TOOLS, type ActionOutcome } from "@/lib/admin/mcp-requests";
import { evaluateApproval } from "./evaluate";

/**
 * 管理員本人按下「確認執行」。
 *
 * 🔴 不包 runAsMachine：getStaff() 讀的是按下按鈕那個人的 cookie，原本的
 *    action 會用他的身分 requireCapability、用他的身分寫稽核。
 *    「AI 提出、某某人按的」這件事由下面那筆 mcp.confirmed 補上。
 *
 * 檢查全部重跑一次（evaluateApproval），不信任頁面 render 時的結果：
 * 頁面開著二十分鐘，中間訂單可能已經被別人處理過。
 */

export type ConfirmState = { error?: string | null; ok?: string | null; done?: boolean } | null;

/** Next 的 redirect() 靠丟例外實作（deleteProduct 成功後會 redirect）。 */
function isRedirect(err: unknown): boolean {
  const digest = (err as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

export async function confirmMcpRequest(
  _prev: ConfirmState,
  formData: FormData,
): Promise<ConfirmState> {
  const token = String(formData.get("t") ?? "");
  const ev = await evaluateApproval(token);
  if (!ev.ok) return { error: ev.message };

  const def = APPROVAL_TOOLS[ev.tool];

  // 目前只有作廢發票吃本人填的值。原因由本人在表單上確認／修改，
  // 不直接採用 AI 寫進 token 的那一句。
  const input: { reason?: string } = {};
  if (ev.tool === "void_invoice") {
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) return { error: "請填寫作廢原因。" };
    if (reason.length > 20) return { error: "作廢原因請在 20 字以內。" };
    input.reason = reason;
  }

  const audit = (result: string) =>
    writeAudit(ev.staff, {
      action: "mcp.confirmed",
      entity: ev.snap.entity,
      entityId: ev.snap.entityId,
      summary: `${ev.staff.email ?? "管理員"} 確認了 AI 透過 MCP 提出的「${def.title}」：${ev.snap.ref}（${result}）`,
      diff: { tool: ev.tool, nonce: ev.payload.nonce, requested_at: new Date(ev.payload.iat * 1000).toISOString() },
    });

  let out: ActionOutcome;
  try {
    out = await def.execute(ev.payload.args, ev.snap, input);
  } catch (err) {
    if (isRedirect(err)) {
      // 成功後的導轉（刪除課程）。先留稽核再放行。
      await audit("已執行");
      throw err;
    }
    console.error("[mcp/confirm] 執行例外", ev.tool, err);
    await audit("執行時發生例外");
    return { error: "執行時發生未預期的錯誤。請到對應頁面確認目前狀態後再決定要不要重試。" };
  }

  if (out && out.error) {
    await audit(`結果：${out.error}`);
    // 不鎖按鈕：錯誤可能是暫時的（金流逾時）。再按一次會從頭重新檢查，
    // 若其實已經改到一半（例如狀態已變），狀態比對會擋下來。
    return { error: out.error };
  }
  await audit("已執行");
  return { ok: (out && out.ok) || "已執行完成。", done: true };
}
