/**
 * MCP 第三批工具（lib/mcp/mobile-tools.ts）的流程測試。
 * 用記憶體裡的假資料庫（lib/mcp/ops-test-mocks.ts 的 memoryDb），不碰正式站、不連網、不寄信。
 *
 * 跑法（repo 根目錄）：
 *
 *   echo "" > /tmp/empty.js
 *   M=./apps/web/lib/mcp/ops-test-mocks.ts
 *   node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     apps/web/lib/mcp/mobile-tools-flow.test.ts --bundle --platform=node --format=cjs \
 *     --external:@opentelemetry/api \
 *     --alias:@=./apps/web --alias:server-only=/tmp/empty.js --alias:sharp=/tmp/empty.js \
 *     --alias:next/navigation=$M --alias:next/cache=$M --alias:@/lib/admin/guard=$M \
 *     --alias:@/lib/admin/audit=$M --alias:@/lib/supabase/server=$M \
 *     --alias:@/lib/account/provision=$M --alias:@/lib/admin/entitlements=$M \
 *     --alias:@/lib/email/outbox=$M \
 *     --outfile=/tmp/mobile-tools-flow.test.cjs
 *   node --test /tmp/mobile-tools-flow.test.cjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerMobileTools, resolveRange, validateOnlineLink } from "./mobile-tools";
import type { RunAs } from "./ops-tools";
import { DEFAULT_FAQ, findMedicalClaims, readFaq, validateFaq } from "@/lib/faq";
import { memoryDb, resetMocks, type MemState, type MockStaff } from "./ops-test-mocks";

process.env.MCP_TOKEN = "test-secret-for-mobile-tools-flow-0123456789";

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
registerMobileTools(server as never, run);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function call(name: string, args: Record<string, unknown>) {
  const t = tools.get(name);
  assert.ok(t, name);
  const res = await t.handler(t.schema.parse(args));
  const text = res.content[0].text;
  return { isError: res.isError === true, text, json: res.isError ? null : (JSON.parse(text) as Json) };
}

const OWNER: MockStaff = { id: "99999999-0000-4000-8000-000000000001", email: "owner@hh", role: "owner", via: "mcp" };

const ATM_ORDER = "11111111-0000-4000-8000-000000000001";
const CARD_ORDER = "11111111-0000-4000-8000-000000000002";
const PAID_ORDER = "11111111-0000-4000-8000-000000000003";
const COURSE = "22222222-0000-4000-8000-00000000000a";
const WORKSHOP = "22222222-0000-4000-8000-00000000000b";
const SESSION = "33333333-0000-4000-8000-000000000001";
const USER = "aaaaaaaa-0000-4000-8000-0000000000a1";

function future(days: number) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

function fixture(): MemState {
  const users: MemState["users"] = { "paid@example.com": { id: USER, email: "paid@example.com" } };
  return {
    users,
    log: [],
    writesThrow: false,
    rpcs: {
      find_auth_user_id: ({ p_email }) => ({ data: users[String(p_email)]?.id ?? null }),
    },
    tables: {
      orders: [
        {
          id: ATM_ORDER, order_no: "HH-20261101-ATM1", status: "pending", payment_method: "atm", payment_provider: null,
          total: 3600, price_unverified: false, user_id: null, contact_name: "王小明", contact_email: "atm@example.com",
          contact_phone: "0912345678", created_at: "2026-11-01T01:00:00.000Z", updated_at: "2026-11-01T01:00:00.000Z", paid_at: null,
        },
        {
          id: CARD_ORDER, order_no: "HH-20261101-CRD1", status: "pending", payment_method: "credit", payment_provider: "blackcat",
          total: 1800, price_unverified: false, user_id: null, contact_name: "李", contact_email: "card@example.com",
          contact_phone: "0922", created_at: "2026-11-01T02:00:00.000Z", updated_at: "2026-11-01T02:00:00.000Z", paid_at: null,
        },
        {
          id: PAID_ORDER, order_no: "HH-20261102-PAID", status: "paid", payment_method: "credit", payment_provider: "blackcat",
          total: 5400, price_unverified: false, user_id: USER, contact_name: "陳", contact_email: "paid@example.com",
          contact_phone: "0933", created_at: "2026-11-02T01:00:00.000Z", updated_at: "2026-11-02T01:00:00.000Z", paid_at: "2026-11-02T01:05:00.000Z",
        },
      ],
      products: [
        { id: COURSE, title: "仁神術線上課", type: "course" },
        { id: WORKSHOP, title: "讀脈直播", type: "workshop" },
      ],
      order_items: [
        { id: "i1", order_id: ATM_ORDER, product_id: COURSE, session_id: null, qty: 1, unit_price: 3600 },
        { id: "i2", order_id: CARD_ORDER, product_id: COURSE, session_id: null, qty: 1, unit_price: 1800 },
        { id: "i3", order_id: PAID_ORDER, product_id: COURSE, session_id: null, qty: 1, unit_price: 1800 },
        { id: "i4", order_id: PAID_ORDER, product_id: WORKSHOP, session_id: SESSION, qty: 2, unit_price: 1800 },
      ],
      entitlements: [{ user_id: USER, product_id: COURSE, order_id: PAID_ORDER, expires_at: null }],
      workshop_sessions: [
        {
          id: SESSION, product_id: WORKSHOP, starts_at: future(3), ends_at: future(3.1), location: "線上",
          address: null, capacity: 10, seats_taken: 2, status: "open", format: "online",
        },
      ],
      workshop_waitlist: [],
      email_outbox: [],
      site_settings: [],
    },
  };
}

function setup() {
  const state = fixture();
  resetMocks(memoryDb(state), OWNER);
  return state;
}

/* ------------------------------------------------------------ mark_order_paid */

