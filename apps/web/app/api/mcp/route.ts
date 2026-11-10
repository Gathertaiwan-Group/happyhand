import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

import { createServiceClient } from "@/lib/supabase/server";
import { loadOrders, loadOrderDetail } from "@/app/admin/orders/queries";
import { ORDER_STATUSES, PAYMENT_METHODS } from "@/app/admin/orders/shared";
import {
  loadSessionList,
  loadSessionDetail,
  loadRoster,
  rosterHeadcount,
  loadWaitlist,
} from "@/app/admin/sessions/queries";
import { parseAuditFilters, loadAuditLog } from "@/app/admin/audit/queries";
import { WAITLIST_STATUSES } from "@/app/admin/sessions/queries";
import { cancelOrder } from "@/app/admin/orders/actions";
import { regrantEntitlements, resendSetupEmail } from "@/app/admin/orders/account-actions";
import { togglePublish } from "@/app/admin/products/actions";
import { adjustSeats, setSessionStatus, setWaitlistStatus } from "@/app/admin/sessions/actions";
import { MCP_ACTOR, runAsMachine } from "@/lib/admin/machine";
import { writeAudit } from "@/lib/admin/audit";
import {
  envSecret,
  matchesRequest,
  signToken,
  stateMatches,
  TTL_SECONDS,
  verifyToken,
  VERIFY_FAILURE_MESSAGE,
  type TokenArgs,
} from "@/lib/admin/mcp-token";
import {
  APPROVAL_TOOLS,
  confirmUrl,
  resolveOrderId,
  twoStepSnapshot,
  type ActionOutcome,
  type ApprovalTool,
  type TwoStepTool,
} from "@/lib/admin/mcp-requests";
import { SITE } from "@/lib/site";

/**
 * MCP server —— 讓 AI 客戶端（Claude Code / claude.ai 連接器）查這個站的後台。
 *
 * ## 寫入分三級（見下方「寫入工具」區塊）
 *
 * 唯讀工具先上線、驗過協定之後，寫入才疊上去。寫入一律走後台既有的
 * server action：
 *   - 直接執行與兩步確認：在 lib/admin/machine.ts 的 runAsMachine() 裡呼叫，
 *     action 的 requireCapability() 看到的是 MCP_ACTOR（刻意不含 staff:manage）。
 *   - 動錢與不可逆：MCP 不執行，只簽一個確認網址。真正執行在
 *     app/admin/mcp/confirm，以按下確認的那個人的 cookie 身分呼叫 action。
 *
 * ## 為什麼不用 withMcpAuth
 *
 * `mcp-handler` 的 `withMcpAuth` 會在失敗時回 RFC 9728 的 OAuth challenge
 * （`WWW-Authenticate: Bearer resource_metadata=…`）。我們走的是靜態 token，
 * 根本沒有 authorization server —— 吐出那個標頭只會把 OAuth-first 的客戶端
 * 引進一條半套的 discovery，然後給使用者一個看不懂的錯誤。
 * 所以自己比對，401 不帶 resource_metadata，`/.well-known/oauth-*` 也不存在。
 *
 * ## 協定
 *
 * `mcp-handler` 2.x 預設雙軌：新客戶端走 2026-07-28（無狀態、無握手），
 * 2025 世代的客戶端自動退回 stateless Streamable HTTP。
 * 🔴 雙軌不是保險起見 —— 目前的 Claude Code CLI 還**完全不認識 2026-07-28**，
 *    只實作新版等於做完連不上。這由套件負責，我們不碰。
 *
 * ## 容量
 *
 * Vercel 的 4.5 MB 上限**連回應方向也算**，而且 SSE 串流繞不過。所以每個工具
 * 的輸出都過 jsonText()，超過就截斷並明講，不要讓它變成 413。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/* ----------------------------------------------------------------- 驗證 */

/**
 * 固定時間比較。
 * 直接用 === 比對 token 會隨著前綴相符的長度而有時間差，理論上可以一個字元
 * 一個字元試出來。成本是三行，沒有理由不做。
 */
function tokenMatches(got: string, expected: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req: Request): boolean {
  const expected = process.env.MCP_TOKEN;
  // 🔴 沒設 token 就整支關閉，不是「沒設就放行」。這支能讀到全站訂單的
  //    姓名、電話、Email，預設必須是關的。
  if (!expected) return false;

  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return tokenMatches(header.slice("Bearer ".length), expected);
}

