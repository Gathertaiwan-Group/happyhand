/**
 * MCP 第二批工具（lib/mcp/ops-tools.ts）的流程測試 + 後台抽核心後行為不變的測試。
 * 用記憶體裡的假資料庫（lib/mcp/ops-test-mocks.ts 的 memoryDb），不碰正式站、不連網。
 *
 * 跑法（repo 根目錄）：
 *
 *   echo "" > /tmp/empty.js
 *   M=./apps/web/lib/mcp/ops-test-mocks.ts
 *   node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     apps/web/lib/mcp/ops-tools-flow.test.ts --bundle --platform=node --format=cjs \
 *     --external:@opentelemetry/api \
 *     --alias:@=./apps/web --alias:server-only=/tmp/empty.js --alias:sharp=/tmp/empty.js \
 *     --alias:next/navigation=$M --alias:next/cache=$M --alias:@/lib/admin/guard=$M \
 *     --alias:@/lib/admin/audit=$M --alias:@/lib/supabase/server=$M \
 *     --alias:@/lib/account/provision=$M --alias:@/lib/admin/entitlements=$M \
 *     --outfile=/tmp/ops-tools-flow.test.cjs
 *   node --test /tmp/ops-tools-flow.test.cjs
 *   # 想看後台三支 action 的完整輸出（給新舊版比對用）：HH_DUMP=/tmp/out.json node --test …
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { registerOpsTools, type RunAs } from "./ops-tools";
import { signToken } from "@/lib/admin/mcp-token";
import { rebindOrderAccount } from "@/app/admin/orders/account-actions";
import { markHandled, markUnhandled } from "@/app/admin/inquiries/actions";
import { addWaitlistEntry } from "@/app/admin/sessions/actions";
import { memoryDb, resetMocks, RedirectSignal, type MemState, type MockStaff } from "./ops-test-mocks";

process.env.MCP_TOKEN = "test-secret-for-ops-tools-flow-0123456789";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
type Schema = { parse: (v: unknown) => Record<string, unknown> };

const tools = new Map<string, { schema: Schema; handler: Handler }>();
const server = {
  registerTool(name: string, meta: { inputSchema: Schema }, handler: Handler) {
    tools.set(name, { schema: meta.inputSchema, handler });
  },
};
const run: RunAs = async (fallbackOk, fn) => {
  const out = await fn();
  if (out && out.error) return { content: [{ type: "text", text: out.error }], isError: true };
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, message: (out && out.ok) || fallbackOk }) }] };
};
registerOpsTools(server as never, run);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function call(name: string, args: Record<string, unknown>) {
  const t = tools.get(name);
  assert.ok(t, name);
  const res = await t.handler(t.schema.parse(args));
  const text = res.content[0].text;
  return { isError: res.isError === true, text, json: res.isError ? null : (JSON.parse(text) as Json) };
}

/** MCP 靜態 token 的機器身分：id 是空字串（不是 auth.users 裡的人） */
const MACHINE: MockStaff = { id: "", email: "mcp", role: "owner", via: "mcp" };
const HUMAN: MockStaff = { id: "99999999-0000-4000-8000-000000000001", email: "staff@hh", role: "owner" };

const ORDER_ID = "11111111-0000-4000-8000-000000000001";
const OLD_USER = "aaaaaaaa-0000-4000-8000-0000000000a1";
const OTHER_USER = "aaaaaaaa-0000-4000-8000-0000000000b2";
const COURSE_A = "22222222-0000-4000-8000-00000000000a";
const COURSE_B = "22222222-0000-4000-8000-00000000000b";
const SESSION_ID = "33333333-0000-4000-8000-000000000001";
const INQ_PENDING = "44444444-0000-4000-8000-000000000001";
const INQ_DONE = "44444444-0000-4000-8000-000000000002";

