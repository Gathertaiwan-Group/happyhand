import "server-only";
import {
  authenticateClient,
  authorizationServerMetadata,
  checkAuthorizeParams,
  clientIp,
  exchangeToken,
  OAUTH_CONSENT_PATH,
  OAuthError,
  oauthBaseUrl,
  oauthEnabled,
  protectedResourceMetadata,
  rateLimit,
  registerClient,
} from "@/lib/mcp-oauth/core";

/**
 * MCP OAuth 的 HTTP 端點。App Router 的 route.ts 都是一行轉進來：
 *
 *   GET  /.well-known/oauth-protected-resource[/api/mcp]     RFC 9728
 *   GET  /.well-known/oauth-authorization-server[/api/mcp]   RFC 8414
 *   POST /oauth/register                                     RFC 7591（公開、限流）
 *   POST /oauth/token                                        authorization_code／refresh_token
 *   POST /oauth/revoke                                       RFC 7009（無狀態，見 core.ts 檔頭）
 *   GET  /oauth/authorize                                    登入檢查 → 同意頁 /admin/mcp/connect
 *
 * 沒設 MCP_OAUTH_SECRET（或短於 32 字、或不是 Vercel production）→ 這些路徑一律 404，
 * 與加這個功能之前一模一樣。
 *
 * 🔴 不記 log 任何 token／code／secret／client_secret。錯誤只記 error code。
 */

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "600",
};

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

function notFound(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function oauthError(err: OAuthError): Response {
  const extra: Record<string, string> = {};
  if (err.status === 401) extra["www-authenticate"] = 'Basic realm="happyhands-oauth"';
  return json(err.status, { error: err.code, error_description: err.message }, extra);
}

function secret(): string | null {
  const s = process.env.MCP_OAUTH_SECRET;
  return oauthEnabled(s) ? s : null;
}

/* ------------------------------------------------------------------ discovery */

export function handleDiscovery(request: Request, which: "prm" | "as"): Response {
  if (!secret()) return notFound();
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  const base = oauthBaseUrl(request.url);
  return json(200, which === "prm" ? protectedResourceMetadata(base) : authorizationServerMetadata(base));
}

/* ------------------------------------------------------------------ 讀參數 */

/** RFC 6749 §3.2：參數不得重複。重複就整個拒絕，不猜要用哪一個。 */
function rejectDuplicates(p: URLSearchParams): URLSearchParams {
  for (const k of new Set(p.keys())) {
    if (p.getAll(k).length > 1) throw new OAuthError("invalid_request", `duplicate parameter: ${k}`);
  }
  return p;
}

async function readParams(request: Request): Promise<URLSearchParams> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  const text = await request.text();
  if (text.length > 16_384) throw new OAuthError("invalid_request", "request body too large");
  if (type.includes("application/json")) {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new OAuthError("invalid_request", "malformed JSON");
    }
    const p = new URLSearchParams();
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof v === "string") p.set(k, v);
      }
    }
    return p;
  }
  return rejectDuplicates(new URLSearchParams(text));
}

function preflight(request: Request): Response | null {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  return null;
}

/* ------------------------------------------------------------------ register */

export async function handleRegister(request: Request): Promise<Response> {
  const s = secret();
  if (!s) return notFound();
  const pre = preflight(request);
  if (pre) return pre;
  const ip = clientIp(request.headers);
  // 公開端點：每個 IP 10 分鐘 20 次。正常使用一個人一輩子註冊沒幾次。
  if (!rateLimit(`register:${ip}`, 20, 600)) {
    return json(429, { error: "rate_limited", error_description: "too many registrations" }, { "retry-after": "600" });
  }
  try {
    const text = await request.text();
    if (text.length > 8192) throw new OAuthError("invalid_client_metadata", "body too large");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OAuthError("invalid_client_metadata", "body must be JSON");
    }
    const client = registerClient(body, s);
    console.info(
      `[mcp-oauth] register ok name=${JSON.stringify(client.client_name)} method=${client.token_endpoint_auth_method} redirects=${JSON.stringify(client.redirect_uris)}`,
    );
    return json(201, {
      ...client,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp",
    });
  } catch (err) {
    return failure("/oauth/register", err);
  }
}

/* ------------------------------------------------------------------ token */

