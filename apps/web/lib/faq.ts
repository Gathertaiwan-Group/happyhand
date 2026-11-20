import { FAQS } from "@/lib/content";

/**
 * 常見問題（/faq）的資料形狀、預設內容與驗證。
 *
 * 2026-11-20 起 /faq 改成「site_settings 的 faq 有值就用它，沒有就用這裡的預設」，
 * 讓業主可以透過 MCP（update_faq）用手機改常見問題。不需要新表：site_settings 本來就是 key-value。
 *
 * 純資料、零 IO：前台頁面、MCP、測試都 import 這一支。
 *
 * ⚠️ 範圍：只影響 /faq 這一頁。課程頁的前 4 題與 AI 小幫手的知識庫仍用 lib/content.ts 的 FAQS。
 * ⚠️ 法規：不得有醫療宣稱（README §免責）。findMedicalClaims() 擋明顯的字眼，擋不住的仍要人看。
 */

export type FaqItem = { q: string; a: string };
export type FaqGroup = { title: string; items: FaqItem[] };
export type FaqValue = { groups: FaqGroup[] };

export const FAQ_LIMITS = {
  groups: 8,
  groupTitle: 20,
  items: 20,
  question: 120,
  answer: 1000,
} as const;

/**
 * 原本寫死在 app/(storefront)/faq/page.tsx 的分組，原封不動搬過來當預設值。
 * `picks` 取自 lib/content.ts 的 FAQS（勿改寫），`extra` 是 /faq 補寫的題目。
 * FAQS 之後若新增題目而沒被分到組，會自動落在第一組，不會消失。
 */
const GROUPS: { title: string; picks: string[]; extra: FaqItem[] }[] = [
  {
    title: "課程相關",
    picks: [
      "我沒有基礎，也沒有運動習慣，可以學嗎？",
      "膝蓋或腰不好，做得來嗎？",
      "預錄課程可以看多久？",
    ],
    extra: [
      {
        q: "用手機看課程可以嗎？字太小看不清楚怎麼辦？",
        a: "可以。手機、平板、電腦都看得到。字幕大小可以自己調，影片也能放慢。真的調不出來，用 LINE 告訴我們，我們在 LINE 上陪你設定一次。",
      },
    ],
  },
  {
    title: "付款與寄送",
    picks: ["可以用 ATM 匯款嗎？", "課本會寄到家裡嗎？"],
    extra: [
      {
        q: "不會線上付款怎麼辦？",
        a: "用 LINE 問我們，有真人回訊息。我們可以幫你代訂，再告訴你匯款帳號，不用自己在網路上填資料。",
      },
      {
        q: "付完錢多久可以開始上課？",
        a: "信用卡付款完成之後馬上就能看。ATM 匯款的話，我們對帳完成會寄一封開通信給你，通常一到兩個工作天。沒收到信先看看垃圾信件匣，還是沒有就用 LINE 問我們。",
      },
    ],
  },
  {
    title: "工作坊",
    picks: ["工作坊如果臨時不能去怎麼辦？"],
    extra: [
      {
        q: "工作坊額滿了，還可以報名嗎？",
        a: "可以候補。額滿的場次按「已額滿・我要候補」用 LINE 跟我們說一聲，有人取消我們會照順序通知你。",
      },
    ],
  },
];

function buildDefault(): FaqValue {
  const byQuestion = new Map(FAQS.map((f) => [f.q, f]));
  const picked = new Set(GROUPS.flatMap((g) => g.picks));
  const unassigned = FAQS.filter((f) => !picked.has(f.q));
  return {
    groups: GROUPS.map((group, i) => ({
      title: group.title,
      items: [
        ...group.picks.flatMap((q) => {
          const found = byQuestion.get(q);
          return found ? [{ q: found.q, a: found.a }] : [];
        }),
        ...(i === 0 ? unassigned.map((f) => ({ q: f.q, a: f.a })) : []),
        ...group.extra,
      ],
    })),
  };
}

