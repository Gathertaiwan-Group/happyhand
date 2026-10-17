"use client";

import { Field } from "@/components/ui/field";
import { validateInvoice, type CarrierType } from "@/lib/invoice/validate";

/**
 * 電子發票的載具與統編。
 *
 * 視覺與互動完全比照 PaymentOptions（同一組 radio 卡片、同樣的 2px 外框只換
 * 顏色、同樣的 ≥56px 高度），因為它們在畫面上是相鄰的兩區，長得不一樣會很怪。
 *
 * ⚠️ 選項刻意只有四個，而且「雲端發票」排第一個並且是預設。
 *    客群偏長輩，多數人不知道自己有沒有載具，也不想在結帳時被問。
 *    預設走雲端發票（存在 Amego，之後可以再歸戶）是最不打斷結帳的選擇，
 *    要載具的人自己會去點。
 *
 * ⚠️ 自然人憑證刻意**不放**：這個客群幾乎不會用，多一個選項只是多一份困惑。
 *    後端與資料庫都支援（validate.ts 有 natural_person），日後要加只要在
 *    這裡多一個 OPTION。
 */

type Option = {
  value: CarrierType;
  label: string;
  desc: string;
};

const OPTIONS: Option[] = [
  {
    value: "cloud",
    label: "雲端發票（預設）",
    desc: "發票存雲端、不印紙本",
  },
  {
    value: "phone",
    label: "存到手機條碼",
    desc: "有手機條碼載具的話填在這裡",
  },
  {
    value: "b2b",
    label: "公司報帳（要統編）",
    desc: "開立三聯式發票，需要統一編號與公司抬頭",
  },
  {
    value: "love_code",
    label: "捐給公益團體",
    desc: "填愛心碼，發票直接捐出去",
  },
];

export type InvoiceValue = {
  carrierType: CarrierType;
  carrierId: string;
  taxId: string;
  title: string;
};

export const EMPTY_INVOICE: InvoiceValue = {
  carrierType: "cloud",
  carrierId: "",
  taxId: "",
  title: "",
};

export function InvoiceOptions({
  value,
  onChange,
  showErrors,
}: {
  value: InvoiceValue;
  onChange: (v: InvoiceValue) => void;
  /** 按過送出之後才把「還沒填」的錯誤顯示出來，跟其他欄位同一個節奏 */
  showErrors: boolean;
}) {
  const err = validateInvoice(value);

  // 有填了才提示格式問題；沒填的提示要等按過送出。
  // 跟 checkout-view.tsx 的 shown() 是同一個判準。
  const showFor = (field: "carrierId" | "taxId" | "title", filled: boolean) =>
    err?.field === field && (filled || showErrors) ? err.message : undefined;

  return (
    <fieldset className="mt-[40px] m-0 border-0 p-0">
      <legend className="p-0 font-serif text-[22px] font-semibold text-brown-900 md:text-[28px]">
        電子發票
      </legend>

      <div className="mt-[20px] flex flex-col gap-[12px]">
        {OPTIONS.map((opt) => {
          const selected = value.carrierType === opt.value;
          return (
            <div key={opt.value}>
              <label className="block cursor-pointer">
                <input
                  type="radio"
                  name="invoice_carrier_type"
                  value={opt.value}
                  checked={selected}
                  onChange={() =>
                    // 切換載具時把另一種的欄位清掉，避免「選了統編又切回雲端，
                    // 統編還留在 state 裡被送出去」。
                    onChange({ ...EMPTY_INVOICE, carrierType: opt.value })
                  }
                  className="peer sr-only"
                />
                <span
                  className={`flex min-h-[56px] items-start gap-[16px] rounded-sm border-2 px-[20px] py-[18px] transition-colors duration-200 peer-focus-visible:outline peer-focus-visible:outline-[3px] peer-focus-visible:outline-offset-2 peer-focus-visible:outline-caramel md:px-[24px] md:py-[22px] ${
                    selected
                      ? "border-caramel-ink bg-cream-100"
                      : "border-sand-400 bg-white hover:bg-cream-100"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`mt-[3px] block h-[24px] w-[24px] shrink-0 rounded-pill ${
                      selected
                        ? "border-[6px] border-caramel-ink"
                        : "border-2 border-sand-400"
                    }`}
                  />
                  <span className="min-w-0">
                    <span className="block text-[17.5px] text-brown-900 md:text-[18.5px]">
                      {opt.label}
                    </span>
                    <span className="mt-[4px] block text-[16px] leading-[1.8] text-brown-500">
                      {opt.desc}
                    </span>
                  </span>
                </span>
              </label>

              {/* 輸入欄位放在 label 外面：包進去點輸入框會誤觸選取 */}
              {selected && opt.value === "phone" && (
                <div className="mt-[8px]">
                  <Field
                    label="手機條碼"
                    name="invoice_carrier_id"
                    value={value.carrierId}
                    onChange={(v) => onChange({ ...value, carrierId: v })}
                    error={showFor("carrierId", value.carrierId.length > 0)}
                    hint="在手機的「電子發票」App 或財政部網站可以查到，長得像 /ABC+123。"
                  />
                </div>
              )}

              {selected && opt.value === "love_code" && (
                <div className="mt-[8px]">
                  <Field
                    label="愛心碼"
                    name="invoice_carrier_id"
                    inputMode="numeric"
                    value={value.carrierId}
                    onChange={(v) => onChange({ ...value, carrierId: v })}
                    error={showFor("carrierId", value.carrierId.length > 0)}
                    hint="3 到 7 位數字。不知道的話可以問你想捐贈的單位。"
                  />
                </div>
              )}

              {selected && opt.value === "b2b" && (
                <div className="mt-[8px] flex flex-col gap-[16px]">
                  <Field
                    label="統一編號"
                    name="invoice_tax_id"
                    inputMode="numeric"
                    required
                    value={value.taxId}
                    onChange={(v) =>
                      // 統編一定是 8 位數字，就地擋掉非數字並截斷 ——
                      // 跟手機欄位同一個做法（checkout-view.tsx 的 onChange）
                      onChange({ ...value, taxId: v.replace(/\D/g, "").slice(0, 8) })
                    }
                    error={showFor("taxId", value.taxId.length > 0)}
                    hint="8 位數字。我們會檢查它是不是有效的統編。"
                  />
                  <Field
                    label="公司抬頭"
                    name="invoice_title"
                    required
                    value={value.title}
                    onChange={(v) => onChange({ ...value, title: v })}
                    error={showFor("title", value.title.length > 0)}
                    hint="會印在發票上，請填公司的正式名稱。"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-[16px] text-[16px] leading-[1.8] text-brown-500">
        {/* 🔴 2026-10-17：這裡**不可以**再出現任何「會開立」「會寄給你」的字樣。
            自動開票已經移除（站上唯一的開票路徑是後台人工按），所以任何承諾
            都沒有人保證履行 —— 客人填了統編卻等不到發票，比沒問他更糟。
            欄位仍然照收：資料留著，要開的時候才有東西可以用。 */}
        你填的統編或載具我們會一起存進訂單。發票的事請用 LINE 跟我們聯絡。
      </p>
    </fieldset>
  );
}
