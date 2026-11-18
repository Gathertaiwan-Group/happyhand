/**
 * ops-tools-flow.test.ts 用的替身模組（只在 esbuild 打包測試時用 --alias 換進來，正式程式不會 import）。
 *
 * 一個檔案同時頂替：next/navigation、next/cache、@/lib/admin/guard、@/lib/admin/audit、
 * @/lib/supabase/server（沿用 app/admin/products/test-mocks.ts），再加上
 * @/lib/account/provision、@/lib/admin/entitlements。
 *
 * 資料庫是記憶體裡的假表（memoryDb），不連網、不碰正式站。
 */
export {
  RedirectSignal,
  redirect,
  notFound,
  revalidatePath,
  AdminAuthError,
  requireCapability,
  checkCapability,
  adminErrorMessage,
  writeAudit,
  diffOf,
  createServiceClient,
  resetMocks,
  type MockStaff,
} from "@/app/admin/products/test-mocks";

type Row = Record<string, unknown>;

export type MemOp = {
  table: string;
  kind: "select" | "insert" | "update" | "delete" | "rpc";
  columns?: string;
  values?: unknown;
  filters: string[];
};

type Filter = (row: Row) => boolean;

/** 嵌入關聯：子表 → 指向父表的欄位；父表 → 子表用來指回來的欄位。 */
const SINGLE_FK: Record<string, string> = {
  products: "product_id",
  workshop_sessions: "session_id",
  orders: "order_id",
};
const CHILD_FK: Record<string, string> = {
  order_items: "order_id",
  invoices: "order_id",
  entitlements: "order_id",
};

/** "a, b, rel(x, y), other!inner(z)" → 頂層欄位清單（括號內不拆） */
function splitTop(cols: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of cols) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export type MemState = {
  tables: Record<string, Row[]>;
  rpcs: Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null }>;
  users: Record<string, { id: string; email: string }>;
  log: MemOp[];
  /** true：任何 insert／update／delete 一出現就 throw（證明預覽不寫入） */
  writesThrow: boolean;
};

