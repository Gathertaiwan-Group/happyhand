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
import { resendSetupEmail } from "@/app/admin/orders/account-actions";
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
  previewAdjustSeats,
  previewCancelOrder,
  previewMarkOrderPaid,
  previewRegrant,
  previewReissueInvoice,
  previewRevoke,
  previewSetSessionStatus,
  previewSetWaitlistStatus,
  previewTogglePublish,
  resolveOrderId,
  twoStepSnapshot,
  type ActionOutcome,
  type Preview,
  type TwoStepTool,
} from "@/lib/admin/mcp-requests";
import { createMcpRequest } from "@/lib/admin/mcp-pending-repo";
import { MCP_PREVIEW_ACTION_PREFIX, REFUND_REASON_MAX, VOID_REASON_MAX } from "@/lib/admin/mcp-pending";

/**
 * MCP server —— 讓 AI 客戶端（Claude Code / claude.ai 連接器）查這個站的後台。
 *
 * ## 寫入的安全模型（2026-11-10 改成跟小時光書店一樣，見下方「寫入工具」區塊）
 *
 *   - 申請制：退款、作廢發票。AI 只能留一筆申請在後台，**不會退款、不會作廢、
 *     不給任何連結**；由負責人到訂單頁按原本的按鈕處理（lib/admin/mcp-pending.ts）。
 *   - 預覽制（dry_run，預設 true）：其他寫入。第一次只回「會改什麼」，用同樣參數加
 *     dry_run=false 再呼叫才執行。執行時在 lib/admin/machine.ts 的 runAsMachine()
 *     裡呼叫後台原本的 server action（MCP_ACTOR 刻意不含 staff:manage 與 mcp:requests）。
 *   - 兩步確認：只剩 resend_setup_email（會真的寄信給客人，含冷卻）。
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

const DRY_RUN_ARG = z
  .boolean()
  .optional()
  .describe(
    "預設 true（省略也是 true）：只預覽會改什麼，不寫入任何資料。" +
      "確認預覽內容、取得使用者同意後，用完全相同的參數加上 dry_run=false 再呼叫一次才會執行。",
  );

/** 預覽制工具 description 的共同說明 */
const DRY_RUN_NOTE =
  "【先預覽再執行】第一次呼叫（dry_run 省略或 true）只回目前狀態與會改什麼，不寫入；" +
  "向使用者說明預覽、取得同意後，用同樣參數加 dry_run=false 再呼叫一次才會執行（執行前會重新檢查一次）。";

