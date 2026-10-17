import "server-only";

import { createClient } from "@/lib/supabase/server";
import { normalizeFormat, placeText, type SessionFormat } from "@/lib/session-format";

/**
 * 會員中心的資料層。
 *
 * 🔑 全部走使用者自己的 session client，完全不碰 service role。
 *    授權靠 RLS 本身：orders_select_own、entitlements_select_own、
 *    lesson_progress_select_own 保證他只查得到自己的東西。
 *    這跟 /admin 的做法相反（那邊一律 service role + TS 層 capability），
 *    因為兩者問的問題不一樣：後台問「你有沒有權限」，會員中心問「這是不是你的」，
 *    而後者正是 RLS 最擅長的。少一條能繞過權限的路就少一個出事的方式。
 *
 * ⚠️ course_lessons 現在是**欄位級 grant**（見 20260810000006）。
 *    這裡的 select 一定要明列欄位，寫成 course_lessons(*) 會整個查詢 42501，
 *    而且錯誤長得像「這門課沒有單元」。youtube_id 不在白名單裡是刻意的。
 *
 * ⚠️ 「買過但後來下架」的商品由 20260810000007 的 products_select_owned
 *    等三條 policy 放行。沒有那支 migration 的話，公司一下架課程，
 *    客人的「我的學習」就會少一門課而且不會報錯。
 */

type Embedded<T> = T | T[] | null;

/** PostgREST 的內嵌關聯有時回物件、有時回陣列，統一收斂。 */
function one<T>(value: Embedded<T>): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/* ------------------------------------------------------------- 我的學習 */

export type MyCourse = {
  productId: string;
  slug: string;
  title: string;
  subtitle: string | null;
  coverUrl: string | null;
  /** null = 永久回放 */
  expiresAt: string | null;
  /** 已經過期。仍然顯示，但不給進教室（誠實勝過讓他點進去看到空白）。 */
  expired: boolean;
  /** products.type。訂閱制沒有影片單元，卡片要講不一樣的話。 */
  type: string;
  totalLessons: number;
  completedLessons: number;
  /** 上次看到哪一堂（用來做「繼續上課」）。全新的課是 null。 */
  resumeLessonId: string | null;
  resumeLessonTitle: string | null;
};

export type MyCoursesResult = {
  courses: MyCourse[];
  /** 讀取失敗。null = 一切正常（可能只是真的沒買過課）。 */
  error: string | null;
};

export async function getMyCourses(): Promise<MyCoursesResult> {
  try {
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("entitlements")
      .select(
        "product_id, expires_at, products(id, slug, title, subtitle, cover_url, type)",
      )
      .order("granted_at", { ascending: false });

    if (error) {
      console.error("[account] 讀取已購課程失敗", error.message);
      return { courses: [], error: "課程清單暫時讀不到。" };
    }

    const rows = data ?? [];
    if (rows.length === 0) return { courses: [], error: null };

    const productIds = rows
      .map((r) => r.product_id as string)
      .filter(Boolean);

    // 單元清單與自己的進度分開查，再在記憶體裡合併。
    // 用一個大 join 的話 PostgREST 會為每一堂課重複整個 product 物件，
    // 而且沒辦法只撈「自己的」progress（那是另一張表的 RLS）。
    const [lessonsRes, progressRes] = await Promise.all([
      supabase
        .from("course_lessons")
        .select("id, product_id, title, sort_order")
        .in("product_id", productIds)
        .order("sort_order", { ascending: true }),
      supabase.from("lesson_progress").select("lesson_id, completed, updated_at"),
    ]);

    if (lessonsRes.error) {
      console.error("[account] 讀取單元失敗", lessonsRes.error.message);
    }
    if (progressRes.error) {
      console.error("[account] 讀取進度失敗", progressRes.error.message);
    }

    const lessons = (lessonsRes.data ?? []) as {
      id: string;
      product_id: string;
      title: string;
      sort_order: number;
    }[];
    const progress = new Map(
      (progressRes.data ?? []).map((p) => [
        p.lesson_id as string,
        {
          completed: p.completed as boolean,
          updatedAt: (p.updated_at as string) ?? "",
        },
      ]),
    );

    const now = Date.now();

    const courses = rows.flatMap<MyCourse>((row) => {
      const product = one(
        row.products as Embedded<{
          id: string;
          slug: string;
          title: string;
          subtitle: string | null;
          cover_url: string | null;
          type: string;
        }>,
      );
      // 商品被硬刪掉（order_items 是 on delete restrict，所以這幾乎不會發生，
      // 但 entitlements 的 FK 是 cascade，理論上這一列也會一起消失）。
      // 真的遇到就跳過，不要渲染一張沒有名字的卡片。
      if (!product) return [];

      const mine = lessons.filter((l) => l.product_id === row.product_id);
      const completed = mine.filter((l) => progress.get(l.id)?.completed).length;

      // 「繼續上課」= 第一個還沒完成的單元。全部完成就回 null（顯示「重看」）。
      const nextLesson = mine.find((l) => !progress.get(l.id)?.completed) ?? null;

      const expiresAt = (row.expires_at as string | null) ?? null;

      return [
        {
          productId: product.id,
          slug: product.slug,
          title: product.title,
          subtitle: product.subtitle,
          coverUrl: product.cover_url,
          type: product.type,
          expiresAt,
          expired: expiresAt !== null && new Date(expiresAt).getTime() < now,
          totalLessons: mine.length,
          completedLessons: completed,
          resumeLessonId: nextLesson?.id ?? null,
          resumeLessonTitle: nextLesson?.title ?? null,
        },
      ];
    });

    return { courses, error: null };
  } catch (err) {
    console.error("[account] getMyCourses 例外", err);
    return { courses: [], error: "課程清單暫時讀不到。" };
  }
}

