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

/**
 * MCP server —— 讓 AI 客戶端（Claude Code / claude.ai 連接器）查這個站的後台。
 *
 * ## 這一版只有唯讀
 *
 * 刻意的。寫入（標記付款、退款、開發票）需要走後台既有的 server action，而那
 * 需要 lib/admin/machine.ts 的機器身分在授權層開一道口。那道口已經寫好了，但
 * 第一次部署不該同時賭「協定寫對了」與「授權層開的口是安全的」—— 先把這條線
 * 驗過能連、能用，寫入才疊上去。
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
  },
  { serverInfo: { name: "happyhands", version: "1.0.0" } },
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
