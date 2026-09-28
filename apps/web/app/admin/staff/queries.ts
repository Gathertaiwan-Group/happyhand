import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { toRole, type Role } from "@/lib/admin/roles";
import { normalizeEmail, UUID_PATTERN } from "./rules";

/**
 * 員工頁的讀取層。
 *
 * ⚠️ 這個檔案最核心的一件事：**profiles 沒有 email 欄位**。
 *    Email 只存在 auth.users，而那張表只有 Supabase Admin API 進得去。
 *    所以「顯示員工 Email」跟「這個信箱是不是已經註冊過了」都得先建一份
 *    id ⇄ email 的索引，見 loadUserEmailIndex()。
 *
 * ⚠️ 純資料 + IO，沒有 JSX。授權不在這裡 —— 呼叫端（page / action）必須自己
 *    先過 requireCapability("staff:manage")。這裡拿到 service role client 就直接查，
 *    不做任何權限判斷，所以不要從別的地方 import 它。
 */

export type Db = ReturnType<typeof createServiceClient>;

export type StaffMember = {
  id: string;
  /** 取自 auth.users；索引建不起來時是 null，UI 要顯示「無法讀取」而不是空白 */
  email: string | null;
  role: Role;
  fullName: string | null;
  createdAt: string;
};

export type PendingInvite = {
  id: string;
  email: string;
  role: Role;
  invitedBy: string | null;
  /** 邀請人的 Email。查不到（帳號已刪／索引不完整）時是 null */
  invitedByEmail: string | null;
  createdAt: string;
  /**
   * 這個信箱其實已經有帳號了 —— handle_new_user() 只在「註冊當下」消費邀請，
   * 已註冊的人不會再觸發一次，所以這筆邀請永遠不會生效。
   * 現在的 inviteStaff() 擋得住這種輸入，但資料庫裡可能留有手動 SQL 塞進來的舊資料。
   */
  dead: boolean;
};

export type UserEmailIndex = {
  emailById: Map<string, string>;
  /** key 是 normalizeEmail() 之後的值 */
  idByEmail: Map<string, string>;
  /**
   * false = 分頁上限用完了還沒掃完，索引不完整。
   * 這時「查不到這個 email」不等於「這個 email 沒註冊過」，呼叫端必須分開處理。
   */
  complete: boolean;
};

/* --------------------------------------------------------------- 純函式 */

// normalizeEmail / isValidEmail / UUID_PATTERN 住在 ./rules.ts。
// 那個檔案不 import server-only，所以驗收腳本可以直接跑它們本人。

/** owner 排前面，其次 editor / support，同角色再依加入時間 */
const ROLE_RANK: Record<Role, number> = { owner: 0, editor: 1, support: 2, customer: 3 };

/* ------------------------------------------------------------ email 索引 */

const USERS_PAGE_SIZE = 200;
/** 200 × 25 = 5000 個帳號。超過就回 complete:false，呼叫端負責說出來。 */
const USERS_MAX_PAGES = 25;

/**
 * 掃一次 auth.users 建立 id ⇄ email 索引。
 *
 * 為什麼是「整份掃完」而不是逐筆查：
 *   顯示端只需要 getUserById()（員工是個位數），但 inviteStaff() 需要反查
 *   「這個 email 有沒有帳號」，而 supabase-js 的 admin API 沒有 getUserByEmail()。
 *   兩邊共用同一份索引，邏輯只有一套，之後要換成 GoTrue 的 ?filter= 也只改這裡。
 *
 * 🔴 2026-09 三站合併後，`auth.users` 是**全集團共用**的（小時光書店／好日子／快樂手），
 *    所以這份索引會包含另外兩站的帳號。兩個使用端的語意都還是對的，而且其中一個變得更準：
 *      - `emailById` 只會被 happyhands 的 profile id 查，查不到別站的人；索引只活在這次請求的
 *        伺服器記憶體裡，不會傳給瀏覽器（page.tsx 只渲染 members／invites／lookedUpAccount）。
 *      - `idByEmail` 的「這個信箱已經有帳號了」**必須**是全集團範圍：邀請是靠 auth trigger 在
 *        「新帳號誕生」時消費的，對方若已經在別站註冊過，trigger 永遠不會再觸發，那張邀請就是死的。
 *        inviteStaff() 因此改走 `invite=exists&account=<id>`（當場改他的角色），畫面上的 `dead`
 *        旗標也是同一個判斷。合併後這條路徑會比以前常走到。
 *
 * 成本是 O(全集團帳號數)。快樂手是課程電商，帳號數以千計時每次仍是 1–5 個請求，
 * 而 /admin/staff 只有負責人偶爾會開。真的長到五千以上時 complete 會變 false，
 * 畫面會明講索引不完整，不會靜默給錯答案。
 */
