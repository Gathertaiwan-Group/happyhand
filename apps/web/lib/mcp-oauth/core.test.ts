/**
 * MCP OAuth 的單元測試：lib/mcp-oauth/core.ts（簽章、PKCE、過期、redirect_uri 白名單、
 * resource、token 交換的角色閘門、/api/mcp 的 bearer 判斷）與 lib/admin/machine.ts 的
 * OAuth 身分（caps 交集、永遠不含 staff:manage、MCP_ACTOR 代換）。
 *
 * 正式站不跑完整授權流程（要負責人本人登入），所以全部在這裡用本機假資料跑。
 *
 * 跑法（repo 根目錄；server-only 換成空模組）：
 *
 *   echo "" > /tmp/empty.js
 *   node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     apps/web/lib/mcp-oauth/core.test.ts --bundle --platform=node --format=cjs \
 *     --alias:@=./apps/web --alias:server-only=/tmp/empty.js \
 *     --external:@opentelemetry/api --outfile=/tmp/mcp-oauth.test.cjs
 *   node --test /tmp/mcp-oauth.test.cjs
 */
import { test } from "node:test";
// 不在 Vercel 時 OAuth 預設關閉，測試要明確打開（見 core.ts 的 oauthEnabled）。
process.env.MCP_OAUTH_DEV = "1";
delete process.env.VERCEL_ENV;
import assert from "node:assert/strict";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  authorizationServerMetadata,
  bearerChallenge,
  checkAuthorizeParams,
  classifyMcpBearer,
  CODE_TTL_SECONDS,
  consentToken,
  exchangeToken,
  mintCode,
  OAuthError,
  oauthBaseUrl,
  oauthEnabled,
  pkceChallengeFor,
  PRODUCTION_ORIGIN,
  protectedResourceMetadata,
  redirectUriAllowed,
  REFRESH_ABSOLUTE_MAX_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  registerClient,
  resourceFor,
  seal,
  TOKEN_PREFIX,
  unseal,
  verifyAccessToken,
  verifyClientId,
  verifyConsentToken,
  __TEST_ONLY__,
  type AccessPayload,
  type AuthorizeRequest,
} from "@/lib/mcp-oauth/core";
import {
  MCP_ACTOR,
  currentMcpActor,
  oauthOwnerActor,
  resolveMcpActor,
  runAsMachine,
  runMcpRequest,
} from "@/lib/admin/machine";
import { checkCapability } from "@/lib/admin/guard";

const SECRET = "test-oauth-secret-不是正式站的-0123456789abcdef";
const OTHER_SECRET = "another-oauth-secret-0123456789abcdef-xyz";
const BASE = PRODUCTION_ORIGIN;
const NOW = 1_800_000_000;
const OWNER = "11111111-2222-4333-8444-555555555555";
const VERIFIER = "v".repeat(20) + "-._~" + "A1b2C3d4E5f6G7h8I9j0K1l2";
const CHALLENGE = pkceChallengeFor(VERIFIER);
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

const yes = async () => true;
const no = async () => false;

function client(redirects = [CLAUDE_CB], method: string = "none") {
  return registerClient(
    { client_name: "Claude", redirect_uris: redirects, token_endpoint_auth_method: method },
    SECRET,
    NOW,
  );
}

function authorizeQuery(clientId: string, over: Record<string, string | null> = {}): string {
  const p = new URLSearchParams();
  const base: Record<string, string | null> = {
    client_id: clientId,
    redirect_uri: CLAUDE_CB,
    response_type: "code",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "xyz",
    scope: "mcp",
    resource: resourceFor(BASE),
    ...over,
  };
  for (const [k, v] of Object.entries(base)) if (v !== null) p.set(k, v);
  return p.toString();
}

function authorizedReq(clientId: string): AuthorizeRequest {
  const c = checkAuthorizeParams(authorizeQuery(clientId), SECRET, BASE);
  assert.ok(c.ok);
  return c.req;
}

function tokenParams(o: Record<string, string>): URLSearchParams {
  return new URLSearchParams(o);
}

async function codeFlow(now = NOW) {
  __TEST_ONLY__.resetUsedCodes();
  const c = client();
  const code = mintCode(authorizedReq(c.client_id), OWNER, 0, SECRET, now);
  const tokens = await exchangeToken(
    tokenParams({
      grant_type: "authorization_code",
      code,
      client_id: c.client_id,
      redirect_uri: CLAUDE_CB,
      code_verifier: VERIFIER,
      resource: resourceFor(BASE),
    }),
    null,
    SECRET,
    BASE,
    yes,
    now,
  );
  return { c, code, tokens };
}

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof OAuthError && e.code === code);
}

