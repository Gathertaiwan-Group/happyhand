import "server-only";
import { revalidatePath } from "next/cache";
import type { Staff } from "@/lib/admin/guard";
import { writeAudit } from "@/lib/admin/audit";
import { createServiceClient } from "@/lib/supabase/server";
import type { SettingsCtx } from "./settings-core";

/**
 * 站台共用內容會出現在每一個報名頁，所以改動一律 revalidate 前台全部路徑。
 * 後台表單（actions.ts）與 MCP 共用這一份清單。
 */
export function revalidateSettingsPages() {
  revalidatePath("/admin/settings");
  revalidatePath("/");
  revalidatePath("/courses");
  revalidatePath("/courses/[slug]", "page");
  revalidatePath("/workshops");
  revalidatePath("/workshops/[slug]", "page");
  // 講師照片也出現在這兩頁。漏掉的話後台換了照片，這裡要等 300 秒才變。
  revalidatePath("/teachers");
  revalidatePath("/about");
}

export function liveSettingsCtx(staff: Staff): SettingsCtx {
  return {
    db: createServiceClient(),
    staff,
    audit: writeAudit,
    revalidate: revalidateSettingsPages,
  };
}
