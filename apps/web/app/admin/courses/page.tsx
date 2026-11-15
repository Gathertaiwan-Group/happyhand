import Link from "next/link";
import { requireCapability, adminErrorMessage, AdminAuthError } from "@/lib/admin/guard";
import { createServiceClient } from "@/lib/supabase/server";
import { DataList } from "@/components/admin/data-list";
import { AdminSelect } from "@/components/admin/admin-field";
import { loadProductList, type ProductListRow } from "../products/queries";
import {
  PRODUCT_TYPE_LABEL,
  firstValue,
  formatMoney,
  pickOne,
  toProductType,
} from "../products/shared";
import {
  FormNotice,
  LoadError,
  PermissionDenied,
  PublishChip,
  TypeChip,
  adminPrimaryButton,
  adminSecondaryButton,
} from "../products/ui";

/**
 * 線上課程（含訂閱制）。
 *
 * 原本課程與工作坊在同一張清單上，但那兩件事的編輯內容與營運方式完全不同 ——
 * 課程是「單元與影片」，工作坊是「場次與報名」，混在一起每次都要先掃過一遍
 * 才找得到要改的那一門。所以拆成兩頁，工作坊在 /admin/workshops。
 *
 * ⚠️ 訂閱制歸在這一頁：它跟課程一樣是「買了就能看」，沒有場次要排。
 *
 * 這頁預設把**草稿也列出來**（用 service client 讀，不是 anon）——
 * 只看得到已發布的清單會讓人以為自己昨天建的課不見了。
 */

export const dynamic = "force-dynamic";

/** 這一頁收哪些類型。工作坊不在裡面，它有自己的頁。 */
const COURSE_TYPES = ["course", "subscription"] as const;

const PUBLISH_FILTERS = ["published", "draft"] as const;

type Row = ProductListRow;