/* ------------------------------------------------------------ 開關與 metadata */

test("OAuth 開關：secret 太短、沒設、Vercel Preview、非 Vercel 沒設 MCP_OAUTH_DEV=1 一律關閉", () => {
  assert.equal(oauthEnabled(undefined, "", "1"), false);
  assert.equal(oauthEnabled("short", "", "1"), false);
  assert.equal(oauthEnabled(SECRET, "", "1"), true);
  assert.equal(oauthEnabled(SECRET, "", ""), false, "本機預設關閉");
  assert.equal(oauthEnabled(SECRET, "production", ""), true);
  assert.equal(oauthEnabled(SECRET, "preview", "1"), false);
  assert.equal(oauthEnabled(SECRET, "development", "1"), false);
});

test("base URL 不信任 Host：只有 http://localhost 用請求 origin，其他一律正式站", () => {
  assert.equal(oauthBaseUrl("https://evil.example/api/mcp"), PRODUCTION_ORIGIN);
  assert.equal(oauthBaseUrl("https://www.happyhands.com.tw/api/mcp"), PRODUCTION_ORIGIN);
  assert.equal(oauthBaseUrl("https://localhost/api/mcp"), PRODUCTION_ORIGIN);
  assert.equal(oauthBaseUrl("http://localhost:3000/api/mcp"), "http://localhost:3000");
  assert.equal(oauthBaseUrl("garbage"), PRODUCTION_ORIGIN);
});

test("metadata：resource＝/api/mcp、只收 S256、沒宣告 CIMD（Claude 走 DCR）", () => {
  const prm = protectedResourceMetadata(BASE);
  assert.equal(prm.resource, "https://happyhands.com.tw/api/mcp");
  assert.deepEqual(prm.authorization_servers, [BASE]);
  const as = authorizationServerMetadata(BASE);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.registration_endpoint, `${BASE}/oauth/register`);
  assert.equal("client_id_metadata_document_supported" in as, false);
  assert.match(
    bearerChallenge(BASE),
    /^Bearer resource_metadata="https:\/\/happyhands\.com\.tw\/\.well-known\/oauth-protected-resource"$/,
  );
});

/* ------------------------------------------------------------ redirect_uri */

test("redirect_uri 白名單：claude.ai、ChatGPT、loopback（任意 port）放行", () => {
  for (const ok of [
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com/connector/oauth/abc_DEF-123",
    "http://localhost:3118/callback",
    "http://localhost/callback",
    "http://127.0.0.1:54321/callback",
    "http://127.0.0.1/callback",
  ]) {
    assert.equal(redirectUriAllowed(ok), true, ok);
  }
});

test("🔴 redirect_uri 白名單：繞過手法一律拒絕", () => {
  for (const bad of [
    "https://claude.ai/api/mcp/auth_callback/../../evil",
    "https://claude.ai/api/mcp/auth_callback?x=1",
    "https://claude.ai.evil.com/api/mcp/auth_callback",
    "https://evil.com/api/mcp/auth_callback",
    "http://claude.ai/api/mcp/auth_callback",
    "https://chatgpt.com/connector/oauth/abc/../../evil",
    "https://chatgpt.com/connector/oauth/abc?next=https://evil.com",
    "https://chatgpt.com/connector/oauth/",
    "https://chatgpt.com/other",
    "https://localhost:3000/callback",
    "http://localhost:1234@evil.com/callback",
    "http://localhost.evil.com/callback",
    "http://127.0.0.1.nip.io/callback",
    "http://[::1]:3000/callback",
    "http://localhost:3000/callback#frag",
    "http://user:pw@localhost:3000/callback",
    "javascript:alert(1)",
    "",
    "x".repeat(600),
  ]) {
    assert.equal(redirectUriAllowed(bad), false, bad);
  }
  assert.throws(() => registerClient({ redirect_uris: ["https://evil.com/cb"] }, SECRET), OAuthError);
  assert.throws(() => registerClient({ redirect_uris: [] }, SECRET), OAuthError);
});

