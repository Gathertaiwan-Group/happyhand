"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCart } from "@/components/cart-provider";
import { createClient as createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Button, LinkButton, buttonClass } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Figure } from "@/components/ui/placeholder";
import { findProduct } from "@/lib/content";
import { suggestEmail } from "@/lib/email-typo";
import { SITE, formatPrice } from "@/lib/site";
import { CheckoutSteps } from "./checkout-steps";
import { CalendarDays, MessageCircle, UserCheck } from "lucide-react";
import { IconText } from "@/components/ui/icon-text";
import { PaymentOptions, type PaymentMethod } from "./payment-options";
import { InvoiceOptions, EMPTY_INVOICE, type InvoiceValue } from "./invoice-options";
import { validateInvoice } from "@/lib/invoice/validate";

type FieldKey = "name" | "phone" | "email" | "address";
type Errors = Partial<Record<FieldKey, string>>;

/** 錯誤要 focus 的順序＝畫面上的順序 */
const FIELD_ORDER: FieldKey[] = ["name", "phone", "email", "address"];

const PHONE_RE = /^09\d{8}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function CheckoutView({
  /** 線上刷卡有沒有真的接好（由 server 端的 isBlackcatConfigured() 算出來） */
  creditEnabled,
}: {
  creditEnabled: boolean;
}) {
  const router = useRouter();
  const { items, total, ready, clear } = useCart();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [payment, setPayment] = useState<PaymentMethod>("credit");
  const [invoice, setInvoice] = useState<InvoiceValue>(EMPTY_INVOICE);

  /**
   * 報名問題。只有購物車裡有工作坊時才問 —— 線上課買了就能看，
   * 不需要老師事先知道學員狀況。
   */
  const [intakeExperience, setIntakeExperience] = useState("");
  const [intakeGoal, setIntakeGoal] = useState("");
  const [intakeSource, setIntakeSource] = useState("");
  const [healthAck, setHealthAck] = useState(false);

  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState(false);

  // 要不要收報名資料，由後台的 products.asks_intake 決定，旗標在加入購物車
  // 那一刻就帶進品項裡 —— 這頁是刻意保持靜態的，不為了這個旗標多打一次 API。
  //
  // 🔴 `?? i.type === "workshop"` 這個 fallback 不能拿掉：改版前就存在
  //    localStorage 裡的購物車沒有這個欄位，拿掉會讓那些人的工作坊訂單
  //    連健康聲明都不用勾。
  const needsIntake = items.some(
    (i) => i.asksIntake ?? i.type === "workshop",
  );

  /**
   * 已登入的人不用重打資料。
   *
   * 刻意在 client 端抓而不是讓 /checkout 變成 server component：
   * 這頁現在是靜態的（○ /checkout），為了少數已登入的人把所有人都變成
   * 每次連線都查一次資料庫並不划算。晚個幾百毫秒才帶入完全可以接受。
   *
   * 只填「還是空的」欄位——使用者已經動手打過的東西絕對不覆蓋。
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = createSupabaseBrowserClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user || cancelled) return;

        const { data: profile } = await supabase
          .from("profiles")
          .select("full_name, phone")
          .eq("id", user.id)
          .maybeSingle();
        if (cancelled) return;

        let touched = false;
        if (user.email) {
          setEmail((v) => {
            if (v) return v;
            touched = true;
            return user.email!;
          });
        }
        if (profile?.full_name) {
          setName((v) => {
            if (v) return v;
            touched = true;
            return profile.full_name as string;
          });
        }
        if (profile?.phone) {
          setPhone((v) => {
            if (v) return v;
            touched = true;
            return profile.phone as string;
          });
        }
        if (touched) setPrefilled(true);
      } catch {
        // 沒登入、環境變數不全、網路壞掉都走這裡。訪客結帳照常運作。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const formRef = useRef<HTMLFormElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  /**
   * 網域可能打錯了的建議。只在 Email 格式本身合法時才提示——
   * 還在打字打到一半就跳出來會很吵。
   */
  const emailSuggestion = useMemo(
    () => (EMAIL_RE.test(email.trim()) ? suggestEmail(email) : null),
    [email],
  );

  /** 有實體課本的商品才需要地址 */
  const needsAddress = useMemo(
    () =>
      items.some((i) => {
        const p = findProduct(i.slug);
        return [i.title, p?.title, ...(p?.tags ?? []), ...(p?.benefits ?? [])]
          .filter(Boolean)
          .join(" ")
          .includes("課本");
      }),
    [items],
  );

  const errors = useMemo<Errors>(() => {
    const e: Errors = {};
    if (!name.trim()) e.name = "請填你的名字，我們才知道怎麼稱呼你。";
    if (!phone.trim()) e.phone = "請填手機號碼，開課前我們會用簡訊提醒你。";
    else if (!PHONE_RE.test(phone))
      e.phone = "手機號碼是 09 開頭、總共 10 個數字。";
    if (!email.trim()) e.email = "這一欄還沒填，我們需要它才能寄開通信給你。";
    else if (!EMAIL_RE.test(email))
      e.email = "Email 看起來還少了什麼，請再檢查一次。";
    if (needsAddress && !address.trim())
      e.address = "這筆訂單有紙本課本要寄，請填收件地址。";
    return e;
  }, [name, phone, email, address, needsAddress]);

  /**
   * 即時驗證：欄位有填了才提示格式問題，不要一進頁面就整排紅字；
   * 按過送出之後才把「還沒填」也一起顯示出來。
   */
  const shown = useCallback(
    (key: FieldKey, filled: string) =>
      submitted || filled.trim().length > 0 ? errors[key] : undefined,
    [submitted, errors],
  );

  const focusFirstError = useCallback((errs: Errors) => {
    const first = FIELD_ORDER.find((k) => errs[k]);
    if (!first) return;
    formRef.current
      ?.querySelector<HTMLElement>(`[name="${first}"]`)
      ?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitted(true);

    if (Object.keys(errors).length > 0) {
      setFormError("有幾個地方還要再確認一下，下面標紅色的欄位請再看一次。");
      focusFirstError(errors);
      return;
    }

    // 健康聲明是法律上的告知同意，沒勾就不能送出。
    if (needsIntake && !healthAck) {
      setFormError("請先閱讀並勾選最下面的健康聲明，我們才能幫你完成報名。");
      window.requestAnimationFrame(() => alertRef.current?.focus());
      return;
    }

    /*
      發票欄位。放在這裡而不是併進 errors：
      errors 是四個聯絡欄位的 useMemo，型別是 Record<FieldKey,…>，硬塞會讓
      focusFirstError 去找一個不存在的 name。發票的錯誤由 InvoiceOptions
      自己顯示在對應欄位下方，這裡只負責擋住送出並把焦點帶過去。
    */
    const invoiceError = validateInvoice(invoice);
    if (invoiceError) {
      setFormError(invoiceError.message);
      window.requestAnimationFrame(() => {
        const el = formRef.current?.querySelector<HTMLElement>(
          `[name="invoice_${invoiceError.field === "carrierId" ? "carrier_id" : invoiceError.field === "taxId" ? "tax_id" : "title"}"]`,
        );
        el?.focus();
      });
      return;
    }

    setFormError(null);
    setBusy(true);

    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
          email: email.trim(),
          address: address.trim(),
          note: note.trim(),
          payment,
          invoice: {
            carrierType: invoice.carrierType,
            carrierId: invoice.carrierId.trim(),
            taxId: invoice.taxId.trim(),
            title: invoice.title.trim(),
          },
          // 報名問題。沒有工作坊時全部是空的，後端會存 null。
          intake: needsIntake
            ? {
                experience: intakeExperience || null,
                goal: intakeGoal.trim() || null,
                source: intakeSource || null,
                healthAck: healthAck,
              }
            : null,
          items: items.map((i) => ({
            productId: i.productId,
            slug: i.slug,
            title: i.title,
            type: i.type,
            qty: i.qty,
            priceSnapshot: i.priceSnapshot,
            sessionId: i.sessionId ?? null,
            sessionLabel: i.sessionLabel ?? null,
          })),
        }),
      });

      const data = (await res.json().catch(() => null)) as {
        order_no?: string;
        message?: string;
        payment_url?: string | null;
      } | null;

      if (!res.ok || !data?.order_no) {
        throw new Error(data?.message ?? "訂單沒有建立成功");
      }

      // 先擋掉「購物車是空的」那段，再清空，避免導頁途中閃出提示
      setLeaving(true);
      clear();

      // 選了刷卡而且金流也開好單了，就直接把人帶去黑貓 PAY 的刷卡頁。
      // 用 location.assign 不用 router.push —— 那是站外網址，Next 的 router 不處理。
      //
      // 沒有 payment_url 的情況照原本的路走到完成頁：可能是選了「LINE 轉帳」，
      // 也可能是金流建單失敗。完成頁本來就會告訴客人怎麼用 LINE 完成付款，
      // 所以這裡不需要（也不應該）跳錯誤給他看。
      if (payment === "credit" && data.payment_url) {
        window.location.assign(data.payment_url);
        return;
      }

      router.push(
        `/checkout/success?order=${encodeURIComponent(data.order_no)}&pay=${payment}`,
      );
    } catch (err) {
      console.error("[checkout] 建立訂單失敗", err);
      setBusy(false);
      setFormError(
        "訂單沒有送出去。請再按一次「確認送出訂單」，或直接用 LINE 問我們，我們幫你完成報名。",
      );
      window.requestAnimationFrame(() => alertRef.current?.focus());
    }
  }

  return (
    <div>
      <CheckoutSteps current={2} />

      <div className="mx-auto max-w-maxw px-[20px] pb-[64px] md:px-[40px] md:pb-[80px]">
        <h1 className="t-h2 text-brown-900">填寫資料與付款</h1>

        {!ready && <CheckoutSkeleton />}

        {ready && items.length === 0 && !leaving && <EmptyCartNotice />}

        {ready && (items.length > 0 || leaving) && (
          <form
            ref={formRef}
            onSubmit={handleSubmit}
            noValidate
            aria-busy={busy}
            className="mt-[24px] grid gap-[32px] md:mt-[32px] md:grid-cols-[1.2fr_0.8fr] md:gap-[40px]"
          >
            <div>
              {formError && (
                <div
                  ref={alertRef}
                  role="alert"
                  tabIndex={-1}
                  className="mb-[24px] rounded-sm border-2 border-error bg-cream-100 px-[20px] py-[18px] text-[17px] leading-[1.9] text-error md:px-[24px]"
                >
                  {formError}
                </div>
              )}

              <h2 className="font-serif text-[22px] font-semibold text-brown-900 md:text-[28px]">
                你的資料
              </h2>

              {prefilled && (
                <p
                  role="status"
                  className="mt-[12px] rounded-card bg-cream-100 px-[18px] py-[12px] text-[16.5px] leading-[1.8] text-brown-700"
                >
                  <IconText icon={UserCheck}>已帶入你的資料，可直接修改</IconText>
                </p>
              )}

              <div className="mt-[20px] grid gap-[16px] lg:grid-cols-2 lg:gap-[20px]">
                <Field
                  label="姓名"
                  name="name"
                  required
                  autoComplete="name"
                  value={name}
                  onChange={setName}
                  error={shown("name", name)}
                />
                <Field
                  label="手機"
                  name="phone"
                  type="tel"
                  inputMode="tel"
                  required
                  autoComplete="tel"
                  value={phone}
                  // 直接吃掉空白與符號，長輩貼「0912-345-678」也不會被擋
                  onChange={(v) => setPhone(v.replace(/\D/g, "").slice(0, 10))}
                  error={shown("phone", phone)}
                  hint="09 開頭，總共 10 個數字"
                />
                <div className="lg:col-span-2">
                  <Field
                    label="Email"
                    name="email"
                    type="email"
                    inputMode="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={setEmail}
                    error={shown("email", email)}
                    hint="課程開通通知會寄到這裡"
                  />
                  {/*
                    網域錯字提示。這一欄現在是「這個人是誰」的唯一鍵——
                    帳號用它建、開通信寄到它、之後登入靠它認回訂單。
                    打錯一個字，客人就會收不到信、登入後看到空的「我的學習」。
                    刻意不自動改，只問一句由他自己按（長輩看到欄位自己變了會慌）。
                  */}
                  {emailSuggestion && (
                    <div className="mt-[10px] rounded-card border border-sand-400 bg-cream-100 px-[18px] py-[14px]">
                      <p className="t-body-sm text-brown-700">
                        你是不是要打{" "}
                        <strong className="break-all text-brown-900">
                          {emailSuggestion}
                        </strong>
                        ？
                      </p>
                      <button
                        type="button"
                        onClick={() => setEmail(emailSuggestion)}
                        className="mt-[10px] inline-flex min-h-[48px] w-full items-center justify-center rounded-pill border-2 border-sand-400 px-[24px] text-[17px] text-brown-900 hover:bg-[#F5E7CE] sm:w-auto"
                      >
                        對，幫我改成這個
                      </button>
                    </div>
                  )}
                </div>
                <div className="lg:col-span-2">
                  <Field
                    label="地址"
                    name="address"
                    required={needsAddress}
                    autoComplete="street-address"
                    value={address}
                    onChange={setAddress}
                    error={shown("address", address)}
                    hint={
                      needsAddress
                        ? "課本會寄到這裡"
                        : "這次沒有紙本課本，可以不填"
                    }
                  />
                </div>
                <div className="lg:col-span-2">
                  <Field
                    label="備註"
                    name="note"
                    as="textarea"
                    value={note}
                    onChange={setNote}
                    hint="選填"
                  />
                </div>
              </div>

              {needsIntake && (
                <div className="mt-[24px] rounded-card border border-sand-400 px-[20px] py-[22px] md:px-[26px]">
                  <h2 className="t-h3 text-brown-900">報名資料</h2>
                  <p className="t-body-sm mt-[6px] text-brown-500">
                    給老師備課用。
                  </p>

                  <div className="mt-[18px] flex flex-col gap-[18px]">
                    <fieldset>
                      <legend className="t-body font-medium text-brown-900">
                        你接觸過仁神術嗎？
                      </legend>
                      <div className="mt-[10px] flex flex-col gap-[8px]">
                        {[
                          ["none", "沒有，第一次接觸"],
                          ["heard", "有聽過或體驗過"],
                          ["formal", "曾正式學習過"],
                        ].map(([value, label]) => (
                          <label
                            key={value}
                            className="flex min-h-[44px] cursor-pointer items-center gap-[10px] text-[17px] text-brown-700"
                          >
                            <input
                              type="radio"
                              name="intake_experience"
                              value={value}
                              checked={intakeExperience === value}
                              onChange={() => setIntakeExperience(value)}
                              className="h-[20px] w-[20px] accent-caramel-ink"
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    <Field
                      label="最希望改善或理解什麼？"
                      name="intake_goal"
                      as="textarea"
                      value={intakeGoal}
                      onChange={setIntakeGoal}
                      hint="簡單幾句就好"
                    />

                    <fieldset>
                      <legend className="t-body font-medium text-brown-900">
                        你從哪裡知道這堂課？
                      </legend>
                      <div className="mt-[10px] flex flex-wrap gap-[8px]">
                        {["朋友介紹", "老師介紹", "Facebook", "Google 搜尋", "電子報", "其他"].map(
                          (opt) => (
                            <label
                              key={opt}
                              className={`flex min-h-[44px] cursor-pointer items-center rounded-pill border px-[18px] text-[17px] transition-colors ${
                                intakeSource === opt
                                  ? "border-caramel-ink bg-cream-100 text-brown-900"
                                  : "border-sand-400 text-brown-700 hover:bg-cream-100"
                              }`}
                            >
                              <input
                                type="radio"
                                name="intake_source"
                                value={opt}
                                checked={intakeSource === opt}
                                onChange={() => setIntakeSource(opt)}
                                className="sr-only"
                              />
                              {opt}
                            </label>
                          ),
                        )}
                      </div>
                    </fieldset>

                    {/*
                      健康聲明。⚠️ 這是法律上的告知同意，不能只是畫面上的一行字 ——
                      勾選時間會存進 orders.health_ack_at。
                    */}
                    <label className="flex cursor-pointer gap-[10px] rounded-card bg-cream-100 px-[16px] py-[14px]">
                      <input
                        type="checkbox"
                        checked={healthAck}
                        onChange={(e) => setHealthAck(e.target.checked)}
                        className="mt-[4px] h-[20px] w-[20px] shrink-0 accent-caramel-ink"
                      />
                      <span className="t-body-sm text-brown-700">
                        我已閱讀並同意：本課程為自我照顧與身體覺察練習，
                        不提供醫療診斷、不取代醫療、不處理緊急狀況，
                        也不建議自行停藥或中斷治療。
                      </span>
                    </label>
                  </div>
                </div>
              )}

              <PaymentOptions value={payment} onChange={setPayment} creditEnabled={creditEnabled} />

        <InvoiceOptions value={invoice} onChange={setInvoice} showErrors={submitted} />
            </div>

            {/* 訂單摘要：桌機 sticky 在右側，手機排在表單下方，
                送出鍵就是表單最後一顆滿版按鈕（表單頁不放固定底部列，免得擋住鍵盤） */}
            <aside className="h-fit rounded-card border border-sand-500 bg-white p-[24px] md:sticky md:top-[24px] md:p-[28px]">
              <h2 className="font-serif text-[22px] font-semibold text-brown-900">
                訂單內容
              </h2>

              <ul className="mt-[18px]">
                {items.map((i) => (
                  <li
                    key={`${i.productId}::${i.sessionId ?? ""}`}
                    className="flex gap-[14px] border-b border-sand-300 py-[16px] first:pt-0"
                  >
                    <Figure
                      alt={i.title}
                      rounded="rounded-input"
                      className="h-[72px] w-[72px] shrink-0"
                      sizes="72px"
                    />
                    <div className="min-w-0">
                      <p className="text-[17px] leading-[1.6] text-brown-900">
                        {i.title}
                      </p>
                      {i.sessionLabel && (
                        <p className="mt-[4px] text-[16px] text-brown-500">
                          <IconText icon={CalendarDays} label="場次">
                            {i.sessionLabel}
                          </IconText>
                        </p>
                      )}
                      <p className="mt-[6px] text-[16px] text-caramel-ink">
                        {formatPrice(i.priceSnapshot)}
                        {i.qty > 1 && (
                          <span className="text-brown-500">　×{i.qty}</span>
                        )}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="mt-[18px] flex justify-between text-[17px] text-brown-700">
                <span>小計</span>
                <span>{formatPrice(total)}</span>
              </div>
              <div className="mt-[10px] flex justify-between text-[17px] text-brown-700">
                <span>課本運費</span>
                <span>{formatPrice(0)}</span>
              </div>
              <div className="mt-[16px] flex items-baseline justify-between border-t border-sand-300 pt-[16px]">
                <span className="text-[18.5px] text-brown-900">總計</span>
                <span className="font-serif text-[30px] font-semibold text-caramel-ink">
                  {formatPrice(total)}
                </span>
              </div>

              <Button
                type="submit"
                variant={busy ? "disabled" : "primary"}
                fullWidth
                disabled={busy}
                className="mt-[20px]"
              >
                {busy ? "處理中…" : "確認送出訂單"}
              </Button>

              {/* 這句話原本是純文字，而且那份條款根本不存在——
                  等於要客人同意一份看不到的東西。連到 /terms。 */}
              <p className="mt-[14px] text-center text-[16px] leading-[1.8] text-brown-300">
                送出即表示同意
                <Link
                  href="/terms"
                  target="_blank"
                  className="-my-[7px] inline-block py-[11px] text-brown-500 underline underline-offset-4 hover:text-caramel-dk"
                >
                  服務條款與退費規定
                  <span className="sr-only">（會開新分頁）</span>
                </Link>
              </p>

              <div className="mt-[16px] border-t border-sand-300 pt-[16px]">
                <p className="text-[16px] leading-[1.7] text-brown-500">
                  <IconText icon={MessageCircle}>卡住了？LINE 陪你一起填</IconText>
                </p>
                <a
                  href={SITE.lineHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClass({
                    variant: "outline",
                    fullWidth: true,
                    className: "mt-[12px]",
                  })}
                >
                  加我們的 LINE
                  <span className="sr-only">（會開啟 LINE）</span>
                </a>
              </div>
            </aside>
          </form>
        )}
      </div>
    </div>
  );
}

function CheckoutSkeleton() {
  return (
    <div className="mt-[24px] md:mt-[32px]">
      <p role="status" className="sr-only">
        訂單資料載入中
      </p>
      <div
        aria-hidden
        className="grid gap-[32px] md:grid-cols-[1.2fr_0.8fr] md:gap-[40px]"
      >
        <div className="flex flex-col gap-[20px]">
          {[0, 1, 2, 3].map((i) => (
            <div key={i}>
              <div className="h-[20px] w-[96px] rounded-input bg-skeleton" />
              <div className="mt-[8px] h-[56px] w-full rounded-input bg-skeleton" />
            </div>
          ))}
        </div>
        <div className="h-[360px] rounded-card bg-skeleton" />
      </div>
    </div>
  );
}

function EmptyCartNotice() {
  return (
    <div className="mt-[24px] rounded-card border border-sand-500 bg-cream-100 px-[24px] py-[48px] text-center md:mt-[32px] md:px-[40px] md:py-[64px]">
      <p className="font-serif text-[24px] font-semibold text-brown-900 md:text-[28px]">
        購物車還是空的
      </p>
      <p className="t-body mx-auto mt-[12px] max-w-[520px] text-brown-500">
        先挑一門課，再回來填資料。
      </p>
      <div className="mt-[28px] flex flex-col items-center justify-center gap-[12px] sm:flex-row">
        <LinkButton
          href="/courses"
          variant="primary"
          size="lg"
          className="w-full sm:w-auto"
        >
          回課程列表
        </LinkButton>
        <a
          href={SITE.lineHref}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonClass({
            variant: "outline",
            size: "lg",
            className: "w-full sm:w-auto",
          })}
        >
          加我們的 LINE
          <span className="sr-only">（會開啟 LINE）</span>
        </a>
      </div>
    </div>
  );
}
