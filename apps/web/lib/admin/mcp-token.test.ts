/**
 * lib/admin/mcp-token.ts 的單元測試。
 *
 * 這支守的是 resend_setup_email 的兩步確認（confirm_token）：AI 不能拿一個
 * token 對別張訂單、別的工具或狀態已經變過的資料重放。正式站不拿真單測
 * （業主規定：AI 不可以直接寫正式站的資料）。簽章、竄改、到期、用途、
 * 參數、狀態比對全部在這裡用本機跑。
 *
 * 跑法（repo 根目錄；server-only 換成空模組）：
 *
 *   echo "" > /tmp/empty.js
 *   node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     apps/web/lib/admin/mcp-token.test.ts --bundle --platform=node --format=esm \
 *     --alias:@=./apps/web --alias:server-only=/tmp/empty.js --outfile=/tmp/mcp-token.test.mjs
 *   node --test /tmp/mcp-token.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  canonicalArgs,
  deriveKey,
  matchesRequest,
  signToken,
  stateMatches,
  TTL_SECONDS,
  verifyToken,
  type TokenPayload,
} from "@/lib/admin/mcp-token";

const SECRET = "test-secret-不是正式站的";
const NOW = 1_800_000_000;
const ORDER = "11111111-2222-4333-8444-555555555555";

function issue(state = "user=u1;last=none", args: Record<string, string | number | boolean> = { order_id: ORDER }) {
  return signToken(SECRET, { kind: "twostep", tool: "resend_setup_email", args, state }, NOW);
}

/** 把 payload 改掉但沿用原本的簽章 —— 模擬攻擊者竄改 body。 */
function tamperBody(token: string, mutate: (p: TokenPayload) => void): string {
  const [body, sig] = token.split(".");
  const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
  mutate(p);
  return `${Buffer.from(JSON.stringify(p)).toString("base64url")}.${sig}`;
}

/** 用正確金鑰重新簽一個任意 payload（模擬金鑰外洩或內部 bug 簽錯用途）。 */
function resign(payload: unknown, kindKey: "twostep" = "twostep"): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", deriveKey(SECRET, kindKey)).update(body).digest("base64url");
  return `${body}.${sig}`;
}

test("正常簽發後驗得過，內容原樣取回；有效 10 分鐘", () => {
  const { token, payload } = issue();
  const v = verifyToken(SECRET, token, "twostep", NOW + 1);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.deepEqual(v.payload, payload);
  assert.equal(v.payload.tool, "resend_setup_email");
  assert.equal(v.payload.args.order_id, ORDER);
  assert.equal(v.payload.exp - v.payload.iat, TTL_SECONDS.twostep);
  assert.equal(TTL_SECONDS.twostep, 600);
});

test("「本人確認」的 approve token 已經拿掉：只剩 twostep 一種", () => {
  assert.deepEqual(Object.keys(TTL_SECONDS), ["twostep"]);
});

test("每次簽發 nonce 都不同", () => {
  assert.notEqual(issue().payload.nonce, issue().payload.nonce);
});

test("竄改 body（換訂單、改狀態、延長到期、換工具）一律 bad_signature", () => {
  const { token } = issue();
  const cases: ((p: TokenPayload) => void)[] = [
    (p) => { p.args.order_id = "99999999-2222-4333-8444-555555555555"; },
    (p) => { p.state = "status=refunded"; },
    (p) => { p.exp = p.exp + 86400; },
    (p) => { p.tool = "cancel_order"; },
  ];
  for (const mutate of cases) {
    const v = verifyToken(SECRET, tamperBody(token, mutate), "twostep", NOW + 1);
    assert.deepEqual(v, { ok: false, reason: "bad_signature" });
  }
});

test("竄改簽章一個字元 → bad_signature", () => {
  const { token } = issue();
  const last = token.at(-2) === "A" ? "B" : "A";
  const bad = token.slice(0, -2) + last + token.slice(-1);
  assert.deepEqual(verifyToken(SECRET, bad, "twostep", NOW + 1), { ok: false, reason: "bad_signature" });
});

test("不同 secret（例如 MCP_TOKEN 已 rotate）→ bad_signature", () => {
  const { token } = issue();
  assert.deepEqual(verifyToken("other-secret", token, "twostep", NOW + 1), { ok: false, reason: "bad_signature" });
});

test("用舊的 approve 金鑰（confirm-v1）簽的 token 一律 bad_signature", () => {
  const { payload } = issue();
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const oldKey = createHash("sha256").update(`${SECRET}:confirm-v1`).digest();
  const sig = createHmac("sha256", oldKey).update(body).digest("base64url");
  assert.deepEqual(verifyToken(SECRET, `${body}.${sig}`, "twostep", NOW + 1), { ok: false, reason: "bad_signature" });
});

