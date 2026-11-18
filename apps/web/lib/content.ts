/**
 * 真實商品與文案 — 來源：design_handoff_happyhands/CONTENT.md
 * 這份同時是 supabase/seed.sql 的來源，也是 DB 尚未就緒時的 fallback，
 * 讓網站在任何情況下都能正常顯示（不會因為 DB 沒接好就整站空白）。
 */

export type ProductType = "course" | "workshop" | "subscription";

export type Lesson = {
  /** course_lessons.id。免費試看的播放器需要它去換影片 ID。 */
  id?: string;
  title: string;
  duration_sec: number;
  free_preview?: boolean;
};

export type Product = {
  slug: string;
  type: ProductType;
  title: string;
  subtitle: string;
  description: string;
  price: number;
  compare_at_price?: number | null;
  featured?: boolean;
  tags: string[];
  benefits: string[];
  cover_url?: string | null;
  lessons?: Lesson[];
  /**
   * 報名頁內容（migration 20260827000003）。
   * 全部 optional：DB 還沒填、或是舊的靜態 PRODUCTS 常數都不會有這些欄位，
   * 前台一律用「空就整塊不顯示」處理。
   */
  hero_lead?: string | null;
  suitable_for?: string[];
  not_suitable_for?: string[];
  outcomes?: string[];
  curriculum_online?: string[];
  curriculum_onsite?: string[];
  includes?: string[];
  notes?: string[];
  asks_intake?: boolean;
};

export type WorkshopSession = {
  slug: string;
  starts_at: string;
  ends_at: string;
  location: string;
  address: string;
  capacity: number;
  seats_taken: number;
};

export const PRODUCTS: Product[] = [
  {
    slug: "self-help-book-28-lessons",
    type: "course",
    title: "自助課本 + 28 堂線上基礎學習課",
    subtitle: "最多人選的完整組合",
    description:
      "從最基礎的手位開始，一堂一個能量流，二十八堂走完一輪。附一本紙本自助課本，練習的時候放在旁邊翻，不用一直看螢幕。",
    price: 3600,
    compare_at_price: 4800,
    featured: true,
    tags: ["線上課程", "含課本"],
    benefits: ["永久回放", "含紙本課本", "可問老師"],
    lessons: [
      { title: "第一堂：先把手放好", duration_sec: 720, free_preview: true },
      { title: "第二堂：呼吸慢下來", duration_sec: 660 },
      { title: "第三堂：手指與情緒", duration_sec: 780 },
      { title: "第四堂：正中能量流（上）", duration_sec: 840 },
      { title: "第五堂：正中能量流（下）", duration_sec: 810 },
      { title: "第六堂：肩頸緊繃時", duration_sec: 700 },
      { title: "第七堂：睡不好的晚上", duration_sec: 690 },
      { title: "第八堂：坐著也能做的替代姿勢", duration_sec: 750 },
    ],
  },
  {
    slug: "jsj-beginner",
    type: "course",
    title: "仁神術新手入門課（永久版）",
    subtitle: "永久版，現在加贈課本",
    description:
      "沒有接觸過仁神術也沒關係。這門課從頭講起，慢慢帶你把手放到對的位置，一次學一個就好。",
    price: 3600,
    compare_at_price: null,
    tags: ["線上課程", "新手"],
    benefits: ["永久回放", "現加贈課本", "可問老師"],
    lessons: [
      { title: "第一堂：什麼是仁神術", duration_sec: 600, free_preview: true },
      { title: "第二堂：手上的能量鎖", duration_sec: 720 },
      { title: "第三堂：每天十分鐘的順序", duration_sec: 660 },
      { title: "第四堂：替家人做的時候", duration_sec: 780 },
    ],
  },
  {
    slug: "pulse-reading",
    type: "course",
    title: "快樂手 JSJ「讀脈入門課」",
    subtitle: "終生回放，另有台北實體班",
    description:
      "把手放上去之後，怎麼知道身體在說什麼。這門課帶你認識讀脈的入門方法，慢慢練，不用急。",
    price: 6800,
    tags: ["線上課程", "進階"],
    benefits: ["終生回放", "另有台北實體班", "可問老師"],
    lessons: [
      { title: "第一堂：讀脈之前", duration_sec: 900, free_preview: true },
      { title: "第二堂：十二段的位置", duration_sec: 1020 },
      { title: "第三堂：手感怎麼練", duration_sec: 960 },
    ],
  },
  {
    slug: "main-central-flow",
    type: "course",
    title: "正中能量流（任脈＋督脈）",
    subtitle: "單堂小品，先試試看感覺",
    description:
      "只有一堂，講最常用的正中能量流。想先試試看的話，從這裡開始最輕鬆。",
    price: 888,
    tags: ["線上課程", "單堂"],
    benefits: ["永久回放", "十分鐘就能做完"],
    lessons: [
      { title: "正中能量流完整示範", duration_sec: 960, free_preview: true },
    ],
  },
  {
    slug: "seasonal-companion",
    type: "subscription",
    title: "『24 節氣美好生活的年度陪伴計畫』",
    subtitle: "依節氣定期寄送內容",
    description:
      "一年二十四個節氣，每到一個節氣就寄一封信給你，講這個時節身體容易怎麼樣、可以怎麼照顧自己。",
    price: 500,
    tags: ["訂閱", "陪伴"],
    benefits: ["依節氣寄送", "可隨時取消"],
  },
  {
    slug: "root-memory-workshop",
    type: "workshop",
    title: "改寫根源記憶：療癒關係工作坊",
    subtitle: "台北實體工作坊",
    description:
      "兩天的實體課，跟著老師一起把手放好，也把心裡的事情放好。名額不多，想來的話早點報名。",
    price: 6800,
    tags: ["實體工作坊", "台北"],
    benefits: ["含茶點", "可改期一次", "現場有助教"],
  },
];

