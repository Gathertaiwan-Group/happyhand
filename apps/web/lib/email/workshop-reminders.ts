import "server-only";

import { createServiceClient } from "@/lib/supabase/server";
import { enqueueEmail } from "@/lib/email/outbox";
import { workshopReminderEmail } from "@/lib/email/templates";
import { twDate, timeRange } from "@/lib/data";
import { normalizeFormat } from "@/lib/session-format";

/**
 * 開課提醒 —— 開課前 3 天與前 1 天各寄一次。
 *
 * 這支的原型是 `apps/worker/src/jobs/workshop-reminders.ts`。搬進 web 端是因為
 * **worker 從來沒有部署過**，而 /checkout/success 對客人寫著「開課前三天我們會
 * 再提醒你一次」—— 那句承諾從上線至今沒有兌現過一次。
 *
 * 搬過來時修掉原版最大的缺陷：
 *
 * 🔴 **去重從記憶體改成資料庫。** worker 版的 dedupe 存在 process 記憶體裡
 *    （它自己的檔頭第 9 行就註明「process 重啟後會重寄」）。serverless 每次
 *    invocation 都是新 process，照搬等於每天重寄同一封。這裡改用
 *    `email_outbox.dedupe_key` 的 unique 約束當冪等保證，key 是
 *    `workshop_reminder:<stage>:<session>:<starts_at>:<email>`，跨 process、
 *    跨部署都有效；帶 starts_at 是為了讓場次改期後會重新提醒一次。
 *
 * 另外兩個差異：
 * ・**視窗放寬成兩天**（見 STAGES）。Vercel Hobby 一天只能跑一次 cron，漏跑一天
 *   就永遠補不回來；放寬之後隔天會補上，而重複由 dedupe_key 擋掉。
 *   ⚠️ 代價是 d3 可能在 D-2 才第一次命中，所以信裡的天數用 daysUntil() 實算，
 *   不能用 stage 推 —— 否則會寄出主旨寫「三天後」但其實是後天的信。
 * ・**沒有 auth.users email 回退**。worker 版會在 contact_email 為空時去查
 *   auth 帳號，這裡只用 contact_email，查不到的計入 `withoutEmail` 讓人工處理
 *   （多半是 LINE 代訂的長輩客人，本來就要打電話）。
 */

export type ReminderStage = "d3" | "d1";

/**
 * 每個階段掃哪個區間（單位：天，相對台北今日 00:00）。
 *
 * ⚠️ 兩段刻意不重疊：d1 只看「明天」，d3 看「後天與大後天」。重疊的話同一場
 *    次會在同一天收到兩封。d3 之所以吃兩天，是為了補 cron 漏跑的那天。
 */
const STAGES: ReadonlyArray<{ stage: ReminderStage; from: number; to: number }> = [
  { stage: "d3", from: 2, to: 4 },
  { stage: "d1", from: 1, to: 2 },
];

/** 台北時區固定 UTC+8，沒有日光節約，所以可以直接位移不必查時區表。 */
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 台北「今天 + daysAhead」那天的 00:00，回傳 UTC 時刻。 */
function taipeiDayStart(daysAhead: number, now: Date): Date {
  const local = new Date(now.getTime() + TAIPEI_OFFSET_MS);
  return new Date(
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() + daysAhead,
    ) - TAIPEI_OFFSET_MS,
  );
}

/** 從 now 到場次開始，差幾個台北日曆日。用來決定信裡寫「明天」還是「三天後」。 */
function daysUntil(startsAt: string, now: Date): number {
  const day = (d: Date) =>
    Math.floor((d.getTime() + TAIPEI_OFFSET_MS) / 86_400_000);
  return day(new Date(startsAt)) - day(now);
}

/** 「9月12日（週六）09:30–17:00」 */
function formatWhen(startsAt: string, endsAt: string): string {
  const { month, day, weekday } = twDate(startsAt);
  // twDate 的 month/day 目前會多帶單位，跟 session-row.tsx 用同一套正規化
  const m = month.replace(/\s+/g, "").replace(/月+$/, "月");
  const d = day.replace(/日+$/, "");
  return `${m}${d}日（${weekday}）${timeRange(startsAt, endsAt)}`;
}

type SessionRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  location: string | null;
  address: string | null;
  format: string | null;
  products: { title: string } | null;
};

type ItemRow = {
  session_id: string | null;
  orders: {
    order_no: string;
    contact_name: string | null;
    contact_email: string | null;
  } | null;
};

export type ReminderResult = {
  dryRun: boolean;
  stages: Record<
    ReminderStage,
    {
      sessions: number;
      queued: number;
      duplicate: number;
      failed: number;
      withoutEmail: number;
    }
  >;
  error?: string;
};

const EMPTY = { sessions: 0, queued: 0, duplicate: 0, failed: 0, withoutEmail: 0 };

