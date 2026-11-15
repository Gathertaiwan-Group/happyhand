/**
 * 單元測試用的替身模組（只在 esbuild 打包測試時用 --alias 換進來，正式程式不會 import）。
 *
 * 一個檔案同時頂替：next/navigation、next/cache、@/lib/admin/guard、
 * @/lib/admin/audit、@/lib/supabase/server。每個 import 只取它需要的名字。
 * 狀態放在 globalThis.__hh（測試自己設定、自己讀）。
 */

export type MockStaff = { id: string; email: string | null; role: string; via?: "mcp" };

type Hooks = {
  db: unknown;
  staff: MockStaff | null;
  audits: { staff: MockStaff; input: Record<string, unknown> }[];
  revalidated: string[];
};

function hooks(): Hooks {
  const g = globalThis as unknown as { __hh?: Hooks };
  g.__hh ??= { db: null, staff: null, audits: [], revalidated: [] };
  return g.__hh;
}

export function resetMocks(db: unknown, staff: MockStaff | null = { id: "u1", email: "a@b", role: "owner" }) {
  const h = hooks();
  h.db = db;
  h.staff = staff;
  h.audits = [];
  h.revalidated = [];
  return h;
}

/* ---------------------------------------------------------- next/navigation */

export class RedirectSignal extends Error {
  constructor(readonly destination: string) {
    super(`NEXT_REDIRECT:${destination}`);
  }
}

export function redirect(destination: string): never {
  throw new RedirectSignal(destination);
}

export function notFound(): never {
  throw new Error("NEXT_NOT_FOUND");
}

/* --------------------------------------------------------------- next/cache */

export function revalidatePath(path: string, type?: string) {
  hooks().revalidated.push(type ? `${path}|${type}` : path);
}

/* --------------------------------------------------------- @/lib/admin/guard */

export class AdminAuthError extends Error {
  constructor(
    message: string,
    readonly reason: "unauthenticated" | "forbidden" | "unconfigured" = "forbidden",
  ) {
    super(message);
    this.name = "AdminAuthError";
  }
}

export async function requireCapability(_cap: string): Promise<MockStaff> {
  void _cap;
  const s = hooks().staff;
  if (!s) throw new AdminAuthError("你的帳號沒有這個權限。");
  return s;
}

export async function checkCapability(_cap: string): Promise<MockStaff | null> {
  void _cap;
  return hooks().staff;
}

export function adminErrorMessage(err: unknown): string {
  if (err instanceof AdminAuthError) return err.message;
  if (err instanceof Error) return err.message;
  return "發生未預期的錯誤，請重試一次";
}

/* --------------------------------------------------------- @/lib/admin/audit */

export async function writeAudit(staff: MockStaff, input: Record<string, unknown>) {
  hooks().audits.push({ staff, input });
}

/** 與 lib/admin/audit.ts 的 diffOf 同一份實作 */
export function diffOf<T extends Record<string, unknown>>(
  before: T | null | undefined,
  after: T,
  fields: readonly (keyof T)[],
): Record<string, { from: unknown; to: unknown }> | null {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of fields) {
    const from = before?.[f];
    const to = after[f];
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      out[String(f)] = { from: from ?? null, to: to ?? null };
    }
  }
  return Object.keys(out).length ? out : null;
}

/* ----------------------------------------------------- @/lib/supabase/server */

export function createServiceClient() {
  return hooks().db;
}

/* ================================================================ 假資料庫 */

export type Op = {
  table: string;
  kind: "select" | "insert" | "update" | "delete";
  values?: unknown;
  filters: [string, string, unknown][];
  columns?: string;
};

export type Responder = (op: Op) => { data?: unknown; error?: { code?: string; message: string } | null };

/**
 * 最小的 PostgREST 查詢建構器替身。每一個 from() 記一筆 Op，結束時（await／maybeSingle）
 * 交給 responder 決定回什麼。writesThrow=true 時任何 insert／update／delete 一出現就 throw
 * —— 用來證明 dry_run 不會寫入。
 */
export function fakeDb(responder: Responder, opts: { writesThrow?: boolean } = {}) {
  const log: Op[] = [];
  const db = {
    log,
    from(table: string) {
      const op: Op = { table, kind: "select", filters: [] };
      const write = (kind: Op["kind"], values?: unknown) => {
        if (opts.writesThrow) throw new Error(`預覽不該寫入：${kind} ${table}`);
        op.kind = kind;
        op.values = values;
        return builder;
      };
      const finish = () => {
        log.push(op);
        const r = responder(op);
        return { data: r.data ?? null, error: r.error ?? null };
      };
      const builder: Record<string, unknown> = {
        select(columns?: string) {
          if (op.kind === "select") op.columns = columns;
          return builder;
        },
        insert: (v: unknown) => write("insert", v),
        update: (v: unknown) => write("update", v),
        delete: () => write("delete"),
        eq(c: string, v: unknown) {
          op.filters.push(["eq", c, v]);
          return builder;
        },
        in(c: string, v: unknown) {
          op.filters.push(["in", c, v]);
          return builder;
        },
        or(expr: string) {
          op.filters.push(["or", "", expr]);
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return builder;
        },
        maybeSingle() {
          return Promise.resolve(finish());
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          try {
            return Promise.resolve(finish()).then(resolve, reject);
          } catch (err) {
            return reject ? Promise.reject(err).catch(reject) : Promise.reject(err);
          }
        },
      };
      return builder;
    },
  };
  return db;
}
