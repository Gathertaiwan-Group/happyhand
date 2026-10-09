# 快樂手 Happy Healing Hands

好日子股份有限公司（GOOD DAY LOVE INC.）「快樂手」品牌的課程電商網站 —
仁神術（Jin Shin Jyutsu, JSJ）線上課程與實體工作坊。

主要客群是退休樂齡族（60–75 歲），**可及性是硬性需求不是加分項**：
內文最小 17px、按鈕高度 ≥ 56px、每頁都要有 LINE 聯絡出口、支援放大到 200% 不破版。

---

## 架構

```
GitHub（原始碼）
  ├── Vercel   → apps/web   前端 + Route Handlers（push main 自動部署 production，PR 產生 Preview）
  ├── Railway  → apps/worker 排程與背景工作
  └── Supabase → DB / Auth / Storage（migration 由 GitHub Actions 在 merge 後 db push）
```

| 層 | 選擇 |
|---|---|
| Framework | Next.js 15 App Router + TypeScript |
| 樣式 | Tailwind CSS v4（token 寫在 `apps/web/app/globals.css` 的 `@theme`） |
| UI | 自建元件（`apps/web/components/ui/`），沒有用任何 UI kit |
| DB / Auth / Storage | Supabase（Postgres + RLS） |
| 背景服務 | Railway（node-cron） |

## 目錄

```
happyhand/
├── apps/web/                  # Next.js（Vercel）
│   ├── app/                   # App Router 頁面
│   ├── components/            # 共用元件（ui/ 為基礎元件）
│   ├── lib/                   # site.ts 品牌資訊、content.ts 真實內容、data.ts 資料層、supabase/
│   └── .env.local             # 本機環境變數（不進版控）
├── apps/worker/               # Railway 排程服務
├── supabase/migrations/       # SQL migration（CI 自動 db push）
├── design_handoff_happyhands/ # 設計交付包：規格、文案、設計稿 HTML（視覺真相）
└── .github/workflows/ci.yml   # lint / typecheck / build / db push
```

## 本機開發

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

`apps/web/.env.local` 需要：

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=      # 只在 server 使用，勿加 NEXT_PUBLIC_
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

> 資料層（`apps/web/lib/data.ts`）**以資料庫為唯一真相，沒有靜態 fallback**。
> 查得到但零筆 → 顯示誠實的空狀態；連不上 → 記 log 後回空，靠 ISR 的舊快取撐著。
> 曾經有過「查不到就退回 `lib/content.ts`」的設計，但有了後台之後那會變成 bug：
> 把課程全部下架反而會讓前台冒出舊資料，而且不會有任何錯誤。

## 部署

### Vercel（前端）

- Project：`happyhands`，Root Directory 設 `apps/web`，Framework 選 Next.js。
- 已連 GitHub `Gathertaiwan-Group/happyhand`：**push 到 `main` 自動部署 production，PR 自動產生 Preview**。
- 環境變數在 Vercel 專案設定裡，四個都要有（見上）。

### Supabase（資料庫）

- Migration 放 `supabase/migrations/`，檔名 `YYYYMMDDHHMMSS_name.sql`。
- CI 在 push 到 `main` 且 web/worker 都通過後，自動執行 `supabase db push`。
- 手動執行：

```bash
supabase link --project-ref <PROJECT_REF>
supabase db push
```

### Railway（背景服務）

- Root Directory 用 **repo 根目錄**（不是 `apps/worker`），設定在 `railway.json`。
- Watch Paths 設 `apps/worker/**` 與 `railway.json`，避免改前端也重新部署 worker。
- 環境變數：`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`RESEND_API_KEY`（選用）、`LINE_CHANNEL_ACCESS_TOKEN`（選用）。
- 詳見 `apps/worker/README.md`。

## CI

`.github/workflows/ci.yml`：

| Job | 觸發 | 內容 |
|---|---|---|
| `web` | push / PR | lint、typecheck、build |
| `worker` | push / PR | typecheck、build |
| `migrate` | 只在 push 到 `main` 且前兩者成功 | `supabase db push` |

需要的 repository secrets：`NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、
`NEXT_PUBLIC_SITE_URL`、`SUPABASE_ACCESS_TOKEN`、`SUPABASE_PROJECT_ID`、`SUPABASE_DB_PASSWORD`。

## 管理員後台 `/admin`

### 角色

