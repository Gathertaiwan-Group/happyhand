import Link from "next/link";
import { requireCapability, adminErrorMessage, AdminAuthError } from "@/lib/admin/guard";
import { createServiceClient } from "@/lib/supabase/server";
import { DataList } from "@/components/admin/data-list";
import { AdminField, AdminSelect } from "@/components/admin/admin-field";
import { formatTaipei } from "@/components/admin/datetime-field";
import {
  AUDIT_LIMIT,
  KNOWN_ENTITIES,
  actorRoleLabel,
  entityLabel,
  hasAnyFilter,
  loadAuditLog,
  parseAuditFilters,
  type AuditResult,
} from "./queries";
import { AuditDetails, Callout, Chip, PermissionDenied } from "./ui";

/**
 * 稽核紀錄。
 *
 * 這一頁存在的理由很具體：客服糾紛時要回答「是誰、在什麼時候、把什麼改成什麼」。
 * 所以四個欄位缺一不可 —— 時間、操作者（Email + 當時的角色）、動作、摘要，
 * 前後值收在 <details> 裡，需要的人展開就看得到。
 *
 * 只有負責人（audit:read）進得來：這張表會顯示每一位同事做過什麼，
 * 讓客服互相查看只會製造辦公室政治，不會提高安全性。
 *
 * ⚠️ 這一頁是唯讀的，沒有任何 server action。
 *    篩選走 <form method="get">，沒有 JavaScript 也能用，網址可以直接貼給別人。
 */

export const dynamic = "force-dynamic";