test("mark_order_paid：刷卡單拒絕、金額不符拒絕、第一步不改訂單、token 綁金額與狀態", async () => {
  const state = setup();

  const card = await call("mark_order_paid", { order: "HH-20261101-CRD1", amount: 1800 });
  assert.equal(card.isError, true);
  assert.match(card.text, /不是 ATM 轉帳或人工收款|不能手動標記/);

  const wrong = await call("mark_order_paid", { order: "HH-20261101-ATM1", amount: 3000 });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /金額不符/);
  assert.ok(!wrong.text.includes("3600"), "金額不符時不能洩漏應收金額");

  state.writesThrow = true;
  const step1 = await call("mark_order_paid", { order: "HH-20261101-ATM1", amount: 3600 });
  assert.equal(step1.isError, false, step1.text);
  assert.equal(step1.json!.status, "needs_confirmation");
  assert.equal(step1.json!.preview.amount_matches, true);
  assert.equal(state.tables.orders[0].status, "pending");
  state.writesThrow = false;

  // token 換金額不能用（金額不同會先被金額檢查擋；換成另一張訂單也不行）
  const otherOrder = await call("mark_order_paid", { order: "HH-20261101-CRD1", amount: 1800, confirm_token: step1.json!.confirm_token });
  assert.equal(otherOrder.isError, true);

  // 訂單在這之間被改過 → token 失效
  state.tables.orders[0].updated_at = "2026-11-01T03:00:00.000Z";
  const stale = await call("mark_order_paid", { order: "HH-20261101-ATM1", amount: 3600, confirm_token: step1.json!.confirm_token });
  assert.equal(stale.isError, true);
  assert.equal(state.tables.orders[0].status, "pending");

  // 竄改 token
  const forged = await call("mark_order_paid", { order: "HH-20261101-ATM1", amount: 3600, confirm_token: step1.json!.confirm_token.slice(0, -4) + "AAAA" });
  assert.equal(forged.isError, true);
});

test("mark_order_paid：正確流程會呼叫後台同一支 action 把訂單改成已收款", async () => {
  const state = setup();
  const step1 = await call("mark_order_paid", { order: "HH-20261101-ATM1", amount: 3600 });
  assert.equal(step1.isError, false, step1.text);
  const step2 = await call("mark_order_paid", { order: "HH-20261101-ATM1", amount: 3600, confirm_token: step1.json!.confirm_token });
  assert.equal(step2.isError, false, step2.text);
  assert.equal(state.tables.orders[0].status, "paid");
  // 同一個 token 不能再用（狀態變了）
  const replay = await call("mark_order_paid", { order: "HH-20261101-ATM1", amount: 3600, confirm_token: step1.json!.confirm_token });
  assert.equal(replay.isError, true);
});