export default async function AdminCoursesPage({
  searchParams,
}: {
  // Next 15：searchParams 是 Promise
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // 頁面層的授權。layout 只擋「不是員工」，擋不了「是員工但沒有 catalog:read」
  // ——客服（support）就屬於後者。
  try {
    await requireCapability("catalog:read");
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return <PermissionDenied message={adminErrorMessage(err)} />;
    }
    throw err;
  }

  const params = await searchParams;
  const typeFilter = pickOne(params.type, COURSE_TYPES);
  const publishFilter = pickOne(params.published, PUBLISH_FILTERS);
  const notice = firstValue(params.msg);
  const hasFilter = Boolean(typeFilter || publishFilter);

  let rows: Row[] = [];
  let loadError = "";

  try {
    const db = createServiceClient();
    rows = await loadProductList(db, {
      types: typeFilter ? [toProductType(typeFilter)] : COURSE_TYPES,
      published: publishFilter ? publishFilter === "published" : undefined,
    });
  } catch (err) {
    console.error("[admin/courses] 讀取清單失敗", err);
    loadError = "課程清單讀取失敗，請重新整理一次。";
  }

  const withSessions = rows.filter((r) => r.sessionCount > 0).length;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-serif text-[24px] leading-tight font-medium text-ink">
            線上課程
          </h1>
          <p className="mt-1 text-[14px] text-ink-soft">
            共 {rows.length} 門{hasFilter ? "（已套用篩選）" : ""}。草稿也會列在這裡，
            只有「發布中」的才會出現在前台。實體工作坊在
            <Link href="/admin/workshops" className="mx-1 text-accent-ink underline underline-offset-4">
              工作坊
            </Link>
            那一頁。
          </p>
        </div>
        <Link href="/admin/products/new" className={`${adminPrimaryButton} shrink-0`}>
          新增課程
        </Link>
      </div>

      {notice && <FormNotice code={notice} />}

      {/*
        有線上課另外開了實體班時要講出來 —— 那一門會同時出現在工作坊那一頁，
        不說的話看到兩邊都有會以為是重複資料或系統壞了。
      */}
      {withSessions > 0 && !loadError && (
        <p className="rounded-card border border-line bg-panel px-4 py-3 text-[13px] leading-relaxed text-ink-soft">
          這裡有 {withSessions} 門線上課程另外開了實體班（「單元／場次」那一欄會顯示場次數）。
          那幾門在「工作坊」那一頁也看得到，場次的報名管理在那邊。
        </p>
      )}

      {/*
        純 HTML 的 GET 表單，沒有 JavaScript 也能篩選。
        AdminSelect 是非受控的，所以要用 key 綁住目前的值 ——
        不然從網址列改參數之後 React 會沿用舊的 DOM 值，畫面與網址對不上。
      */}
      <form
        method="get"
        className="grid grid-cols-1 gap-3 rounded-card border border-line bg-panel p-3.5 admin:grid-cols-[minmax(0,12rem)_minmax(0,12rem)_1fr] admin:items-end admin:p-4"
      >
        <AdminSelect
          key={`type-${typeFilter}`}
          name="type"
          label="類型"
          defaultValue={typeFilter}
          options={[
            { value: "", label: "全部類型" },
            ...COURSE_TYPES.map((value) => ({
              value,
              label: PRODUCT_TYPE_LABEL[value],
            })),
          ]}
        />
        <AdminSelect
          key={`published-${publishFilter}`}
          name="published"
          label="發布狀態"
          defaultValue={publishFilter}
          options={[
            { value: "", label: "全部狀態" },
            { value: "published", label: "發布中" },
            { value: "draft", label: "草稿" },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className={adminSecondaryButton}>
            套用篩選
          </button>
          {hasFilter && (
            <Link
              href="/admin/courses"
              className="text-[14px] text-accent-ink underline underline-offset-4"
            >
              清除
            </Link>
          )}
        </div>
      </form>

      {loadError ? (
        <LoadError message={loadError} />
      ) : (
        <DataList
          items={rows}
          keyOf={(row) => row.id}
          href={(row) => `/admin/products/${row.id}`}
          caption="線上課程與訂閱制清單，含類型、售價、發布狀態與內容數量"
          empty={
            hasFilter
              ? "沒有符合篩選條件的課程。試著把篩選清除看看。"
              : "還沒有任何線上課程。點右上角的「新增課程」開始建立。"
          }
          columns={[
            {
              header: "課程名稱",
              primary: true,
              cell: (row) => (
                <span className="block">
                  {row.title}
                  <span className="mt-0.5 block text-[12px] font-normal text-ink-soft">
                    /{row.slug}
                  </span>
                </span>
              ),
            },
            {
              header: "發布狀態",
              trailing: true,
              cell: (row) => <PublishChip published={row.is_published} />,
            },
            { header: "類型", cell: (row) => <TypeChip type={row.type} /> },
            { header: "售價", align: "right", cell: (row) => formatMoney(row.price) },
            {
              header: "單元／場次",
              align: "right",
              cell: (row) => <ContentCount row={row} />,
            },
            {
              header: "排序",
              align: "right",
              desktopOnly: true,
              cell: (row) => row.sort_order,
            },
          ]}
        />
      )}
    </div>
  );
}

/**
 * 單元數與場次數。
 *
 * 🔴 場次數在這一頁**也要顯示**，不可以因為「這裡是課程頁」就藏起來：
 *    資料庫刻意沒有限制 workshop_sessions.product_id 必須是 workshop 類型
 *    （見 init.sql 的表註解），實際資料裡「讀脈入門課」就是一門 course
 *    同時掛著一場台北實體班。藏起來的話那一場在這一頁就完全看不出存在。
 */
function ContentCount({ row }: { row: { lessonCount: number; sessionCount: number } }) {
  const parts: string[] = [];
  if (row.lessonCount > 0) parts.push(`${row.lessonCount} 單元`);
  if (row.sessionCount > 0) parts.push(`${row.sessionCount} 場次`);
  if (parts.length === 0) return <span className="text-ink-soft">—</span>;
  return <span className="whitespace-nowrap">{parts.join("／")}</span>;
}