test("authorize：redirect_uri 不是註冊時那一個 → fatal（不導回，避免 open redirect）", () => {
  const c = client(["http://localhost:1111/callback"]);
  const r = checkAuthorizeParams(authorizeQuery(c.client_id, { redirect_uri: CLAUDE_CB }), SECRET, BASE);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.fatal, true);
  // 偽造／別把 secret 簽的 client_id 也是 fatal
  const forged = checkAuthorizeParams(authorizeQuery(c.client_id + "x"), SECRET, BASE);
  assert.equal(!forged.ok && forged.fatal, true);
  const other = registerClient({ redirect_uris: [CLAUDE_CB] }, OTHER_SECRET);
  const o = checkAuthorizeParams(authorizeQuery(other.client_id), SECRET, BASE);
  assert.equal(!o.ok && o.fatal, true);
});

/* ------------------------------------------------------------ PKCE／resource／scope */

test("🔴 authorize：PKCE 必填且只收 S256；resource 必須是這支 MCP", () => {
  const c = client();
  const cases: Record<string, string | null>[] = [
    { code_challenge_method: "plain" },
    { code_challenge_method: null },
    { code_challenge: null },
    { code_challenge: "short" },
    { resource: "https://evil.com/api/mcp" },
    { resource: "https://happyhands.com.tw/api/other" },
    { scope: "admin" },
    { response_type: "token" },
  ];
  for (const over of cases) {
    const r = checkAuthorizeParams(authorizeQuery(c.client_id, over), SECRET, BASE);
    assert.equal(r.ok, false, JSON.stringify(over));
    // 這些錯誤導回的一定是註冊過的 redirect_uri
    assert.ok(!r.ok && !r.fatal && r.redirectUrl.startsWith(CLAUDE_CB + "?"), JSON.stringify(over));
  }
  // 沒帶 resource、帶結尾斜線都可以
  assert.ok(checkAuthorizeParams(authorizeQuery(c.client_id, { resource: null }), SECRET, BASE).ok);
  assert.ok(checkAuthorizeParams(authorizeQuery(c.client_id, { resource: resourceFor(BASE) + "/" }), SECRET, BASE).ok);
});

test("🔴 token：PKCE verifier 錯、redirect_uri 不同、resource 不同、別的 client → invalid_grant／invalid_target", async () => {
  __TEST_ONLY__.resetUsedCodes();
  const c = client();
  const other = client(["http://localhost:9/callback"]);
  const code = () => mintCode(authorizedReq(c.client_id), OWNER, 0, SECRET, NOW);
  const base = {
    grant_type: "authorization_code",
    client_id: c.client_id,
    redirect_uri: CLAUDE_CB,
    code_verifier: VERIFIER,
  };
  await rejects(exchangeToken(tokenParams({ ...base, code: code(), code_verifier: "w".repeat(43) }), null, SECRET, BASE, yes, NOW), "invalid_grant");
  await rejects(exchangeToken(tokenParams({ ...base, code: code(), code_verifier: "" }), null, SECRET, BASE, yes, NOW), "invalid_grant");
  await rejects(exchangeToken(tokenParams({ ...base, code: code(), redirect_uri: "http://localhost:1/callback" }), null, SECRET, BASE, yes, NOW), "invalid_grant");
  await rejects(exchangeToken(tokenParams({ ...base, code: code(), resource: "https://evil.com/api/mcp" }), null, SECRET, BASE, yes, NOW), "invalid_target");
  await rejects(exchangeToken(tokenParams({ ...base, code: code(), client_id: other.client_id }), null, SECRET, BASE, yes, NOW), "invalid_grant");
  await rejects(exchangeToken(tokenParams({ ...base, code: code(), client_id: "hhc1.forged.sig" }), null, SECRET, BASE, yes, NOW), "invalid_client");
});

/* ------------------------------------------------------------ 簽章、過期、跨用途 */

test("happy path：授權碼 → access＋refresh；access 1 小時、refresh 30 天", async () => {
  const { tokens } = await codeFlow();
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.expires_in, ACCESS_TOKEN_TTL_SECONDS);
  assert.equal(ACCESS_TOKEN_TTL_SECONDS, 3600);
  assert.equal(REFRESH_TOKEN_TTL_SECONDS, 30 * 86400);
  assert.equal(REFRESH_ABSOLUTE_MAX_SECONDS, 90 * 86400);
  const at = verifyAccessToken(tokens.access_token, SECRET, BASE, NOW + 10);
  assert.equal(at?.sub, OWNER);
  assert.equal(verifyAccessToken(tokens.access_token, SECRET, BASE, NOW + 3600), null, "1 小時後過期");
  const rt = unseal<{ exp: number }>("refresh", tokens.refresh_token, SECRET, NOW);
  assert.equal(rt?.exp, NOW + REFRESH_TOKEN_TTL_SECONDS);
});

