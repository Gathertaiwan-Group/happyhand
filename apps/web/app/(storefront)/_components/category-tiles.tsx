import Link from "next/link";
import {
  CATEGORY_HREF,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  type CourseCategory,
} from "@/lib/course-category";

/**
 * 首頁第一屏的三類課程入口（2026-11-18 手機版改版）。
 *
 * 參考 PressPlay 首頁的分類圖示列、MasterClass「你想學什麼」：
 * 一進來先讓人選「哪一種上課方式」，不用先讀完品牌文案。
 * 三格並排、每格整格可點（≥ 96px 高），字 17px 以上，網址沿用導覽列的三個入口。
 */
const SUB: Record<CourseCategory, string> = {
  recorded: "永久回放",
  live: "在家跟著練",
  onsite: "面對面小班",
};

function Icon({ cat }: { cat: CourseCategory }) {
  const common = {
    viewBox: "0 0 32 32",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "h-[30px] w-[30px]",
    "aria-hidden": true,
  };
  if (cat === "recorded")
    return (
      <svg {...common}>
        <rect x="4" y="6" width="24" height="17" rx="3" />
        <path d="M14 11.5v6l5-3-5-3Z" />
        <path d="M11 27h10" />
      </svg>
    );
  if (cat === "live")
    return (
      <svg {...common}>
        <rect x="3.5" y="9" width="17" height="14" rx="3" />
        <path d="M20.5 14l7-4v12l-7-4" />
        <circle cx="9" cy="14" r="1.6" fill="currentColor" stroke="none" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="11" cy="10" r="3.5" />
      <circle cx="21.5" cy="11" r="3" />
      <path d="M4.5 25c.6-4.6 3.4-7 6.5-7s5.9 2.4 6.5 7" />
      <path d="M17.5 19.2c1.1-.8 2.4-1.2 4-1.2 2.8 0 5.1 2.1 5.6 6" />
    </svg>
  );
}

export function CategoryTiles({
  counts,
}: {
  /** 每一類目前有幾項（預錄＝幾門課、直播／工作坊＝幾場）。0 時顯示「看看有什麼」 */
  counts: Record<CourseCategory, number>;
}) {
  return (
    <nav aria-label="三類課程" className="mx-auto max-w-[1080px]">
      <ul className="grid grid-cols-3 gap-[10px] md:gap-[20px]">
        {CATEGORY_ORDER.map((cat) => (
          <li key={cat}>
            <Link
              href={CATEGORY_HREF[cat]}
              className="flex h-full min-h-[112px] flex-col items-center justify-center gap-[4px] rounded-[18px] border border-sand-300 bg-white px-[6px] py-[12px] text-center text-brown-900 shadow-[0_6px_18px_rgba(74,53,36,0.06)] transition-[border-color,box-shadow] duration-200 hover:border-caramel hover:shadow-card md:min-h-[132px] md:flex-row md:gap-[16px] md:px-[24px] md:text-left"
            >
              <span className="flex h-[48px] w-[48px] shrink-0 items-center justify-center rounded-full bg-cream-200 text-caramel-dk md:h-[60px] md:w-[60px]">
                <Icon cat={cat} />
              </span>
              <span className="flex flex-col">
                <span className="text-[18px] leading-[1.4] font-semibold md:text-[21px]">
                  {CATEGORY_LABEL[cat]}
                </span>
                <span className="text-[16px] leading-[1.5] text-brown-700 md:text-[17px]">
                  {SUB[cat]}
                  <span className="hidden md:inline">
                    {counts[cat] > 0
                      ? `・${counts[cat]} ${cat === "recorded" ? "門" : "場"}`
                      : ""}
                  </span>
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
