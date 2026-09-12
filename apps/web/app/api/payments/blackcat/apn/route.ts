import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { grantEntitlementsForOrder } from "@/lib/admin/entitlements";
import { ensureInvoiceRow, issueForOrder } from "@/lib/invoice/issue";
import {
  APN_STATUS,
  APN_STATUS_LABEL,
  extractPaidAmount,
  queryOrder,
  verifyApnChecksum,
} from "@/lib/payment/blackcat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 黑貓 PAY APN 主動通知接收端點。
 *
 * 這個網址要填進黑貓 PAY 後台（會員專區 › 連線設定修改 › 線上刷卡 ›
 * 「APN - 主動通知接收網址」），或由建單時的 apn_url 指定。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 為什麼光驗 checksum 不夠：checksum 裡沒有任何祕密
 * ─────────────────────────────────────────────────────────────
 * 規格 P89 的算法是
 *     MD5(api_id : trans_id : amount : status : nonce)
 * 五個欄位**全部都在通知本體裡**，沒有 hash_base、沒有任何預先共享的密鑰。
 * 也就是說任何人都能自己組一份「付款成功」的 JSON、自己算出合法的 checksum，
 * POST 到這個公開網址。客人知道自己的訂單編號，所以這不是理論攻擊。
 *
 * 因此這裡**一定要回查黑貓 PAY 的訂單查詢 API**（CocsOrderQuery）拿 process_code，
 * 以他們伺服器上的狀態為準。checksum 只用來擋掉隨機亂打的雜訊。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 金額要用「獨立來源」比，order_amount 不算獨立
 * ─────────────────────────────────────────────────────────────
 * 規格 P35 注意事項 2（紅字）：「APN 回檔時，有回拋實際繳款金額 pay_amount 給商戶，
 * 請技術要以實際繳款金額去判別這筆繳款應實收是否相符後才撥付商品給消費者。」
 *
 * 這裡曾經寫成 `payAmount ?? remoteAmount`，而 remoteAmount 是回查回來的
 * order_amount —— 那是我們自己在建單時送出去的數字，回查只是原樣念回來，
 * 永遠等於 orders.total。於是只要 pay_amount 讀不到，比對就退化成
 * 「orders.total === orders.total」的恆真式：防護還在、看起來也很像在防，
 * 但實際上什麼都沒擋，正好抵消掉這條紅字規則存在的理由。
 *
 * 現在讀不到獨立金額就**誠實記成沒驗過**（outcome = applied_unverified），
 * 讓它出現在後台告警裡等人看，而不是假裝驗過了。
 *
 * ─────────────────────────────────────────────────────────────
 * 回覆規定（規格 P87）
 * ─────────────────────────────────────────────────────────────
 * 必須回**純文字 `OK`**。沒回的話每 15 分鐘重送一次、同一個狀態碼最多送 3 次。
 * 所以：業務面的失敗（金額不符、找不到訂單）也要回 OK —— 重送不會讓結果變好，
 * 那些要靠 /admin 的告警讓人去處理。只有「我們自己壞了」（DB 失敗、回查失敗）
 * 才回非 200 讓它重送，而重送要真的能重跑，見下面 claimEvent() 的說明。
 */

/** 規格附件 1：這些 process_code 代表銀行確實授權過。 */
const AUTHORIZED_PROCESS_CODES = new Set([
  15, // 授權完成
  20, // 請求請款
  21, // 請款作業中
  22, // 請款完成
]);

/**
 * 這幾個狀態都代表「銀行已經授權過」，都要走開通流程。
 *
 * 🔴 原本只認 B（授權完成）。問題是同一個狀態碼最多重送 3 次就放棄，
 *    B 那三次要是都沒能處理完（網路抖一下、回查暫時失敗），隔天請款完成的 E
 *    進來也只會被記一個狀態碼然後丟掉 —— 錢請款完成了，訂單卻永遠停在待付款。
 *    B/O/E 都認等於多兩次自癒機會；重複進來不會重複開通，因為下面的 update 有
 *    .eq("status", "pending")，grant 與發票也各自冪等。
 */
const GRANTING_STATUSES = new Set<string>([
  APN_STATUS.AUTHORIZED, // B 授權完成
  APN_STATUS.CAPTURING, // O 請款作業中
  APN_STATUS.CAPTURED, // E 請款完成
]);