/* ------------------------------------------------------------- 我的訂單 */

export type MyOrderItem = {
  title: string;
  qty: number;
  unitPrice: number;
  sessionStartsAt: string | null;
  sessionLocation: string | null;
};

export type MyOrder = {
  id: string;
  orderNo: string;
  status: string;
  paymentMethod: string | null;
  total: number;
  createdAt: string;
  paidAt: string | null;
  shippingAddress: string | null;
  note: string | null;
  items: MyOrderItem[];
};

export type MyOrdersResult = { orders: MyOrder[]; error: string | null };

const ORDER_SELECT =
  "id, order_no, status, payment_method, total, created_at, paid_at, shipping_address, note, " +
  "order_items(qty, unit_price, products(title), workshop_sessions(starts_at, location, format))";

function mapOrder(row: Record<string, unknown>): MyOrder {
  const rawItems = (row.order_items ?? []) as Record<string, unknown>[];
  return {
    id: row.id as string,
    orderNo: row.order_no as string,
    status: row.status as string,
    paymentMethod: (row.payment_method as string | null) ?? null,
    total: (row.total as number) ?? 0,
    createdAt: row.created_at as string,
    paidAt: (row.paid_at as string | null) ?? null,
    shippingAddress: (row.shipping_address as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    items: rawItems.map((item) => {
      const product = one(item.products as Embedded<{ title: string }>);
      const session = one(
        item.workshop_sessions as Embedded<{
          starts_at: string | null;
          location: string | null;
          format: string | null;
        }>,
      );
      return {
        // order_items 沒有存商品名稱快照，只能 join products。
        // 商品被刪掉時會是 null——顯示佔位字而不是空白，客人才知道不是網站壞了。
        title: product?.title ?? "（這個品項已經下架）",
        qty: (item.qty as number) ?? 1,
        unitPrice: (item.unit_price as number) ?? 0,
        sessionStartsAt: session?.starts_at ?? null,
        // 在這裡就換成給客人看的那句（線上 →「線上上課」），訂單明細頁不用改。
        // 以前照印 location，線上場次填了「ON LINE」就顯示「・ON LINE」。
        sessionLocation: session
          ? placeText(normalizeFormat(session.format), session.location) || null
          : null,
      };
    }),
  };
}

export async function getMyOrders(): Promise<MyOrdersResult> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("orders")
      .select(ORDER_SELECT)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      console.error("[account] 讀取訂單失敗", error.message);
      return { orders: [], error: "訂單清單暫時讀不到。" };
    }
    // 兩層內嵌（orders → order_items → products / workshop_sessions）會讓
    // supabase-js 的型別推導放棄並回 GenericStringError，所以這裡先轉 unknown。
    // 實際的形狀由 mapOrder() 逐欄收斂，不是無腦相信。
    return {
      orders: (data ?? []).map((row) =>
        mapOrder(row as unknown as Record<string, unknown>),
      ),
      error: null,
    };
  } catch (err) {
    console.error("[account] getMyOrders 例外", err);
    return { orders: [], error: "訂單清單暫時讀不到。" };
  }
}

