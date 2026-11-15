import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability, adminErrorMessage, AdminAuthError } from "@/lib/admin/guard";
import { createServiceClient } from "@/lib/supabase/server";
import {
  ProductAudienceSection,
  ProductCoverSection,
  ProductCurriculumSection,
  ProductFormAnchor,
  ProductIncludesSection,
  ProductIntroSection,
  ProductNotesSection,
  ProductSaveBar,
  ProductSettingsSection,
} from "@/components/admin/product-form";
import { LessonEditor } from "@/components/admin/lesson-editor";
import { SessionEditor } from "@/components/admin/session-editor";
import { BlockEditor } from "@/components/admin/block-editor";
import { ConfirmButton } from "@/components/admin/confirm-button";
import { deleteProduct, togglePublish } from "../actions";
import { loadProductDetail } from "../queries";
import {
  PRODUCT_TYPES,
  firstValue,
  pickOne,
  toProductType,
  type LessonRow,
  type ProductRow,
  type SessionRow,
  type BlockRow,
} from "../shared";
import {
  FormNotice,
  LoadError,
  MirrorNote,
  PermissionDenied,
  PublishChip,
  SectionHeader,
  TypeChip,
} from "../ui";

/**
 * 新增／編輯課程。
 *
 * id === "new" 走新增。用同一個路由而不是另開 /admin/products/new/page.tsx，
 * 表單與驗證只會有一份。
 *
 * 🔑 這一頁的區段順序 = 前台頁面由上到下的區塊順序。
 *    改順序之前請先開一次 /workshops/{slug} 對照，兩邊要一致 ——
 *    整個設計的用途就是「照著填就等於在排前台的版面」。
 *    對照表見下面的 FRONT_END_ORDER 註解。
 *
 * 單元／場次／區塊只在編輯既有課程時出現：它們都需要 product_id 才掛得上去，
 * 新增時還沒有。所以新增成功後 redirect 到 ?msg=created，
 * 那句話會告訴使用者現在可以往下編輯了。
 */

export const dynamic = "force-dynamic";

/*
  FRONT_END_ORDER —— 前台工作坊頁（app/(storefront)/workshops/[slug]/page.tsx）
  由上到下的區塊，以及它在這一頁對應的區段：

     封面大圖          cover_url            → ProductCoverSection
     標題／副標／簡介／引言／賣點             → ProductIntroSection
     場次與報名        workshop_sessions    → SessionEditor
     適合／不適合／學完之後                   → ProductAudienceSection
     學習路徑          block "step"
     課程內容（線上／實體）                   → ProductCurriculumSection
     陪伴機制          block "feature"
     一次報名全部帶走  includes             → ProductIncludesSection
     報名前先確認      block "info_row"
     費用方案          block "pricing"
     講師介紹          site_settings        → MirrorNote（在 /admin/settings 改）
     常見問題          block "faq"
     健康聲明          site_settings        → MirrorNote（在 /admin/settings 改）
     上課地點          取自第一場場次        → MirrorNote
     來之前先知道      notes                → ProductNotesSection
*/

/** 五種報名頁區塊的標題與說明。key 是 product_blocks.kind。 */
const BLOCK_META = {
  step: {
    title: "學習路徑",
    description: "從報名到完課的階段。前台會自動編號 01、02…",
  },
  feature: {
    title: "陪伴機制",
    description: "教學特色、課後支援這類說明，前台排成三欄卡片。",
  },
  info_row: {
    title: "報名前先確認",
    description: "「項目：內容」的對照表，例如上課地點、付款方式、退費規則。",
  },
  pricing: {
    title: "費用方案",
    description: "新生價、複訓價等不同方案。可以各自帶金額與附註。",
  },
  faq: {
    title: "常見問題",
    description: "客人最常問的問題。前台是可以點開收合的手風琴。",
  },
} as const;

type BlockKind = keyof typeof BLOCK_META;

