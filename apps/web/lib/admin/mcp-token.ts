import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * MCP 寫入工具的簽章 token —— 「待確認請求」的全部狀態都在這裡面。
 *
 * ## 為什麼是 token 而不是一張 pending_requests 表
 *
 * 合併後的資料庫我們沒有 DDL 權限，不能開新表。所以把「誰提出、要做什麼、
 * 對哪一筆、當時那一筆是什麼狀態、什麼時候過期」全部簽進 token，
 * 伺服器端不存任何東西。
 *
 * ## 沒有「已使用」紀錄，重放靠什麼擋
 *
 * 靠 `state`。token 記下提出當下那一筆資料的狀態（訂單 status、場次
 * seats_taken、發票號碼…），執行前與資料庫目前的狀態逐字比對，不一樣就拒絕。
 * 操作一旦執行，狀態就變了 —— 同一個 token 第二次一定對不上。
 * 這同時擋掉「舊連結在狀態改變後被重放成另一件事」（例如訂單被重新處理過之後，
 * 一條半小時前產生的退款連結）。
 *
 * ## 兩種 token，金鑰不同
 *
 * - `approve`：本人在後台確認用（確認網址裡的 ?t=）。30 分鐘。
 * - `twostep`：MCP 兩步確認用（confirm_token）。10 分鐘。
 *
 * 金鑰由 MCP_TOKEN 依 label 衍生成兩把，所以一種 token 永遠驗不過另一種的
 * 簽章 —— AI 拿到的 confirm_token 不可能被當成「本人已確認」送進後台，
 * 反之亦然。payload 的 `k` 欄位是第二道（同一把金鑰外洩時的保險）。
 *
 * 不新增環境變數：rotate MCP_TOKEN 等於同時作廢所有待確認連結，這正是
 * token 外洩時要的行為。
 */

export type TokenKind = "approve" | "twostep";

/** 參數一律是扁平的純量。巢狀物件沒有必要，而且會讓「參數相同」的判斷變複雜。 */
export type TokenArgs = Record<string, string | number | boolean>;

export type TokenPayload = {
  v: 1;
  k: TokenKind;
  tool: string;
  args: TokenArgs;
  /** 提出當下那一筆資料的狀態指紋。由各工具自己定義，見 lib/admin/mcp-requests.ts */
  state: string;
  /** 簽發時間（epoch 秒） */
  iat: number;
  /** 到期時間（epoch 秒） */
  exp: number;
  nonce: string;
};

export type VerifyFailure =
  | "unconfigured"
  | "malformed"
  | "bad_signature"
  | "wrong_kind"
  | "expired";

export type VerifyResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; reason: VerifyFailure };

export const TTL_SECONDS: Record<TokenKind, number> = {
  approve: 30 * 60,
  twostep: 10 * 60,
};

const LABEL: Record<TokenKind, string> = {
  approve: "confirm-v1",
  twostep: "twostep-v1",
};

/** 給人看的失敗原因。確認頁與 MCP 兩邊共用。 */
export const VERIFY_FAILURE_MESSAGE: Record<VerifyFailure, string> = {
  unconfigured: "伺服器沒有設定 MCP 金鑰，無法驗證這個請求。",
  malformed: "這個確認碼格式不對（可能被截斷或改過）。",
  bad_signature: "這個確認碼的簽章不正確，可能被竄改過，已拒絕。",
  wrong_kind: "這個確認碼不是給這個用途的，已拒絕。",
  expired: "這個確認碼已經過期，請重新提出請求。",
};

/* ---------------------------------------------------------------- 金鑰 */

/** 由 MCP_TOKEN 衍生出某一種 token 的 HMAC 金鑰。 */
export function deriveKey(secret: string, kind: TokenKind): Buffer {
  return createHash("sha256").update(`${secret}:${LABEL[kind]}`).digest();
}

/** 目前環境的 secret。沒設就是 null —— 呼叫端必須當成「整個功能關閉」。 */
export function envSecret(): string | null {
  const s = process.env.MCP_TOKEN;
  return s && s.length > 0 ? s : null;
}

/* ---------------------------------------------------------------- 編碼 */

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * 參數的正規化 JSON：key 排序。
 * 「參數相同」用這個字串比，避免 {a,b} 與 {b,a} 被當成不同請求。
 */