export function memoryDb(state: MemState) {
  let seq = 1000;
  const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

  function project(table: string, row: Row, cols: string | undefined): Row {
    if (!cols || cols.trim() === "*") return { ...row };
    const out: Row = {};
    for (const part of splitTop(cols)) {
      const m = /^([\w]+)(!inner)?\(([\s\S]*)\)$/.exec(part);
      if (!m) {
        out[part] = row[part];
        continue;
      }
      const rel = m[1];
      const inner = m[3];
      const relRows = state.tables[rel] ?? [];
      if (CHILD_FK[rel] && !(SINGLE_FK[rel] && row[SINGLE_FK[rel]] !== undefined)) {
        out[rel] = relRows.filter((r) => r[CHILD_FK[rel]] === row.id).map((r) => project(rel, r, inner));
      } else {
        const fk = SINGLE_FK[rel];
        const hit = relRows.find((r) => r.id === row[fk]);
        out[rel] = hit ? project(rel, hit, inner) : null;
      }
    }
    return out;
  }

  const getPath = (row: Row, col: string): unknown => {
    const j = /^(\w+)->>(\w+)$/.exec(col);
    if (j) {
      const v = (row[j[1]] as Row | null)?.[j[2]];
      return v == null ? null : String(v);
    }
    const dot = /^(\w+)\.(\w+)$/.exec(col);
    if (dot) {
      const fk = SINGLE_FK[dot[1]];
      const parent = (state.tables[dot[1]] ?? []).find((r) => r.id === row[fk]);
      return parent ? parent[dot[2]] : undefined;
    }
    return row[col];
  };

  return {
    state,
    rpc(fn: string, args: Record<string, unknown> = {}) {
      state.log.push({ table: fn, kind: "rpc", values: args, filters: [] });
      const h = state.rpcs[fn];
      if (!h) return Promise.resolve({ data: null, error: { message: `no rpc ${fn}` } });
      const r = h(args);
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    },
    auth: {
      admin: {
        getUserById(id: string) {
          const u = Object.values(state.users).find((x) => x.id === id);
          return Promise.resolve(u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: "not found" } });
        },
      },
    },
    from(table: string) {
      const op: MemOp = { table, kind: "select", filters: [] };
      const filters: Filter[] = [];
      let order: [string, boolean][] = [];
      let limit: number | undefined;
      let count = false;
      let head = false;
      let single = false;
      let returning: string | undefined;

      const write = (kind: MemOp["kind"], values?: unknown) => {
        if (state.writesThrow) throw new Error(`預覽不該寫入：${kind} ${table}`);
        op.kind = kind;
        op.values = values;
        return builder;
      };
      const add = (desc: string, f: Filter) => {
        op.filters.push(desc);
        filters.push(f);
        return builder;
      };

      const finish = () => {
        state.log.push(op);
        const rows = (state.tables[table] ??= []);
        if (op.kind === "insert") {
          const list = (Array.isArray(op.values) ? op.values : [op.values]) as Row[];
          const added = list.map((v) => {
            const r: Row = { id: newId(), created_at: new Date().toISOString(), ...v };
            rows.push(r);
            return r;
          });
          const data = added.map((r) => project(table, r, returning));
          return { data: single ? (data[0] ?? null) : data, error: null };
        }
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        if (op.kind === "update") {
          for (const r of hit) Object.assign(r, op.values as Row);
          const data = hit.map((r) => project(table, r, returning));
          return { data: single ? (data[0] ?? null) : data, error: null };
        }
        if (op.kind === "delete") {
          state.tables[table] = rows.filter((r) => !hit.includes(r));
          return { data: null, error: null };
        }
        let out = [...hit];
        for (const [col, asc] of [...order].reverse()) {
          out.sort((a, b) => {
            const x = a[col] as string | number;
            const y = b[col] as string | number;
            return (x > y ? 1 : x < y ? -1 : 0) * (asc ? 1 : -1);
          });
        }
        // !inner：嵌入關聯不存在的列要拿掉
        for (const part of splitTop(op.columns ?? "")) {
          const m = /^(\w+)!inner\(/.exec(part);
          if (m) out = out.filter((r) => (state.tables[m[1]] ?? []).some((p) => p.id === r[SINGLE_FK[m[1]]]));
        }
        const total = out.length;
        if (limit !== undefined) out = out.slice(0, limit);
        const data = head ? null : out.map((r) => project(table, r, op.columns));
        return {
          data: single ? ((data as Row[] | null)?.[0] ?? null) : data,
          error: null,
          count: count ? total : null,
        };
      };

      const builder: Record<string, unknown> = {
        select(columns?: string, opts?: { count?: string; head?: boolean }) {
          if (op.kind === "select") {
            op.columns = columns;
            count = opts?.count === "exact";
            head = opts?.head === true;
          } else {
            returning = columns;
          }
          return builder;
        },
        insert: (v: unknown) => write("insert", v),
        update: (v: unknown) => write("update", v),
        delete: () => write("delete"),
        eq: (c: string, v: unknown) => add(`eq:${c}=${String(v)}`, (r) => getPath(r, c) === v),
        neq: (c: string, v: unknown) => add(`neq:${c}`, (r) => getPath(r, c) !== v),
        in: (c: string, v: unknown[]) => add(`in:${c}`, (r) => v.includes(getPath(r, c))),
        is: (c: string, v: null) => add(`is:${c}`, (r) => (getPath(r, c) ?? null) === v),
        gt: (c: string, v: string | number) => add(`gt:${c}`, (r) => { const x = getPath(r, c); return x != null && (x as string) > (v as string); }),
        gte: (c: string, v: string | number) => add(`gte:${c}`, (r) => { const x = getPath(r, c); return x != null && (x as string) >= (v as string); }),
        lt: (c: string, v: string | number) => add(`lt:${c}`, (r) => { const x = getPath(r, c); return x != null && (x as string) < (v as string); }),
        like: (c: string, pattern: string) => {
          const re = new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$");
          return add(`like:${c}`, (r) => re.test(String(getPath(r, c) ?? "")));
        },
        not: (c: string, operator: string, v: unknown) => {
          if (operator === "is") return add(`not.is:${c}`, (r) => (getPath(r, c) ?? null) !== v);
          if (operator === "in") {
            const list = String(v).replace(/^\(|\)$/g, "").split(",");
            // SQL：NULL not in (...) 是 NULL → 不算符合
            return add(`not.in:${c}`, (r) => { const x = getPath(r, c); return x != null && !list.includes(String(x)); });
          }
          throw new Error(`not.${operator} 沒有實作`);
        },
        order(c: string, o?: { ascending?: boolean }) {
          order = [...order, [c, o?.ascending !== false]];
          return builder;
        },
        limit(n: number) {
          limit = n;
          return builder;
        },
        maybeSingle() {
          single = true;
          return Promise.resolve(finish());
        },
        single() {
          single = true;
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
}

function mem(): MemState {
  const g = globalThis as unknown as { __hh?: { db: { state?: MemState } | null } };
  const s = g.__hh?.db?.state;
  if (!s) throw new Error("memoryDb 還沒設定");
  return s;
}

/* ----------------------------------------------------- @/lib/account/provision */

export async function findOrCreateUser(email: string): Promise<{ userId: string; created: boolean } | null> {
  const s = mem();
  const key = email.trim().toLowerCase();
  if (s.users[key]) return { userId: s.users[key].id, created: false };
  if (s.writesThrow) throw new Error("預覽不該建帳號");
  const id = `aaaaaaaa-0000-4000-8000-${String(Object.keys(s.users).length + 1).padStart(12, "0")}`;
  s.users[key] = { id, email: key };
  return { userId: id, created: true };
}

export async function generateSetupLink(): Promise<string | null> {
  return "https://example.test/setup";
}

/* ----------------------------------------------------- @/lib/admin/entitlements */

export async function grantEntitlementsForOrder(orderId: string) {
  const s = mem();
  const order = s.tables.orders?.find((o) => o.id === orderId);
  const items = (s.tables.order_items ?? []).filter((i) => i.order_id === orderId);
  let granted = 0;
  let kept = 0;
  const products: string[] = [];
  for (const it of items) {
    const p = (s.tables.products ?? []).find((x) => x.id === it.product_id);
    if (!p || (p.type !== "course" && p.type !== "subscription")) continue;
    const ents = (s.tables.entitlements ??= []);
    if (ents.some((e) => e.user_id === order?.user_id && e.product_id === p.id)) {
      kept++;
      continue;
    }
    ents.push({ user_id: order?.user_id, product_id: p.id, order_id: orderId, expires_at: null });
    granted++;
    products.push(String(p.title));
  }
  return { ok: true as const, granted, kept, products, warning: "", reason: null };
}

export async function revokeEntitlement(userId: string, productId: string): Promise<boolean> {
  const s = mem();
  const before = (s.tables.entitlements ?? []).length;
  s.tables.entitlements = (s.tables.entitlements ?? []).filter((e) => !(e.user_id === userId && e.product_id === productId));
  return s.tables.entitlements.length < before;
}
