"use client";

import { useCallback } from "react";
import { useCart, type CartItem } from "@/components/cart-provider";
import { LinkButton, buttonClass } from "@/components/ui/button";
import { Figure } from "@/components/ui/placeholder";
import { SITE, formatPrice } from "@/lib/site";
import { CheckoutSteps } from "@/app/(storefront)/checkout/_components/checkout-steps";

const TYPE_LABEL: Record<CartItem["type"], string> = {
  course: "線上課程",
  workshop: "工作坊",
};

/** 同一件商品的唯一鍵（工作坊要連場次一起看） */
function keyOf(item: CartItem) {
  return `${item.productId}::${item.sessionId ?? ""}`;
}

/**
 * 數量加減鍵：56×56（README §5 點擊區下限），外框樣式與共用 outline 按鈕一致。
 * 這裡不用共用 <Button>，因為要覆蓋它的 px/text-size，Tailwind 同屬性覆蓋的
 * 先後順序不保證，直接寫死比較安全。
 */
const QTY_BUTTON =
  "flex h-[56px] w-[56px] shrink-0 items-center justify-center rounded-pill border-2 border-sand-400 text-[22px] text-brown-900 transition-colors duration-200 hover:bg-cream-300 disabled:border-sand-300 disabled:text-brown-300 disabled:hover:bg-transparent";