| role | 中文 | 能做什麼 |
|---|---|---|
| `customer` | 一般會員（預設） | 只有前台，進不了 `/admin` |
| `support` | 客服 | 訂單、標記收款、取消退款、報名名單匯出、候補、開關場次報名 |
| `editor` | 內容編輯 | 課程與工作坊 CRUD、單元、場次、圖片上傳 |
| `owner` | 負責人 | 以上全部 ＋ 員工帳號管理 ＋ 稽核紀錄 |

`editor` **看不到訂單**是刻意的：訂單含姓名、電話、Email、寄送地址，
內容編輯的工作不需要這些。能力表的唯一真相在 `apps/web/lib/admin/roles.ts`。

### 第一位 owner 怎麼產生

到 Supabase Dashboard 的 SQL editor 執行一次（email 是 PII，刻意不寫進 migration）：

```sql
insert into public.staff_invites (email, role)
values (lower(trim('負責人的信箱')), 'owner');
```

然後該信箱到 `/login` 註冊，`handle_new_user()` trigger 會自動套用角色並刪掉那筆邀請。
之後所有員工都由 owner 在 `/admin/staff` 邀請，不需要再下 SQL。
owner 不需要、也不可以替員工設密碼。

### 為什麼授權不走 RLS

後台寫入一律經 service role，授權擋在 TypeScript 層（`lib/admin/guard.ts`），
**沒有寫任何 admin RLS policy**。這不是偷懶：

`supabase/migrations/20260808000002_rls.sql` 開頭 `revoke all ... from anon, authenticated`，
讓「沒有 GRANT」本身就是最強的一道防線。走真 RLS 的話得
`grant insert/update/delete on products… to authenticated`、
`grant update on orders to authenticated` —— 後者那個檔案的註解正好寫著為什麼不行
（「orders.status 若使用者可改，任何人都能把自己的訂單改成 paid」）。
為了後台去拆掉這道保護不划算。

代價：對 service role key 外洩沒有第二道防線。緩解是 key 只存在 Vercel 環境變數
（不進 client bundle）＋ `audit_log` 留下每一筆寫入的痕跡。

四層守衛：

| 層 | 位置 | 擋什麼 |
|---|---|---|
| 1 | `middleware.ts` | 只看有無 session cookie，**不查 DB**。`/api/admin/*` 回 401 不導轉 |
| 2 | `app/admin/layout.tsx` | 查 role，非員工導回首頁。**保護不了 server action** |
| 3 | 每支 server action / route handler 的 `requireCapability()` | **唯一不能少的一層** |
| 4 | DB | 維持 revoke-all |

### 圖片素材

public bucket **`media`**，bucket 名的唯一真相在 `apps/web/lib/admin/media.ts`。

⚠️ **bucket 名一旦有圖就不能改** —— `products.cover_url` 存的是完整 public URL，
改名會讓所有既有圖片 404。

⚠️ 該 bucket **刻意沒有任何 `storage.objects` policy**。讀走 public endpoint 不經 RLS，
寫因為沒有 insert policy 而全擋，上傳只能經 `/api/admin/uploads`。
**不要「順手補齊 RLS」加 select policy** —— 加了之後匿名就能用 `storage.list()`
列出整個 bucket 的檔名。

圖片刪除只從欄位移除，**不刪 storage 檔案**（誤刪線上圖的代價高於孤兒檔）。
bucket 會單向長大，長期需要清理腳本。以目前規模一年不到 50MB。

### 報名名單與 `seats_taken`

報名名單是從 `order_items` join `orders(status='paid')` **即時算出來的**，
不是讀 `seats_taken`。

`seats_taken` 是場次建立時寫入的初始值，全站沒有任何程式碼寫過它
（`reserve_seat()` 那套 15 分鐘暫扣沒有接上結帳流程）。所以它與實際報名數
**目前對不起來**，後台兩個數字都會顯示並標註原因。
校正手段只有 `/admin/sessions/[id]` 的名額微調（走 `admin_adjust_seats` RPC）。

`seats_taken` 仍然有作用：結帳時的可用名額 = `capacity − seats_taken − 未付款但已下單`。

### 聯絡方式：LINE 官方帳號

站上**不再放電話**，所有聯絡出口都指向 LINE 官方帳號 `@hao2082l`
（`https://page.line.me/hao2082l`）。唯一真相在 `apps/web/lib/site.ts` 的
`lineId` / `lineLabel` / `lineHref`。

