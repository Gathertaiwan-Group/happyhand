import { LinkButton } from "@/components/ui/button";
import type { WorkshopRow } from "@/lib/data";
import { SessionRow } from "@/app/(storefront)/workshops/_components/session-row";
import { NoSessions } from "@/app/(storefront)/workshops/_components/no-sessions";
import { hasOnline } from "@/lib/session-format";

/** 首頁最多列幾個工作坊。超過的收進 /workshops，不要讓首頁變成場次表。 */
const HOME_SESSION_LIMIT = 6;

/**
 * 同一個工作坊只留最近的一場。
 *
 * 一門工作坊開好幾梯是常態（root-memory 兩梯、26 道鎖三梯），首頁把每一梯
 * 都列出來的話，同一個名字會連著出現兩三次，看起來像是資料重複而不是
 * 「這門課有很多場可以挑」。挑場次是 /workshops 的事，首頁只負責讓人知道
 * 有哪些工作坊、最近一場什麼時候。
 *
 * ⚠️ 依賴 getWorkshopSessions() 已經照 starts_at 由近到遠排序 —— 第一筆
 * 就是最近的一場。那個排序改掉的話這裡會變成「留下任意一場」。
 */
function oneRowPerWorkshop(sessions: WorkshopRow[]): WorkshopRow[] {
  const seen = new Set<string>();
  return sessions.filter((s) => {
    if (seen.has(s.slug)) return false;
    seen.add(s.slug);
    return true;
  });
}

/**
 * 首頁的工作坊區塊。
 *
 * 為什麼放在課程卡之後、老師之前：
 * 線上課是低門檻的入口，工作坊是更高的承諾也是更高的客單價（6,800 vs 3,600），
 * 而且它有「特定日期 + 剩幾位」這種線上課沒有的具體性與稀缺感。
 * 先讓人知道有這個選項，再用老師的段落收信任，最後才是聯絡出口。
 *
 * 刻意重用 /workshops 的 SessionRow 而不是另刻一版卡片：
 * 同一種東西在站上長得不一樣會讓人以為是兩件事，而且那個元件的
 * RWD 已經驗過（390px 無溢出、觸控區達標），另刻等於重新承擔一次風險。
 *
 * 一個工作坊只列一場（最近的那場），最多幾個由 HOME_SESSION_LIMIT 決定。
 * 首頁的任務是「讓人知道有實體課、下一場什麼時候」，不是把場次表搬過來——
 * 其餘梯次用底下那顆按鈕帶去 /workshops。
 */
export function HomeWorkshops({
  sessions,
  workshopSlugs,
}: {
  sessions: WorkshopRow[];
  /** 只有 type=workshop 的商品有單場詳情頁，其餘（例如讀脈入門課的實體班）標題不做連結 */
  workshopSlugs: Set<string>;
}) {
  const upcoming = oneRowPerWorkshop(sessions).slice(0, HOME_SESSION_LIMIT);
  // 比的是「全部場次」不是「全部工作坊」：被摺疊掉的梯次也在 /workshops 上，
  // 所以就算工作坊全列完了，只要還有別的梯次，那顆按鈕就該出現。
  const more = sessions.length - upcoming.length;

  return (
    <section
      aria-labelledby="home-workshops-title"
      className="border-t border-sand-300 bg-white px-[20px] py-[40px] md:px-[40px] md:py-[76px]"
    >
      <div className="mx-auto max-w-[1080px]">
        <div className="text-center">
          <p className="t-eyebrow text-caramel-ink">WORKSHOPS</p>
          <h2 id="home-workshops-title" className="t-h2 mt-[10px]">
            也可以跟老師面對面練一次
          </h2>
          <p className="t-body mx-auto mt-[14px] max-w-[620px] text-pretty text-brown-500">
            小班制，八到十個人，老師會一個一個看過去。工具跟講義都準備好了，你空手來就行。
          </p>
          {/* 同 /workshops：首頁列出的場次裡有線上的，才補這一句。 */}
          {upcoming.some((s) => hasOnline(s.format)) && (
            <p className="t-body mx-auto mt-[8px] max-w-[620px] text-pretty text-brown-500">
              標示「線上」的場次用視訊上課，上課連結會在開課前傳給你。
            </p>
          )}
        </div>

        <div className="mt-[24px] md:mt-[36px]">
          {upcoming.length === 0 ? (
            <NoSessions message="最近沒有安排實體場次。想知道下一場什麼時候開，用 LINE 問我們，開課前會先告訴你。" />
          ) : (
            <ul className="flex list-none flex-col gap-[14px]">
              {upcoming.map((s) => (
                <SessionRow
                  key={s.id ?? `${s.slug}-${s.starts_at}`}
                  session={s}
                  detailHref={
                    workshopSlugs.has(s.slug) ? `/workshops/${s.slug}` : null
                  }
                />
              ))}
            </ul>
          )}
        </div>

        {/* 還有其他場次時才給出口。全部都列完的話這顆按鈕會把人帶到一模一樣的內容。 */}
        {more > 0 && (
          <div className="mt-[20px] text-center md:mt-[28px]">
            <LinkButton href="/workshops" variant="outline">
              看全部 {sessions.length} 場場次
            </LinkButton>
          </div>
        )}
      </div>
    </section>
  );
}
