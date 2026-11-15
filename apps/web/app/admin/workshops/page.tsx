import Link from "next/link";
import { checkCapability } from "@/lib/admin/guard";
import { createServiceClient } from "@/lib/supabase/server";
import { DataList } from "@/components/admin/data-list";
import { AdminCheckbox } from "@/components/admin/admin-field";
import { formatTaipei } from "@/components/admin/datetime-field";
import {
  firstValue,
  formatMoney,
  toProductType,
  toSessionStatus,
  type ProductType,
  type SessionStatus,
} from "../products/shared";
import {
  FormNotice,
  PublishChip,
  TypeChip,
  adminPrimaryButton,
  adminSecondaryButton,
} from "../products/ui";
import {
  Callout,
  LoadError,
  PermissionDenied,
  SeatMismatchNote,
  SessionStatusChip,
} from "../sessions/ui";
import { loadSessionList } from "../sessions/queries";
import { loadWorkshopProducts } from "../products/queries";

/**
 * 工作坊：課程本身 ＋ 它的場次，一頁看完。
 *
 * 原本場次是側欄的獨立入口（/admin/sessions），跟「課程與工作坊」分開。
 * 但一場場次離開它的工作坊就沒有意義，所以收進來 —— 每門工作坊底下直接列
 * 它的場次，點場次才進報名名單。
 *
 * 🔴 這一頁是全站唯一「兩種權限任一就進得去」的頁：
 *
 *    catalog:read（內容編輯）—— 來改場次的日期、地點、名額
 *    orders:read（客服）    —— 來看誰報名了
 *
 *    所以**這一頁只顯示場次層的資料**：日期、地點、名額、候補數。
 *    全部非個資，而且這條線本來就存在 —— /admin 總覽的「即將開課場次」
 *    也是無條件顯示給所有員工看的（app/admin/page.tsx:75）。
 *
 *    ⚠️ 客人的姓名電話 Email 一律留在 /admin/sessions/[id]，那一頁的守衛
 *       仍然是 orders:read，沒有放寬。沒有 orders:read 的人在這裡連
 *       「點進去」的連結都看不到 —— 不要讓人點了才發現進不去。
 */

export const dynamic = "force-dynamic";

type SessionRow = {
  id: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  capacity: number;
  seatsTaken: number;
  status: SessionStatus;
  paidHeadcount: number | null;
  waitingCount: number | null;
};

type WorkshopRow = {
  id: string;
  type: ProductType;
  slug: string;
  title: string;
  price: number;
  is_published: boolean;
  sessions: SessionRow[];
  /**
   * 被「只看未結束的」濾掉的場次數。
   *
   * 🔴 收錄判斷用的是**全部**場次，篩選只影響顯示 —— 一門線上課的唯一一場
   *    已經結束時，它仍然要出現在這一頁（場次與報名名單都還在資料庫裡）。
   *    但那時候場次清單會是空的，如果不說「有 N 場已結束」，畫面看起來就像
   *    「這門課從來沒排過場次」。
   */
  hiddenPast: number;
};