function fixture(): MemState {
  const users: MemState["users"] = {
    "old@example.com": { id: OLD_USER, email: "old@example.com" },
    "other@example.com": { id: OTHER_USER, email: "other@example.com" },
  };
  const state: MemState = {
    users,
    log: [],
    writesThrow: false,
    rpcs: {
      find_auth_user_id: ({ p_email }) => ({ data: users[String(p_email)]?.id ?? null }),
      count_pending_inquiries: () => ({ data: 1 }),
      count_unfulfilled_paid_orders: () => ({ data: 1 }),
      list_unfulfilled_paid_orders: () => ({ data: [{ id: ORDER_ID, order_no: "HH-20261101-AAAA" }] }),
      count_invoice_alerts: () => ({ data: [{ pending_overdue: 1, stuck_issuing: 0, exhausted: 0 }] }),
      count_payment_alerts: () => ({ data: 2 }),
      count_payment_unverified: () => ({ data: 0 }),
    },
    tables: {
      orders: [
        {
          id: ORDER_ID,
          order_no: "HH-20261101-AAAA",
          status: "paid",
          user_id: OLD_USER,
          contact_email: "old@example.com",
          contact_name: "王小明",
          contact_phone: "0912345678",
          total: 3600,
          paid_at: "2026-11-01T02:00:00.000Z",
          created_at: "2026-11-01T01:00:00.000Z",
          updated_at: "2026-11-01T02:00:00.000Z",
        },
      ],
      products: [
        { id: COURSE_A, title: "讀脈入門", type: "course" },
        { id: COURSE_B, title: "仁神術線上課", type: "course" },
      ],
      order_items: [
        { id: "i1", order_id: ORDER_ID, product_id: COURSE_A, qty: 1, unit_price: 1800 },
        { id: "i2", order_id: ORDER_ID, product_id: COURSE_B, qty: 1, unit_price: 1800 },
      ],
      entitlements: [
        { user_id: OLD_USER, product_id: COURSE_A, order_id: ORDER_ID, expires_at: null },
        { user_id: OLD_USER, product_id: COURSE_B, order_id: ORDER_ID, expires_at: null },
      ],
      workshop_sessions: [
        {
          id: SESSION_ID,
          product_id: COURSE_A,
          starts_at: "2026-12-01T06:00:00.000Z",
          ends_at: "2026-12-01T08:00:00.000Z",
          location: "台北教室",
          address: null,
          capacity: 10,
          seats_taken: 10,
          status: "full",
        },
      ],
      workshop_waitlist: [
        { id: "w1", session_id: SESSION_ID, name: "陳阿姨", phone: "0911-222-333", email: null, note: null, status: "waiting", created_at: "2026-11-02T00:00:00.000Z" },
        { id: "w2", session_id: SESSION_ID, name: "林先生", phone: "0922000000", email: "lin@example.com", note: null, status: "cancelled", created_at: "2026-11-03T00:00:00.000Z" },
      ],
      ai_chat_logs: [
        {
          id: INQ_PENDING,
          session_id: "s1",
          created_at: "2026-11-10T03:00:00.000Z",
          contact_name: "張小姐",
          contact_email: "chang@example.com",
          contact_phone: "0933000000",
          contact_line: null,
          summary: "想問讀脈課的時間",
          first_question: "讀脈課什麼時候開？",
          intent: "course",
          has_contact: true,
          handled_at: null,
          handled_by: null,
          message_count: 2,
          messages: [
            { role: "user", text: "讀脈課什麼時候開？" },
            { role: "model", text: "下一場是 12/1。" },
          ],
          user_ip: "203.0.113.9",
          user_agent: "Mozilla/5.0",
          handled_note: "內部備註",
          last_reply: "下一場是 12/1。",
        },
        {
          id: INQ_DONE,
          session_id: "s2",
          created_at: "2026-11-05T03:00:00.000Z",
          contact_name: null,
          contact_email: null,
          contact_phone: null,
          contact_line: null,
          summary: null,
          first_question: "有停車位嗎",
          intent: null,
          has_contact: false,
          handled_at: "2026-11-06T00:00:00.000Z",
          handled_by: HUMAN.id,
          message_count: 2,
          messages: [],
          user_ip: "203.0.113.10",
          user_agent: "x",
          handled_note: null,
          last_reply: null,
        },
      ],
      email_outbox: [
        {
          id: "e1",
          dedupe_key: `order_paid:${ORDER_ID}`,
          to_email: "old@example.com",
          status: "failed",
          attempts: 5,
          last_error: "rejected recipient old@example.com",
          updated_at: "2026-11-02T00:00:00.000Z",
        },
      ],
      invoices: [
        { id: "inv1", order_id: ORDER_ID, status: "pending", retry_count: 2, last_error: "Amego 逾時", claimed_at: null },
      ],
      payment_events: [
        { id: "p1", order_id: ORDER_ID, order_no: "HH-20261101-AAAA", status_code: "B", amount: 3600, outcome: "amount_mismatch", note: null, raw: { card: "secret" }, created_at: new Date(Date.now() - 2 * 86400000).toISOString() },
        { id: "p2", order_id: null, order_no: "HH-X", status_code: "B", amount: 100, outcome: "order_not_found", note: null, raw: {}, created_at: new Date(Date.now() - 86400000).toISOString() },
        { id: "p3", order_id: null, order_no: "HH-Y", status_code: "D", amount: 100, outcome: "order_not_found", note: null, raw: {}, created_at: new Date(Date.now() - 86400000).toISOString() },
      ],
      audit_log: [],
    },
  };
  return state;
}