test("🔴 授權碼：5 分鐘過期、同一 instance 只能用一次", async () => {
  const { c, code } = await codeFlow();
  const params = {
    grant_type: "authorization_code",
    code,
    client_id: c.client_id,
    redirect_uri: CLAUDE_CB,
    code_verifier: VERIFIER,
  };
  await rejects(exchangeToken(tokenParams(params), null, SECRET, BASE, yes, NOW + 1), "invalid_grant");
  __TEST_ONLY__.resetUsedCodes();
  await rejects(exchangeToken(tokenParams(params), null, SECRET, BASE, yes, NOW + CODE_TTL_SECONDS), "invalid_grant");
});

test("🔴 token 偽造與跨用途：竄改、換 secret、refresh 當 access、code 當 access 都不行", async () => {
  const { tokens, code } = await codeFlow();
  const t = tokens.access_token;
  const ch = t.at(-3)!;
  const flipped = t.slice(0, -3) + (ch === "A" ? "B" : "A") + t.slice(-2);
  assert.notEqual(flipped, t);
  assert.equal(verifyAccessToken(flipped, SECRET, BASE, NOW), null);
  assert.equal(verifyAccessToken(t, OTHER_SECRET, BASE, NOW), null, "換 MCP_OAUTH_SECRET＝全部作廢");
  const asAccess = TOKEN_PREFIX.access + tokens.refresh_token.slice(TOKEN_PREFIX.refresh.length);
  assert.equal(verifyAccessToken(asAccess, SECRET, BASE, NOW), null, "refresh 改前綴當 access：AAD 不同解不開");
  const codeAsAccess = TOKEN_PREFIX.access + code.slice(TOKEN_PREFIX.code.length);
  assert.equal(verifyAccessToken(codeAsAccess, SECRET, BASE, NOW), null);
  // 本機（localhost aud）簽出的 token 拿到正式站不收
  const local = verifyAccessToken(t, SECRET, "http://localhost:3000", NOW);
  assert.equal(local, null);
  // 自己用同一把 key 簽一張「超長效期」的 access（金鑰外洩情境）也被 TTL 上限擋下
  const forged: AccessPayload = { exp: NOW + 86400 * 365, iat: NOW, sub: OWNER, cid: "x", sc: "mcp", aud: resourceFor(BASE), ep: 0 };
  assert.equal(verifyAccessToken(seal("access", forged, SECRET), SECRET, BASE, NOW), null);
});

test("refresh：輪替出新 token；90 天封頂；別的 client 不能用", async () => {
  const { c, tokens } = await codeFlow();
  const r1 = await exchangeToken(
    tokenParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: c.client_id }),
    null, SECRET, BASE, yes, NOW + 100,
  );
  assert.notEqual(r1.refresh_token, tokens.refresh_token);
  // 一路 refresh 到第 89 天：新 refresh 的到期日不超過 at0+90 天
  const late = NOW + 89 * 86400;
  const lateRt = seal("refresh", { exp: late + 100, iat: late, sub: OWNER, cid: unseal<{ exp: number; cid: string }>("refresh", tokens.refresh_token, SECRET, NOW)!.cid, sc: "mcp", aud: resourceFor(BASE), at0: NOW, jti: "j", ep: 0 }, SECRET);
  const r2 = await exchangeToken(tokenParams({ grant_type: "refresh_token", refresh_token: lateRt, client_id: c.client_id }), null, SECRET, BASE, yes, late);
  const exp2 = unseal<{ exp: number }>("refresh", r2.refresh_token, SECRET, late)!.exp;
  assert.equal(exp2, NOW + REFRESH_ABSOLUTE_MAX_SECONDS);
  await rejects(exchangeToken(tokenParams({ grant_type: "refresh_token", refresh_token: lateRt, client_id: c.client_id }), null, SECRET, BASE, yes, NOW + REFRESH_ABSOLUTE_MAX_SECONDS), "invalid_grant");
  const other = client(["http://localhost:9/callback"]);
  await rejects(exchangeToken(tokenParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: other.client_id }), null, SECRET, BASE, yes, NOW + 100), "invalid_grant");
});