/**
 * 「本來收到的錢，後來沒了」。
 *
 * 🔴 這不是假設性的：正式站的 HH-20260831-AHM4（NT$20）在 8/31 14:33 收到 B、
 *    開通完成，15:05 又收到 Q（取消授權完成）—— 而當時的程式把 Q 歸在
 *    「其餘狀態記錄下來就好」，記成 outcome=ignored 然後回 OK。
 *    結果就是：授權被取消、錢沒了，訂單到現在還是「已收款」，
 *    工作坊席次還佔著，課程權限也還在，而後台沒有任何地方看得出來。
 *
 * ⚠️ 刻意**不自動**把訂單改成已退款：
 *    - refunded 是終局狀態（shared.ts 的 ORDER_TRANSITIONS），改下去就回不來；
 *    - 改狀態會連帶把工作坊席次放掉，等於憑一則 webhook 就讓別人補上位子；
 *    - 這整套的設計原則是「不可逆的事情要有人按」（退款、作廢發票都是這樣）。
 *    所以這裡只負責讓它**吵**：記成 reversal_notice，進 /admin 的「需要處理」。
 */
const REVERSAL_STATUSES = new Set<string>([
  APN_STATUS.REFUNDED, // M 取消交易完成
  APN_STATUS.AUTH_CANCELLED, // Q 取消授權完成
  APN_STATUS.CAPTURE_FAILED, // P 請款失敗（授權過但錢請不進來）
]);

/**
 * 「這則通知上一次已經處理到底了」的 outcome。
 *
 * 🔴 去重要以**做完**為準，不是以**收到過**為準。
 *    這裡列的是重送也不會有不同結果的終局：
 *      applied / applied_unverified —— 已經開通
 *      ignored                     —— 這個狀態碼本來就不觸發開通
 *      amount_mismatch             —— 金額不對，重送一百次還是不對
 *
 *    刻意**不列**在裡面的（＝重送時會重跑一次）：
 *      pending        —— 上次跑到一半就掛了
 *      verify_failed  —— 回查失敗，下次可能就查得到
 *      not_authorized —— 回查說還沒授權。有可能只是 APN 比對方自己的
 *                        訂單狀態早一步；偽造的通知重送兩次也還是會被擋，
 *                        代價只有兩次白工。
 *      order_not_found—— 訂單可能是事後人工補建的
 */
const TERMINAL_OUTCOMES = new Set([
  "applied",
  "applied_unverified",
  "ignored",
  "amount_mismatch",
  "reversal_notice",
]);