export default async function AdminAuditPage({
  searchParams,
}: {
  // Next 15：searchParams 是 Promise
  searchParams: Promise<{ entity?: string; action?: string; from?: string; to?: string }>;
}) {
  let staff;
  try {
    staff = await requireCapability("audit:read");
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return <PermissionDenied message={adminErrorMessage(err)} />;
    }
    throw err;
  }

  const params = await searchParams;
  const parsed = parseAuditFilters(params);

  let result: AuditResult = { rows: [], total: null, error: null };
  try {
    const db = createServiceClient();
    result = await loadAuditLog(db, parsed);
  } catch (err) {
    console.error("[admin/audit] service client 建立失敗", err);
    result = {
      rows: [],
      total: null,
      error: "無法連線到資料庫，請重新整理。詳細錯誤已記在伺服器 log。",
    };
  }

  const filtered = hasAnyFilter(parsed.filters);
  // total 查得到就用它判斷有沒有被截斷；查不到（極少見）才退回「剛好等於上限」的猜法。
  const truncated =
    result.total !== null ? result.total > result.rows.length : result.rows.length >= AUDIT_LIMIT;

  // 認得的 entity 加上這次查詢實際出現過的值，避免資料庫裡有新種類卻選不到。
  const entityOptions = Array.from(
    new Set<string>([...KNOWN_ENTITIES, ...result.rows.map((row) => row.entity)]),
  ).sort();

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="font-serif text-[24px] leading-tight font-medium text-ink">稽核紀錄</h1>
        <p className="mt-1 text-[14px] leading-relaxed text-ink-soft">
          後台每一次寫入都會留下一筆：誰、什麼時候、把什麼改成什麼。時間為台北時間。
        </p>
        <p className="sr-only">你好，{staff.email ?? "同事"}。</p>
      </header>

      {/*
        純 HTML 的 GET 表單，沒有 JavaScript 也能篩。
        條件全都在網址列上，所以「9 月那批訂單改動」這種查詢可以直接把網址貼給同事。
      */}
      <form
        method="get"
        className="flex flex-col gap-3 rounded-card border border-line bg-panel px-4 py-4"
      >
        <div className="grid gap-3 admin:grid-cols-4">
          <AdminSelect
            label="對象"
            name="entity"
            defaultValue={parsed.filters.entity}
            options={[
              { value: "", label: "全部" },
              ...entityOptions.map((entity) => ({
                value: entity,
                label: entityLabel(entity),
              })),
            ]}
            wrapperClassName="min-w-0"
          />
          <AdminField
            label="動作"
            name="action"
            defaultValue={parsed.filters.action}
            autoComplete="off"
            spellCheck={false}
            maxLength={60}
            placeholder="order 或 session.set_status"
            hint="部分比對。打 session 就會列出所有 session.* 的動作。"
            wrapperClassName="min-w-0"
          />
          <AdminField
            label="從（含當日）"
            name="from"
            type="date"
            defaultValue={parsed.filters.from}
            wrapperClassName="min-w-0"
          />
          <AdminField
            label="到（含當日）"
            name="to"
            type="date"
            defaultValue={parsed.filters.to}
            wrapperClassName="min-w-0"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="inline-flex min-h-11 items-center justify-center rounded-input border border-accent-ink bg-accent-ink px-5 text-[15px] font-medium text-paper transition-colors hover:bg-accent admin:min-h-10"
          >
            套用篩選
          </button>
          {filtered && (
            <Link
              href="/admin/audit"
              className="inline-flex min-h-11 items-center justify-center rounded-input border border-line-input bg-paper px-4 text-[14px] font-medium text-ink transition-colors hover:bg-panel admin:min-h-10"
            >
              清除條件
            </Link>
          )}
        </div>
      </form>

      {parsed.notes.map((note) => (
        <Callout key={note} tone="warn" title={note} />
      ))}

      {parsed.hidePreviews && (
        <p className="text-[13px] text-ink-soft">
          AI（MCP）的「只預覽、未執行」紀錄預設不列出；要看請在「動作」填 mcp.preview。
        </p>
      )}

      {result.error ? (
        <Callout tone="danger" title={result.error} />
      ) : (
        <>
          <p className="text-[13px] text-ink-soft">
            {result.total === null
              ? `顯示 ${result.rows.length} 筆。`
              : `符合條件共 ${result.total} 筆${
                  truncated ? `，這裡顯示最近 ${AUDIT_LIMIT} 筆` : ""
                }。`}
          </p>

          {truncated && (
            <Callout tone="warn" title={`清單被截斷了，只有最近 ${AUDIT_LIMIT} 筆在下面。`}>
              更早的紀錄沒有顯示出來。請縮小日期區間，或加上「對象」「動作」條件再查一次
              —— 不然你會以為某段時間什麼都沒發生。
            </Callout>
          )}

          <DataList
            items={result.rows}
            keyOf={(row) => String(row.id)}
            caption="後台操作稽核紀錄，時間由新到舊"
            empty={
              filtered
                ? "這些條件下沒有任何紀錄。放寬日期區間或清除條件再試一次。"
                : "目前沒有任何稽核紀錄。後台有人做過寫入操作之後才會開始累積。"
            }
            columns={[
              {
                header: "摘要",
                primary: true,
                className: "min-w-[18rem]",
                cell: (row) => <span className="break-words">{row.summary}</span>,
              },
              {
                header: "時間",
                className: "whitespace-nowrap",
                cell: (row) => formatTaipei(row.createdAt),
              },
              {
                header: "操作者",
                cell: (row) => (
                  <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="break-all">{row.actorEmail ?? "（未記錄 Email）"}</span>
                    <Chip label={actorRoleLabel(row.actorRole)} />
                  </span>
                ),
              },
              {
                header: "動作",
                className: "whitespace-nowrap",
                cell: (row) => (
                  <span className="break-all text-[13px]">{row.action}</span>
                ),
              },
              {
                header: "對象",
                className: "whitespace-nowrap",
                cell: (row) => entityLabel(row.entity),
              },
              {
                header: "明細",
                className: "min-w-[14rem]",
                cell: (row) => <AuditDetails entityId={row.entityId} diff={row.diff} />,
              },
            ]}
          />
        </>
      )}
    </div>
  );
}
