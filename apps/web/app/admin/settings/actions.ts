"use server";

import { redirect } from "next/navigation";
import { requireCapability } from "@/lib/admin/guard";
import { liveSettingsCtx } from "./settings-ctx";
import {
  normalizeHealthNotice,
  normalizeTeacher,
  saveHealthNoticeCore,
  saveTeacherCore,
} from "./settings-core";

/**
 * 站台共用內容的寫入（site_settings）。
 *
 * ⚠️ 跟 products/actions.ts 一樣：每一支都自己呼叫 requireCapability。
 *    app/admin/layout.tsx 的守衛只在 render 頁面時跑，server action 的
 *    POST 不經過它。
 *
 * 驗證與寫入的核心在 settings-core.ts（MCP 也走同一支），
 * 清快取的路徑清單在 settings-ctx.ts。
 */

export async function saveTeacher(formData: FormData): Promise<void> {
  let destination = "/admin/settings";
  try {
    const staff = await requireCapability("catalog:write");

    const value = normalizeTeacher({
      name: String(formData.get("name") ?? ""),
      title: String(formData.get("title") ?? ""),
      paragraphs: String(formData.get("paragraphs") ?? ""),
      credentials: String(formData.get("credentials") ?? ""),
      links: String(formData.get("links") ?? ""),
      photo_url: String(formData.get("photo_url") ?? ""),
    });
    if (!value) {
      destination = "/admin/settings?msg=teacher_name_required";
      return;
    }

    const r = await saveTeacherCore(liveSettingsCtx(staff), value);
    destination = r.ok ? "/admin/settings?msg=teacher_saved" : "/admin/settings?msg=failed";
  } catch (err) {
    console.error("[admin/settings] saveTeacher 例外", err);
    destination = "/admin/settings?msg=denied";
  } finally {
    redirect(destination);
  }
}

export async function saveHealthNotice(formData: FormData): Promise<void> {
  let destination = "/admin/settings";
  try {
    const staff = await requireCapability("catalog:write");

    const value = normalizeHealthNotice({
      title: String(formData.get("title") ?? ""),
      body: String(formData.get("body") ?? ""),
    });

    const r = await saveHealthNoticeCore(liveSettingsCtx(staff), value);
    destination = r.ok ? "/admin/settings?msg=health_saved" : "/admin/settings?msg=failed";
  } catch (err) {
    console.error("[admin/settings] saveHealthNotice 例外", err);
    destination = "/admin/settings?msg=denied";
  } finally {
    redirect(destination);
  }
}