export const WORKSHOP_SESSIONS: WorkshopSession[] = [
  {
    slug: "root-memory-workshop",
    starts_at: "2026-09-12T01:30:00Z",
    ends_at: "2026-09-12T09:00:00Z",
    location: "好日子・台北教室",
    address: "臺北市中山區新生北路三段 1 號 9 樓之 15",
    capacity: 16,
    seats_taken: 12,
  },
  {
    slug: "root-memory-workshop",
    starts_at: "2026-09-27T01:30:00Z",
    ends_at: "2026-09-27T09:00:00Z",
    location: "好日子・台北教室",
    address: "臺北市中山區新生北路三段 1 號 9 樓之 15",
    capacity: 16,
    seats_taken: 16,
  },
  {
    slug: "pulse-reading",
    starts_at: "2026-10-18T02:00:00Z",
    ends_at: "2026-10-18T09:30:00Z",
    location: "好日子・台北教室",
    address: "臺北市中山區新生北路三段 1 號 9 樓之 15",
    capacity: 12,
    seats_taken: 3,
  },
];

export const TEACHER = {
  name: "劉柳樺老師",
  eyebrow: "TEACHER",
  paragraphs: [
    "好日子創辦人，長年在台灣推廣仁神術。她總說，這不是什麼神奇的東西，就是把手放好、把呼吸放慢，剩下的身體自己會做。",
    "課堂上她講得很慢，會等每個人都跟上；學員裡有六十幾歲才開始學的，現在也能天天替家人做。",
  ],
};

export const REASONS = [
  {
    no: "一",
    title: "每天十分鐘",
    desc: "一次一個能量流，早晚各做一回就夠了。",
    descMobile: "早晚各做一回就夠了。",
  },
  {
    no: "二",
    title: "坐著也能做",
    desc: "膝蓋、腰不舒服也不用擔心，全程都有替代姿勢。",
    descMobile: "全程都有替代姿勢。",
  },
  {
    no: "三",
    title: "有人陪著練",
    desc: "線上同學群＋每月實體班，不會練到一半就放掉。",
    descMobile: "線上同學群＋每月實體班。",
  },
];

export const FAQS = [
  {
    q: "我沒有基礎，也沒有運動習慣，可以學嗎？",
    a: "可以。課程從最基本的手位開始，不需要體力也不需要器材，坐著就能做。班上有六十幾歲才開始學的同學。",
  },
  {
    q: "預錄課程可以看多久？",
    a: "永久回放。買了之後登入會員就能一直看，沒有期限，也可以重複看。線上直播是排好時間的視訊課，跟預錄課程不一樣。",
  },
  {
    q: "膝蓋或腰不好，做得來嗎？",
    a: "做得來。每個動作都有替代姿勢，坐在椅子上、躺著都可以，課程裡都會示範。",
  },
  {
    q: "可以用 ATM 匯款嗎？",
    a: "可以。結帳時選「ATM 匯款」會顯示帳號，匯款後我們對帳完成就會開通課程。也可以直接用 LINE 跟我們說一聲，請我們代訂。",
  },
  {
    q: "工作坊如果臨時不能去怎麼辦？",
    a: "開課前七天告訴我們可以改期一次。若是身體不舒服，用 LINE 跟我們說，我們會盡量協助。",
  },
  {
    q: "課本會寄到家裡嗎？",
    a: "會。付款完成後我們會用宅配寄出，通常三到五個工作天會到。",
  },
  /*
   * 下面三題是「買了之後怎麼看」。原本 FAQ 完全沒有提到帳號與登入——
   * 客人下完單、收到信、卻不知道那封信是幹嘛的，只能打 LINE 問。
   * 這三題就是客服最常被問的三句話，寫在這裡可以擋掉大部分的詢問。
   */
  {
    q: "買了課之後，要去哪裡看？",
    a: "從網站右上角的「我的學習」進去就看得到。第一次進去要先登入，用你下單時填的 Email，密碼是你在「請設定密碼」那封信裡自己設定的那一組。",
  },
  {
    q: "我沒有註冊過帳號，也可以買嗎？",
    a: "可以，直接下單就好，不用先註冊。我們會用你填的 Email 幫你開好帳號，並寄一封「請設定密碼」的信給你，設定完就能登入看課程。",
  },
  {
    q: "忘記密碼、或是根本沒設定過密碼怎麼辦？",
    a: "在登入頁面按「忘記密碼？」，輸入你下單時填的 Email，我們會再寄一封信給你重新設定。連結只能用一次，如果你按了兩次，請用最新收到的那一封。還是不行的話用 LINE 找我們，報你的名字就好。",
  },
];

export function findProduct(slug: string) {
  return PRODUCTS.find((p) => p.slug === slug) ?? null;
}
