/**
 * route.test.ts 用的替身模組（只在 esbuild 打包測試時用 --alias 換進來，正式程式不會 import）。
 *
 * 一個檔案同時頂替：next/server、next/cache、@/lib/supabase/server、
 * @/lib/account/provision、@/lib/email/outbox、@/lib/payment/blackcat。
 * 狀態放在 globalThis.__orders（測試自己設定、自己讀）。
 *
 * 🔴 這些替身沒有任何一個會連到網路或正式站：資料庫是記憶體裡的假表，
 *    黑貓 PAY 只記錄「被叫了幾次、金額多少」。
 */

export type FakeRow = Record<string, unknown>;

export type FakeState = {
  tables: Record<string, FakeRow[]>;
  /** 讓某張表的 select 回錯誤，模擬資料庫讀取失敗 */
  failSelect: Set<string>;
  selects: { table: string; columns: string }[];
  inserts: { table: string; rows: FakeRow[] }[];
  credit: { orderNo: string; amount: number }[];
};

function state(): FakeState {
  const g = globalThis as unknown as { __orders?: FakeState };
  g.__orders ??= {
    tables: {},
    failSelect: new Set(),
    selects: [],
    inserts: [],
    credit: [],
  };
  return g.__orders;
}

export function resetFake(tables: Record<string, FakeRow[]>) {
  const s = state();
  s.tables = structuredClone(tables);
  s.failSelect = new Set();
  s.selects = [];
  s.inserts = [];
  s.credit = [];
  return s;
}

/* ----------------------------------------------------------- 假的 supabase */

/** 依 select 的欄位清單投影：沒選的欄位真的拿不到，才驗得出「有沒有撈 is_published」 */
function project(row: FakeRow, columns: string): FakeRow {
  const cols = columns.split(",").map((c) => c.trim()).filter(Boolean);
  if (cols.includes("*")) return { ...row };
  return Object.fromEntries(cols.map((c) => [c, row[c]]));
}

function fakeDb() {
  return {
    from(table: string) {
      return {
        select(columns: string) {
          const s = state();
          s.selects.push({ table, columns });
          return {
            in(column: string, values: readonly string[]) {
              if (s.failSelect.has(table)) {
                return Promise.resolve({ data: null, error: { message: "boom" } });
              }
              const rows = (s.tables[table] ?? [])
                .filter((r) => values.includes(r[column] as string))
                .map((r) => project(r, columns));
              return Promise.resolve({ data: rows, error: null });
            },
          };
        },
        insert(rows: FakeRow | FakeRow[]) {
          const list = Array.isArray(rows) ? rows : [rows];
          state().inserts.push({ table, rows: list });
          const result = { data: { id: `${table}-id-1` }, error: null };
          return {
            select() {
              return { single: () => Promise.resolve(result) };
            },
            then<T>(ok: (v: typeof result) => T) {
              return Promise.resolve(result).then(ok);
            },
          };
        },
        update() {
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    },
    rpc() {
      return Promise.resolve({ data: [], error: null });
    },
  };
}

export function createServiceClient() {
  return fakeDb();
}

/** lib/data.ts 會 import 這兩個；route 只用到它的日期格式函式 */
export function createPublicClient() {
  return fakeDb();
}
export function hasSupabaseEnv() {
  return true;
}

/** 已登入的客人 → route 不會去走 findOrCreateUser */
export async function createClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } } }),
    },
  };
}

/* -------------------------------------------------------------- next/server */

export const NextResponse = {
  json(body: unknown, init?: ResponseInit) {
    return Response.json(body, init);
  },
};

/** 寄信排程：測試裡不執行 */
export function after() {}

/* --------------------------------------------------------------- next/cache */

export function revalidatePath() {}

/* ------------------------------------------------------ account / email 替身 */

export async function findOrCreateUser() {
  throw new Error("測試裡客人是已登入的，不該走到 findOrCreateUser");
}
export async function generateSetupLink() {
  return null;
}
export async function enqueueEmail() {}
export async function flushOutbox() {}

/* ----------------------------------------------------------- 黑貓 PAY 替身 */

export function isBlackcatConfigured() {
  return true;
}

export async function createCreditOrder(input: { orderNo: string; amount: number }) {
  state().credit.push({ orderNo: input.orderNo, amount: input.amount });
  return { ok: true as const, url: "https://pay.invalid/fake" };
}