export async function loadUserEmailIndex(
  db: Db,
): Promise<{ index: UserEmailIndex; error: string | null }> {
  const emailById = new Map<string, string>();
  const idByEmail = new Map<string, string>();
  let complete = false;

  for (let page = 1; page <= USERS_MAX_PAGES; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({
      page,
      perPage: USERS_PAGE_SIZE,
    });

    if (error) {
      // 只記 message，不整包丟 log：listUsers 的回應內容是全站使用者的 Email。
      console.error("[admin/staff] listUsers 失敗", error.message);
      return {
        index: { emailById, idByEmail, complete: false },
        error: "無法從 Supabase 讀取帳號 Email，下面的清單只會顯示角色。",
      };
    }

    for (const user of data.users) {
      if (!user.email) continue;
      emailById.set(user.id, user.email);
      idByEmail.set(normalizeEmail(user.email), user.id);
    }

    if (!data.nextPage) {
      complete = true;
      break;
    }
  }

  return { index: { emailById, idByEmail, complete }, error: null };
}

/* ------------------------------------------------------------ 頁面資料 */

type ProfileRow = {
  id: string;
  role: string | null;
  full_name: string | null;
  created_at: string;
};

type InviteRow = {
  id: string;
  email: string;
  role: string | null;
  invited_by: string | null;
  created_at: string;
};

export type StaffPageData = {
  members: StaffMember[];
  invites: PendingInvite[];
  /** 目前的負責人人數，用來在畫面上解釋為什麼某些操作被鎖住 */
  ownerCount: number;
  /** ?account= 指定的那個帳號（可能是 customer，所以不在 members 裡） */
  lookedUpAccount: StaffMember | null;
  index: UserEmailIndex;
  /** 讀取層的警告訊息（Email 索引失敗、清單查詢失敗…），要顯示在畫面上 */
  warnings: string[];
};

export async function loadStaffPage(
  db: Db,
  options: { accountId?: string | null } = {},
): Promise<StaffPageData> {
  const warnings: string[] = [];

  const { index, error: indexError } = await loadUserEmailIndex(db);
  if (indexError) warnings.push(indexError);
  if (!indexError && !index.complete) {
    warnings.push(
      `帳號數超過 ${USERS_PAGE_SIZE * USERS_MAX_PAGES} 個，Email 對照可能不完整；` +
        "「這個信箱已經有帳號了」的檢查也會失準，邀請前請先確認。",
    );
  }

  const emailOf = (id: string | null | undefined) =>
    id ? (index.emailById.get(id) ?? null) : null;

  // ---------------------------------------------------------------- 員工
  let members: StaffMember[] = [];
  const { data: profileRows, error: profileError } = await db
    .from("profiles")
    .select("id, role, full_name, created_at")
    .neq("role", "customer")
    .order("created_at", { ascending: true });

  if (profileError) {
    console.error("[admin/staff] 讀取 profiles 失敗", profileError.code, profileError.message);
    warnings.push("讀取員工清單失敗，請重新整理。詳細錯誤已記在伺服器 log。");
  } else {
    members = ((profileRows ?? []) as ProfileRow[])
      .map((row) => ({
        id: row.id,
        email: emailOf(row.id),
        role: toRole(row.role),
        fullName: row.full_name,
        createdAt: row.created_at,
      }))
      .sort(
        (a, b) =>
          ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.createdAt.localeCompare(b.createdAt),
      );
  }

  // ---------------------------------------------------------------- 邀請
  let invites: PendingInvite[] = [];
  const { data: inviteRows, error: inviteError } = await db
    .from("staff_invites")
    .select("id, email, role, invited_by, created_at")
    .order("created_at", { ascending: false });

  if (inviteError) {
    console.error("[admin/staff] 讀取 staff_invites 失敗", inviteError.code, inviteError.message);
    warnings.push("讀取邀請名單失敗，請重新整理。詳細錯誤已記在伺服器 log。");
  } else {
    invites = ((inviteRows ?? []) as InviteRow[]).map((row) => ({
      id: row.id,
      email: row.email,
      role: toRole(row.role),
      invitedBy: row.invited_by,
      invitedByEmail: emailOf(row.invited_by),
      createdAt: row.created_at,
      // 索引不完整時不敢說死（會嚇到人），一律當成正常邀請
      dead: index.complete && index.idByEmail.has(normalizeEmail(row.email)),
    }));
  }

  // ------------------------------------------------ ?account= 指定的帳號
  let lookedUpAccount: StaffMember | null = null;
  if (options.accountId && UUID_PATTERN.test(options.accountId)) {
    const { data, error } = await db
      .from("profiles")
      .select("id, role, full_name, created_at")
      .eq("id", options.accountId)
      .maybeSingle();

    if (error) {
      console.error("[admin/staff] 讀取指定帳號失敗", error.code, error.message);
    } else if (data) {
      const row = data as unknown as ProfileRow;
      lookedUpAccount = {
        id: row.id,
        email: emailOf(row.id),
        role: toRole(row.role),
        fullName: row.full_name,
        createdAt: row.created_at,
      };
    }
  }

  const ownerCount = members.filter((m) => m.role === "owner").length;

  return { members, invites, ownerCount, lookedUpAccount, index, warnings };
}
