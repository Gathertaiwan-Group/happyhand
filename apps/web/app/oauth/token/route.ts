import { handleToken } from "@/lib/mcp-oauth/http";

/** MCP OAuth：見 lib/mcp-oauth/http.ts。沒開 OAuth 時 404。 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handleToken(req);
}
export const OPTIONS = POST;
