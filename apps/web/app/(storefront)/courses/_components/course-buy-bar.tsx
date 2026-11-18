"use client";

import { formatPrice } from "@/lib/site";
import type { Product } from "@/lib/content";
import { AddToCartButton } from "./add-to-cart-button";

/**
 * 手機底部固定購買列（設計稿 453–459 行）
 * 只在 < 768px 出現；桌機／平板改用右欄 sticky 購買卡。
 * 這是「購買」用的固定列，跟行銷用的共用 MobileActionBar 不同。
 * 頁面最外層需加 `.pb-action-bar` 預留空間。
 */
export function CourseBuyBar({ product }: { product: Product }) {
  // 2026-11-18 手機版改版：價格與按鈕併成同一排（參考 Hahow「立即購買」、Accupass「立即報名」），
  // 固定列從約 130px 降到約 84px，內容區多出一大截。
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-sand-300 bg-white/97 px-[16px] pt-[12px] pb-[calc(12px+env(safe-area-inset-bottom))] backdrop-blur-sm md:hidden">
      <div className="flex items-center gap-[14px]">
        <p className="flex shrink-0 flex-col leading-[1.2]">
          <span className="font-serif text-[24px] font-semibold text-caramel-dk">
            {formatPrice(product.price)}
          </span>
          {product.compare_at_price ? (
            <span className="text-[15px] text-brown-500">
              <span className="sr-only">原價 </span>
              <span className="line-through">
                {formatPrice(product.compare_at_price)}
              </span>
            </span>
          ) : null}
        </p>

        <AddToCartButton product={product} className="min-w-0 flex-1" />
      </div>
    </div>
  );
}
