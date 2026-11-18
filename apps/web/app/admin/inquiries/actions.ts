"use server";

import { redirect } from "next/navigation";
import { requireCapability } from "@/lib/admin/guard";
import { setInquiryHandledCore } from "./inquiry-core";

/**
 * 小幫手諮詢紀錄的跟進狀態。
 *
 * ⚠️ 跟其他 actions.ts 一樣：每一支都自己呼叫 requireCapability。
 *    app/admin/layout.tsx 的守衛只在 render 頁面時跑，server action 的 POST
 *    不經過它 —— 少寫一行，任何登入會員都能改客人的跟進狀態。
 */

async function setHandled(formData: FormData, handled: boolean): Promise<void> {
  let destination = "/admin/inquiries";
  try {
    const staff = await requireCapability("orders:read");

    // 本體在 ./inquiry-core.ts（MCP 的 mark_inquiry_handled／unhandled 共用同一支）。
    const result = await setInquiryHandledCore(staff, String(formData.get("id") ?? ""), handled);
    if (!result.ok) {
      destination = `/admin/inquiries?msg=${result.code}`;
      return;
    }

    // 從哪一頁按的就回哪一頁，篩選條件不會被洗掉
    const back = String(formData.get("back") ?? "").trim();
    destination = `${back.startsWith("/admin/inquiries") ? back : "/admin/inquiries"}${
      back.includes("?") ? "&" : "?"
    }msg=${handled ? "handled" : "reopened"}`;
  } catch (err) {
    console.error("[admin/inquiries] 例外", err);
    destination = "/admin/inquiries?msg=denied";
  } finally {
    redirect(destination);
  }
}

export async function markHandled(formData: FormData): Promise<void> {
  return setHandled(formData, true);
}

export async function markUnhandled(formData: FormData): Promise<void> {
  return setHandled(formData, false);
}