export function canonicalArgs(args: TokenArgs): string {
  const sorted: TokenArgs = {};
  for (const key of Object.keys(args).sort()) sorted[key] = args[key];
  return JSON.stringify(sorted);
}

function mac(key: Buffer, body: string): Buffer {
  return createHmac("sha256", key).update(body).digest();
}

/* ---------------------------------------------------------------- 簽發 */

export function signToken(
  secret: string,
  input: { kind: TokenKind; tool: string; args: TokenArgs; state: string },
  now: number = Math.floor(Date.now() / 1000),
): { token: string; payload: TokenPayload } {
  const payload: TokenPayload = {
    v: 1,
    k: input.kind,
    tool: input.tool,
    args: JSON.parse(canonicalArgs(input.args)) as TokenArgs,
    state: input.state,
    iat: now,
    exp: now + TTL_SECONDS[input.kind],
    nonce: b64url(randomBytes(12)),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(mac(deriveKey(secret, input.kind), body));
  return { token: `${body}.${sig}`, payload };
}

/* ---------------------------------------------------------------- 驗證 */

const TOKEN_RE = /^[A-Za-z0-9_-]{16,4096}\.[A-Za-z0-9_-]{43}$/;

/**
 * 驗簽、驗用途、驗到期。
 *
 * 順序是刻意的：**先驗簽章才解析內容**。沒驗過的 payload 一個字都不信，
 * 連「它說自己是哪一種 token」都不信 —— 用哪一把金鑰是呼叫端決定的。
 */
export function verifyToken(
  secret: string | null,
  token: string | null | undefined,
  expected: TokenKind,
  now: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  if (!secret) return { ok: false, reason: "unconfigured" };
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    return { ok: false, reason: "malformed" };
  }

  const [body, sig] = token.split(".");
  const want = mac(deriveKey(secret, expected), body);
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    !payload ||
    payload.v !== 1 ||
    typeof payload.tool !== "string" ||
    typeof payload.state !== "string" ||
    typeof payload.exp !== "number" ||
    typeof payload.args !== "object" ||
    payload.args === null
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (payload.k !== expected) return { ok: false, reason: "wrong_kind" };
  if (now >= payload.exp) return { ok: false, reason: "expired" };
  // 有效期不能比這種 token 的 TTL 長、簽發時間不能在未來。正常簽發的 token
  // 一定滿足；不滿足代表是拿到金鑰的人自己簽的（例如讀到客戶端設定檔裡的
  // MCP_TOKEN），把「30 分鐘」的保證守住。60 秒是時鐘誤差的容忍。
  if (
    typeof payload.iat !== "number" ||
    payload.iat > now + 60 ||
    payload.exp - payload.iat > TTL_SECONDS[expected]
  ) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, payload };
}

/* ------------------------------------------------------------ 執行前檢查 */

export type ExecCheck = { ok: true } | { ok: false; message: string };

/**
 * 兩步確認的第二步：token 必須是同一個工具、同一組參數。
 * 參數變了就失效 —— 否則 AI 可以拿「取消 A 訂單」的 token 去取消 B。
 */
export function matchesRequest(
  payload: TokenPayload,
  tool: string,
  args: TokenArgs,
): ExecCheck {
  if (payload.tool !== tool) {
    return { ok: false, message: "這個 confirm_token 不是這個工具發的，已拒絕。請重新呼叫一次（不帶 confirm_token）取得新的。" };
  }
  if (canonicalArgs(payload.args) !== canonicalArgs(args)) {
    return { ok: false, message: "參數與產生 confirm_token 時不同，已拒絕。請用新的參數重新呼叫一次（不帶 confirm_token）取得新的。" };
  }
  return { ok: true };
}

/**
 * 狀態比對。token 記錄的狀態必須與資料庫**現在**的狀態完全相同。
 * 這是唯一的重放防線（見檔頭），所以用嚴格相等，不做任何寬鬆比對。
 */
export function stateMatches(payload: TokenPayload, currentState: string): ExecCheck {
  if (payload.state !== currentState) {
    return {
      ok: false,
      message:
        "這筆資料在請求提出之後已經變動過（可能已經處理過，或被其他人改過），" +
        "這個請求已經失效。請重新查看最新狀態後再決定。",
    };
  }
  return { ok: true };
}