test("confidential client：secret 錯不行；client_secret_basic 必須走 Basic", async () => {
  const c = client([CLAUDE_CB], "client_secret_post");
  assert.ok(c.client_secret);
  __TEST_ONLY__.resetUsedCodes();
  const code = mintCode(authorizedReq(c.client_id), OWNER, 0, SECRET, NOW);
  const base = { grant_type: "authorization_code", code, client_id: c.client_id, redirect_uri: CLAUDE_CB, code_verifier: VERIFIER };
  await rejects(exchangeToken(tokenParams({ ...base, client_secret: "wrong" }), null, SECRET, BASE, yes, NOW), "invalid_client");
  const ok = await exchangeToken(tokenParams({ ...base, client_secret: c.client_secret! }), null, SECRET, BASE, yes, NOW);
  assert.ok(ok.access_token);
  assert.equal(verifyClientId(c.client_id, OTHER_SECRET), null);
});

/* ------------------------------------------------------------ 角色閘門 */

test("🔴 非負責人拿不到 token；角色被拔掉後 refresh 立刻失效", async () => {
  __TEST_ONLY__.resetUsedCodes();
  const c = client();
  const code = mintCode(authorizedReq(c.client_id), OWNER, 0, SECRET, NOW);
  const params = { grant_type: "authorization_code", code, client_id: c.client_id, redirect_uri: CLAUDE_CB, code_verifier: VERIFIER };
  await rejects(exchangeToken(tokenParams(params), null, SECRET, BASE, no, NOW), "invalid_grant");
  // 查詢出錯：fail closed（throw，不發 token），而且碼沒被燒掉，可以重試
  await assert.rejects(exchangeToken(tokenParams(params), null, SECRET, BASE, async () => { throw new Error("db down"); }, NOW), /db down/);
  const ok = await exchangeToken(tokenParams(params), null, SECRET, BASE, yes, NOW);
  await rejects(
    exchangeToken(tokenParams({ grant_type: "refresh_token", refresh_token: ok.refresh_token, client_id: c.client_id }), null, SECRET, BASE, no, NOW + 60),
    "invalid_grant",
  );
});

test("🔴 角色變更後：OAuth 身分只給有 mcp:connect 的負責人", () => {
  assert.ok(oauthOwnerActor({ id: OWNER, email: "o@x", role: "owner" }));
  for (const role of ["support", "editor", "customer"] as const) {
    assert.equal(oauthOwnerActor({ id: OWNER, email: "o@x", role }), null, role);
  }
  assert.equal(oauthOwnerActor({ id: "", email: "o@x", role: "owner" }), null);
});

test("🔴 caps＝角色能力 ∩ MCP_ACTOR.caps，永遠不含 staff:manage／mcp:requests／mcp:connect", () => {
  const a = oauthOwnerActor({ id: OWNER, email: "o@x", role: "owner" })!;
  assert.equal(a.via, "mcp");
  assert.equal(a.id, OWNER);
  assert.equal(a.email, "o@x");
  for (const c of ["staff:manage", "mcp:requests", "mcp:connect"] as const) {
    assert.equal(a.caps!.includes(c), false, c);
  }
  for (const c of a.caps!) assert.ok(MCP_ACTOR.caps!.includes(c), c);
  assert.deepEqual([...a.caps!].sort(), [...MCP_ACTOR.caps!].sort());
});

test("同意頁 CSRF token：綁人、綁參數、15 分鐘", () => {
  const c = client();
  const q = authorizeQuery(c.client_id);
  const t = consentToken(OWNER, q, SECRET, NOW);
  assert.equal(verifyConsentToken(t, OWNER, q, SECRET, NOW + 10), true);
  assert.equal(verifyConsentToken(t, "22222222-2222-4333-8444-555555555555", q, SECRET, NOW + 10), false);
  assert.equal(verifyConsentToken(t, OWNER, authorizeQuery(c.client_id, { state: "other" }), SECRET, NOW + 10), false);
  assert.equal(verifyConsentToken(t, OWNER, q, SECRET, NOW + 15 * 60), false);
  assert.equal(verifyConsentToken(t, OWNER, q, OTHER_SECRET, NOW + 10), false);
});

/* ------------------------------------------------------------ /api/mcp 閘門 */

