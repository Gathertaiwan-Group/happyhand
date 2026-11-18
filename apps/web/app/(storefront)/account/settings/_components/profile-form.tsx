"use client";

import { useActionState } from "react";
import { Field } from "@/components/ui/field";
import { buttonClass } from "@/components/ui/button";
import { updateProfile, type ProfileFormState } from "../actions";

/**
 * 個人資料表單。
 *
 * 用原生 <form action={serverAction}> 加 useActionState：
 * 沒有 JavaScript 也送得出去，而且送出結果能顯示在畫面上
 * （會員中心的表單一定要有回饋 —— 長輩按了沒反應只會再按一次）。
 *
 * 三欄都可以留空白（除了姓名），刻意不強迫填滿。
 */
export function ProfileForm({
  defaults,
}: {
  defaults: { fullName: string; phone: string; birthYear: string };
}) {
  const [state, action, pending] = useActionState<ProfileFormState, FormData>(
    updateProfile,
    null,
  );

  return (
    <form action={action} className="flex flex-col gap-[18px]">
      {state?.ok && (
        <p
          role="status"
          className="t-body rounded-card border border-sand-400 bg-cream-100 px-[20px] py-[14px] text-brown-900"
        >
          {state.ok}
        </p>
      )}
      {state?.error && (
        <p
          role="alert"
          className="t-body rounded-card border border-error bg-white px-[20px] py-[14px] text-error"
        >
          {state.error}
        </p>
      )}

      <Field
        label="姓名"
        name="full_name"
        required
        autoComplete="name"
        defaultValue={defaults.fullName}
        hint="寄信與稱呼你時用"
      />
      <Field
        label="手機"
        name="phone"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        defaultValue={defaults.phone}
        hint="09 開頭 10 碼，工作坊異動時聯絡你。可空白。"
      />
      <Field
        label="出生年"
        name="birth_year"
        inputMode="numeric"
        autoComplete="bday-year"
        defaultValue={defaults.birthYear}
        hint="西元年，例如 1958。可不填。"
      />

      <div>
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className={buttonClass({
            variant: pending ? "disabled" : "primary",
            size: "lg",
            fullWidth: true,
            className: "sm:w-auto",
          })}
        >
          {pending ? "儲存中…" : "存起來"}
        </button>
      </div>
    </form>
  );
}