/** action 的回傳 → MCP 結果。action 回 undefined 代表成功。 */
function outcomeText(out: ActionOutcome, fallbackOk: string) {
  if (out && out.error) return errText(out.error);
  return jsonText({ ok: true, executed: true, message: (out && out.ok) || fallbackOk });
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
 * 預覽制（比照小時光書店的 dry_run）。
 *
 * dry_run 省略或 true：只讀資料庫、回預覽，唯一的寫入是一筆 mcp.preview.<工具名> 稽核。
 * dry_run=false：**重新**預檢（不沿用上一次預覽），條件成立才以機器身分呼叫原本的 action。
 * 沒有 token：參數就是請求本身，執行與否只看此刻資料庫的狀態，跟小時光一致。
 */
async function previewOrRun(tool: string, dryRun: boolean | undefined, build: () => Promise<Preview>) {
  let p: Preview;
  try {
    p = await build();
  } catch (err) {
    console.error("[mcp] 預檢例外", tool, err);
    return errText("讀取資料失敗，請稍後再試。資料沒有被改動。");
  }
  if (!p.ok) return errText(p.error);

  if (dryRun !== false) {
    await writeAudit(MCP_ACTOR, {
      action: `${MCP_PREVIEW_ACTION_PREFIX}${tool}`,
      entity: p.entity,
      entityId: p.entityId,
      summary: `AI 透過 MCP 預覽「${tool}」：${p.ref}（只預覽，未執行）`,
      diff: { will_execute: p.willExecute },
    });
    return jsonText({
      dry_run: true,
      executed: false,
      target: p.ref,
      current: p.current,
      will_execute: p.willExecute,
      ...(p.willExecute ? { preview: p.message } : { blocked_reason: p.message }),
      next_step: p.willExecute
        ? "這只是預覽，還沒有執行。請把 preview 告訴使用者、取得明確同意後，用完全相同的參數加上 dry_run=false 再呼叫一次。"
        : "目前條件不符，用 dry_run=false 呼叫也會被拒絕。",
    });
  }

  if (!p.willExecute) return errText(p.message);
  return asMachine(p.okMessage, p.run);
}

/**
 * 兩步確認（只剩 resend_setup_email）。
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
 * 申請制（request_refund / request_invoice_void）。
 *
 * 🔴 不退款、不作廢、不給任何連結。回給 AI 的只有文字。
 */
async function fileRequest(kind: "refund" | "invoice_void", order: string, reason: string) {
  try {
    const r = await createMcpRequest(kind, order, reason);
    if (r.status === "error") return errText(r.message);
    return jsonText({
      requested: r.status === "created",
      already_pending: r.status === "already_pending",
      executed: false,
      message: r.message,
    });
  } catch (err) {
    console.error("[mcp] 建立申請例外", kind, err);
    return errText("讀取或寫入資料失敗，申請沒有建立。請稍後再試，或直接通知負責人。");
  }
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
          "actor_role 是 mcp 的代表那一筆是透過這個 MCP 做的，不是人在後台按的。" +
          "預覽紀錄（action 以 mcp.preview. 開頭）預設不列，要看請在 action 填 mcp.preview。",
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
     * 2026-11-10 業主拍板，改成跟小時光書店一樣的做法。AI 可以被 prompt injection，
     * 所以：
     *
     *   申請制  退款、作廢發票。MCP 只在 audit_log 留一筆申請，負責人在後台首頁
     *           看到、進訂單頁用原本的按鈕處理。AI 沒有任何路徑能讓錢移動或作廢
     *           發票，也拿不到任何可以點的連結。
     *   預覽制  其他寫入。dry_run 預設 true：只回會改什麼；同樣參數加 dry_run=false
     *           再呼叫才執行，執行前重新檢查一次。
     *   兩步確認 只剩 resend_setup_email（會真的寄信，含冷卻）。
     *
     * 拿掉的工具：refund_order、mark_refunded_manually、void_invoice、
     * force_grant_entitlements、delete_product、delete_session（以及「本人確認」連結）。
     *
     * 🔴 每一支 server action 自己的冪等條件式 update、「先退錢後改狀態」等順序
     *    保證全部原封不動 —— 這裡只做包裝，不重寫任何業務邏輯。
     */

    /* ---------------------------------------------------- 申請制 */

    server.registerTool(
      "request_refund",
      {
        title: "申請退款（不會退款）",
        description:
          "為一筆「已收款」的訂單提出退款申請，留給負責人在後台處理。" +
          "⚠️ 這個工具不會退款、不會呼叫黑貓 PAY、不會改訂單狀態，也不會回傳任何連結；" +
          "只會在後台首頁與訂單頁出現一筆待處理申請，由負責人用訂單頁原本的「退款」按鈕處理或關閉申請。" +
          "同一張訂單已經有待處理的退款申請時不會重複建立；負責人關閉申請後 7 天內不接受同樣的申請。沒有 dry_run：呼叫一次就建立申請，請先向使用者確認。",
        inputSchema: z.object({
          order: ORDER_ARG,
          reason: z
            .string()
            .max(1000)
            .describe(`退款原因，${REFUND_REASON_MAX} 字以內（會顯示給負責人，並標明是 AI 提供的）`),
        }),
        // 不動錢、不改訂單，只新增一筆申請紀錄；重複呼叫不會重複建立
        annotations: { ...WRITE, destructiveHint: false, idempotentHint: true },
      },
      async ({ order, reason }) => fileRequest("refund", order, reason),
    );

    server.registerTool(
      "request_invoice_void",
      {
        title: "申請作廢發票（不會作廢）",
        description:
          "為一張「已開立且有號碼」的電子發票提出作廢申請，留給負責人在後台處理。" +
          "⚠️ 這個工具不會作廢發票、不會呼叫 Amego、不會退款，也不會回傳任何連結；" +
          "只會在後台首頁與訂單頁出現一筆待處理申請，由負責人用訂單頁原本的「作廢這張發票」按鈕處理或關閉申請。" +
          `作廢原因最多 ${VOID_REASON_MAX} 字（跟後台作廢發票一樣）。同一張訂單已經有待處理的作廢申請時不會重複建立；負責人關閉申請後 7 天內不接受同樣的申請。` +
          "沒有 dry_run：呼叫一次就建立申請，請先向使用者確認。",
        inputSchema: z.object({
          order: ORDER_ARG,
          reason: z
            .string()
            .max(1000)
            .describe(`作廢原因，${VOID_REASON_MAX} 字以內`),
        }),
        annotations: { ...WRITE, destructiveHint: false, idempotentHint: true },
      },
      async ({ order, reason }) => fileRequest("invoice_void", order, reason),
    );

    /* ---------------------------------------------------- 預覽制 */

    server.registerTool(
      "mark_order_paid",
      {
        title: "標記已收款（只限 ATM／人工，先預覽）",
        description:
          "把「待收款」訂單標記為已收款：佔用工作坊名額、開通線上課程、寄開通通知信給客人，之後不能改回待收款。" +
          "⚠️ 只限付款方式是 ATM 轉帳（atm）或人工／臨櫃（manual）的訂單。" +
          "線上刷卡（credit／黑貓 PAY）的訂單一律拒絕：請到黑貓 PAY 後台核對，金流商沒通知收款不能手動標記。" +
          "金額由資料庫決定，不接受指定金額。請先確認款項確實已入帳。" +
          DRY_RUN_NOTE,
        inputSchema: z.object({ order: ORDER_ARG, dry_run: DRY_RUN_ARG }),
        annotations: { ...WRITE, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ order, dry_run }) =>
        previewOrRun("mark_order_paid", dry_run, () => previewMarkOrderPaid(db(), order)),
    );

    server.registerTool(
      "reissue_invoice",
      {
        title: "補開發票（先預覽）",
        description:
          "為「已收款」且還沒開出發票的訂單透過 Amego 開立電子發票（跟後台「補開發票」按鈕相同條件）。" +
          "已開立或已作廢的發票不會執行；不會作廢、不會退款。Amego 上已經有的會認回，不會重複開立。" +
          "預覽會說明目前發票狀態與會不會執行。" +
          DRY_RUN_NOTE,
        inputSchema: z.object({ order: ORDER_ARG, dry_run: DRY_RUN_ARG }),
        annotations: { ...WRITE, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ order, dry_run }) =>
        previewOrRun("reissue_invoice", dry_run, () => previewReissueInvoice(db(), order)),
    );

    server.registerTool(
      "cancel_order",
      {
        title: "取消訂單（只限待收款，先預覽）",
        description:
          "取消一筆「待收款」的訂單。已收款的訂單不能取消（要退款請用 request_refund 提出申請）。" +
          "取消是最終狀態，不能改回；不會動到錢。" +
          DRY_RUN_NOTE,
        inputSchema: z.object({ order: ORDER_ARG, dry_run: DRY_RUN_ARG }),
        annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
      },
      async ({ order, dry_run }) =>
        previewOrRun("cancel_order", dry_run, () => previewCancelOrder(db(), order)),
    );

    server.registerTool(
      "adjust_seats",
      {
        title: "微調場次名額（先預覽）",
        description:
          "把某場次的已報名人數加 1 或減 1（一次只能 ±1），用在現場報名、電話保留位等不經過訂單的情況。" +
          "不會建立或修改任何訂單。" +
          DRY_RUN_NOTE,
        inputSchema: z.object({
          session_id: z.string().uuid().describe("workshop_sessions.id"),
          delta: z.union([z.literal(1), z.literal(-1)]).describe("1 加一人／-1 減一人"),
          dry_run: DRY_RUN_ARG,
        }),
        annotations: { ...WRITE, destructiveHint: false, idempotentHint: false },
      },
      async ({ session_id, delta, dry_run }) =>
        previewOrRun("adjust_seats", dry_run, () => previewAdjustSeats(db(), session_id, delta)),
    );

    server.registerTool(
      "set_session_status",
      {
        title: "開關場次報名（先預覽）",
        description:
          "把工作坊場次改成開放報名（open）、暫停報名（closed）或已取消（cancelled），照後台的狀態規則。" +
          "「已額滿」由系統依名額自動判定，不能手動設定。不會取消或退款任何訂單。" +
          DRY_RUN_NOTE,
        inputSchema: z.object({
          session_id: z.string().uuid().describe("workshop_sessions.id"),
          status: z
            .enum(["open", "closed", "cancelled"])
            .describe("open 開放報名／closed 暫停報名／cancelled 已取消"),
          dry_run: DRY_RUN_ARG,
        }),
        annotations: { ...WRITE, destructiveHint: false, idempotentHint: true },
      },
      async ({ session_id, status, dry_run }) =>
        previewOrRun("set_session_status", dry_run, () => previewSetSessionStatus(db(), session_id, status)),
    );

    server.registerTool(
      "publish_product",
      {
        title: "發布課程（先預覽）",
        description:
          "把課程／工作坊從草稿改成發布中，前台會看得到。不會改內容或價格；隨時可以用 unpublish_product 下架。" +
          DRY_RUN_NOTE,
        inputSchema: z.object({ product_id: z.string().uuid().describe("products.id"), dry_run: DRY_RUN_ARG }),
        annotations: { ...WRITE, destructiveHint: false, idempotentHint: true },
      },
      async ({ product_id, dry_run }) =>
        previewOrRun("publish_product", dry_run, () => previewTogglePublish(db(), product_id, true)),
    );

    server.registerTool(
      "unpublish_product",
      {
        title: "下架課程（先預覽）",
        description:
          "把課程／工作坊改回草稿，前台看不到。不會刪除課程，已購買的學員不受影響；隨時可以用 publish_product 再發布。" +
          DRY_RUN_NOTE,
        inputSchema: z.object({ product_id: z.string().uuid().describe("products.id"), dry_run: DRY_RUN_ARG }),
        annotations: { ...WRITE, destructiveHint: false, idempotentHint: true },
      },
      async ({ product_id, dry_run }) =>
        previewOrRun("unpublish_product", dry_run, () => previewTogglePublish(db(), product_id, false)),
    );

    server.registerTool(
      "set_waitlist_status",
      {
        title: "更新候補狀態（先預覽）",
        description:
          "更新一筆候補登記的狀態。正常流程是 waiting 候補中 → offered 已通知 → converted 已轉正式報名；" +
          "未結束的都可以改成 cancelled。⚠️ cancelled 是終點，改了就不能復原。不會建立訂單、不會通知客人。" +
          DRY_RUN_NOTE,
        inputSchema: z.object({
          waitlist_id: z.string().uuid().describe("workshop_waitlist.id（get_session_waitlist 查得到）"),
          status: z
            .enum(WAITLIST_STATUSES)
            .describe("waiting 候補中／offered 已通知／converted 已轉正式報名／cancelled 已取消"),
          dry_run: DRY_RUN_ARG,
        }),
        // cancelled 是終點，所以誠實標成 destructive
        annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
      },
      async ({ waitlist_id, status, dry_run }) =>
        previewOrRun("set_waitlist_status", dry_run, () => previewSetWaitlistStatus(db(), waitlist_id, status)),
    );

    server.registerTool(
      "regrant_entitlements",
      {
        title: "重新開通課程（先預覽）",
        description:
          "依「已收款」訂單的品項補開通線上課程觀看權限（已開通的不會重複）。有新開通時會寄一封開通通知信給客人（同一筆訂單只寄一次）。" +
          "金額未核對的訂單不會執行（要由負責人在後台核對）；不會改訂單狀態、不會收款或退款。" +
          DRY_RUN_NOTE,
        inputSchema: z.object({ order: ORDER_ARG, dry_run: DRY_RUN_ARG }),
        annotations: { ...WRITE, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ order, dry_run }) =>
        previewOrRun("regrant_entitlements", dry_run, () => previewRegrant(db(), order)),
    );

    server.registerTool(
      "revoke_course_access",
      {
        title: "關閉課程觀看權限（先預覽）",
        description:
          "關閉訂單綁定的會員帳號對某門課的觀看權限（只限這張訂單買的課），客人會立刻看不到課。" +
          "帳號由訂單決定，不能另外指定。不會退款、不會改訂單狀態；要恢復請用 regrant_entitlements。" +
          DRY_RUN_NOTE,
        inputSchema: z.object({
          order: ORDER_ARG,
          product_id: z.string().uuid().describe("要關閉的課程 products.id"),
          dry_run: DRY_RUN_ARG,
        }),
        annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
      },
      async ({ order, product_id, dry_run }) =>
        previewOrRun("revoke_course_access", dry_run, () => previewRevoke(db(), order, product_id)),
    );

    /* ---------------------------------------------------- 兩步確認 */

    server.registerTool(
      "resend_setup_email",
      {
        title: "重寄設定密碼信（兩步確認）",
        description:
          "重寄「設定密碼」信到訂單的聯絡信箱（客人說沒收到信時用）。每執行一次就會真的寄一封；同一個帳號 10 分鐘內只能重寄一次。" +
          "不會改訂單或帳號資料。" +
          "兩步確認：第一次呼叫不要帶 confirm_token，會回預覽與 confirm_token；" +
          "取得使用者同意後，用完全相同的參數加上 confirm_token 再呼叫一次才會寄出。",
        inputSchema: z.object({ order: ORDER_ARG, confirm_token: CONFIRM_TOKEN_ARG }),
        annotations: { ...WRITE, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ order, confirm_token }) => {
        let orderId: string | null;
        try {
          orderId = await resolveOrderId(db(), order);
        } catch (err) {
          console.error("[mcp] 解析訂單例外", err);
          return errText("讀取訂單失敗，請稍後再試。");
        }
        if (!orderId) return errText(`找不到訂單 ${order}。`);
        const id = orderId;
        return twoStep("resend_setup_email", { order_id: id }, confirm_token, () => resendSetupEmail(id));
      },
    );
  },
  { serverInfo: { name: "happyhands", version: "2.0.0" } },
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