⚠️ 那是**外部連結**，不是 `tel:`。手寫 `<a>` 要自己帶 `target="_blank"` 與
`rel="noopener noreferrer"`；`LinkButton` 現在會在 `href` 以 `http` 開頭時
自動帶上（呼叫端仍可覆寫）。純圖示或短標籤的連結要補
`<span className="sr-only">（會開啟 LINE）</span>`，讓螢幕閱讀器知道會開新分頁。

後台的 `tel:` 連結是**刻意保留**的：客人結帳時仍會留電話，客服在手機後台
點一下就能撥出去，那是他們最常做的下一步。

### 報名名單 CSV 是個資出口

姓名＋電話＋Email＋地址會一次打包離開系統。每次匯出都會寫進 `audit_log`
（誰、何時、哪一場、幾筆幾人）。**流程上要跟好日子講清楚誰能匯、匯出後存哪。**

`lib/admin/csv.ts` 處理了三個不做就會出事的問題：formula injection
（姓名是使用者輸入，`=HYPERLINK(...)` 會在員工開檔時真的執行）、
Excel 吃掉電話開頭的 0、UTF-8 中文亂碼（Excel 只看 BOM）。

## 學員會員中心 `/account`

學員下單後自動有帳號，登入就能上課、查訂單、看報名的工作坊。

### 訂單一定要有主人

這是整個會員中心的地基。在 2026-08 之前 `orders.user_id` 從來沒被寫過，
而 `entitlements.user_id` 是 NOT NULL 的主鍵前導欄 ——
也就是說舊的資料模型下「開通線上課程」**物理上做不到**。

現在有三道，缺一不可：

1. **下單當下**（`app/api/orders/route.ts`）：已登入就用 session 的身分；
   否則用客人填的 Email 建帳號（`lib/account/provision.ts`）。
   Admin API 逾時（3 秒）不擋單。
2. **登入當下**（`claim_guest_orders()` RPC）：把 `contact_email` 等於自己
   已驗證信箱的未歸戶訂單認領過來。呼叫點是 `/auth/callback`、`/auth/confirm`、
   `/account` 的 layout。
3. **worker 每小時**（`backfill-order-users` job）：處理逾時與「客人一週後才註冊」。

> 🔴 `claim_guest_orders()` 與 `backfill_order_user_ids()` **都必須驗
> `email_confirmed_at is not null`**。少了那一行，任何人註冊一個未驗證的
> `victim@example.com` 就能認領受害者的訂單，看到姓名、電話、地址。
> 這是整套設計裡最容易寫錯、後果最嚴重的一行。

自動建帳號時 `email_confirm` 一定要 `true`：Supabase 的自動身分歸戶
（之後用 Google／LINE 登入時掛到既有帳號）明文要求 email 已驗證。
設 `false` 的話客人用 Google 登入會變成第二個帳號，然後看不到自己買的課，
**而且不會報錯**。

已知且可接受的取捨：若甲用乙的 Email 下單，乙註冊後會看到甲的姓名／電話／地址。
無法避免（那封「設定密碼」信本來就寄到乙的信箱了），業界一致如此。

### 付款 → 開通

`transitionOrder()` 在條件式 update 之後、`syncSeats()` 之前呼叫
`grant_entitlements_for_order()`。排在名額同步前面是刻意的：
名額沒對只是「數字要人工修」，課沒開通是「客人付了錢看不到課」。

三種開不了通的情形（沒綁帳號、`price_unverified`、RPC 失敗）**一律回報成畫面警告**，
不靜默。另有三個顯示點：訂單明細的「會員帳號與課程開通」面板、
訂單列表、以及 `/admin` 總覽的「已收款但未開通：N」——最後那個是唯一每天會被看到的地方。

**退款不會自動撤銷觀看權限。** `entitlements` 的 PK 是 `(user_id, product_id)`，
權限跨訂單共用，自動撤銷會誤刪另一筆合法訂單帶來的權限。改成客服逐課按按鈕（有 audit）。

### 影片：YouTube 不公開

`course_lessons.youtube_id` 存 11 碼 ID，後台貼整條網址由 `lib/youtube.ts` 解析。

> ⚠️ **影片在 YouTube 上必須設「不公開」（unlisted）。**
> 設「公開」→ 任何人搜尋得到，付費內容等於免費。
> 設「私人」→ 無法嵌入，學員一定看不到。
> **沒有任何程式碼檢查得到這件事**，只能靠上傳的人記得（後台欄位下方有紅字提醒）。

