import { handleAuthorize } from "@/lib/mcp-oauth/http";

/** MCP OAuth 授權端點：登入檢查後轉到同意頁 /admin/mcp/connect（見 lib/mcp-oauth/http.ts）。 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return handleAuthorize(req);
}