export default async function AdminWorkshopsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  /*
    兩種能力任一即可。用 checkCapability 而不是 requireCapability：
    這裡不是「有或沒有」的二元判斷，而是要拿兩個結果去決定顯示到哪個程度。
  */
  const catalogStaff = await checkCapability("catalog:read");
  const ordersStaff = await checkCapability("orders:read");

  if (!catalogStaff && !ordersStaff) {
    return (
      <PermissionDenied message="你的帳號沒有查看工作坊的權限。" />
    );
  }

  const canEdit = Boolean(catalogStaff);
  const canViewRoster = Boolean(ordersStaff);

  const params = await searchParams;
  // 沒勾的 checkbox 不會出現在 query string，所以「有這個參數」就等於「要看已結束的」
  const includePast = params.past !== undefined;
  const notice = firstValue(params.msg);

  let rows: WorkshopRow[] = [];
  let loadError = "";

  try {
    const db = createServiceClient();

    /*
      兩支查詢併起來：
        A. products + 內嵌的場次（場次本身的欄位）
        B. loadSessionList()（已付款人數與候補數，那要 join order_items 算）

      B 是既有的查詢，沿用它才不會出現兩套「誰算報名了」的定義 ——
      queries.ts:116-132 把那個定義標了 🔴，worker 寄提醒也用同一條。
    */
    const [products, sessionList] = await Promise.all([
      loadWorkshopProducts(db),
      loadSessionList(db, { includePast }),
    ]);

    // 已付款人數與候補數，用場次 id 對回去
    const stats = new Map(
      sessionList.rows.map((r) => [r.id, { paid: r.paidHeadcount, waiting: r.waitingCount }]),
    );

    rows = products
      .map((raw) => {
        const all = raw.workshop_sessions ?? [];
        const sessions = all
          // loadSessionList 已經套用了 includePast，沒出現在 stats 裡的就是被濾掉的過去場次
          .filter((s) => includePast || stats.has(s.id))
          .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
          .map((s) => ({
            id: s.id,
            startsAt: s.starts_at,
            endsAt: s.ends_at,
            location: s.location,
            capacity: s.capacity,
            seatsTaken: s.seats_taken,
            status: toSessionStatus(s.status),
            paidHeadcount: stats.get(s.id)?.paid ?? null,
            waitingCount: stats.get(s.id)?.waiting ?? null,
          }));

        return {
          id: raw.id,
          type: toProductType(raw.type),
          slug: raw.slug,
          title: raw.title,
          price: raw.price,
          is_published: raw.is_published,
          sessions,
          hiddenPast: all.length - sessions.length,
          // 判斷用的是「全部場次」不是篩選後的，見下面的 filter
          hasAnySession: all.length > 0,
        };
      })
      /*
        🔴 收錄條件是「type 是工作坊 **或** 有場次」，不是只看 type。

        資料庫刻意沒有限制 workshop_sessions.product_id 必須是 workshop
        （見 init.sql 的表註解）—— 「讀脈入門課」是線上課但另開了台北實體班。
        只看 type 的話那一場會在這一頁完全消失，沒有人管得到報名。

        這跟 products/[id]/page.tsx 的 showSessions 是同一個判準，
        兩邊要一起改。
      */
      .filter((r) => r.type === "workshop" || r.hasAnySession)
      // hasAnySession 只是過濾用的暫時欄位，不要讓它流進畫面的型別
      .map((r) => ({
        id: r.id,
        type: r.type,
        slug: r.slug,
        title: r.title,
        price: r.price,
        is_published: r.is_published,
        sessions: r.sessions,
        hiddenPast: r.hiddenPast,
      }));
  } catch (err) {
    console.error("[admin/workshops] 讀取清單失敗", err);
    loadError = "工作坊清單讀取失敗，請重新整理一次。";
  }

  const allSessions = rows.flatMap((r) => r.sessions);
  const mismatched = allSessions.filter(
    (s) => s.paidHeadcount !== null && s.paidHeadcount !== s.seatsTaken,
  ).length;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-serif text-[24px] leading-tight font-medium text-ink">
            工作坊
          </h1>
          <p className="mt-1 text-[14px] text-ink-soft">
            共 {rows.length} 門、{allSessions.length} 場
            {includePast ? "（含已結束）" : ""}。
            {canViewRoster
              ? "點場次可以看報名名單。"
              : "報名名單只開放客服與負責人查看。"}
          </p>
        </div>
        {canEdit && (
          <Link
            href="/admin/products/new?type=workshop"
            className={`${adminPrimaryButton} shrink-0`}
          >
            新增工作坊
          </Link>
        )}
      </div>

      {notice && <FormNotice code={notice} />}

      {/*
        這一頁最重要的一件事：同時顯示兩個人數，並在它們打架時說出來。
        （沿用 /admin/sessions 原本的主張，見那一頁的檔頭。）
      */}
      {mismatched > 0 && (
        <Callout tone="warn" title={`有 ${mismatched} 場的報名人數與系統名額對不上`}>
          <SeatMismatchNote />
        </Callout>
      )}

      <form
        method="get"
        className="flex flex-wrap items-end gap-3 rounded-card border border-line bg-panel p-3.5 admin:p-4"
      >
        <AdminCheckbox
          key={`past-${includePast}`}
          name="past"
          label="顯示已結束的場次"
          defaultChecked={includePast}
        />
        <button type="submit" className={adminSecondaryButton}>
          套用
        </button>
        {includePast && (
          <Link
            href="/admin/workshops"
            className="text-[14px] text-accent-ink underline underline-offset-4"
          >
            只看未結束的
          </Link>
        )}
      </form>

      {loadError ? (
        <LoadError message={loadError} />
      ) : rows.length === 0 ? (
        <div className="rounded-card border border-line bg-panel px-5 py-10 text-center text-[15px] text-ink-soft">
          還沒有任何工作坊。
          {canEdit && "點右上角的「新增工作坊」開始建立。"}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {rows.map((row) => (
            <WorkshopCard
              key={row.id}
              row={row}
              canEdit={canEdit}
              canViewRoster={canViewRoster}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkshopCard({
  row,
  canEdit,
  canViewRoster,
}: {
  row: WorkshopRow;
  canEdit: boolean;
  canViewRoster: boolean;
}) {
  // 線上課另開的實體班。這件事一定要說出來，不然看到一門「線上課程」
  // 出現在工作坊頁會以為是分類錯了。
  const isHybrid = row.type !== "workshop";

  return (
    <section className="rounded-card border border-line bg-paper p-4 admin:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[16px] font-medium text-ink">
            {canEdit ? (
              <Link
                href={`/admin/products/${row.id}`}
                className="underline-offset-4 hover:underline"
              >
                {row.title}
              </Link>
            ) : (
              row.title
            )}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <TypeChip type={row.type} />
            <PublishChip published={row.is_published} />
            <span className="text-[13px] text-ink-soft">{formatMoney(row.price)}</span>
            <span className="text-[13px] text-ink-soft">/{row.slug}</span>
          </div>
          {isHybrid && (
            <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
              這是一門線上課程，另外開了實體班。它在「線上課程」那一頁也看得到，
              影片與單元在那邊管。
            </p>
          )}
        </div>
        {canEdit && (
          <Link
            href={`/admin/products/${row.id}`}
            className={`${adminSecondaryButton} shrink-0`}
          >
            編輯內容
          </Link>
        )}
      </div>

      <div className="mt-4">
        <DataList
          items={row.sessions}
          keyOf={(s) => s.id}
          // 🔴 只有 orders:read 才給連結。沒有的話點進去只會看到權限不足，
          //    不如一開始就不做成連結。
          href={canViewRoster ? (s) => `/admin/sessions/${s.id}` : undefined}
          caption={`${row.title} 的場次`}
          empty={
            row.hiddenPast > 0
              ? `這門課的 ${row.hiddenPast} 場都已經結束了。勾選上面的「顯示已結束的場次」就看得到。`
              : canEdit
                ? "這門工作坊還沒有場次。到「編輯內容」的「場次與報名」那一段新增。"
                : "這門工作坊目前沒有場次。"
          }
          columns={[
            {
              header: "開始時間",
              primary: true,
              cell: (s) => formatTaipei(s.startsAt) || "—",
            },
            {
              header: "狀態",
              trailing: true,
              cell: (s) => <SessionStatusChip status={s.status} />,
            },
            { header: "地點", cell: (s) => s.location || "—" },
            {
              header: "已付款報名",
              align: "right",
              cell: (s) => <PaidCount session={s} />,
            },
            {
              header: "系統名額",
              align: "right",
              cell: (s) => (
                <span className="whitespace-nowrap">
                  {s.seatsTaken} / {s.capacity}
                </span>
              ),
            },
            {
              header: "候補",
              align: "right",
              desktopOnly: true,
              cell: (s) =>
                s.waitingCount === null ? "—" : s.waitingCount > 0 ? s.waitingCount : "—",
            },
          ]}
        />
      </div>
    </section>
  );
}

/** 已付款報名人數。跟系統名額不一致時要看得出來。 */
function PaidCount({ session }: { session: SessionRow }) {
  if (session.paidHeadcount === null) {
    return <span className="text-ink-soft">—</span>;
  }
  const mismatch = session.paidHeadcount !== session.seatsTaken;
  return (
    <span className={`whitespace-nowrap ${mismatch ? "font-medium text-ink" : ""}`}>
      {session.paidHeadcount}
      {mismatch && (
        <>
          <span aria-hidden="true" className="ml-1 text-danger">
            ⚠
          </span>
          <span className="sr-only">（與系統名額不一致）</span>
        </>
      )}
    </span>
  );
}