/** 新的假資料庫 + 指定身分。audit_log 由 test-mocks 的 writeAudit 記在記憶體（hh.audits）。 */
function setup(staff: MockStaff | null = MACHINE) {
  const state = fixture();
  const db = memoryDb(state);
  const hh = resetMocks(db, staff as never);
  // 稽核同步進 audit_log 表，冪等查詢（diff->>idempotency_key）才查得到
  const origPush = hh.audits.push.bind(hh.audits);
  hh.audits.push = (...items) => {
    for (const a of items) {
      state.tables.audit_log.push({
        action: a.input.action,
        entity_id: a.input.entityId ?? null,
        diff: a.input.diff ?? null,
        created_at: new Date().toISOString(),
      });
    }
    return origPush(...items);
  };
  return { state, hh };
}

const writes = (s: MemState) => s.log.filter((o) => o.kind === "insert" || o.kind === "update" || o.kind === "delete");

/* ================================================================ rebind_order_account */

test("rebind：第一步只回預覽與 token，不寫任何東西（連稽核都沒有）", async () => {
  const { state, hh } = setup();
  state.writesThrow = true;
  const r = await call("rebind_order_account", { order: "HH-20261101-AAAA", new_email: "  New@Example.com " });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json?.status, "needs_confirmation");
  assert.equal(r.json?.executed, false);
  const p = r.json?.preview;
  assert.equal(p.order_no, "HH-20261101-AAAA");
  assert.equal(p.email_from, "old@example.com");
  assert.equal(p.email_to, "new@example.com");
  assert.equal(p.new_email_has_account, false);
  assert.deepEqual([...p.courses_to_move].sort(), ["仁神術線上課", "讀脈入門"]);
  assert.equal(p.will_grant_courses, true);
  assert.equal(writes(state).length, 0);
  assert.equal(hh.audits.length, 0);
  assert.equal(Object.keys(state.users).length, 2, "預覽不建帳號");
  assert.equal(r.json?.expires_in_minutes, 10);
});