export default async function AdminProductEditPage({
  params,
  searchParams,
}: {
  // Next 15：params 與 searchParams 都是 Promise
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    await requireCapability("catalog:read");
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return <PermissionDenied message={adminErrorMessage(err)} />;
    }
    throw err;
  }

  const { id } = await params;
  const notice = firstValue((await searchParams).msg);
  const isNew = id === "new";

  if (isNew) {
    /*
      新增時的任務跟編輯不一樣：這裡要先把「這門課是什麼」建立起來，
      內容可以之後再慢慢填。所以設定排在最前面（而且它才有必填欄位），
      圖片與標題跟著，其餘區段等有了 id 再出現。

      ⚠️ 這一條是 product-form.tsx 檔頭那句「所有欄位一定要屬於同一張表單」
         的唯一例外，而且只在這裡成立：新增走的是 insert，沒送出的欄位是
         「還沒有值」不是「被清空」。編輯既有課程時少一個欄位就是資料流失。
    */
    /*
      從工作坊清單頁按「新增工作坊」會帶 ?type=workshop 進來。
      pickOne 只做白名單過濾（回 string），再過一次 toProductType 拿到正確的
      union 型別 —— 認不得的一律回 "course"，跟表單本來的預設一致。
    */
    const typeParam = pickOne((await searchParams).type, PRODUCT_TYPES);
    const defaultType = typeParam ? toProductType(typeParam) : undefined;

    return (
      <div className="flex flex-col gap-6">
        <Header
          title={defaultType === "workshop" ? "新增工作坊" : "新增課程"}
          backTo={defaultType === "workshop" ? "workshop" : "course"}
        />
        {notice && <FormNotice code={notice} />}
        <ProductFormAnchor product={null} />
        <ProductSettingsSection product={null} defaultType={defaultType} />
        <ProductCoverSection product={null} />
        <ProductIntroSection product={null} />
        <ProductSaveBar isNew backTo={defaultType === "workshop" ? "workshop" : "course"} />
      </div>
    );
  }

  let product: ProductRow | null = null;
  let lessons: LessonRow[] = [];
  let blocks: BlockRow[] = [];
  let sessions: SessionRow[] = [];
  let loadError = "";

  try {
    const db = createServiceClient();
    const detail = await loadProductDetail(db, id);
    if (!detail) notFound();

    product = detail.product;
    lessons = detail.lessons;
    blocks = detail.blocks;
    sessions = detail.sessions;
  } catch (err) {
    // notFound() 是靠丟例外實作的，被這裡 catch 住就會變成「讀取失敗」
    // 而不是 404 畫面。原封不動往上丟。
    if (isNextControlFlow(err)) throw err;
    console.error("[admin/products] 讀取課程失敗", err);
    loadError = "課程資料讀取失敗，請重新整理一次。";
  }

  if (loadError || !product) {
    return (
      <div className="flex flex-col gap-5">
        <Header title="編輯課程" />
        <LoadError message={loadError || "找不到這門課。"} />
      </div>
    );
  }

  /*
    單元／場次要不要顯示，看的是「有沒有資料」而不是只看 type。

    資料庫刻意沒有限制 workshop_sessions.product_id 必須是 workshop
    （見 init.sql 的表註解），實際資料裡「快樂手 JSJ 讀脈入門課」就是
    一門 course 同時掛著一場台北實體班。只依 type 二選一顯示的話，
    那一場會在後台完全消失 —— 沒有人改得到，也沒有人知道它還在。
  */
  const showLessons = product.type === "course" || lessons.length > 0;
  const showSessions = product.type === "workshop" || sessions.length > 0;

  /*
    🔴 線上課程頁（app/(storefront)/courses/[slug]/page.tsx）**不渲染**
       hero_lead / subtitle / suitable_for / not_suitable_for / outcomes /
       curriculum_online / curriculum_onsite / includes / notes，
       以及全部五種 product_blocks（那一頁的講師與 FAQ 是寫死在
       lib/content.ts 的常數，不讀資料庫）。

       欄位還是留著能填 —— 資料不會消失，日後課程頁支援了就直接有內容 ——
       但要講清楚現在填了不會顯示，否則就是另一個「填了沒反應」的靜默無效。
  */
  const workshopOnlyIsDead = product.type === "course";

  /*
    區段編號：連號產生，被條件隱藏的區段不會留下斷號。

    🔴 nextStep() 必須在**畫面上的那個位置**才被呼叫到。
       JSX 建立元素時 props 就地求值 —— 所以
         const someSection = (<X step={nextStep()} />)   // 這一行就領走號碼了
       會讓號碼照「原始碼出現順序」發放，而不是「畫面顯示順序」。
       曾經因此讓整頁從第 10 段開始。要延後求值就寫成函式（見下面的
       renderWorkshopOnly），由使用它的那個位置呼叫。
  */
  let stepCounter = 0;
  const nextStep = () => String(++stepCounter);

  const publicHref =
    product.type === "workshop"
      ? `/workshops/${product.slug}`
      : `/courses/${product.slug}`;

  /*
    ⚠️ 這裡一定要是函式不是常數 —— 常數會在 return 之前就把裡面的
       nextStep() 全部跑完（見上面的說明）。呼叫點在下面的三元運算子，
       那才是這些區段在畫面上的位置。
  */
  const renderWorkshopOnly = () => (
    <>
      <ProductAudienceSection product={product} step={nextStep()} />

      <BlockSection
        productId={product.id}
        kind="step"
        step={nextStep()}
        blocks={blocks}
      />

      <ProductCurriculumSection product={product} step={nextStep()} />

      <BlockSection
        productId={product.id}
        kind="feature"
        step={nextStep()}
        blocks={blocks}
      />

      <ProductIncludesSection product={product} step={nextStep()} />

      <BlockSection
        productId={product.id}
        kind="info_row"
        step={nextStep()}
        blocks={blocks}
      />

      <BlockSection
        productId={product.id}
        kind="pricing"
        step={nextStep()}
        blocks={blocks}
      />

      <MirrorNote title="講師介紹">
        這一段前台會顯示，但不是在這裡改 —— 講師照片、介紹與經歷是全站共用的，
        請到{" "}
        <Link href="/admin/settings" className="text-accent-ink underline underline-offset-4">
          網站設定
        </Link>
        。
      </MirrorNote>

      <BlockSection productId={product.id} kind="faq" step={nextStep()} blocks={blocks} />

      <MirrorNote title="健康聲明">
        前台在常見問題底下會顯示一段健康聲明，內容同樣是全站共用的，
        請到{" "}
        <Link href="/admin/settings" className="text-accent-ink underline underline-offset-4">
          網站設定
        </Link>
        。
      </MirrorNote>

      <MirrorNote title="上課地點">
        前台的地點與地圖是取自這門課
        <span className="font-medium text-ink">最近一場</span>
        場次的「地點名稱」與「地址」。要改的話回到上面的場次那一段改，這裡沒有另外的欄位。
      </MirrorNote>

      <ProductNotesSection product={product} step={nextStep()} />
    </>
  );

  return (
    <div className="flex flex-col gap-6">
      <Header
        title={product.title}
        // 線上課另開實體班的那一門也回工作坊 —— 會來這裡改它的人多半是為了場次
        backTo={showSessions ? "workshop" : "course"}
        meta={
          <>
            <TypeChip type={product.type} />
            <PublishChip published={product.is_published} />
            <span className="text-[13px] text-ink-soft">/{product.slug}</span>
          </>
        }
        actions={
          <>
            {/*
              對照用的連結。這一頁的區段順序刻意等於前台的區塊順序，
              開著前台頁面對照著填是它的用法。
              未上架的課程前台是 404（RLS 擋掉），所以只有上架時才給連結。
            */}
            {product.is_published && (
              <Link
                href={publicHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center justify-center rounded-input border border-line-input bg-paper px-4 text-[14px] font-medium text-ink transition-colors hover:bg-panel admin:min-h-10"
              >
                看前台這一頁
              </Link>
            )}
            <ConfirmButton
              action={togglePublish.bind(null, product.id, !product.is_published)}
              confirmText={
                product.is_published
                  ? `確定要把「${product.title}」下架嗎？\n\n下架後前台就看不到這門課了，已經買過的學員仍然看得到。`
                  : `確定要發布「${product.title}」嗎？\n\n發布後任何人都能在前台看到並購買。`
              }
            >
              {product.is_published ? "下架" : "發布"}
            </ConfirmButton>
            <ConfirmButton
              action={deleteProduct.bind(null, product.id)}
              variant="danger"
              confirmText={
                `確定要刪除「${product.title}」嗎？\n\n` +
                "這門課的所有單元與場次都會一起刪除，無法復原。\n" +
                "如果已經有人買過，系統會擋下來並請你改用「下架」。"
              }
            >
              刪除
            </ConfirmButton>
          </>
        }
      />

      {notice && <FormNotice code={notice} />}

      <p className="rounded-card bg-panel px-4 py-3 text-[13px] leading-relaxed text-ink-soft">
        下面的順序就是前台頁面由上到下的順序，從第 1 段開始往下填，
        填到最後就是完整的一頁。留空的段落在前台不會出現，不需要的直接跳過。
      </p>

      {/* 🔑 承接 action 的空表單。底下的商品欄位靠 form 屬性歸隊，見 product-form.tsx 檔頭。 */}
      <ProductFormAnchor product={product} />

      <ProductCoverSection product={product} step={nextStep()} />

      <ProductIntroSection product={product} step={nextStep()} />
      {workshopOnlyIsDead && (
        <p className="-mt-2 text-[13px] leading-relaxed text-ink-soft">
          ⚠️ 線上課程頁目前不顯示「副標」與「引言」這兩欄，其餘照常顯示。
        </p>
      )}

      {/*
        ⑦ 這一格放「這門課要賣的東西」：工作坊頁的場次、課程頁的單元，
        在各自的前台頁面都緊接在介紹之後。兩者都有資料時就兩個都出現。
      */}
      {showSessions && (
        <section id="sessions" className="flex flex-col gap-4 border-t border-line pt-6">
          <SectionHeader
            step={nextStep()}
            title="場次與報名"
            description={
              product.type === "workshop"
                ? "前台在介紹底下就是這一區，是整頁最重要的部分。已報名人數由結帳流程維護，這裡看得到但改不了；要微調請到「場次報名」。"
                : "這門課的類型不是實體工作坊，但它底下已經有場次（例如線上課另外開的實體班），所以一併列出來讓你能編輯。"
            }
          />
          <SessionEditor productId={product.id} sessions={sessions} />
        </section>
      )}

      {showLessons && (
        <section id="lessons" className="flex flex-col gap-4 border-t border-line pt-6">
          <SectionHeader
            step={nextStep()}
            title="課程單元"
            description={
              product.type === "course"
                ? "前台在介紹底下就是這一區，學員買了之後也是在這裡上課。調整順序不會動到學員已經看到的進度；移除單元則會連進度一起刪掉。"
                : "這門課的類型不是線上課程，但它底下已經有單元，所以一併列出來讓你能編輯。"
            }
          />
          <LessonEditor productId={product.id} lessons={lessons} />
        </section>
      )}

      {/*
        線上課程頁還沒支援下面這些區段（見上面 workshopOnlyIsDead 的說明）。
        收起來而不是拿掉：資料還在，也還能先寫好等前台支援。
        ⚠️ <details> 裡面不可以放 required 欄位 —— 收合時瀏覽器沒辦法把焦點
           移到看不見的欄位，會靜默拒絕送出。這裡面全部是選填 textarea 與
           沒有 required 的 BlockEditor，已確認過。
      */}
      {workshopOnlyIsDead ? (
        <details className="rounded-card border border-dashed border-line-strong bg-panel px-4 py-3">
          <summary className="flex min-h-11 cursor-pointer list-none items-center text-[15px] font-medium text-ink admin:min-h-10 [&::-webkit-details-marker]:hidden">
            ＋ 工作坊報名頁專用的段落（線上課程頁目前不會顯示）
          </summary>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
            這些欄位填了會存起來，但線上課程的前台頁面現在還沒有這幾段版面，
            所以客人看不到。工作坊則會照常顯示。
            線上課程頁的講師介紹與常見問題目前是寫死在程式裡的，改這裡或網站設定都不會變動。
          </p>
          <div className="mt-4 flex flex-col gap-6">{renderWorkshopOnly()}</div>
        </details>
      ) : (
        renderWorkshopOnly()
      )}

      <ProductSettingsSection product={product} step={nextStep()} />

      <ProductSaveBar isNew={false} backTo={showSessions ? "workshop" : "course"} />
    </div>
  );
}