**對內容保護要誠實**：unlisted 擋得住沒買的人，擋不住買了的人。影片 ID 一定要
送到瀏覽器才能播，已購買者按 F12 讀 iframe 的 src、或右鍵複製網址就拿得到，
然後 `yt-dlp` 一行下載整支（unlisted 不需登入）。這在架構上無解 ——
換 Vimeo 或簽名 URL 也一樣，同一個人照樣可以螢幕錄影。

能做的是：
- `POST /api/lessons/[id]/video` 驗證 entitlement 後才回 ID，**教室頁的 RSC
  刻意不撈 `youtube_id`**（撈了整門課的 ID 會一次進 HTML）。
  `course_lessons` 的欄位級 grant 讓這件事變成「寫錯也拿不到」而不是靠自律。
- 播放器上疊遮罩後的 Email 浮水印：技術防護 0%，但外流時追得到來源。
- **影片 ID 可以隨時換** —— 這是唯一真正的補救手段。外流後重新上傳一支
  unlisted、在後台改掉 ID，舊連結就變孤兒。

YouTube 一般頻道**沒有**「限制嵌入網域」功能（那是 Content Manager 夥伴專屬），
不要對客戶承諾這件事。

### 兩條寄信路徑是刻意並存的

- **忘記密碼** → Supabase 內建 SMTP（`resetPasswordForEmail`）。
  保留它自帶的防帳號枚舉與 rate limit，自己重做很容易做錯。
- **訂單成立／設定密碼／課程開通** → 我們自己的 `email_outbox`。
  需要控制中文文案與觸發時機，而且要能重試、要查得到。

**不要「統一」它們。** 兩者解決的問題不一樣。

`email_outbox.dedupe_key` 的 unique 就是冪等保證。web 端用 `after()` 立刻試寄一次，
worker 的 `flush-email-outbox`（每 2 分鐘）負責重試，八次後標 `failed` 並上 `/admin` 總覽。

寄件人是 `noreply@gathertaiwan.com` —— Resend 帳號裡只有 `gathertaiwan.com` 與
`realreal.cc` 通過驗證，`happyhands.tw` 沒登記。

> 🔴 `gathertaiwan.com` 是**給樂其他專案共用的寄件網域**。
> `/api/orders` 會用它寄信給請求裡指定的任意信箱，所以防濫用不是可選的：
> setup 信只在新建帳號時寄、`dedupe_key` 綁 `user_id`（同一信箱一輩子只寄一封）、
> IP 節流、全站每小時 setup 信上限。出事時把 `SETUP_EMAIL_ON` 設成 `paid`
> 可以立刻把寄信移到客服手動的環節。

### 信件連結走 `/auth/confirm`，不是 `/auth/callback`

`/auth/callback` 吃 `?code=`（PKCE），而 PKCE 的 `code_verifier` 綁在
**發起請求的那個瀏覽器**。60–75 歲客群最典型的行為是「在 Safari 按忘記密碼 →
打開 Gmail App → 點連結 → Gmail 用內建瀏覽器開」，那裡沒有 `code_verifier`。

所以：
- `?code=` → `/auth/callback`（**只給 OAuth**，那一定是使用者自己按的按鈕）
- `?token_hash=` → `/auth/confirm`（信件連結，`verifyOtp` 不需要 `code_verifier`）

Supabase 的 Email Template 已改成 `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=…&next=…`。
改模板的時候記得四份（recovery / confirmation / magic_link / email_change）都要改。

### 「買過但後來下架」的商品仍然看得到

`products_select_published` 這類 policy 綁 `is_published = true`，對公開目錄正確，
但會員中心用同一組 policy 的話，公司一下架課程，客人的「我的學習」就會少一門課
**而且不報錯**。`20260810000007` 用 `owns_product()` / `registered_for_session()`
兩支 security definer 函式加三條 OR 的 policy 放行已經買過的人。

### 尚未啟用：LINE / Google 登入

程式面已經預留（`handle_new_user()` 的 `full_name → name → nickname` fallback
就是為 LINE 準備的，LINE 只給 `name`），但要啟用需要外部憑證：

- **Google**：Supabase 原生 provider。Google Cloud 建 OAuth client，
  redirect URI 填 `https://<project-ref>.supabase.co/auth/v1/callback`。