/** 純文字 OK —— 規格要的就是這個，不能包成 JSON。 */
function ok() {
  return new NextResponse("OK", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** APN 的數字欄位可能是 number 也可能是字串（規格 sample 兩種都有）。 */
function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = Number(v.trim().replace(/["']/g, ""));
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

type Db = ReturnType<typeof createServiceClient>;

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new NextResponse("BAD_REQUEST", { status: 400 });
  }

  const apiId = body.api_id;
  const transId = String(body.trans_id ?? "");
  const orderNo = String(body.order_no ?? "");
  const status = String(body.status ?? "");
  const amount = toInt(body.amount);

  if (!transId || !status) {
    return new NextResponse("BAD_REQUEST", { status: 400 });
  }

  // 1) 驗 checksum。擋隨機雜訊用，不是真正的授權依據（見檔頭）。
  const checksumOk = verifyApnChecksum({
    apiId,
    transId,
    amount: body.amount,
    status,
    nonce: body.nonce,
    checksum: body.checksum,
  });
  if (!checksumOk) {
    console.warn("[blackcat/apn] checksum 驗證失敗", { orderNo, transId, status });
    return new NextResponse("BAD_CHECKSUM", { status: 400 });
  }

  const detail = (body.payment_detail ?? {}) as Record<string, unknown>;
  const payAmount = toInt(detail.pay_amount);

  const db = createServiceClient();

  // 2) 找訂單。用我們自己的 order_no（建單時就是拿它當 cust_order_no）。
  const { data: order, error: findError } = await db
    .from("orders")
    .select("id, order_no, status, total, payment_status_code")
    .eq("order_no", orderNo)
    .maybeSingle();

  if (findError) {
    // 我們自己的 DB 壞了 —— 回非 200 讓它重送。
    console.error("[blackcat/apn] 查訂單失敗", orderNo, findError.message);
    return new NextResponse("DB_ERROR", { status: 500 });
  }

  /**
   * 3) 去重／認領。
   *
   * 🔴 這一段以前是這樣寫的：
   *        if (error && error.code !== "23505") return false;
   *        return !error;                       // 23505 也回 false
   *      ...
   *        const isNew = await logEvent("pending");
   *        if (!isNew) return ok();
   *
   *    兩個獨立的問題疊在一起：
   *
   *    a. 「資料庫寫入失敗」和「這則通知重複了」被壓成同一個回傳值 false，
   *       於是 DB 暫時性錯誤會被當成重複通知**靜默 ack**，那筆付款連一列
   *       紀錄都不會留下。
   *
   *    b. 去重列是在**做事之前**就寫下去的。所以回查遇到暫時性錯誤 → 回 500
   *       要求重送 → 重送時撞到那一列 → 判定為重複 → 靜默 ack。
   *       檔案裡每一句「回 500 讓它重送」實際上都到不了。
   *       一次網路抖動就永久掉一張單。
   *
   *    現在分成四種結果，而且以「上次有沒有做完」決定要不要重跑。
   *    重跑是安全的：訂單 update 有 .eq("status","pending")、
   *    grantEntitlementsForOrder 冪等、發票有自己的 claim、
   *    名額只在這次真的把 pending 翻成 paid 時才動。
   */
  const claim = await claimEvent(db, {
    order_id: order?.id ?? null,
    provider: "blackcat",
    trans_id: transId,
    order_no: orderNo,
    status_code: status,
    amount,
    pay_amount: payAmount,
    nonce: body.nonce ? String(body.nonce) : null,
    raw: body,
    outcome: "pending",
  });

  if (claim === "db_error") {
    // 真的寫不進去。回非 200 讓它重送 —— 這條路現在是通的。
    return new NextResponse("DB_ERROR", { status: 500 });
  }
  if (claim === "already_done") {
    return ok();
  }

  /** 把這則通知的處理結果定案。queryRaw 有給就一併存起來（見下方註解）。 */
  const finish = async (
    outcome: string,
    note?: string,
    queryRaw?: Record<string, unknown>,
  ) => {
    const patch: Record<string, unknown> = { outcome, note: note ?? null };
    /*
      回查的完整回應存進 raw，查帳用。
      欄位名已於 2026-09-12 用同一家 COCS 的真實交易驗證（見 lib/payment/blackcat.ts
      的 PAID_AMOUNT_FIELDS 註解）：實收金額只在 APN 的 payment_detail.pay_amount，
      回查回應裡沒有。所以 applied_unverified 只會在 APN 缺 payment_detail 時出現，
      真實資料顯示 B/O/E 每一則都帶。
    */
    if (queryRaw) patch.raw = { ...body, __query_response: queryRaw };
    const { error } = await db
      .from("payment_events")
      .update(patch)
      .eq("provider", "blackcat")
      .eq("trans_id", transId)
      .eq("status_code", status);
    if (error) {
      console.error("[blackcat/apn] 更新 payment_events 失敗", transId, error.message);
    }
  };

  if (!order) {
    await finish("order_not_found");
    console.warn("[blackcat/apn] 找不到訂單", orderNo, transId);
    return ok(); // 重送也多半找不到，回 OK 停止重送，靠告警處理
  }

  // 只有「已授權」那一族要開通課程。其餘狀態記錄下來就好。
  if (!GRANTING_STATUSES.has(status)) {
    await db
      .from("orders")
      .update({
        payment_status_code: status,
        payment_notified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id);

    /*
      沖銷通知。只有在訂單「現在還是已收款」時才算異常 ——
      已經是 refunded／cancelled 的話，代表這是我們自己按退款按鈕造成的回拋，
      系統跟金流是一致的，不需要再吵一次。
    */
    if (REVERSAL_STATUSES.has(status) && order.status === "paid") {
      const label = APN_STATUS_LABEL[status] ?? status;
      console.error("[blackcat/apn] 收到沖銷通知但訂單仍是已收款", orderNo, status);
      await finish(
        "reversal_notice",
        `黑貓 PAY 回報「${label}」，但訂單還是已收款 —— ` +
          "錢已經退回去了，訂單狀態、工作坊席次與課程權限都還沒處理。" +
          "請確認之後手動按「已在後台退過款」。",
      );
      return ok();
    }

    await finish("ignored", `狀態 ${status} 不觸發開通`);
    return ok();
  }

  // 4) 🔴 回查黑貓 PAY，以他們伺服器上的狀態為準（防偽造通知）。
  const remote = await queryOrder(orderNo);
  if (!remote.ok) {
    // 查不到就不能開通。回 500 讓它重送，說不定下次查得到 ——
    // verify_failed 不在 TERMINAL_OUTCOMES 裡，所以重送會真的重跑一次。
    console.error("[blackcat/apn] 回查訂單失敗", orderNo, remote.reason);
    await finish("verify_failed", remote.reason);
    return new NextResponse("VERIFY_FAILED", { status: 500 });
  }

  const processCode = toInt(remote.data.process_code);
  if (processCode === null || !AUTHORIZED_PROCESS_CODES.has(processCode)) {
    console.warn("[blackcat/apn] 回查狀態不是已授權", orderNo, processCode);
    await finish("not_authorized", `回查 process_code=${processCode}`, remote.raw);
    return ok();
  }

  /*
    5) 🔴 金額比對。只認**獨立來源**的金額。

    order_amount 不是獨立來源：那是我們自己送出去的數字，回查原樣念回來，
    永遠等於 order.total。拿它比對是恆真式（見檔頭）。

    讀不到獨立金額時的選擇：
      - 不開通 → 客人付了錢看不到課，而這條金流的金額是我們在建單時就鎖死的，
                 客人根本沒有機會付成別的數字，風險幾乎不存在。太嚴苛。
      - 假裝驗過 → 就是原本那個恆真式。不行。
      - 開通，但誠實記成「沒驗過」→ 課照開，後台看得到有幾筆需要人工核對金額。
    取第三種。
  */
  const paid = extractPaidAmount(detail, remote.data);
  if (paid !== null && paid !== order.total) {
    console.error("[blackcat/apn] 金額不符，不開通", {
      orderNo,
      應收: order.total,
      實收: paid,
      apn_amount: amount,
    });
    await finish(
      "amount_mismatch",
      `應收 ${order.total}，實收 ${paid}`,
      remote.raw,
    );
    return ok(); // 重送沒用，要人工處理
  }

  // 6) 標記付款。條件式 update：只有 pending 會被改到，這是第二層冪等。
  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await db
    .from("orders")
    .update({
      status: "paid",
      paid_at: now,
      payment_provider: "blackcat",
      payment_trade_no: transId,
      payment_status_code: status,
      // 🔴 驗不到就寫 null。寫 order.total 會讓這一欄看起來像「已核對的實收金額」，
      //    但那只是把應收金額抄一份 —— 對帳的人會被騙。
      payment_paid_amount: paid,
      payment_card_no: detail.auth_card_no ? String(detail.auth_card_no) : null,
      payment_auth_code: detail.auth_code ? String(detail.auth_code) : null,
      payment_notified_at: now,
      payment_method: "credit",
      updated_at: now,
    })
    .eq("id", order.id)
    .eq("status", "pending")
    .select("id, order_no")
    .maybeSingle();

  if (updateError) {
    console.error("[blackcat/apn] 更新訂單失敗", orderNo, updateError.message);
    return new NextResponse("DB_ERROR", { status: 500 });
  }

  // updated 是 null 代表訂單已經不是 pending（例如客服先手動標記過），
  // 這不是錯誤 —— 照樣往下開通，grant 本身是冪等的。
  const grant = await grantEntitlementsForOrder(order.id);

  /*
    電子發票。刻意放在開通課程**之後**、而且整段包在自己的 try 裡：
    錢已經收了、課要開通，發票開不出來絕不可以讓這支 APN 回非 200 ——
    那會讓黑貓 PAY 每 15 分鐘重送，而重送不會讓發票變得開得出來。

    ensureInvoiceRow 是冪等的（unique amego_order_id），所以客服先手動標記過、
    APN 再進來的情況重複呼叫也安全。
    issueForOrder 內部有 claim，不會因為兩條路都跑而開出兩張。
  */
  try {
    if (await ensureInvoiceRow(order.id)) {
      const out = await issueForOrder(order.id);
      if (out.status === "failed") {
        console.error("[blackcat/apn] 開立發票失敗（不影響付款）", orderNo, out.reason);
      }
    }
  } catch (err) {
    console.error("[blackcat/apn] 發票流程例外（不影響付款）", orderNo, err);
  }

  // 🔴 工作坊名額同步。只有這次真的把訂單從 pending 改成 paid 才做，
  //    否則客服先手動標記過、APN 再進來就會重複加一次。
  //
  //    沒有這段的話會超賣：workshop_holds() 只算 pending 的訂單，付款後那筆
  //    不再計入 held，但 seats_taken 也沒增加 —— 位子就憑空多出來了。
  //
  //    ⚠️ 這裡刻意用跟 admin/orders/actions.ts 的 syncSeats() 同一支 RPC
  //    （admin_adjust_seats）。那支是 server action 的私有函式沒有 export，
  //    改動它的名額邏輯時記得這裡也要跟著改。
  if (updated) {
    const { data: seatItems, error: seatError } = await db
      .from("order_items")
      .select("session_id, qty")
      .eq("order_id", order.id)
      .not("session_id", "is", null);

    if (seatError) {
      console.error("[blackcat/apn] 讀取品項失敗，名額未同步", orderNo, seatError.message);
    } else {
      // 同一場次可能拆成多個品項，先合併再呼叫，一個場次只打一次 RPC
      const bySession = new Map<string, number>();
      for (const it of (seatItems ?? []) as {
        session_id: string | null;
        qty: number;
      }[]) {
        if (!it.session_id) continue;
        bySession.set(
          it.session_id,
          (bySession.get(it.session_id) ?? 0) + (it.qty ?? 0),
        );
      }
      for (const [sessionId, qty] of bySession) {
        const { error } = await db.rpc("admin_adjust_seats", {
          p_session_id: sessionId,
          p_delta: qty,
        });
        if (error) {
          // 錢已經收了，不能因為名額沒同步就退回。留 log 讓客服對帳。
          console.error(
            "[blackcat/apn] 名額同步失敗，請人工確認場次報名人數",
            orderNo,
            sessionId,
            error.message,
          );
        }
      }
      if (bySession.size > 0) revalidatePath("/workshops");
    }
  }

  await finish(
    paid === null ? "applied_unverified" : "applied",
    `${updated ? "已標記付款" : "訂單原本就不是待付款"}；` +
      `開通 ${grant.granted} 門、既有 ${grant.kept} 門` +
      (grant.ok ? "" : `；開通失敗：${grant.reason ?? "unknown"}`) +
      (paid === null
        ? "；⚠️ 回應裡沒有可用的實收金額欄位，這筆的金額**沒有核對過**，請人工比對"
        : ""),
    remote.raw,
  );

  if (!grant.ok) {
    // 錢收了但課沒開通 —— 這是最嚴重的情況，一定要在 log 裡看得到。
    console.error("[blackcat/apn] 已收款但開通失敗", orderNo, grant.reason);
  }

  return ok();
}

/**
 * 認領這則通知。回傳四種結果：
 *
 *   new          第一次收到，往下跑
 *   resume       收過但上次沒做完，往下重跑一次（每一步都冪等）
 *   already_done 上次已經處理到終局，直接 ack
 *   db_error     我們自己壞了，回非 200 讓它重送
 *
 * unique index 是 (provider, trans_id, status_code)，見
 * migrations/20260817000001_payment_blackcat.sql。
 */
async function claimEvent(
  db: Db,
  row: Record<string, unknown>,
): Promise<"new" | "resume" | "already_done" | "db_error"> {
  const { error } = await db.from("payment_events").insert(row);
  if (!error) return "new";

  // 23505 = unique 衝突 = 這個狀態碼收過了。其餘都是真的壞掉。
  if (error.code !== "23505") {
    console.error("[blackcat/apn] 寫入 payment_events 失敗", error.message);
    return "db_error";
  }

  const { data: prev, error: readError } = await db
    .from("payment_events")
    .select("outcome")
    .eq("provider", row.provider as string)
    .eq("trans_id", row.trans_id as string)
    .eq("status_code", row.status_code as string)
    .maybeSingle();

  if (readError || !prev) {
    // 衝突了卻讀不回來，狀況不明 —— 當成我們自己的問題讓它重送，
    // 不要猜「大概處理過了吧」然後把一筆付款吞掉。
    console.error(
      "[blackcat/apn] 讀取既有 payment_events 失敗",
      row.trans_id,
      readError?.message ?? "查無資料",
    );
    return "db_error";
  }

  return TERMINAL_OUTCOMES.has(String(prev.outcome)) ? "already_done" : "resume";
}

/** GET 用來讓人確認網址填對了（黑貓 PAY 後台只吃 POST）。 */
export async function GET() {
  return new NextResponse("blackcat APN endpoint", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
