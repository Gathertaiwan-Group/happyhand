import { handleDiscovery } from "@/lib/mcp-oauth/http";

/** RFC 8414 authorization server metadata。沒開 OAuth 時 404（見 lib/mcp-oauth/http.ts）。 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return handleDiscovery(req, "as");
}
export const OPTIONS = GET;