/**
 * Origin 檢查。規範寫成 MUST，而 createMcpHandler 不做這件事。
 *
 * 大部分 MCP 客戶端是伺服器對伺服器、不送 Origin，所以「沒帶」是正常的。
 * 帶了就必須在清單內 —— 這擋的是 DNS rebinding 與瀏覽器端的跨站呼叫。
 */
const ALLOWED_ORIGINS = [
  "https://happyhands.com.tw",
  "https://www.happyhands.com.tw",
  "https://claude.ai",
];

function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // MCP Inspector 跑在本機
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/* ----------------------------------------------------------------- 工具 */

/** 單一工具回應的字數上限。遠低於 Vercel 的 4.5 MB，但足夠任何一次查詢。 */
const MAX_TEXT = 200_000;

/**
 * 把結果轉成給模型看的文字。
 * 超長就截斷並**講出來** —— 靜默截斷會讓模型以為自己看到了全部，
 * 然後拿一份不完整的名單去回答「有誰報名」。
 */
function jsonText(value: unknown): { content: [{ type: "text"; text: string }] } {
  let text = JSON.stringify(value, null, 2);
  if (text.length > MAX_TEXT) {
    text =
      text.slice(0, MAX_TEXT) +
      `\n\n⚠️ 輸出超過 ${MAX_TEXT} 字已截斷，上面不是完整結果。請縮小查詢範圍再試一次。`;
  }
  return { content: [{ type: "text" as const, text }] };
}