export async function getMyOrder(orderId: string): Promise<MyOrder | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("orders")
      .select(ORDER_SELECT)
      .eq("id", orderId)
      .maybeSingle();

    // 查不到有兩種可能：訂單不存在，或它不是這個人的（RLS 濾掉了）。
    // 刻意不區分——區分就等於告訴人家「這個 id 存在但不是你的」。
    if (error) {
      console.error("[account] 讀取訂單明細失敗", orderId, error.message);
      return null;
    }
    return data ? mapOrder(data as unknown as Record<string, unknown>) : null;
  } catch (err) {
    console.error("[account] getMyOrder 例外", err);
    return null;
  }
}

/* --------------------------------------------------------- 我的工作坊 */

export type MyWorkshop = {
  orderId: string;
  orderNo: string;
  orderStatus: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  location: string | null;
  address: string | null;
  /** 實體／線上／混合，已正規化（未指定 = 實體）。 */
  format: SessionFormat;
  sessionStatus: string | null;
};

export type MyWorkshopsResult = {
  upcoming: MyWorkshop[];
  past: MyWorkshop[];
  error: string | null;
};

/**
 * 我報名的工作坊。
 *
 * 資料來源是 order_items.session_id ——**不是** entitlements。
 * workshop 從來不發 entitlement（見 grant_entitlements_for_order 的註解），
 * 報名名單一律從訂單推導，worker 的 workshop-reminders.ts 也是同一個模式。
 *
 * 待付款的訂單也列出來，但會標「還沒收到款項」：
 * 客人 ATM 匯款後隔一天才對帳，這段時間他最想看到的就是「我報名了」。
 */
export async function getMyWorkshops(): Promise<MyWorkshopsResult> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("orders")
      .select(
        "id, order_no, status, order_items(session_id, products(title), " +
          "workshop_sessions(starts_at, ends_at, location, address, format, status))",
      )
      .in("status", ["pending", "paid"])
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[account] 讀取工作坊失敗", error.message);
      return { upcoming: [], past: [], error: "報名紀錄暫時讀不到。" };
    }

    const now = Date.now();
    const upcoming: MyWorkshop[] = [];
    const past: MyWorkshop[] = [];

    // 同 getMyOrders()：兩層內嵌會讓型別推導放棄，先轉 unknown 再逐欄收斂。
    const orderRows = (data ?? []) as unknown as Record<string, unknown>[];

    for (const order of orderRows) {
      const items = (order.order_items ?? []) as Record<string, unknown>[];
      for (const item of items) {
        if (!item.session_id) continue;
        const session = one(
          item.workshop_sessions as Embedded<{
            starts_at: string | null;
            ends_at: string | null;
            location: string | null;
            address: string | null;
            format: string | null;
            status: string | null;
          }>,
        );
        const product = one(item.products as Embedded<{ title: string }>);

        const entry: MyWorkshop = {
          orderId: order.id as string,
          orderNo: order.order_no as string,
          orderStatus: order.status as string,
          title: product?.title ?? "（這個工作坊已經下架）",
          startsAt: session?.starts_at ?? null,
          endsAt: session?.ends_at ?? null,
          location: session?.location ?? null,
          address: session?.address ?? null,
          format: normalizeFormat(session?.format),
          sessionStatus: session?.status ?? null,
        };

        // 場次被刪掉時 session_id 會被設成 null（on delete set null），
        // 所以這裡拿到 null 代表場次還在但讀不到 —— 當成「即將舉行」列出來，
        // 讓客人至少看得到自己報名過，細節請他用 LINE 問。
        const started = entry.startsAt ? new Date(entry.startsAt).getTime() : null;
        if (started !== null && started < now) past.push(entry);
        else upcoming.push(entry);
      }
    }

    upcoming.sort((a, b) => (a.startsAt ?? "").localeCompare(b.startsAt ?? ""));
    past.sort((a, b) => (b.startsAt ?? "").localeCompare(a.startsAt ?? ""));

    return { upcoming, past, error: null };
  } catch (err) {
    console.error("[account] getMyWorkshops 例外", err);
    return { upcoming: [], past: [], error: "報名紀錄暫時讀不到。" };
  }
}