test("rebind：token 綁定訂單與新信箱；換信箱、竄改、過期都拒絕；正確才執行且只能用一次", async () => {
  const { state, hh } = setup();
  const first = await call("rebind_order_account", { order: "HH-20261101-AAAA", new_email: "new@example.com" });
  const token = first.json?.confirm_token as string;
  assert.ok(token);

  // 換成別的信箱（例如被注入的 AI 想轉給 other@）
  const swapped = await call("rebind_order_account", { order: "HH-20261101-AAAA", new_email: "other@example.com", confirm_token: token });
  assert.equal(swapped.isError, true);
  assert.match(swapped.text, /參數與產生 confirm_token 時不同/);

  // 竄改簽章
  const tampered = await call("rebind_order_account", { order: ORDER_ID, new_email: "new@example.com", confirm_token: token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA") });
  assert.equal(tampered.isError, true);

  // 別的工具發的 token 不能用
  const foreign = signToken(process.env.MCP_TOKEN!, {
    kind: "twostep",
    tool: "resend_setup_email",
    args: { order_id: ORDER_ID, new_email: "new@example.com" },
    state: "x",
  }).token;
  const wrongTool = await call("rebind_order_account", { order: ORDER_ID, new_email: "new@example.com", confirm_token: foreign });
  assert.equal(wrongTool.isError, true);
  assert.match(wrongTool.text, /不是這個工具發的/);

  // 過期
  const expired = signToken(
    process.env.MCP_TOKEN!,
    { kind: "twostep", tool: "rebind_order_account", args: { order_id: ORDER_ID, new_email: "new@example.com" }, state: "x" },
    Math.floor(Date.now() / 1000) - 11 * 60,
  ).token;
  const late = await call("rebind_order_account", { order: ORDER_ID, new_email: "new@example.com", confirm_token: expired });
  assert.equal(late.isError, true);
  assert.match(late.text, /過期/);

  assert.equal(writes(state).length, 0, "以上全部都不該寫入");

  // 正確（用訂單 UUID 也行：token 綁的是解析後的訂單 id）
  const ok = await call("rebind_order_account", { order: ORDER_ID, new_email: "NEW@example.com", confirm_token: token });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(ok.json?.executed, true);
  const order = state.tables.orders[0];
  assert.equal(order.contact_email, "new@example.com");
  const newUser = state.users["new@example.com"].id;
  assert.equal(order.user_id, newUser);
  const ents = state.tables.entitlements;
  assert.equal(ents.filter((e) => e.user_id === OLD_USER).length, 0, "舊帳號的課被移走");
  assert.equal(ents.filter((e) => e.user_id === newUser).length, 2, "新帳號拿到兩門課");
  const audit = hh.audits.find((a) => a.input.action === "order.rebind_account");
  assert.ok(audit);
  assert.equal(audit.staff.via, "mcp");
  assert.match(String(ok.json?.next_step), /resend_setup_email/);

  // 同一個 token 第二次：訂單已經變了（updated_at、信箱、帳號），拒絕
  const again = await call("rebind_order_account", { order: ORDER_ID, new_email: "new@example.com", confirm_token: token });
  assert.equal(again.isError, true);
  assert.match(again.text, /變動過|不需要重綁/);
  assert.equal(hh.audits.filter((a) => a.input.action === "order.rebind_account").length, 1);
});

test("rebind：預覽之後訂單被改過（例如後台有人先改），舊 token 失效", async () => {
  const { state } = setup();
  const first = await call("rebind_order_account", { order: ORDER_ID, new_email: "other@example.com" });
  assert.equal(first.json?.preview.new_email_has_account, true);
  state.tables.orders[0].updated_at = "2026-11-18T00:00:00.000Z";
  const r = await call("rebind_order_account", { order: ORDER_ID, new_email: "other@example.com", confirm_token: first.json?.confirm_token });
  assert.equal(r.isError, true);
  assert.match(r.text, /變動過/);
  assert.equal(state.tables.orders[0].contact_email, "old@example.com");
});

test("rebind：信箱與帳號都沒變、格式錯、找不到訂單都直接回中文錯誤", async () => {
  setup();
  const same = await call("rebind_order_account", { order: ORDER_ID, new_email: "OLD@example.com" });
  assert.equal(same.isError, true);
  assert.match(same.text, /不需要重綁/);
  const bad = await call("rebind_order_account", { order: ORDER_ID, new_email: "not-an-email" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /格式/);
  const missing = await call("rebind_order_account", { order: "HH-00000000-NONE", new_email: "a@b.co" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /找不到訂單/);
});

test("rebind：沒有 orders:write 權限就不能預覽也不能執行", async () => {
  setup(null);
  const r = await call("rebind_order_account", { order: ORDER_ID, new_email: "new@example.com" });
  assert.equal(r.isError, true);
});

/* ================================================================ 諮詢 */

test("list_inquiries：預設只列待跟進；不回後台頁面沒顯示的 IP／UA／內部備註", async () => {
  setup();
  const r = await call("list_inquiries", {});
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json?.view, "followup");
  assert.equal(r.json?.inquiries.length, 1);
  const row = r.json?.inquiries[0];
  assert.equal(row.inquiry_id, INQ_PENDING);
  assert.equal(row.status, "待跟進");
  assert.equal(row.contact.email, "chang@example.com");
  assert.equal(row.transcript, undefined, "預設不附對話");
  assert.doesNotMatch(r.text, /203\.0\.113|Mozilla|內部備註/);

  const all = await call("list_inquiries", { view: "all", include_transcript: true });
  assert.equal(all.json?.inquiries.length, 2);
  assert.equal(all.json?.inquiries[0].transcript[0].who, "訪客");

  const range = await call("list_inquiries", { view: "all", from: "2026-11-08", to: "2026-11-10" });
  assert.equal(range.json?.inquiries.length, 1);
  const badDate = await call("list_inquiries", { from: "2026-02-31" });
  assert.equal(badDate.isError, true);
  assert.match(badDate.text, /格式不對/);
});

test("mark_inquiry_handled：預覽不寫入；執行後已處理，機器身分 handled_by 寫 null；重複標記會擋", async () => {
  const { state, hh } = setup();
  state.writesThrow = true;
  const pv = await call("mark_inquiry_handled", { inquiry_id: INQ_PENDING });
  assert.equal(pv.isError, false, pv.text);
  assert.equal(pv.json?.dry_run, true);
  assert.deepEqual(pv.json?.confirm_args, { inquiry_id: INQ_PENDING, dry_run: false });
  assert.equal(writes(state).length, 0);
  assert.equal(hh.audits.length, 1);
  assert.equal(hh.audits[0].input.action, "mcp.preview.mark_inquiry_handled");
  assert.doesNotMatch(JSON.stringify(hh.audits[0].input), /張小姐|chang@/);

  state.writesThrow = false;
  const ex = await call("mark_inquiry_handled", pv.json?.confirm_args);
  assert.equal(ex.isError, false, ex.text);
  const row = state.tables.ai_chat_logs[0];
  assert.ok(row.handled_at);
  assert.equal(row.handled_by, null);
  assert.ok(hh.audits.some((a) => a.input.action === "inquiry.handled"));

  const again = await call("mark_inquiry_handled", { inquiry_id: INQ_PENDING, dry_run: false });
  assert.equal(again.isError, true);
  assert.match(again.text, /已經是「已處理」/);

  const back = await call("mark_inquiry_unhandled", { inquiry_id: INQ_PENDING, dry_run: false });
  assert.equal(back.isError, false, back.text);
  assert.equal(state.tables.ai_chat_logs[0].handled_at, null);

  const nf = await call("mark_inquiry_handled", { inquiry_id: "44444444-0000-4000-8000-0000000000ff" });
  assert.equal(nf.isError, true);
  assert.match(nf.text, /找不到這筆諮詢/);
});

test("mark_inquiry_handled：OAuth 真人身分執行時 handled_by 是本人 id", async () => {
  const { state } = setup({ ...HUMAN, via: "mcp" });
  const ex = await call("mark_inquiry_handled", { inquiry_id: INQ_PENDING, dry_run: false });
  assert.equal(ex.isError, false, ex.text);
  assert.equal(state.tables.ai_chat_logs[0].handled_by, HUMAN.id);
});

/* ================================================================ 候補 */

test("add_waitlist_entry：預覽不寫入、告知候補人數與重複；沒 key 不能執行；執行一次、重送不重複", async () => {
  const { state, hh } = setup();
  state.writesThrow = true;
  const pv = await call("add_waitlist_entry", {
    session_id: SESSION_ID,
    name: " 陳阿姨 ",
    phone: "0911222333",
    note: "想要兩位",
  });
  assert.equal(pv.isError, false, pv.text);
  const p = pv.json?.preview;
  assert.equal(p.waiting_now, 1);
  assert.equal(p.will_be_position, 2);
  assert.equal(p.already_on_list.length, 1);
  assert.equal(p.already_on_list[0].matched_by, "電話相同");
  assert.ok(p.warning);
  assert.equal(writes(state).length, 0);
  const key = pv.json?.confirm_args.idempotency_key;
  assert.match(key, /^mcp-/);

  // Email 相同也算（已取消的那筆也列出來，讓業主判斷）
  const pv2 = await call("add_waitlist_entry", { session_id: SESSION_ID, name: "林", phone: "000", email: "LIN@example.com" });
  assert.equal(pv2.json?.preview.already_on_list[0].status, "已取消");

  state.writesThrow = false;
  const noKey = await call("add_waitlist_entry", { session_id: SESSION_ID, name: "陳阿姨", phone: "0911222333", dry_run: false });
  assert.equal(noKey.isError, true);
  assert.match(noKey.text, /idempotency_key/);

  const ex = await call("add_waitlist_entry", pv.json?.confirm_args);
  assert.equal(ex.isError, false, ex.text);
  assert.equal(ex.json?.executed, true);
  const added = state.tables.workshop_waitlist.filter((w) => w.id === ex.json?.waitlist_id);
  assert.equal(added.length, 1);
  assert.equal(added[0].name, "陳阿姨");
  assert.equal(added[0].status, "waiting");
  assert.equal(added[0].created_by, null, "機器身分 created_by 寫 null（外鍵）");
  const audit = hh.audits.find((a) => a.input.action === "waitlist.create");
  assert.equal((audit?.input.diff as Json).idempotency_key, key);

  const replay = await call("add_waitlist_entry", pv.json?.confirm_args);
  assert.equal(replay.isError, false, replay.text);
  assert.equal(replay.json?.already_created, true);
  assert.equal(replay.json?.waitlist_id, ex.json?.waitlist_id);
  assert.equal(state.tables.workshop_waitlist.length, 3, "重送沒有多一筆");

  const nosession = await call("add_waitlist_entry", { session_id: "33333333-0000-4000-8000-0000000000ff", name: "a", phone: "1" });
  assert.equal(nosession.isError, true);
  assert.match(nosession.text, /找不到這個場次/);
});

/* ================================================================ 儀表板 */

test("get_dashboard：五個待處理數字與營收；list_problem_orders：照 RPC 條件、不讀 payment_events.raw", async () => {
  const { state } = setup();
  state.writesThrow = true;
  const d = await call("get_dashboard", {});
  assert.equal(d.isError, false, d.text);
  assert.equal(d.json?.needs_attention.unfulfilled_paid_orders.count, 1);
  assert.equal(d.json?.needs_attention.failed_emails.count, 1);
  assert.equal(d.json?.needs_attention.stuck_invoices.count, 1);
  assert.equal(d.json?.needs_attention.payment_alerts.count, 2);
  assert.equal(typeof d.json?.revenue.this_month.paid_total, "number");
  assert.equal(d.json?.upcoming_sessions.length, 1);

  const p = await call("list_problem_orders", {});
  assert.equal(p.isError, false, p.text);
  const g = Object.fromEntries((p.json?.groups as Json[]).map((x) => [x.kind, x]));
  assert.equal(g.unfulfilled.rows[0].order_no, "HH-20261101-AAAA");
  assert.match(g.unfulfilled.rows[0].next_step, /regrant_entitlements/);
  assert.equal(g.failed_email.rows[0].order_no, "HH-20261101-AAAA");
  assert.doesNotMatch(JSON.stringify(g.failed_email), /old@example\.com/, "收件人要遮罩");
  assert.equal(g.stuck_invoice.rows.length, 1);
  assert.match(g.stuck_invoice.rows[0].next_step, /reissue_invoice/);
  // 狀態碼 D 的 order_not_found 不算（照 count_payment_alerts）
  assert.equal(g.payment_alert.rows.length, 2);
  assert.equal(g.payment_alert.note, null, "清單筆數等於總覽數字");
  assert.ok(!state.log.some((o) => o.table === "payment_events" && /\braw\b/.test(o.columns ?? "")));
  assert.equal(writes(state).length, 0);
});

test("list_problem_orders：清單 RPC 不列的「沒綁帳號／金額未核對」也要列出來，並指向對的工具", async () => {
  const { state } = setup();
  state.writesThrow = true;
  state.rpcs.count_unfulfilled_paid_orders = () => ({ data: 3 });
  state.tables.orders.push(
    { id: "o-nouser", order_no: "HH-NOUSER", status: "paid", user_id: null, price_unverified: false, total: 1800, paid_at: "2026-11-02T00:00:00.000Z", created_at: "2026-11-02T00:00:00.000Z" },
    { id: "o-unver", order_no: "HH-UNVER", status: "paid", user_id: OLD_USER, price_unverified: true, total: 900, paid_at: "2026-11-03T00:00:00.000Z", created_at: "2026-11-03T00:00:00.000Z" },
    // 沒綁帳號但只買工作坊（不發 entitlement）→ 不算
    { id: "o-ws", order_no: "HH-WS", status: "paid", user_id: null, price_unverified: false, total: 500, paid_at: "2026-11-03T00:00:00.000Z", created_at: "2026-11-03T00:00:00.000Z" },
    // 沒綁帳號但還沒付款 → 不算
    { id: "o-pend", order_no: "HH-PEND", status: "pending", user_id: null, price_unverified: false, total: 500, paid_at: null, created_at: "2026-11-03T00:00:00.000Z" },
  );
  state.tables.products.push({ id: "p-ws", title: "工作坊", type: "workshop" });
  state.tables.order_items.push(
    { id: "i3", order_id: "o-nouser", product_id: COURSE_A, qty: 1, unit_price: 1800 },
    { id: "i4", order_id: "o-unver", product_id: COURSE_B, qty: 1, unit_price: 900 },
    { id: "i5", order_id: "o-ws", product_id: "p-ws", qty: 1, unit_price: 500 },
    { id: "i6", order_id: "o-pend", product_id: COURSE_A, qty: 1, unit_price: 500 },
  );
  const r = await call("list_problem_orders", { kind: "unfulfilled" });
  assert.equal(r.isError, false, r.text);
  const g = r.json?.groups[0];
  assert.deepEqual(g.rows.map((x: Json) => x.order_no), ["HH-NOUSER", "HH-UNVER", "HH-20261101-AAAA"]);
  assert.match(g.rows[0].next_step, /rebind_order_account/);
  assert.match(g.rows[1].next_step, /負責人/);
  assert.equal(g.note, null, "三筆＝總覽的 3");
});

test("add_waitlist_entry：同一個 idempotency_key 換了人，不會把別人那筆當成已登記", async () => {
  setup();
  const pv = await call("add_waitlist_entry", { session_id: SESSION_ID, name: "甲", phone: "0900000001" });
  const ex = await call("add_waitlist_entry", pv.json?.confirm_args);
  assert.equal(ex.isError, false, ex.text);
  const other = await call("add_waitlist_entry", { ...pv.json?.confirm_args, name: "乙", phone: "0900000002" });
  assert.equal(other.isError, true);
  assert.match(other.text, /另一位候補/);
});

/* ======================================================== 後台 action（抽核心後行為不變） */

const dump: Record<string, unknown> = {};
after(() => {
  if (process.env.HH_DUMP) writeFileSync(process.env.HH_DUMP, JSON.stringify(dump, null, 2));
});

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

async function redirectOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.destination;
    throw err;
  }
  return "(no redirect)";
}

function snapshot(state: MemState, hh: ReturnType<typeof setup>["hh"]) {
  return {
    writes: writes(state).map((o) => ({ table: o.table, kind: o.kind, filters: o.filters, values: scrubTimes(o.values) })),
    audits: hh.audits.map((a) => ({ staff: a.staff.id, input: a.input })),
    revalidated: hh.revalidated,
  };
}

function scrubTimes(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v ?? null), (_k, val) =>
    typeof val === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val) ? "<time>" : val,
  );
}