test("金鑰對但 payload 自稱另一種用途 → wrong_kind", () => {
  const { payload } = issue();
  const forged = resign({ ...payload, k: "approve" });
  assert.deepEqual(verifyToken(SECRET, forged, "twostep", NOW + 1), { ok: false, reason: "wrong_kind" });
});

test("到期：exp 前一秒可用，exp 當秒起拒絕", () => {
  const { token, payload } = issue();
  assert.equal(verifyToken(SECRET, token, "twostep", payload.exp - 1).ok, true);
  assert.deepEqual(verifyToken(SECRET, token, "twostep", payload.exp), { ok: false, reason: "expired" });
  assert.deepEqual(verifyToken(SECRET, token, "twostep", payload.exp + 3600), { ok: false, reason: "expired" });
});

test("格式不對 → malformed；沒設 secret → unconfigured", () => {
  for (const bad of [undefined, null, "", "abc", "a.b", "x".repeat(50), `${"A".repeat(20)}.${"B".repeat(42)}`, "<script>.x"]) {
    assert.deepEqual(verifyToken(SECRET, bad as string, "twostep", NOW), { ok: false, reason: "malformed" });
  }
  // 簽章正確但內容不是合法 payload
  assert.deepEqual(verifyToken(SECRET, resign({ hello: 1 }), "twostep", NOW), { ok: false, reason: "malformed" });
  assert.deepEqual(verifyToken(SECRET, resign("just a string"), "twostep", NOW), { ok: false, reason: "malformed" });

  const { token } = issue();
  assert.deepEqual(verifyToken(null, token, "twostep", NOW), { ok: false, reason: "unconfigured" });
  assert.deepEqual(verifyToken("", token, "twostep", NOW), { ok: false, reason: "unconfigured" });
});

test("狀態比對：與資料庫目前狀態不同就拒絕（防舊連結重放）", () => {
  const { payload } = issue("status=paid");
  assert.equal(stateMatches(payload, "status=paid").ok, true);
  // 已經退過款 → 同一條連結第二次一定失效
  assert.equal(stateMatches(payload, "status=refunded").ok, false);
  // 嚴格相等：大小寫、空白都不放過
  assert.equal(stateMatches(payload, "status=Paid").ok, false);
  assert.equal(stateMatches(payload, "status=paid ").ok, false);
});

test("兩步確認：工具或參數變了就失效；參數順序不影響", () => {
  const { payload } = signToken(
    SECRET,
    { kind: "twostep", tool: "adjust_seats", args: { session_id: ORDER, delta: 1 }, state: "seats=3;cap=10" },
    NOW,
  );
  assert.equal(matchesRequest(payload, "adjust_seats", { delta: 1, session_id: ORDER }).ok, true);
  assert.equal(matchesRequest(payload, "adjust_seats", { session_id: ORDER, delta: -1 }).ok, false);
  assert.equal(matchesRequest(payload, "adjust_seats", { session_id: "99999999-2222-4333-8444-555555555555", delta: 1 }).ok, false);
  assert.equal(matchesRequest(payload, "cancel_order", { session_id: ORDER, delta: 1 }).ok, false);
  // 多帶一個參數也不行
  assert.equal(matchesRequest(payload, "adjust_seats", { session_id: ORDER, delta: 1, extra: true }).ok, false);
  // 型別不同（"1" vs 1）也不行
  assert.equal(matchesRequest(payload, "adjust_seats", { session_id: ORDER, delta: "1" }).ok, false);
});

test("canonicalArgs 依 key 排序", () => {
  assert.equal(canonicalArgs({ b: 1, a: "x" }), canonicalArgs({ a: "x", b: 1 }));
  assert.equal(canonicalArgs({ b: 1, a: "x" }), '{"a":"x","b":1}');
});

test("拿到金鑰的人自己簽的長效 token（exp 超過 TTL、iat 在未來）一律拒絕", () => {
  const { payload } = issue();
  const longLived = resign({ ...payload, exp: payload.iat + 365 * 86400 });
  assert.deepEqual(verifyToken(SECRET, longLived, "twostep", NOW + 1), { ok: false, reason: "expired" });
  const future = resign({ ...payload, iat: NOW + 3600, exp: NOW + 3600 + 60 });
  assert.deepEqual(verifyToken(SECRET, future, "twostep", NOW), { ok: false, reason: "expired" });
  // 剛好等於 TTL、iat 在 60 秒誤差內 → 正常
  const edge = resign({ ...payload, iat: NOW + 30, exp: NOW + 30 + TTL_SECONDS.twostep });
  assert.equal(verifyToken(SECRET, edge, "twostep", NOW).ok, true);
});