/** 工具自己的錯誤要回在 result 裡（isError），不要回 JSON-RPC 協定錯誤 —— */
/** 否則模型看不到錯誤內容，也就沒辦法自己修正查詢條件。 */
function errText(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function db() {
  return createServiceClient();
}

/* ------------------------------------------------------------ 寫入共用 */

const WRITE = {
  readOnlyHint: false,
  openWorldHint: false,
} as const;

const ORDER_ARG = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .describe("訂單編號（例如 HH-20260831-AHM4）或訂單 UUID");

const CONFIRM_TOKEN_ARG = z
  .string()
  .max(4200)
  .optional()
  .describe("第二次呼叫時帶上第一次回傳的 confirm_token；第一次呼叫請不要帶");

/** action 的回傳 → MCP 結果。action 回 undefined 代表成功。 */
function outcomeText(out: ActionOutcome, fallbackOk: string) {
  if (out && out.error) return errText(out.error);
  return jsonText({ ok: true, message: (out && out.ok) || fallbackOk });
}

/**
 * 以機器身分呼叫一支 server action。
 *
 * 🔴 getStaff() 被 React.cache() 包著，這個 request 內**第一次**呼叫它的地方
 *    必須已經在 runAsMachine() 裡 —— 所以 action 一律從這裡進，而且 route 的
 *    其他地方都不呼叫 getStaff()。
 */
async function asMachine(fallbackOk: string, fn: () => Promise<ActionOutcome>) {
  try {
    const out = await runAsMachine(MCP_ACTOR, fn);
    return outcomeText(out, fallbackOk);
  } catch (err) {
    console.error("[mcp] 寫入工具例外", err);
    return errText("執行時發生未預期的錯誤，資料可能沒有被改動。請用唯讀工具確認目前狀態。");
  }
}

/**
 * 兩步確認。
 *
 * 第一步（沒帶 token）：預檢 + 回預覽與 confirm_token，**不寫任何東西**。
 * 第二步：驗簽 → 驗工具與參數相同 → 重讀資料庫比對狀態 → 執行。
 * 狀態比對是重放防線：執行過一次之後狀態就變了，同一個 token 不能再用。
 */
async function twoStep(
  tool: TwoStepTool,
  args: TokenArgs,
  token: string | undefined,
  run: () => Promise<ActionOutcome>,
) {
  const secret = envSecret();
  if (!secret) return errText(VERIFY_FAILURE_MESSAGE.unconfigured);

  let snap;
  try {
    snap = await twoStepSnapshot(db(), tool, args);
  } catch (err) {
    console.error("[mcp] 兩步確認預檢例外", tool, err);
    return errText("讀取資料失敗，請稍後再試。");
  }
  if (!snap.ok) return errText(snap.error);

  if (!token) {
    const { token: confirmToken } = signToken(secret, { kind: "twostep", tool, args, state: snap.state });
    return jsonText({
      status: "needs_confirmation",
      preview: snap.preview,
      confirm_token: confirmToken,
      expires_in_minutes: TTL_SECONDS.twostep / 60,
      next_step:
        "這個操作還沒有執行。請把 preview 告訴使用者、取得明確同意後，" +
        "用完全相同的參數加上這個 confirm_token 再呼叫一次。",
    });
  }

  const v = verifyToken(secret, token, "twostep");
  if (!v.ok) return errText(VERIFY_FAILURE_MESSAGE[v.reason]);
  const same = matchesRequest(v.payload, tool, args);
  if (!same.ok) return errText(same.message);
  const fresh = stateMatches(v.payload, snap.state);
  if (!fresh.ok) return errText(fresh.message);

  return asMachine("已執行。", run);
}

/**
 * 本人在後台確認：預檢、簽 token、寫一筆 mcp.request 稽核、回確認網址。
 *
 * 🔴 回給 AI 的只有「已建立、網址、時效」—— 不多給任何唯讀工具本來就不給的資料。
 */
async function approval(tool: ApprovalTool, args: TokenArgs) {
  const secret = envSecret();
  if (!secret) return errText(VERIFY_FAILURE_MESSAGE.unconfigured);
  const def = APPROVAL_TOOLS[tool];

  let snap;
  try {
    snap = await def.snapshot(db(), args);
  } catch (err) {
    console.error("[mcp] 待確認請求預檢例外", tool, err);
    return errText("讀取資料失敗，請稍後再試。");
  }
  if (!snap.ok) return errText(snap.error);

  const { token, payload } = signToken(secret, { kind: "approve", tool, args, state: snap.state });

  await writeAudit(MCP_ACTOR, {
    action: "mcp.request",
    entity: snap.entity,
    entityId: snap.entityId,
    summary: `AI 透過 MCP 提出「${def.title}」：${snap.ref}，等待管理員本人在後台確認`,
    diff: { tool, nonce: payload.nonce, expires_at: new Date(payload.exp * 1000).toISOString() },
  });

  return jsonText({
    status: "pending_human_confirmation",
    message:
      "已建立待確認請求，這個操作**還沒有執行**。請把下面的確認網址交給管理員，" +
      "由本人登入後台核對後按下確認才會生效。",
    confirm_url: confirmUrl(SITE.url, token),
    expires_in_minutes: TTL_SECONDS.approve / 60,
  });
}

async function approvalByOrder(tool: ApprovalTool, order: string, extra: TokenArgs = {}) {
  let orderId: string | null;
  try {
    orderId = await resolveOrderId(db(), order);
  } catch (err) {
    console.error("[mcp] 解析訂單例外", err);
    return errText("讀取訂單失敗，請稍後再試。");
  }
  if (!orderId) return errText(`找不到訂單 ${order}。`);
  return approval(tool, { order_id: orderId, ...extra });
}

const mcp = createMcpHandler(
  (server) => {
    /* ---------------------------------------------------------- 訂單 */

    server.registerTool(
      "list_orders",
      {
        title: "訂單列表",
        description:
          "列出訂單，由新到舊，最多 100 筆。可用狀態、付款方式篩選，或用訂單編號／聯絡電話搜尋。" +
          "回傳含聯絡人姓名與電話。",
        inputSchema: z.object({
          status: z
            .enum(ORDER_STATUSES)
            .optional()
            .describe("訂單狀態：pending 待收款／paid 已付款／cancelled 已取消／refunded 已退款"),
          payment_method: z
            .enum(PAYMENT_METHODS)
            .optional()
            .describe("付款方式：credit 信用卡／atm 轉帳／manual 人工"),
          search: z
            .string()
            .max(60)
            .optional()
            .describe("比對訂單編號或聯絡電話的片段，例如 HH-20260831 或 0912"),
        }),
        annotations: READ_ONLY,
      },
      async ({ status, payment_method, search }) => {
        const r = await loadOrders({
          status: status ?? "",
          paymentMethod: payment_method ?? "",
          search: search ?? "",
        });
        if (r.error) return errText(r.error);
        return jsonText({
          orders: r.rows,
          shown: r.rows.length,
          matched: r.matched,
          // 被 LIMIT 截掉時一定要講。客服以為看到全部就會漏掉最舊的待收款訂單。
          truncated:
            typeof r.matched === "number" && r.matched > r.rows.length
              ? `符合條件共 ${r.matched} 筆，只回傳最近 ${r.rows.length} 筆，請縮小篩選範圍`
              : null,
        });
      },
    );

    server.registerTool(
      "get_order",
      {
        title: "訂單明細",
        description:
          "用訂單編號（例如 HH-20260831-AHM4）或訂單 UUID 查單筆訂單，" +
          "含品項、聯絡資訊、付款時間與電子發票狀態。",
        inputSchema: z.object({
          order: z.string().min(1).max(80).describe("訂單編號或 UUID"),
        }),
        annotations: READ_ONLY,
      },
      async ({ order }) => {
        const row = await loadOrderDetail(db(), order);
        if (!row) return errText(`找不到訂單 ${order}。`);
        return jsonText(row);
      },
    );

    /* ---------------------------------------------------------- 場次 */

    server.registerTool(
      "list_workshop_sessions",
      {
        title: "工作坊場次列表",
        description:
          "列出工作坊場次，含容量、已報名人數（由已付款訂單推導）與候補人數。" +
          "預設只列還沒開始的場次。",
        inputSchema: z.object({
          include_past: z
            .boolean()
            .optional()
            .describe("是否一併列出已經結束的場次，預設 false"),
        }),
        annotations: READ_ONLY,
      },
      async ({ include_past }) => {
        const r = await loadSessionList(db(), { includePast: include_past ?? false });
        if (r.error) return errText(r.error);
        return jsonText({ sessions: r.rows, count: r.rows.length });
      },
    );

    server.registerTool(
      "get_workshop_session",
      {
        title: "場次明細",
        description: "用場次 UUID 查單一場次的時間、地點、容量與狀態。",
        inputSchema: z.object({
          session_id: z.string().uuid().describe("workshop_sessions.id"),
        }),
        annotations: READ_ONLY,
      },
      async ({ session_id }) => {
        const row = await loadSessionDetail(db(), session_id);
        if (!row) return errText(`找不到場次 ${session_id}。`);
        return jsonText(row);
      },
    );

    server.registerTool(
      "get_session_roster",
      {
        title: "報到名單",
        description:
          "某一場次的報名名單（只含已付款訂單），以訂單為單位，含姓名、電話、Email 與人數。" +
          "⚠️ 這是個人資料，只在需要聯絡或現場報到時查。",
        inputSchema: z.object({
          session_id: z.string().uuid().describe("workshop_sessions.id"),
        }),
        annotations: READ_ONLY,
      },
      async ({ session_id }) => {
        const r = await loadRoster(db(), session_id);
        if (r.error) return errText(r.error);
        return jsonText({
          roster: r.rows,
          orders: r.rows.length,
          headcount: rosterHeadcount(r.rows),
        });
      },
    );

    server.registerTool(
      "get_session_waitlist",
      {
        title: "候補名單",
        description: "某一場次的候補登記清單。⚠️ 含個人資料。",
        inputSchema: z.object({
          session_id: z.string().uuid().describe("workshop_sessions.id"),
        }),
        annotations: READ_ONLY,
      },
      async ({ session_id }) => {
        const r = await loadWaitlist(db(), session_id);
        if (r.error) return errText(r.error);
        return jsonText({ waitlist: r.rows, count: r.rows.length });
      },
    );

    /* ---------------------------------------------------------- 稽核 */

    server.registerTool(
      "search_audit_log",
      {
        title: "查稽核紀錄",
        description:
          "查後台操作紀錄：誰在什麼時候對哪一筆訂單／商品做了什麼。" +
          "actor_role 是 mcp 的代表那一筆是透過這個 MCP 做的，不是人在後台按的。",
        inputSchema: z.object({
          entity: z
            .string()
            .max(60)
            .optional()
            .describe("實體類型，例如 order／product／session／staff"),
          action: z.string().max(60).optional().describe("動作關鍵字，例如 refund"),
          from: z.string().max(10).optional().describe("起始日期 YYYY-MM-DD"),
          to: z.string().max(10).optional().describe("結束日期 YYYY-MM-DD"),
        }),
        annotations: READ_ONLY,
      },
      async ({ entity, action, from, to }) => {
        const parsed = parseAuditFilters({ entity, action, from, to });
        const r = await loadAuditLog(db(), parsed);
        if (r.error) return errText(r.error);
        return jsonText({
          entries: r.rows,
          shown: r.rows.length,
          total: r.total,
          // parseAuditFilters 會丟掉格式不對的條件，丟掉就要講，不然
          // 模型會以為自己的篩選生效了。
          ignored: parsed.notes.length ? parsed.notes : null,
        });
      },
    );

    /* ====================================================== 寫入工具
     *
     * 三級風險（業主原則：全部功能都能經 AI 操作，但 AI 可被 prompt injection，
     * 所以「動錢與不可逆」的最終確認不交給 AI）：
     *
     *   直接執行  可逆、冪等。在 runAsMachine() 裡直接呼叫原本的 server action。
     *   兩步確認  第一次只回預覽與 confirm_token，第二次帶同一個 token 才執行。
     *             token 綁定工具＋參數＋到期時間＋當下狀態。
     *             ⚠️ token 是回給同一個 AI 的，所以這一級擋的是「AI 誤觸／沒先
     *             跟使用者確認」，**不擋 prompt injection**。動錢的不放這一級。
     *   本人確認  MCP 不執行，只回一個後台確認網址。管理員登入後看著資料庫讀出
     *             的摘要、本人按確認，才以他自己的身分呼叫 action。
     *
     * 🔴 每一支 server action 自己的冪等條件式 update、「先退錢後改狀態」等順序
     *    保證全部原封不動 —— 這裡只做包裝，不重寫任何業務邏輯。
     */

    /* ---------------------------------------------------- 直接執行 */

    server.registerTool(
      "set_session_status",
      {
        title: "開關場次報名",
        description:
          "把工作坊場次改成開放報名（open）、暫停報名（closed）或已取消（cancelled）。" +
          "「已額滿」由系統依名額自動判定，不能手動設定。已取消可以再改回開放報名。",
        inputSchema: z.object({
          session_id: z.string().uuid().describe("workshop_sessions.id"),
          status: z
            .enum(["open", "closed", "cancelled"])
            .describe("open 開放報名／closed 暫停報名／cancelled 已取消"),
        }),
        annotations: { ...WRITE, destructiveHint: false, idempotentHint: true },
      },
      async ({ session_id, status }) =>
        asMachine("場次狀態已更新。", () => setSessionStatus(session_id, status)),
    );

    server.registerTool(
      "publish_product",
      {
        title: "發布課程",
        description: "把課程／工作坊從草稿改成發布中，前台會看得到。隨時可以用 unpublish_product 下架。",
        inputSchema: z.object({
          product_id: z.string().uuid().describe("products.id"),
        }),
        annotations: { ...WRITE, destructiveHint: false, idempotentHint: true },
      },
      async ({ product_id }) =>
        asMachine("已發布。", () => togglePublish(product_id, true)),
    );

    server.registerTool(
      "unpublish_product",
      {
        title: "下架課程",
        description: "把課程／工作坊改回草稿，前台看不到。已購買的學員不受影響。隨時可以用 publish_product 再發布。",
        inputSchema: z.object({
          product_id: z.string().uuid().describe("products.id"),
        }),
        annotations: { ...WRITE, destructiveHint: false, idempotentHint: true },
      },
      async ({ product_id }) =>
        asMachine("已下架。", () => togglePublish(product_id, false)),
    );

    server.registerTool(
      "set_waitlist_status",
      {
        title: "更新候補狀態",
        description:
          "更新一筆候補登記的狀態。正常流程是 waiting 候補中 → offered 已通知 → converted 已轉正式報名；" +
          "未結束的都可以改成 cancelled。⚠️ cancelled 是終點，改了就不能復原（要重新登記一筆）。",
        inputSchema: z.object({
          waitlist_id: z.string().uuid().describe("workshop_waitlist.id（get_session_waitlist 查得到）"),
          status: z
            .enum(WAITLIST_STATUSES)
            .describe("waiting 候補中／offered 已通知／converted 已轉正式報名／cancelled 已取消"),
        }),
        // cancelled 是終點，所以誠實標成 destructive
        annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
      },
      async ({ waitlist_id, status }) => {
        const { data } = await db()
          .from("workshop_waitlist")
          .select("session_id")
          .eq("id", waitlist_id)
          .maybeSingle();
        const sessionId = (data as { session_id?: string } | null)?.session_id;
        if (!sessionId) return errText(`找不到候補紀錄 ${waitlist_id}。`);
        return asMachine("候補狀態已更新。", () =>
          setWaitlistStatus(waitlist_id, sessionId, status),
        );
      },
    );

    server.registerTool(
      "regrant_entitlements",
      {
        title: "重新開通課程",
        description:
          "依訂單內容補開通線上課程觀看權限（已開通的不會重複）。有新開通時會寄一封開通通知信給客人（同一筆訂單只寄一次）。" +
          "金額未核對的訂單會被擋下，那種要用 force_grant_entitlements。",
        inputSchema: z.object({ order: ORDER_ARG }),
        annotations: { ...WRITE, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ order }) => {
        const orderId = await resolveOrderId(db(), order);
        if (!orderId) return errText(`找不到訂單 ${order}。`);
        return asMachine("已處理。", () => regrantEntitlements(orderId));
      },
    );

    /* ---------------------------------------------------- 兩步確認 */

    server.registerTool(
      "cancel_order",
      {
        title: "取消訂單（兩步確認）",
        description:
          "取消一筆待收款的訂單（已收款的訂單不能取消，要走退款）。取消是最終狀態。" +
          "兩步確認：第一次呼叫不要帶 confirm_token，會回預覽與 confirm_token；" +
          "向使用者說明預覽內容、取得同意後，用完全相同的參數加上 confirm_token 再呼叫一次才會執行。",
        inputSchema: z.object({ order: ORDER_ARG, confirm_token: CONFIRM_TOKEN_ARG }),
        annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
      },
      async ({ order, confirm_token }) => {
        const orderId = await resolveOrderId(db(), order);
        if (!orderId) return errText(`找不到訂單 ${order}。`);
        return twoStep("cancel_order", { order_id: orderId }, confirm_token, () =>
          cancelOrder(orderId),
        );
      },
    );

    server.registerTool(
      "adjust_seats",
      {
        title: "微調場次名額（兩步確認）",
        description:
          "把某場次的已報名人數加 1 或減 1（一次只能 ±1）。用在現場報名、電話保留位等不經過訂單的情況。" +
          "兩步確認：第一次呼叫不要帶 confirm_token，會回預覽與 confirm_token；" +
          "取得使用者同意後，用完全相同的參數加上 confirm_token 再呼叫一次才會執行。",
        inputSchema: z.object({
          session_id: z.string().uuid().describe("workshop_sessions.id"),
          delta: z.union([z.literal(1), z.literal(-1)]).describe("1 加一人／-1 減一人"),
          confirm_token: CONFIRM_TOKEN_ARG,
        }),
        annotations: { ...WRITE, destructiveHint: false, idempotentHint: false },
      },
      async ({ session_id, delta, confirm_token }) =>
        twoStep("adjust_seats", { session_id, delta }, confirm_token, () =>
          adjustSeats(session_id, delta),
        ),
    );

    server.registerTool(
      "resend_setup_email",
      {
        title: "重寄設定密碼信（兩步確認）",
        description:
          "重寄「設定密碼」信到訂單的聯絡信箱（客人說沒收到信時用）。每呼叫一次就會真的寄一封。" +
          "兩步確認：第一次呼叫不要帶 confirm_token，會回預覽與 confirm_token；" +
          "取得使用者同意後，用完全相同的參數加上 confirm_token 再呼叫一次才會寄出。",
        inputSchema: z.object({ order: ORDER_ARG, confirm_token: CONFIRM_TOKEN_ARG }),
        annotations: { ...WRITE, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ order, confirm_token }) => {
        const orderId = await resolveOrderId(db(), order);
        if (!orderId) return errText(`找不到訂單 ${order}。`);
        return twoStep("resend_setup_email", { order_id: orderId }, confirm_token, () =>
          resendSetupEmail(orderId),
        );
      },
    );

    /* ---------------------------------------------- 本人在後台確認 */

    const APPROVAL_NOTE =
      "⚠️ 這個工具不會執行操作：它只建立一個待確認請求並回傳後台確認網址，" +
      "必須由管理員本人登入後台、核對摘要後按下確認才會生效（30 分鐘內有效）。" +
      "請把網址交給使用者，不要嘗試自己開啟或確認。";

    server.registerTool(
      "mark_order_paid",
      {
        title: "標記已收款（需本人確認）",
        description:
          "請求把待收款訂單標記為已收款（會佔用名額、開通課程、寄開通信）。" + APPROVAL_NOTE,
        inputSchema: z.object({ order: ORDER_ARG }),
        annotations: { ...WRITE, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ order }) => approvalByOrder("mark_order_paid", order),
    );

    server.registerTool(
      "refund_order",
      {
        title: "退款（需本人確認）",
        description:
          "請求為已收款訂單退款。線上刷卡的訂單在確認後會真的呼叫黑貓 PAY 退刷。" + APPROVAL_NOTE,
        inputSchema: z.object({ order: ORDER_ARG }),
        annotations: { ...WRITE, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ order }) => approvalByOrder("refund_order", order),
    );

    server.registerTool(
      "mark_refunded_manually",
      {
        title: "標記已人工退款（需本人確認）",
        description:
          "請求把已收款訂單標記為已退款，但不呼叫金流（錢已經在黑貓 PAY 後台或其他管道退過）。" +
          APPROVAL_NOTE,
        inputSchema: z.object({ order: ORDER_ARG }),
        annotations: { ...WRITE, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ order }) => approvalByOrder("mark_refunded_manually", order),
    );

    server.registerTool(
      "reissue_invoice",
      {
        title: "補開發票（需本人確認）",
        description: "請求為已收款訂單透過 Amego 補開電子發票。" + APPROVAL_NOTE,
        inputSchema: z.object({ order: ORDER_ARG }),
        annotations: { ...WRITE, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ order }) => approvalByOrder("reissue_invoice", order),
    );

    server.registerTool(
      "void_invoice",
      {
        title: "作廢發票（需本人確認）",
        description:
          "請求作廢訂單的電子發票（不會退款、不會改訂單狀態）。作廢後同一張訂單不能再用系統重開。" +
          "作廢原因會預填在確認頁上，由管理員本人確認或修改後才送出。" +
          APPROVAL_NOTE,
        inputSchema: z.object({
          order: ORDER_ARG,
          reason: z.string().trim().min(1).max(20).describe("作廢原因，20 字以內（會送到 Amego）"),
        }),
        annotations: { ...WRITE, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ order, reason }) => approvalByOrder("void_invoice", order, { reason }),
    );

    server.registerTool(
      "force_grant_entitlements",
      {
        title: "核對金額並強制開通（需本人確認）",
        description:
          "請求解除訂單的「金額未核對」旗標並開通課程。確認的人等於聲明「已核對金額無誤」。" +
          APPROVAL_NOTE,
        inputSchema: z.object({ order: ORDER_ARG }),
        annotations: { ...WRITE, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ order }) => approvalByOrder("force_grant_entitlements", order),
    );

    server.registerTool(
      "revoke_course_access",
      {
        title: "關閉課程觀看權限（需本人確認）",
        description:
          "請求關閉訂單綁定的會員帳號對某門課的觀看權限。帳號由訂單決定，不能另外指定。" +
          APPROVAL_NOTE,
        inputSchema: z.object({
          order: ORDER_ARG,
          product_id: z.string().uuid().describe("要關閉的課程 products.id"),
        }),
        annotations: { ...WRITE, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ order, product_id }) =>
        approvalByOrder("revoke_course_access", order, { product_id }),
    );

    server.registerTool(
      "delete_product",
      {
        title: "刪除課程（需本人確認）",
        description:
          "請求永久刪除一門課程／工作坊（含底下場次）。有人買過的課不能刪，請改用 unpublish_product。" +
          APPROVAL_NOTE,
        inputSchema: z.object({ product_id: z.string().uuid().describe("products.id") }),
        annotations: { ...WRITE, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ product_id }) => approval("delete_product", { product_id }),
    );

    server.registerTool(
      "delete_session",
      {
        title: "刪除場次（需本人確認）",
        description:
          "請求永久刪除一個工作坊場次。已有訂單的場次不能刪，請改用 set_session_status 設成 cancelled。" +
          APPROVAL_NOTE,
        inputSchema: z.object({ session_id: z.string().uuid().describe("workshop_sessions.id") }),
        annotations: { ...WRITE, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ session_id }) => approval("delete_session", { session_id }),
    );
  },
  { serverInfo: { name: "happyhands", version: "1.1.0" } },
);

/* ----------------------------------------------------------------- 入口 */

export async function POST(req: Request) {
  if (!originAllowed(req)) {
    return new Response(JSON.stringify({ error: "forbidden_origin" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  if (!authorized(req)) {
    // 刻意只有一個裸的 Bearer challenge：不帶 resource_metadata，
    // 也不提供 /.well-known/oauth-*。讓 OAuth-first 的客戶端乾淨地
    // 失敗在這個 401，而不是失敗在一條走不通的 discovery 裡。
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": "Bearer",
      },
    });
  }
  return mcp(req);
}