test("後台 rebindOrderAccount：各種輸入的回傳、寫入、稽核", async () => {
  const cases: [string, MockStaff | null, Record<string, string>][] = [
    ["改新信箱", HUMAN, { email: " New@Example.com " }],
    ["改成已有帳號的信箱", HUMAN, { email: "other@example.com" }],
    ["空白＝用原信箱重綁", HUMAN, { email: "" }],
    ["格式錯", HUMAN, { email: "abc" }],
    ["沒權限", null, { email: "x@y.co" }],
  ];
  for (const [name, staff, f] of cases) {
    const { state, hh } = setup(staff);
    const out = await rebindOrderAccount(ORDER_ID, {}, form(f));
    dump[`rebind:${name}`] = { out, ...snapshot(state, hh), order: scrubTimes(state.tables.orders[0]), ents: state.tables.entitlements };
  }
  const { state } = setup(HUMAN);
  const out = await rebindOrderAccount("11111111-0000-4000-8000-0000000000ff", {}, form({ email: "a@b.co" }));
  dump["rebind:找不到訂單"] = { out, writes: writes(state).length };
  assert.deepEqual(out, { error: "找不到這筆訂單，請重新整理後再試。" });
  assert.match(String((dump["rebind:改新信箱"] as Json).out.ok), /已綁定 new@example\.com，並開通了 2 門課。這是新建立的帳號/);
  assert.deepEqual((dump["rebind:格式錯"] as Json).out, { error: "Email 格式看起來不太對，請再檢查一次。" });
  assert.equal((dump["rebind:沒權限"] as Json).writes.length, 0);
});

