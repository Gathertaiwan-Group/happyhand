import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { checkCapability, getStaff } from "@/lib/admin/guard";
import { ROLE_LABELS } from "@/lib/admin/roles";
import { currentOAuthBaseUrl } from "@/lib/mcp-oauth/base";
import {
  checkAuthorizeParams,
  consentToken,
  oauthEnabled,
  redirectDisplay,
} from "@/lib/mcp-oauth/core";
import { ConsentForm } from "./consent-form";
import { RevokeButton } from "./revoke-button";

/**
 * MCP 的 OAuth 授權同意頁 —— claude.ai／Claude 手機 App／ChatGPT 的自訂連接器按下「連接」
 * 後，負責人的瀏覽器經 /oauth/authorize 被帶到這裡（未登入的話先去 /login 再回來）。
 *
 *   · 不是負責人（沒有 mcp:connect）→ 婉拒，說明要用負責人帳號。
 *   · client 或 redirect_uri 不對 → 只顯示錯誤，**不導回**（那是 open redirect）。
 *   · 其他參數錯誤 → 照 RFC 6749 導回 client 帶 error。
 *   · 負責人 → 同意畫面；按下去交給 actions.ts 重驗一次再簽授權碼。
 *   · 沒帶 client_id（從側欄「AI 連線」點進來）→ 連線說明＋「撤銷我的所有 AI 連線」。
 *
 * 放在 /admin 底下：middleware 要求登入、admin layout 要求員工、next.config 的
 * frame-ancestors 'none' 防點擊劫持都自動套上。
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "授權 AI 連接後台",
  robots: { index: false, follow: false },
};

function rebuildQuery(sp: Record<string, string | string[] | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (Array.isArray(v)) for (const x of v) p.append(k, x);
    else if (typeof v === "string") p.append(k, v);
  }
  return p.toString();
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-6 admin:py-10">
      <div className="flex flex-col gap-5 rounded-card border border-line bg-panel p-5 admin:p-7">
        {children}
      </div>
    </div>
  );
}

export default async function McpConnectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const secret = process.env.MCP_OAUTH_SECRET;
  if (!oauthEnabled(secret)) {
    return (
      <Frame>
        <h1 className="text-[20px] font-medium text-ink">這個功能目前沒有開啟</h1>
      </Frame>
    );
  }

  const sp = await searchParams;
  if (sp.client_id === undefined) return <ManageView />;

  const query = rebuildQuery(sp);
  const base = await currentOAuthBaseUrl();
  const check = checkAuthorizeParams(query, secret, base);
  if (!check.ok && !check.fatal) redirect(check.redirectUrl);
  if (!check.ok) {
    return (
      <Frame>
        <h1 className="text-[20px] font-medium text-ink">無法完成授權</h1>
        <p className="text-[15px] leading-relaxed text-ink-soft">{check.message}</p>
      </Frame>
    );
  }

  // 只有負責人：用能力表（mcp:connect）判斷，不比對角色字串。
  const owner = await checkCapability("mcp:connect");
  if (!owner || owner.via || owner.caps || !owner.id) {
    const staff = await getStaff();
    return (
      <Frame>
        <h1 className="text-[20px] font-medium text-ink">需要負責人帳號</h1>
        <p className="text-[15px] leading-relaxed text-ink-soft">
          你目前以 <span className="font-medium text-ink">{staff?.email ?? "（未知帳號）"}</span>{" "}
          登入，角色是「{staff ? ROLE_LABELS[staff.role] : "—"}」。讓 AI 連接後台只能由負責人本人授權。
        </p>
        <form action="/logout" method="post">
          <button
            type="submit"
            className="inline-flex min-h-11 w-full items-center justify-center rounded-input border border-line-input px-3.5 text-[15px] text-ink hover:bg-paper"
          >
            登出，改用負責人帳號
          </button>
        </form>
      </Frame>
    );
  }

  const shown = redirectDisplay(check.req.redirectUri);
  const clientName = check.req.client.client_name;
  const known = /(^|\.)claude\.(ai|com)$/.test(shown.host)
    ? "Claude"
    : shown.host === "chatgpt.com"
      ? "ChatGPT"
      : null;
  // 釣魚警示（資安審查 2026-11-15 M2）：Claude／ChatGPT 每次按「連接」都會當場註冊，
  // 所以自己發起的連線，client 一定是剛剛註冊的。註冊超過 15 分鐘＝很可能是別人準備好寄來的連結。
  const ageMinutes = Math.floor((Date.now() / 1000 - check.req.client.client_id_issued_at) / 60);
  const stale = ageMinutes > 15;

  return (
    <Frame>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[20px] font-medium leading-snug text-ink">
          {known ?? clientName} 想要連接快樂手後台
        </h1>
        <p className="text-[14px] text-ink-soft">
          以 <span className="font-medium text-ink">{owner.email ?? "（此帳號沒有 Email）"}</span>{" "}
          的負責人身分授權
        </p>
      </div>

      <dl className="flex flex-col gap-2 rounded-input bg-paper px-4 py-3 text-[14px]">
        <div className="flex justify-between gap-3">
          <dt className="shrink-0 text-ink-soft">應用程式名稱</dt>
          <dd className="break-all text-right font-medium text-ink">{clientName}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="shrink-0 text-ink-soft">授權後會回到</dt>
          <dd className="break-all text-right font-medium text-ink">
            {shown.host}
            {shown.loopback ? "（這台電腦上的程式，例如 Claude Code）" : ""}
          </dd>
        </div>
      </dl>

      <div className="flex flex-col gap-2 text-[14px] leading-relaxed">
        <p className="font-medium text-ink">授權後，AI 會以你的名義：</p>
        <ul className="list-disc pl-5 text-ink-soft">
          <li>查看訂單（含客人姓名、電話、Email）、場次、報名名單、候補與稽核紀錄</li>
          <li>先預覽、經你同意後執行：標記收款、補開發票、取消訂單、調整名額、上下架等</li>
          <li>提出退款、作廢發票的「申請」（不會自己退款或作廢，要你在後台按）</li>
          <li>每一筆操作都會記在稽核紀錄，記成你本人（標示為 MCP）</li>
        </ul>
        <p className="font-medium text-ink">它不能：</p>
        <ul className="list-disc pl-5 text-ink-soft">
          <li>管理員工帳號與權限、授權其他連線、關閉 AI 申請</li>
        </ul>
        <p className="text-[13px] text-ink-soft">
          授權最長 90 天；你的帳號不再是負責人時立即失效。
        </p>
      </div>

      {stale ? (
        <p className="rounded-input border border-danger px-4 py-3 text-[13px] leading-relaxed text-danger">
          注意：這個連線是 {ageMinutes >= 1440 ? `${Math.floor(ageMinutes / 1440)} 天` : `${ageMinutes} 分鐘`}
          前建立的，不是剛剛。你自己在 Claude／ChatGPT 按「連接」時，這裡會是剛剛建立的。
          如果是你自己剛剛按的連接，可以繼續；如果這是別人傳給你的連結，請按「拒絕」。
        </p>
      ) : null}

      {shown.loopback ? (
        <p className="rounded-input border border-danger px-4 py-3 text-[13px] leading-relaxed text-danger">
          這個授權會交給「這台電腦上的程式」。只有在你自己剛剛從電腦上的 Claude Code
          發起連線時才按允許。
        </p>
      ) : null}

      <ConsentForm query={query} csrf={consentToken(owner.id, query, secret)} />
    </Frame>
  );
}

async function ManageView() {
  const owner = await checkCapability("mcp:connect");
  if (!owner || owner.via || owner.caps || !owner.id) {
    return (
      <Frame>
        <h1 className="text-[20px] font-medium text-ink">AI 連線</h1>
        <p className="text-[15px] leading-relaxed text-ink-soft">這一頁只有負責人可以使用。</p>
      </Frame>
    );
  }
  return (
    <Frame>
      <h1 className="text-[20px] font-medium text-ink">AI 連線</h1>
      <div className="flex flex-col gap-2 text-[14px] leading-relaxed text-ink-soft">
        <p>
          在 Claude（網頁版、手機 App）或 ChatGPT 新增自訂連接器，網址填{" "}
          <span className="break-all font-medium text-ink">https://happyhands.com.tw/api/mcp</span>
          ，按連接後用你的負責人帳號登入、按「允許」，就能讓 AI 幫你查訂單與操作後台。
        </p>
        <p>每一次授權最長 90 天；你的帳號不再是負責人時立即失效。</p>
        <p>
          手機或帳號遺失、懷疑被別人連上時，按下面的按鈕：你之前授權出去的所有 AI 連線會立刻失效
          （要繼續用的話重新連線即可）。也建議同時更換登入密碼。
        </p>
      </div>
      <RevokeButton />
    </Frame>
  );
}