test("/api/mcp bearer 判斷：靜態 token、OAuth、沒帶、亂帶", async () => {
  const STATIC = "s".repeat(40);
  const { tokens } = await codeFlow(Math.floor(Date.now() / 1000));
  assert.deepEqual(classifyMcpBearer(`Bearer ${STATIC}`, STATIC, SECRET, BASE), { kind: "static" });
  const o = classifyMcpBearer(`Bearer ${tokens.access_token}`, STATIC, SECRET, BASE);
  assert.equal(o.kind, "oauth");
  assert.deepEqual(classifyMcpBearer(null, STATIC, SECRET, BASE), { kind: "deny", reason: "missing" });
  assert.deepEqual(classifyMcpBearer("Basic abc", STATIC, SECRET, BASE), { kind: "deny", reason: "missing" });
  assert.deepEqual(classifyMcpBearer("Bearer nope", STATIC, SECRET, BASE), { kind: "deny", reason: "invalid" });
  // 沒設 MCP_TOKEN 不是放行
  assert.deepEqual(classifyMcpBearer("Bearer ", undefined, undefined, BASE), { kind: "deny", reason: "missing" });
  assert.deepEqual(classifyMcpBearer("Bearer x", "", undefined, BASE), { kind: "deny", reason: "invalid" });
  // OAuth 關閉（沒 secret）時 OAuth token 不收
  assert.deepEqual(classifyMcpBearer(`Bearer ${tokens.access_token}`, STATIC, undefined, BASE), { kind: "deny", reason: "invalid" });
});

/* ------------------------------------------------------------ 身分代換 */

test("🔴 MCP 請求裡 MCP_ACTOR 自動換成這次請求的身分；請求之間不串", async () => {
  const owner = oauthOwnerActor({ id: OWNER, email: "o@x", role: "owner" })!;
  assert.equal(currentMcpActor(), MCP_ACTOR);
  assert.equal(resolveMcpActor(MCP_ACTOR), MCP_ACTOR);

  const [a, b] = await Promise.all([
    runMcpRequest(owner, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return runAsMachine(MCP_ACTOR, async () => (await checkCapability("orders:read"))?.id);
    }),
    runMcpRequest(MCP_ACTOR, async () => runAsMachine(MCP_ACTOR, async () => (await checkCapability("orders:read"))?.id)),
  ]);
  assert.equal(a, OWNER, "OAuth 請求以負責人本人執行");
  assert.equal(b, "", "靜態 token 請求仍是機器身分");

  const blocked = await runMcpRequest(owner, () => runAsMachine(MCP_ACTOR, () => checkCapability("staff:manage")));
  assert.equal(blocked, null, "OAuth 負責人透過 MCP 也拿不到 staff:manage");
  const noDismiss = await runMcpRequest(owner, () => runAsMachine(MCP_ACTOR, () => checkCapability("mcp:requests")));
  assert.equal(noDismiss, null);
  // 傳真人身分（不是 MCP_ACTOR）不會被代換
  const human = { id: "x", email: "h", role: "support" as const };
  assert.equal(await runMcpRequest(owner, async () => resolveMcpActor(human)), human);
});

test("🔴 撤銷版號：負責人按「撤銷我的所有 AI 連線」（epoch+1）後，token 換不到新的、access 也帶著舊 epoch", async () => {
  // OwnerCheck 收到的是 token 裡的 epoch；帳號現在的 epoch 是 1 → 0 的 token 全部失效。
  const currentEpoch = 1;
  const owner = async (_u: string, ep: number) => ep === currentEpoch;
  const { c, tokens } = await codeFlow();
  const at = verifyAccessToken(tokens.access_token, SECRET, BASE, NOW + 1);
  assert.equal(at?.ep, 0, "access token 帶 epoch，route.ts 每次拿它去比對帳號現值");
  await rejects(
    exchangeToken(tokenParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: c.client_id }), null, SECRET, BASE, owner, NOW + 60),
    "invalid_grant",
  );
  // 撤銷前授權、撤銷後才拿去換的授權碼也不行
  __TEST_ONLY__.resetUsedCodes();
  const code = mintCode(authorizedReq(c.client_id), OWNER, 0, SECRET, NOW);
  await rejects(
    exchangeToken(tokenParams({ grant_type: "authorization_code", code, client_id: c.client_id, redirect_uri: CLAUDE_CB, code_verifier: VERIFIER }), null, SECRET, BASE, owner, NOW),
    "invalid_grant",
  );
  // 沒有 ep 的 access（舊格式／自簽）不收
  const noEp = seal("access", { exp: NOW + 100, iat: NOW, sub: OWNER, cid: "x", sc: "mcp", aud: resourceFor(BASE) }, SECRET);
  assert.equal(verifyAccessToken(noEp, SECRET, BASE, NOW), null);
});