test("後台 markHandled／markUnhandled：redirect 目的地、寫入、稽核", async () => {
  const cases: [string, MockStaff | null, "h" | "u", Record<string, string>][] = [
    ["標記已處理（帶 back）", HUMAN, "h", { id: INQ_PENDING, back: "/admin/inquiries?view=all" }],
    ["標記已處理（無 back）", HUMAN, "h", { id: INQ_PENDING }],
    ["改回待處理", HUMAN, "u", { id: INQ_DONE, back: "/admin/inquiries?view=followup" }],
    ["back 不是本頁", HUMAN, "h", { id: INQ_PENDING, back: "https://evil.test/" }],
    ["壞 id", HUMAN, "h", { id: "nope" }],
    ["不存在", HUMAN, "h", { id: "44444444-0000-4000-8000-0000000000ff" }],
    ["沒權限", null, "h", { id: INQ_PENDING }],
  ];
  for (const [name, staff, which, f] of cases) {
    const { state, hh } = setup(staff);
    const dest = await redirectOf(() => (which === "h" ? markHandled(form(f)) : markUnhandled(form(f))));
    dump[`inquiry:${name}`] = { dest, ...snapshot(state, hh) };
  }
  assert.equal((dump["inquiry:標記已處理（帶 back）"] as Json).dest, "/admin/inquiries?view=all&msg=handled");
  assert.equal((dump["inquiry:back 不是本頁"] as Json).dest, "/admin/inquiries?msg=handled");
  assert.equal((dump["inquiry:壞 id"] as Json).dest, "/admin/inquiries?msg=bad_id");
  assert.equal((dump["inquiry:不存在"] as Json).dest, "/admin/inquiries?msg=failed");
  assert.equal((dump["inquiry:沒權限"] as Json).dest, "/admin/inquiries?msg=denied");
  assert.equal((dump["inquiry:改回待處理"] as Json).dest, "/admin/inquiries?view=followup&msg=reopened");
});

