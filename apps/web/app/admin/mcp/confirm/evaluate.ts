import "server-only";
import { checkCapability, getStaff, type Staff } from "@/lib/admin/guard";
import { createServiceClient } from "@/lib/supabase/server";
import {
  envSecret,
  stateMatches,
  verifyToken,
  VERIFY_FAILURE_MESSAGE,
  type TokenPayload,
} from "@/lib/admin/mcp-token";
import {
  APPROVAL_TOOLS,
  isApprovalTool,
  type ApprovalTool,
  type Snapshot,
} from "@/lib/admin/mcp-requests";

/**
 * 確認頁與確認動作共用的檢查。頁面 render 時跑一次，按下確認的 server action
 * 再從頭跑一次 —— 兩次之間可能隔了二十分鐘，狀態隨時會變。
 *
 * 順序：
 *   1. 驗簽、驗用途、驗到期（沒過就不碰資料庫）
 *   2. 工具名稱必須在白名單內
 *   3. 目前登入者有沒有那支 action 需要的能力（action 自己也會擋，這裡先擋是為了
 *      訊息清楚，也避免沒權限的人看到摘要）
 *   4. 重讀資料庫做預檢，算出目前的狀態指紋
 *   5. 與 token 記錄的指紋逐字比對
 *
 * 🔴 這裡**不呼叫 runAsMachine**。getStaff() 讀的是按下確認那個人的 cookie。
 */

export type Evaluation =
  | { ok: false; message: string }
  | {
      ok: true;
      tool: ApprovalTool;
      payload: TokenPayload;
      snap: Extract<Snapshot, { ok: true }>;
      staff: Staff;
    };

export async function evaluateApproval(token: string | null | undefined): Promise<Evaluation> {
  const v = verifyToken(envSecret(), token, "approve");
  if (!v.ok) return { ok: false, message: VERIFY_FAILURE_MESSAGE[v.reason] };

  const tool = v.payload.tool;
  if (!isApprovalTool(tool)) {
    return { ok: false, message: "這個請求的操作不在可確認的清單內，已拒絕。" };
  }
  const def = APPROVAL_TOOLS[tool];

  const staff = await checkCapability(def.capability);
  if (!staff) {
    const who = await getStaff();
    return {
      ok: false,
      message: who
        ? "你的帳號沒有執行這個操作的權限，請改由有權限的同事（例如負責人）開啟這個連結。"
        : "請先登入後台。",
    };
  }
  // 機器身分不能自己確認自己提出的請求。正常情況下這裡不可能是 mcp
  // （確認頁不在 runAsMachine 裡），這行是防未來有人把它包進去。
  if (staff.via === "mcp") {
    return { ok: false, message: "這個操作必須由管理員本人確認。" };
  }

  let snap: Snapshot;
  try {
    snap = await def.snapshot(createServiceClient(), v.payload.args);
  } catch (err) {
    console.error("[mcp/confirm] 預檢例外", tool, err);
    return { ok: false, message: "讀取資料失敗，請重新整理後再試一次。" };
  }
  if (!snap.ok) {
    return { ok: false, message: `目前不能執行：${snap.error}` };
  }

  const fresh = stateMatches(v.payload, snap.state);
  if (!fresh.ok) return { ok: false, message: fresh.message };

  return { ok: true, tool, payload: v.payload, snap, staff };
}
