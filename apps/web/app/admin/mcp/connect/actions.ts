"use server";

import { requireCapability, adminErrorMessage } from "@/lib/admin/guard";
import { writeAudit } from "@/lib/admin/audit";
import { currentOAuthBaseUrl } from "@/lib/mcp-oauth/base";
import {
  approvalRedirect,
  checkAuthorizeParams,
  clientHash,
  denialRedirect,
  mintCode,
  oauthEnabled,
  redirectDisplay,
  verifyConsentToken,
} from "@/lib/mcp-oauth/core";

/**
 * 同意頁按下「允許」／「拒絕」。
 *
 * **重新**驗一次全部：OAuth 開著、參數（client／redirect_uri 白名單／PKCE／resource）、
 * 真人 cookie 身分有 mcp:connect（只有負責人）、CSRF token（綁這位負責人＋這一組參數＋
 * 15 分鐘）。全部通過才簽出 5 分鐘的授權碼。
 *
 * 🔴 用真人的 cookie 身分（requireCapability），**不可以**包 runAsMachine。via 有值（機器
 *    身分）一律拒絕：AI 不能替自己授權新的連線。
 */
export async function decideMcpConnect(
  query: string,
  csrf: string,
  allow: boolean,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const secret = process.env.MCP_OAUTH_SECRET;
  if (!oauthEnabled(secret)) return { ok: false, message: "這個功能目前沒有開啟。" };
  if (typeof query !== "string" || query.length > 8192 || typeof csrf !== "string") {
    return { ok: false, message: "授權參數不正確，請回到 Claude／ChatGPT 重新連線。" };
  }

  let staff;
  try {
    staff = await requireCapability("mcp:connect");
  } catch (err) {
    return { ok: false, message: `只有負責人可以授權。${adminErrorMessage(err)}` };
  }
  if (staff.via || staff.caps || !staff.id) {
    return { ok: false, message: "只有負責人本人登入後台才能授權。" };
  }

  const base = await currentOAuthBaseUrl();
  const check = checkAuthorizeParams(query, secret, base);
  if (!check.ok) {
    return {
      ok: false,
      message: check.fatal ? check.message : "授權參數不正確，請回到 Claude／ChatGPT 重新連線。",
    };
  }
  if (!verifyConsentToken(csrf, staff.id, query, secret)) {
    return { ok: false, message: "這個授權畫面已經過期或不是由你開啟的，請重新整理頁面再試一次。" };
  }

  const host = redirectDisplay(check.req.redirectUri).host;
  if (!allow) {
    console.info(`[mcp-oauth] consent denied by=${staff.id}`);
    return { ok: true, url: denialRedirect(check.req, base) };
  }

  let epoch: number;
  try {
    const { readOAuthEpoch } = await import("@/lib/mcp-oauth/owner");
    epoch = await readOAuthEpoch(staff.id);
  } catch (err) {
    console.error("[mcp-oauth] 讀取撤銷版號失敗", err instanceof Error ? err.message : err);
    return { ok: false, message: "暫時無法完成授權，請稍後再試一次。" };
  }
  const code = mintCode(check.req, staff.id, epoch, secret);
  console.info(
    `[mcp-oauth] consent granted by=${staff.id} client=${JSON.stringify(check.req.client.client_name)} cid=${clientHash(check.req.client.client_id)} redirect_host=${host}`,
  );
  await writeAudit(staff, {
    action: "mcp.oauth_granted",
    entity: "staff",
    entityId: staff.id,
    summary: `負責人授權「${check.req.client.client_name}」透過 MCP 以自己的身分操作後台（授權後回到 ${host}，最長 90 天）`,
    diff: { client: check.req.client.client_name, cid: clientHash(check.req.client.client_id), redirect_host: host },
  });
  return { ok: true, url: approvalRedirect(check.req, code, base) };
}

/**
 * 「撤銷我的所有 AI 連線」：把這位負責人的撤銷版號加 1，他之前授權出去的所有 OAuth
 * token（claude.ai、手機 App、ChatGPT…）下一個請求就失效。靜態 MCP_TOKEN 不受影響。
 *
 * 🔴 只收真人 cookie 身分（via 有值一律拒絕）：AI 不能替負責人撤銷或操作這件事。
 */
export async function revokeMyMcpConnections(): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  let staff;
  try {
    staff = await requireCapability("mcp:connect");
  } catch (err) {
    return { ok: false, message: adminErrorMessage(err) };
  }
  if (staff.via || staff.caps || !staff.id) {
    return { ok: false, message: "只有負責人本人登入後台才能撤銷。" };
  }
  try {
    const { bumpOAuthEpoch } = await import("@/lib/mcp-oauth/owner");
    const epoch = await bumpOAuthEpoch(staff.id);
    await writeAudit(staff, {
      action: "mcp.oauth_revoked_all",
      entity: "staff",
      entityId: staff.id,
      summary: "負責人撤銷了自己所有的 AI（MCP OAuth）連線，之前授權的連接器都要重新連線",
      diff: { epoch },
    });
  } catch (err) {
    console.error("[mcp-oauth] 撤銷失敗", err instanceof Error ? err.message : err);
    return { ok: false, message: "撤銷失敗，請稍後再試；仍失敗請聯絡工程師換掉 MCP_OAUTH_SECRET。" };
  }
  return {
    ok: true,
    message: "已撤銷。之前連上的 Claude／ChatGPT 下一次使用時就會失效，要用的話請重新連線。若懷疑帳號外洩，請同時更換登入密碼（舊的登入狀態仍可能重新授權）。",
  };
}