test("後台 addWaitlistEntry：redirect 代碼、寫入、稽核（不帶 idempotency_key）", async () => {
  const cases: [string, MockStaff | null, string, Record<string, string>][] = [
    ["正常", HUMAN, SESSION_ID, { name: " 黃小姐 ", phone: " 0955 ", email: " h@x.co ", note: "" }],
    ["缺電話", HUMAN, SESSION_ID, { name: "黃", phone: "  " }],
    ["名字太長", HUMAN, SESSION_ID, { name: "名".repeat(61), phone: "1" }],
    ["沒有這場", HUMAN, "33333333-0000-4000-8000-0000000000ff", { name: "黃", phone: "1" }],
    ["沒權限", null, SESSION_ID, { name: "黃", phone: "1" }],
  ];
  for (const [name, staff, sid, f] of cases) {
    const { state, hh } = setup(staff);
    const dest = await redirectOf(() => addWaitlistEntry(sid, form(f)));
    dump[`waitlist:${name}`] = { dest, ...snapshot(state, hh) };
  }
  const ok = dump["waitlist:正常"] as Json;
  assert.equal(ok.dest, `/admin/sessions/${SESSION_ID}?wl=ok#waitlist`);
  assert.deepEqual(ok.writes[0].values, {
    session_id: SESSION_ID,
    name: "黃小姐",
    phone: "0955",
    email: "h@x.co",
    note: null,
    status: "waiting",
    created_by: HUMAN.id,
  });
  assert.deepEqual(ok.audits[0].input.diff, { session_id: SESSION_ID, has_email: true, has_note: false });
  assert.equal((dump["waitlist:缺電話"] as Json).dest, `/admin/sessions/${SESSION_ID}?wl=missing#waitlist`);
  assert.equal((dump["waitlist:名字太長"] as Json).dest, `/admin/sessions/${SESSION_ID}?wl=toolong#waitlist`);
  assert.match((dump["waitlist:沒有這場"] as Json).dest, /wl=nosession/);
  assert.match((dump["waitlist:沒權限"] as Json).dest, /wl=denied/);
});