export const DEFAULT_FAQ: FaqValue = buildDefault();

/**
 * 不得出現在常見問題裡的字眼（醫療宣稱）。只擋明顯的；語意上的暗示仍要人看。
 * 與 lib/ai 小幫手的紅線同一個方向：只能寫「練習」「保健」「放鬆」。
 */
const MEDICAL_WORDS = [
  "治療",
  "治癒",
  "治好",
  "療效",
  "痊癒",
  "根治",
  "診斷",
  "處方",
  "藥效",
  "醫治",
  "保證有效",
  "改善病",
  "取代醫",
  "不用看醫生",
  "不必看醫生",
];

export function findMedicalClaims(value: FaqValue): string[] {
  const hits = new Set<string>();
  const texts = value.groups.flatMap((g) => [g.title, ...g.items.flatMap((i) => [i.q, i.a])]);
  for (const t of texts) {
    for (const w of MEDICAL_WORDS) if (t.includes(w)) hits.add(w);
  }
  return [...hits];
}

const clean = (v: unknown, max: number) =>
  String(v ?? "")
    .replace(/\r\n?/g, "\n")
    // 控制字元（保留換行）
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);

/**
 * 嚴格驗證（MCP 寫入用）：超過上限就報錯，不靜默截斷 —— 業主說了一段話，
 * 存進去卻少了一半，比擋下來更糟。
 */
export function validateFaq(input: unknown): { ok: true; value: FaqValue } | { ok: false; error: string } {
  const groups = (input as { groups?: unknown })?.groups;
  if (!Array.isArray(groups) || groups.length === 0) return { ok: false, error: "至少要有一個分組。" };
  if (groups.length > FAQ_LIMITS.groups) return { ok: false, error: `分組最多 ${FAQ_LIMITS.groups} 個。` };
  const out: FaqGroup[] = [];
  const seen = new Set<string>();
  for (const [gi, g] of groups.entries()) {
    const title = clean((g as FaqGroup)?.title, 200);
    if (!title) return { ok: false, error: `第 ${gi + 1} 個分組沒有標題。` };
    if (title.length > FAQ_LIMITS.groupTitle) {
      return { ok: false, error: `分組標題「${title.slice(0, 20)}…」超過 ${FAQ_LIMITS.groupTitle} 字。` };
    }
    const items = (g as FaqGroup)?.items;
    if (!Array.isArray(items) || items.length === 0) return { ok: false, error: `分組「${title}」沒有題目。` };
    if (items.length > FAQ_LIMITS.items) return { ok: false, error: `分組「${title}」最多 ${FAQ_LIMITS.items} 題。` };
    const cleanItems: FaqItem[] = [];
    for (const [ii, it] of items.entries()) {
      const q = clean((it as FaqItem)?.q, 5000);
      const a = clean((it as FaqItem)?.a, 5000);
      if (!q || !a) return { ok: false, error: `分組「${title}」第 ${ii + 1} 題的問題或答案是空的。` };
      if (q.length > FAQ_LIMITS.question) return { ok: false, error: `問題「${q.slice(0, 20)}…」超過 ${FAQ_LIMITS.question} 字。` };
      if (a.length > FAQ_LIMITS.answer) return { ok: false, error: `問題「${q.slice(0, 20)}…」的答案超過 ${FAQ_LIMITS.answer} 字。` };
      if (seen.has(q)) return { ok: false, error: `問題「${q.slice(0, 30)}」重複了。` };
      seen.add(q);
      cleanItems.push({ q, a });
    }
    out.push({ title, items: cleanItems });
  }
  return { ok: true, value: { groups: out } };
}

/**
 * 寬鬆讀取（前台用）：資料庫的值形狀不對就回 null，前台退回 DEFAULT_FAQ。
 * 前台不能因為一筆壞資料整頁掛掉。
 */
export function readFaq(raw: unknown): FaqValue | null {
  const v = validateFaq(raw);
  return v.ok ? v.value : null;
}