/* ------------------------------------------------------------ resend_order_email */

test("resend_order_email：種類與狀態要對、第一步不寄、第二步寄一封、10 分鐘冷卻", async () => {
  const state = setup();

  const bad = await call("resend_order_email", { order: "HH-20261102-PAID", kind: "order_created" });
  assert.equal(bad.isError, true);

  state.writesThrow = true;
  const step1 = await call("resend_order_email", { order: "HH-20261102-PAID", kind: "order_paid" });
  assert.equal(step1.isError, false, step1.text);
  assert.equal(step1.json!.preview.to, "pa***@example.com");
  assert.deepEqual(step1.json!.preview.courses, ["仁神術線上課"]);
  assert.equal(state.tables.email_outbox.length, 0);
  state.writesThrow = false;

  // token 不能拿去寄另一種信
  const swapped = await call("resend_order_email", { order: "HH-20261102-PAID", kind: "order_created", confirm_token: step1.json!.confirm_token });
  assert.equal(swapped.isError, true);

  const step2 = await call("resend_order_email", { order: "HH-20261102-PAID", kind: "order_paid", confirm_token: step1.json!.confirm_token });
  assert.equal(step2.isError, false, step2.text);
  assert.equal(state.tables.email_outbox.length, 1);
  assert.equal(state.tables.email_outbox[0].to_email, "paid@example.com");

  const replay = await call("resend_order_email", { order: "HH-20261102-PAID", kind: "order_paid", confirm_token: step1.json!.confirm_token });
  assert.equal(replay.isError, true);
  assert.equal(state.tables.email_outbox.length, 1);

  const again = await call("resend_order_email", { order: "HH-20261102-PAID", kind: "order_paid" });
  assert.equal(again.isError, true);
  assert.match(again.text, /10 分鐘/);
});

test("resend_order_email：待收款 ATM 單可補寄匯款資訊信", async () => {
  const state = setup();
  const s1 = await call("resend_order_email", { order: "HH-20261101-ATM1", kind: "order_created" });
  assert.equal(s1.isError, false, s1.text);
  const s2 = await call("resend_order_email", { order: "HH-20261101-ATM1", kind: "order_created", confirm_token: s1.json!.confirm_token });
  assert.equal(s2.isError, false, s2.text);
  assert.match(String(state.tables.email_outbox[0].body_text), /HH-20261101-ATM1/);
});

/* ------------------------------------------------------------ send_session_online_link */

test("send_session_online_link：只收白名單 https、預覽不寄、寄給已付款報名者、同連結不重寄", async () => {
  const state = setup();

  for (const link of ["http://zoom.us/j/1", "https://evil.example.com/zoom.us", "https://zoom.us.evil.com/j/1", "https://user:pw@zoom.us/j/1"]) {
    const r = await call("send_session_online_link", { session_id: SESSION, link });
    assert.equal(r.isError, true, link);
  }
  const noteUrl = await call("send_session_online_link", { session_id: SESSION, link: "https://us02web.zoom.us/j/123", note: "請看 bit.ly/x" });
  assert.equal(noteUrl.isError, true);

  state.writesThrow = true;
  const s1 = await call("send_session_online_link", { session_id: SESSION, link: "https://us02web.zoom.us/j/123?pwd=abc" });
  assert.equal(s1.isError, false, s1.text);
  assert.equal(s1.json!.preview.will_send_to, 1);
  state.writesThrow = false;

  const otherLink = await call("send_session_online_link", { session_id: SESSION, link: "https://meet.google.com/abc-defg-hij", confirm_token: s1.json!.confirm_token });
  assert.equal(otherLink.isError, true);
  assert.equal(state.tables.email_outbox.length, 0);

  const s2 = await call("send_session_online_link", { session_id: SESSION, link: "https://us02web.zoom.us/j/123?pwd=abc", confirm_token: s1.json!.confirm_token });
  assert.equal(s2.isError, false, s2.text);
  // 學員一封＋負責人副本一封
  assert.equal(state.tables.email_outbox.filter((m) => String(m.dedupe_key).startsWith("online_link:")).length, 1);
  assert.equal(state.tables.email_outbox.find((m) => String(m.dedupe_key).startsWith("online_link:"))!.to_email, "paid@example.com");
  assert.equal(state.tables.email_outbox.find((m) => String(m.dedupe_key).startsWith("online_link_copy:"))!.to_email, "owner@hh");

  const again = await call("send_session_online_link", { session_id: SESSION, link: "https://us02web.zoom.us/j/123?pwd=abc" });
  assert.equal(again.isError, false);
  assert.equal(again.json!.executed, false);
});