export function CartView() {
  const { items, total, ready, remove, setQty } = useCart();

  /** CartProvider 已把 sessionId 正規化成 null 再比對，直接用 remove() 即可 */
  const removeItem = useCallback(
    (target: CartItem) => remove(target.productId, target.sessionId),
    [remove],
  );

  const changeQty = useCallback(
    (item: CartItem, delta: 1 | -1) => {
      if (delta === -1 && item.qty <= 1) return;
      setQty(item.productId, item.qty + delta, item.sessionId);
    },
    [setQty],
  );

  return (
    <div className="pb-action-bar">
      <CheckoutSteps current={1} />

      <div className="mx-auto max-w-maxw px-[20px] pb-[64px] md:px-[40px] md:pb-[80px]">
        <h1 className="t-h2 text-brown-900">購物車</h1>

        {!ready && <CartSkeleton />}

        {ready && items.length === 0 && <EmptyCart />}

        {ready && items.length > 0 && (
          <div className="mt-[24px] grid gap-[24px] md:mt-[32px] md:grid-cols-[1fr_300px] md:gap-[32px] lg:grid-cols-[1fr_360px] lg:gap-[40px]">
            <ul className="border-t border-sand-300">
              {items.map((item) => (
                <li
                  key={keyOf(item)}
                  className="grid grid-cols-[88px_1fr] items-start gap-x-[16px] gap-y-[16px] border-b border-sand-300 py-[20px] lg:grid-cols-[96px_1fr_auto] lg:items-center lg:gap-x-[24px] lg:py-[24px]"
                >
                  <Figure
                    alt={item.title}
                    rounded="rounded-input"
                    className="h-[88px] w-[88px] lg:h-[96px] lg:w-[96px]"
                    sizes="96px"
                  />

                  <div className="min-w-0">
                    <span className="inline-block rounded-pill bg-cream-100 px-[12px] py-[3px] text-[16px] text-brown-500">
                      {TYPE_LABEL[item.type]}
                    </span>
                    <h2 className="mt-[8px] text-[17px] leading-[1.6] text-brown-900 lg:text-[18.5px]">
                      {item.title}
                    </h2>
                    {item.sessionLabel && (
                      <p className="mt-[4px] text-[16px] text-brown-500">
                        {item.sessionLabel}
                      </p>
                    )}
                    <p className="mt-[6px] text-[16px] text-brown-300">
                      單價 {formatPrice(item.priceSnapshot)}
                    </p>
                  </div>

                  <div className="col-span-2 flex items-center justify-between gap-[8px] lg:col-span-1 lg:justify-end lg:gap-[20px]">
                    <div className="flex items-center">
                      <button
                        type="button"
                        aria-label={`減少一件「${item.title}」的數量`}
                        disabled={item.qty <= 1}
                        onClick={() => changeQty(item, -1)}
                        className={QTY_BUTTON}
                      >
                        <span aria-hidden>−</span>
                      </button>
                      <span
                        aria-label={`目前數量 ${item.qty} 件`}
                        className="w-[44px] text-center font-serif text-[20px] text-brown-900"
                      >
                        {item.qty}
                      </span>
                      <button
                        type="button"
                        aria-label={`增加一件「${item.title}」的數量`}
                        onClick={() => changeQty(item, 1)}
                        className={QTY_BUTTON}
                      >
                        <span aria-hidden>＋</span>
                      </button>
                    </div>

                    <p className="font-serif text-[20px] text-caramel-ink lg:text-[22px]">
                      {formatPrice(item.priceSnapshot * item.qty)}
                    </p>

                    <button
                      type="button"
                      onClick={() => removeItem(item)}
                      className="min-h-[56px] rounded-pill px-[12px] text-[17px] text-brown-500 underline underline-offset-4 transition-colors duration-200 hover:text-caramel-dk"
                    >
                      移除
                      <span className="sr-only">「{item.title}」</span>
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            {/* 合計卡：桌機在右側、手機在下方 */}
            <aside className="h-fit rounded-card border border-sand-500 bg-white p-[24px] md:sticky md:top-[24px] lg:p-[28px]">
              <h2 className="font-serif text-[22px] font-semibold text-brown-900">
                合計
              </h2>

              <div className="mt-[18px] flex justify-between text-[17px] text-brown-700">
                <span>小計</span>
                <span>{formatPrice(total)}</span>
              </div>
              <div className="mt-[10px] flex justify-between text-[17px] text-brown-700">
                <span>課本運費</span>
                <span>{formatPrice(0)}</span>
              </div>

              <div className="mt-[16px] flex items-baseline justify-between border-t border-sand-300 pt-[16px]">
                <span className="text-[18.5px] text-brown-900">合計</span>
                <span className="font-serif text-[30px] font-semibold text-caramel-ink">
                  {formatPrice(total)}
                </span>
              </div>

              <div className="mt-[20px] hidden md:block">
                <LinkButton href="/checkout" variant="primary" fullWidth>
                  去填資料
                </LinkButton>
              </div>

              <p className="mt-[14px] text-[16px] leading-[1.8] text-brown-300">
                下一步填聯絡資料與付款方式，還不會扣款。
              </p>

              <div className="mt-[16px] border-t border-sand-300 pt-[16px]">
                <p className="text-[16px] leading-[1.8] text-brown-500">
                  不方便自己操作？用 LINE 告訴我們，我們幫你處理。
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
          </div>
        )}
      </div>

      {/* 手機底部固定列（設計稿 759–761）。頁面最外層已加 pb-action-bar 預留空間 */}
      {ready && items.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-sand-300 bg-white/96 px-[16px] pt-[12px] pb-[calc(12px+env(safe-area-inset-bottom))] backdrop-blur-sm md:hidden">
          <div className="mb-[8px] flex items-baseline justify-between px-[4px]">
            <span className="text-[17px] text-brown-700">合計</span>
            <span className="font-serif text-[26px] font-semibold text-caramel-ink">
              {formatPrice(total)}
            </span>
          </div>
          <LinkButton href="/checkout" variant="primary" fullWidth>
            去填資料
          </LinkButton>
        </div>
      )}
    </div>
  );
}

/** 讀 localStorage 期間的同色系 skeleton（README §5：不要旋轉 spinner） */
function CartSkeleton() {
  return (
    <div className="mt-[24px] md:mt-[32px]">
      <p role="status" className="sr-only">
        購物車載入中
      </p>
      <div
        aria-hidden
        className="grid gap-[24px] md:grid-cols-[1fr_300px] md:gap-[32px] lg:grid-cols-[1fr_360px] lg:gap-[40px]"
      >
        <div className="border-t border-sand-300">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="flex items-start gap-[16px] border-b border-sand-300 py-[20px] lg:gap-[24px] lg:py-[24px]"
            >
              <div className="h-[88px] w-[88px] shrink-0 rounded-input bg-skeleton lg:h-[96px] lg:w-[96px]" />
              <div className="min-w-0 flex-1">
                <div className="h-[24px] w-[96px] rounded-pill bg-skeleton" />
                <div className="mt-[10px] h-[20px] w-full max-w-[280px] rounded-input bg-skeleton" />
                <div className="mt-[10px] h-[20px] w-[120px] rounded-input bg-skeleton" />
              </div>
            </div>
          ))}
        </div>
        <div className="h-[280px] rounded-card bg-skeleton" />
      </div>
    </div>
  );
}

function EmptyCart() {
  return (
    <div className="mt-[24px] rounded-card border border-sand-500 bg-cream-100 px-[24px] py-[48px] text-center md:mt-[32px] md:px-[40px] md:py-[64px]">
      <p className="font-serif text-[24px] font-semibold text-brown-900 md:text-[28px]">
        購物車還是空的
      </p>
      <p className="t-body mx-auto mt-[12px] max-w-[520px] text-brown-500">
        還沒有選課程。看看有哪些課，或是用 LINE 問我們哪一門適合你。
      </p>
      <div className="mt-[28px] flex flex-col items-center justify-center gap-[12px] sm:flex-row">
        <LinkButton
          href="/courses"
          variant="primary"
          size="lg"
          className="w-full sm:w-auto"
        >
          看看有哪些課
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