/** 一種報名頁區塊 = 一個區段。標題與說明來自 BLOCK_META。 */
function BlockSection({
  productId,
  kind,
  step,
  blocks,
}: {
  productId: string;
  kind: BlockKind;
  step: string;
  blocks: BlockRow[];
}) {
  const meta = BLOCK_META[kind];
  return (
    <section className="flex flex-col gap-4 border-t border-line pt-6">
      <SectionHeader step={step} title={meta.title} description={meta.description} />
      <BlockEditor
        productId={productId}
        kind={kind}
        blocks={blocks.filter((b) => b.kind === kind)}
      />
    </section>
  );
}

function Header({
  title,
  meta,
  actions,
  backTo = "course",
}: {
  title: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  /**
   * 麵包屑要回哪一張清單。
   *
   * 清單已經拆成「線上課程」與「工作坊」兩頁，而編輯頁還是同一支（/admin/products/[id]）——
   * 那代表編輯的時候側欄不會有任何項目亮起來。麵包屑至少要把人送回他剛才來的那一頁，
   * 不然改完一門工作坊會被丟到課程清單上。
   */
  backTo?: "course" | "workshop";
}) {
  const back =
    backTo === "workshop"
      ? { href: "/admin/workshops", label: "← 回工作坊" }
      : { href: "/admin/courses", label: "← 回線上課程" };

  return (
    <div className="flex flex-col gap-3">
      <Link
        href={back.href}
        className="text-[14px] text-accent-ink underline underline-offset-4"
      >
        {back.label}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-serif text-[24px] leading-tight font-medium break-words text-ink">
            {title}
          </h1>
          {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/**
 * Next 用「丟例外」實作 notFound() 與 redirect()。
 * 這種例外必須原封不動往上丟，被 catch 住的話 404 會變成一句
 * 「讀取失敗」，而使用者以為是系統壞了。
 */
function isNextControlFlow(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const digest = (error as { digest?: unknown }).digest;
  return (
    typeof digest === "string" &&
    (digest.startsWith("NEXT_REDIRECT") || digest === "NEXT_NOT_FOUND")
  );
}