test("send_session_online_link：note 擋帳號／LINE／數字串；同一場最多 2 個不同連結", async () => {
  const state = setup();
  for (const note of ["請匯款到 012-345678901", "加 LINE 好友", "密碼 12345678"]) {
    const r = await call("send_session_online_link", { session_id: SESSION, link: "https://zoom.us/j/1", note });
    assert.equal(r.isError, true, note);
  }
  state.tables.email_outbox.push(
    { dedupe_key: `online_link:${SESSION}:aaaaaaaaaaaaaaaa:x`, created_at: "2026-11-01T00:00:00Z" },
    { dedupe_key: `online_link:${SESSION}:bbbbbbbbbbbbbbbb:x`, created_at: "2026-11-01T00:00:00Z" },
  );
  const r = await call("send_session_online_link", { session_id: SESSION, link: "https://zoom.us/j/9" });
  assert.equal(r.isError, true);
  assert.match(r.text, /不同的上課連結/);
});

test("mark_order_paid：每天上限", async () => {
  const state = setup();
  // 稽核由 mock 的 writeAudit 收走，這裡直接在 audit_log 假表放 10 筆今天的紀錄
  state.tables.audit_log = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, action: "mcp.mark_order_paid", created_at: new Date().toISOString() }));
  const r = await call("mark_order_paid", { order: "HH-20261101-ATM1", amount: 3600 });
  assert.equal(r.isError, true);
  assert.match(r.text, /上限/);
});

test("send_session_online_link：實體場次拒絕", async () => {
  const state = setup();
  state.tables.workshop_sessions[0].format = null;
  const r = await call("send_session_online_link", { session_id: SESSION, link: "https://zoom.us/j/1" });
  assert.equal(r.isError, true);
  assert.match(r.text, /實體課/);
});

test("validateOnlineLink 主機白名單", () => {
  assert.equal(validateOnlineLink("https://meet.google.com/abc").ok, true);
  assert.equal(validateOnlineLink("https://www.youtube.com/live/x").ok, true);
  assert.equal(validateOnlineLink("https://notzoom.us/j/1").ok, false);
  assert.equal(validateOnlineLink("javascript:alert(1)").ok, false);
});

/* ------------------------------------------------------------ FAQ */

test("FAQ：預設內容與原本頁面一致、醫療宣稱擋下、預覽不寫、confirm_args 寫入", async () => {
  assert.equal(DEFAULT_FAQ.groups.map((g) => g.title).join("|"), "課程相關|付款與寄送|工作坊");
  assert.ok(DEFAULT_FAQ.groups[0].items.length >= 4);
  assert.deepEqual(findMedicalClaims(DEFAULT_FAQ), []);
  assert.equal(readFaq({ groups: "bad" }), null);
  assert.equal(validateFaq({ groups: [{ title: "x", items: [{ q: "a", a: "" }] }] }).ok, false);

  const state = setup();
  const got = await call("get_faq", {});
  assert.equal(got.json!.source, "default");

  const groups = [...DEFAULT_FAQ.groups.map((g) => ({ ...g, items: [...g.items] }))];
  groups[2].items.push({ q: "可以帶朋友一起來嗎？", a: "可以，請朋友也報名一個名額。" });

  const med = await call("update_faq", { groups: [{ title: "課程", items: [{ q: "能治療腰痛嗎", a: "可以治療。" }] }] });
  assert.equal(med.isError, true);
  assert.match(med.text, /醫療宣稱/);

  state.writesThrow = true;
  const p = await call("update_faq", { groups });
  assert.equal(p.isError, false, p.text);
  assert.deepEqual(p.json!.preview.added, ["可以帶朋友一起來嗎？"]);
  state.writesThrow = false;

  const done = await call("update_faq", p.json!.confirm_args);
  assert.equal(done.isError, false, done.text);
  const row = state.tables.site_settings.find((r) => r.key === "faq");
  assert.ok(row);
  assert.equal(readFaq(row!.value)!.groups[2].items.length, groups[2].items.length);

  const same = await call("update_faq", p.json!.confirm_args);
  assert.match(same.text, /不需要更新/);
});