- **LINE**：**Supabase 沒有原生支援**，要走 Custom OIDC
  （identifier 必須是 `custom:line`，Issuer `https://access.line.me`）。
  ⚠️ LINE 的 email 權限**要另外送審**。拿不到 email 的話那個帳號
  **不可能跟訪客訂單歸戶** —— 長輩用 LINE 登入會看到空的「我的學習」，
  而 log 裡沒有任何錯誤。所以 `email_optional` 要保持關閉，
  拿不到 email 就讓登入明確失敗並顯示中文說明。
  **靜默開一個空帳號比登入失敗糟一百倍。**

## 設計規範

視覺真相是 `design_handoff_happyhands/design/happyhands-B-all-pages.dc.html`（7 頁 × 桌機＋手機）。
改 UI 之前先讀 `design_handoff_happyhands/README.md`：

- 顏色一律用 `globals.css` `@theme` 裡的 token，**不可出現 token 以外的色碼**，不可用 Inter 或預設藍色連結。
- 字級用 `t-h1` / `t-h2` / `t-body` 等 utility，已內建 390px→1280px 流體內插（390px 等於手機稿、≥1280px 等於桌機稿）。
- 斷點：`< 768px` 手機單欄＋底部固定行動列 / `768–1279px` 平板兩欄 / `≥ 1280px` 桌機。
- 動畫只做淡入與位移、≤300ms，遵守 `prefers-reduced-motion`，禁止視差與自動輪播。

## 文案規範

見 `design_handoff_happyhands/CONTENT.md`。重點：

- 對象是長輩，短句、口語、稱呼用「你」。
- **禁止醫療宣稱**（治療／療效／根治／痊癒／取代醫療），這是法規風險。可用「練習」「調理」「照顧自己」「放鬆」。
- 不要英文術語、行銷腔、emoji。
- 頁尾需有免責聲明：本課程為自我保健練習，非醫療行為，不能取代專業醫療診斷與治療。

## 尚未完成

- **金流**：已串**黑貓 PAY**（統一客樂得多元支付平台，系統商禹動科技，收單行統一金流 PAYUNi），
  不是綠界。程式在 `apps/web/lib/payment/blackcat.ts`＋`app/api/payments/blackcat/{apn,return}`。
  環境變數 `BLACKCAT_CUST_ID` / `BLACKCAT_API_PASSWORD` 都有值時才會真的開刷卡單，
  否則結帳會建立 `pending` 訂單由客服用 LINE 確認（前台文案會跟著換，見 `checkout/page.tsx`）。
  ⚠️ **真實刷卡從未端到端測過** —— 資料庫裡沒有任何一筆帶 `payment_trade_no` 的訂單。
  ⚠️ 退款／取消授權**尚未實作**，後台的「標記為已退款」只改資料庫狀態，不會通知黑貓 PAY。
  ⚠️ 代收代付（ibon／ATM 虛擬帳號）帳號已開通但**沒有串**，目前 ATM 是純人工對帳。
- **電子發票**：已串 **Amego**（光貿電子發票加值中心），賣方好日子股份有限公司／統編 53912857。
  程式在 `apps/web/lib/invoice/`，開票掛在付款成功（APN）與後台標記收款兩條路徑上。
  🔴 **目前開不出來**：Amego 後台設了 API 來源 IP 白名單（4 個固定 IP），而 Vercel 的出口 IP
  是浮動的，每次呼叫都會被回 `code 14 IP 錯誤`。要請光貿客服移除白名單才能運作。
- **第三方登入**：LINE 與 Google 登入尚未啟用，需要外部憑證（見下方「學員會員中心」）。
- **影片內容**：`course_lessons.youtube_id` 目前全是空的，後台填入 YouTube 網址就會上線。
- **素材**：設計稿中的斜紋色塊都是圖片佔位，等客戶提供照片（清單見 `design_handoff_happyhands/README.md` §8）。
- **網域**：目前是 Vercel 預設網域，`happyhands.tw` 尚未掛上。
- **字型未自架 subset**：目前用 `next/font/google` 載 Noto Sans TC / Noto Serif TC，
  兩個 CJK family 會展開 800+ 條 `@font-face`，約 **70 KB（brotli）的 render-blocking CSS**
  （全站 CSS 合計 79 KB，其中應用程式本身只有 8 KB）。已砍掉未使用的字重 300。
  要再降低就得照 `design_handoff_happyhands/README.md` §8 的建議自架 subset：
  用 `pyftsubset` 依實際用字產生 woff2，再自己寫 `@font-face`。對長輩的慢速網路值得做。
