"use server";

import { revalidatePath } from "next/cache";
import { requireCapability, adminErrorMessage } from "@/lib/admin/guard";
import { dismissMcpRequest } from "@/lib/admin/mcp-pending-repo";
import type { McpRequestKind } from "@/lib/admin/mcp-pending";

/**
 * 後台「不處理，關閉申請」（AI 透過 MCP 提出的退款／作廢發票申請）。
 *
 * 🔴 用真人的 cookie 身分（requireCapability），**不要**包 runAsMachine：
 *    關閉紀錄要記下是哪一位負責人按的，而且 mcp:requests 只有負責人有、
 *    MCP 的機器身分沒有 —— AI 不能自己把申請關掉。
 *
 * 要「處理」申請不在這裡：負責人用訂單頁原本的「退款」「已在後台退過款」
 * 「作廢發票」按鈕，狀態一變申請就自動不算待處理。
 */
export async function dismissMcpRequestAction(
  orderId: string,
  kind: McpRequestKind,
): Promise<{ error?: string | null; ok?: string | null }> {
  let staff;
  try {
    staff = await requireCapability("mcp:requests");
  } catch (err) {
    return { error: adminErrorMessage(err) };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId) || (kind !== "refund" && kind !== "invoice_void")) {
    return { error: "參數不正確。" };
  }

  const result = await dismissMcpRequest(staff, orderId, kind);
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin");
  return "ok" in result ? { ok: result.ok } : { error: result.error };
}