export async function handleToken(request: Request): Promise<Response> {
  const s = secret();
  if (!s) return notFound();
  const pre = preflight(request);
  if (pre) return pre;
  const ip = clientIp(request.headers);
  if (!rateLimit(`token:${ip}`, 60, 60)) {
    return json(429, { error: "rate_limited", error_description: "too many requests" }, { "retry-after": "60" });
  }
  try {
    const params = await readParams(request);
    const { lookupOAuthOwner } = await import("@/lib/mcp-oauth/owner");
    const tokens = await exchangeToken(
      params,
      request.headers.get("authorization"),
      s,
      oauthBaseUrl(request.url),
      async (userId, epoch) => (await lookupOAuthOwner(userId, epoch)) !== null,
    );
    console.info(`[mcp-oauth] token ok grant=${params.get("grant_type")}`);
    return json(200, tokens);
  } catch (err) {
    return failure("/oauth/token", err);
  }
}

/* ------------------------------------------------------------------ revoke */

export async function handleRevoke(request: Request): Promise<Response> {
  const s = secret();
  if (!s) return notFound();
  const pre = preflight(request);
  if (pre) return pre;
  const ip = clientIp(request.headers);
  if (!rateLimit(`revoke:${ip}`, 60, 60)) return json(429, { error: "rate_limited" });
  try {
    const params = await readParams(request);
    authenticateClient(params, request.headers.get("authorization"), s);
    // RFC 7009 §2.2：不論 token 存不存在都回 200。無狀態設計下這裡撤不掉任何東西 ——
    // 撤銷個人＝在後台把他改成不是負責人；全部撤銷＝換 MCP_OAUTH_SECRET（見 core.ts 檔頭）。
    return json(200, {});
  } catch (err) {
    return failure("/oauth/revoke", err);
  }
}

function failure(path: string, err: unknown): Response {
  if (err instanceof OAuthError) {
    console.warn(`[mcp-oauth] ${path} rejected: ${err.code}`);
    return oauthError(err);
  }
  console.error(`[mcp-oauth] ${path} failed: ${err instanceof Error ? err.name : "error"}`);
  return json(500, { error: "server_error" });
}

/* ------------------------------------------------------------------ authorize */

function htmlError(message: string, status = 400): Response {
  const esc = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>無法完成授權｜快樂手</title></head>` +
      `<body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;line-height:1.7;color:#333"><h1 style="font-size:1.25rem">無法完成授權</h1><p>${esc}</p></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        "x-frame-options": "DENY",
      },
    },
  );
}

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { location: url, "cache-control": "no-store" } });
}

/**
 * GET /oauth/authorize —— AS metadata 公布的授權端點。
 *
 * 為什麼不直接把同意頁放在這個網址：middleware 把未登入的人導去 /login 時**只帶 pathname、
 * 丟掉 query**（避免訂單編號之類出現在網址列）。OAuth 的參數全在 query 裡，直接讓
 * /admin/mcp/connect 被 middleware 擋下就會在登入後遺失。所以這裡先：
 *   1. 驗 client／redirect_uri（壞的只顯示錯誤，**不導回**＝不做 open redirect）；
 *      其他參數錯誤照 RFC 6749 導回 client。
 *   2. 沒登入 → /login?redirect=<同意頁＋完整 query>（login 表單用 safeRedirect，保留 query）。
 *   3. 已登入 → 同意頁。是不是負責人由同意頁的 requireCapability("mcp:connect") 決定。
 */
export async function handleAuthorize(request: Request): Promise<Response> {
  const s = secret();
  if (!s) return notFound();
  const url = new URL(request.url);
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  if (query.length > 8192) return htmlError("授權參數太長，已拒絕。");
  const base = oauthBaseUrl(request.url);
  const check = checkAuthorizeParams(query, s, base);
  if (!check.ok && check.fatal) return htmlError(check.message);
  if (!check.ok) return redirect(check.redirectUrl);

  const consent = `${OAUTH_CONSENT_PATH}?${query}`;
  let loggedIn = false;
  try {
    const { createClient, hasSupabaseEnv } = await import("@/lib/supabase/server");
    if (hasSupabaseEnv()) {
      const supabase = await createClient();
      const { data } = await supabase.auth.getUser();
      loggedIn = !!data.user;
    }
  } catch {
    loggedIn = false;
  }
  if (!loggedIn) return redirect(`/login?redirect=${encodeURIComponent(consent)}`);
  return redirect(consent);
}