/**
 * 掃出該提醒的場次並把信排進 outbox。
 *
 * `dryRun` 時完全不寫 outbox，只回統計 —— 用來在正式站上驗證「會寄給誰」
 * 而不真的寄出去。
 */
export async function sendWorkshopReminders(opts?: {
  now?: Date;
  dryRun?: boolean;
}): Promise<ReminderResult> {
  const now = opts?.now ?? new Date();
  const dryRun = opts?.dryRun ?? false;
  const result: ReminderResult = {
    dryRun,
    stages: { d3: { ...EMPTY }, d1: { ...EMPTY } },
  };

  // ⚠️ createServiceClient() 缺 key 時是 throw 不是回 null，所以要接。
  let db: ReturnType<typeof createServiceClient>;
  try {
    db = createServiceClient();
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }

  for (const { stage, from, to } of STAGES) {
    const tally = result.stages[stage];

    const { data: sessionData, error: sessionError } = await db
      .from("workshop_sessions")
      .select("id,starts_at,ends_at,location,address,format,products(title)")
      .gte("starts_at", taipeiDayStart(from, now).toISOString())
      .lt("starts_at", taipeiDayStart(to, now).toISOString())
      // 取消的場次不提醒。closed（額滿關閉報名）照樣提醒 —— 已經報名的人還是要上課。
      .neq("status", "cancelled");

    if (sessionError) {
      console.error("[reminders] 讀場次失敗", stage, sessionError.message);
      result.error = sessionError.message;
      continue;
    }

    const sessions = (sessionData ?? []) as unknown as SessionRow[];
    tally.sessions = sessions.length;
    if (sessions.length === 0) continue;

    const { data: itemData, error: itemError } = await db
      .from("order_items")
      .select("session_id,orders!inner(order_no,status,contact_name,contact_email)")
      .in(
        "session_id",
        sessions.map((s) => s.id),
      )
      // 只提醒已付款的人。待匯款的還不算報名成功，提醒他去上課會誤導。
      .eq("orders.status", "paid");

    if (itemError) {
      console.error("[reminders] 讀報名失敗", stage, itemError.message);
      result.error = itemError.message;
      continue;
    }

    const byId = new Map(sessions.map((s) => [s.id, s]));
    // 同一場次、同一信箱只寄一封（同一個人可能有兩張已付款訂單）
    const seen = new Set<string>();

    for (const item of (itemData ?? []) as unknown as ItemRow[]) {
      const session = item.session_id ? byId.get(item.session_id) : undefined;
      const order = item.orders;
      if (!session || !order) continue;

      const email = order.contact_email?.trim() ?? "";
      if (email === "") {
        // 沒有信箱就寄不了。多半是電話／LINE 代訂，需要客服打電話。
        tally.withoutEmail += 1;
        console.warn(
          "[reminders] 報名者沒有 email，需人工通知",
          stage,
          order.order_no,
        );
        continue;
      }

      const key = `${session.id}:${email.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (dryRun) {
        tally.queued += 1;
        continue;
      }

      /*
        dedupe key 帶上 starts_at：場次改期之後應該要**重新**提醒一次。
        不帶的話 key 不變 → 被當成重複 → 客人手上只有一封寫著舊日期的信。
      */
      const dedupeKey = `workshop_reminder:${stage}:${session.id}:${session.starts_at}:${email.toLowerCase()}`;
      const queued = await enqueueEmail({
        dedupeKey,
        ...workshopReminderEmail({
          to: email,
          name: order.contact_name?.trim() || "同學",
          daysAhead: daysUntil(session.starts_at, now),
          title: session.products?.title ?? "快樂手工作坊",
          when: formatWhen(session.starts_at, session.ends_at),
          location: session.location,
          address: session.address,
          // 線上場次整封提醒信的用詞都不一樣，而且不可以寄地址。
          format: normalizeFormat(session.format),
          orderNo: order.order_no,
        }),
      });

      if (queued) {
        tally.queued += 1;
        continue;
      }

      /*
        🔴 enqueueEmail 對「重複」與「資料庫錯誤」都回 false。全部記成 duplicate
        的話，排入失敗會長得跟正常去重一模一樣 —— 而 d1 只有 D-1 一次機會，
        那位客人的提醒就永久消失且監控上無跡可循。回頭查一次 key 在不在來分辨。
      */
      const { data: existing, error: checkError } = await db
        .from("email_outbox")
        .select("id")
        .eq("dedupe_key", dedupeKey)
        .maybeSingle();

      if (!checkError && existing) {
        tally.duplicate += 1;
      } else {
        tally.failed += 1;
        console.error(
          "[reminders] 🔴 排入 outbox 失敗，這位客人不會收到提醒",
          stage,
          order.order_no,
        );
      }
    }
  }

  return result;
}