/* ------------------------------------------------------------ 報表 */

test("get_sales_summary／get_top_products：依付款時間、只算已付款", async () => {
  setup();
  const r = await call("get_sales_summary", { from: "2026-11-01", to: "2026-11-30" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json!.paid.orders, 1);
  assert.equal(r.json!.paid.revenue, 5400);
  assert.equal(r.json!.pending_created_in_period.orders, 2);
  const top = await call("get_top_products", { from: "2026-11-01", to: "2026-11-30", sort_by: "qty" });
  assert.equal(top.json!.top[0].title, "讀脈直播");
  assert.equal(top.json!.top[0].qty, 2);

  assert.equal(resolveRange("2026-01-01", "2027-06-01").ok, false);
  assert.equal(resolveRange("2026-11-30", "2026-11-01").ok, false);
});

test("export_roster_csv／export_orders_csv：CSV 防公式、記稽核", async () => {
  const state = setup();
  state.tables.orders[2].contact_name = "=HYPERLINK(1)";
  const r = await call("export_roster_csv", { session_id: SESSION });
  assert.equal(r.isError, false, r.text);
  assert.match(r.json!.csv, /'=HYPERLINK/);
  assert.match(r.json!.download_url, /\/api\/admin\/sessions\/.+\/roster\.csv$/);
  const o = await call("export_orders_csv", { from: "2026-11-01", to: "2026-11-30" });
  assert.equal(o.json!.rows, 3);
});

test("lookup_member：帳號、開通、訂單；不回帳號 id", async () => {
  setup();
  const r = await call("lookup_member", { email: "Paid@Example.com" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json!.account.exists, true);
  assert.deepEqual(r.json!.entitled_courses.map((e: Json) => e.course), ["仁神術線上課"]);
  assert.equal(r.json!.orders[0].order_no, "HH-20261102-PAID");
  assert.ok(!r.text.includes(USER));
  const none = await call("lookup_member", { email: "nobody@example.com" });
  assert.equal(none.json!.account.exists, false);
});

/* ------------------------------------------------------------ 圖片 */

test("create_image_upload_link／get_image_upload_result：ref 對得上才回網址", async () => {
  const state = setup();
  const l = await call("create_image_upload_link", { kind: "teachers" });
  assert.match(l.json!.upload_url, /\/admin\/upload\?kind=teachers&ref=[0-9a-f-]{36}$/);
  const ref = l.json!.ref as string;
  const before = await call("get_image_upload_result", { ref, kind: "teachers" });
  assert.equal(before.json!.uploaded, false);
  state.storage = { [`media/teachers/${ref}.webp`]: true };
  const after = await call("get_image_upload_result", { ref, kind: "teachers" });
  assert.equal(after.json!.uploaded, true);
  assert.match(after.json!.url, new RegExp(`/media/teachers/${ref}\\.webp$`));
  // 不同 kind 找不到
  const wrongKind = await call("get_image_upload_result", { ref, kind: "covers" });
  assert.equal(wrongKind.json!.uploaded, false);
  // ref 格式不對在 schema 就擋下
  await assert.rejects(() => call("get_image_upload_result", { ref: "../x" }));
});
