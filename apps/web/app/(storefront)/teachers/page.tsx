import type { Metadata } from "next";
import { TEACHER } from "@/lib/content";
import { getSiteSetting, type TeacherSetting } from "@/lib/data";
import { LinkButton } from "@/components/ui/button";
import { MobileActionBar } from "@/components/mobile-action-bar";
import { PageHero } from "@/app/_components/page-hero";
import { CallBand } from "@/app/_components/call-band";
import { TeacherFeature } from "@/app/_components/teacher-feature";
import { MonitorPlay, Video } from "lucide-react";

export const metadata: Metadata = {
  title: "師資介紹",
  description:
    "劉柳樺老師是好日子創辦人，教仁神術二十幾年。課堂上她講得很慢，會等每個人都跟上。台北、台中每月開課，線上課程也由她親自錄製。",
};

/** 前兩段照抄 CONTENT.md（lib/content.ts 的 TEACHER.paragraphs），後三段為本頁補寫 */
const TEACHING_STYLE = [
  "她上課不趕進度。一個手位會講三、四遍，換個說法再講一次，直到大家都點頭才往下走。同一個問題有人問到第三次，她也還是從頭講一次。",
  "一堂課大概十幾分鐘，一次只教一個能量流。回家之後早晚各做一回，做順了再進下一堂。她常說，慢慢來比較快。",
  "來上課的多半是五、六十歲以上的長輩，也有人是為了照顧家裡的長輩才來學。有夫妻一起報名的，也有女兒帶著媽媽來的。大家程度都差不多，不用擔心跟不上。",
];

/**
 * 講師照片放在 site_settings（後台 /admin/settings 可換），不是寫死在 content.ts。
 * 這頁因此變成 async，但仍然是靜態 + ISR —— getSiteSetting 走 anon client、
 * 不讀 cookie，不會把整頁變成每次連線都查一次資料庫。
 * 後台換照片時 saveTeacher 會 revalidate 這條路徑，不用等 300 秒。
 */
export const revalidate = 300;

export default async function TeachersPage() {
  const teacher = await getSiteSetting<TeacherSetting>("teacher");

  return (
    <div className="pb-action-bar">
      <PageHero
        eyebrow={TEACHER.eyebrow}
        title={TEACHER.name}
        lead="台北、台中每月開課；線上課程也由她親自錄製。"
      />

      {/* 老師區（設計稿 895–910 行桌機、949–959 行手機） */}
      <TeacherFeature
        heading={
          <>
            把手放好，
            <br className="hidden md:inline" />
            把呼吸放慢
          </>
        }
        paragraphs={[...TEACHER.paragraphs, ...TEACHING_STYLE]}
        photoSrc={teacher?.photo_url}
        stats={[
          { value: "20 年", label: "教學經驗" },
          { value: "4,800+", label: "上過課的同學" },
          { value: "台北・台中", label: "每月開課" },
        ]}
      />

      {/* 想上她的課 */}
      <section className="bg-cream-100">
        <div className="mx-auto max-w-[860px] px-[20px] py-[40px] text-center md:px-[40px] md:py-[64px]">
          <h2 className="t-h2">想上她的課</h2>
          <p className="t-body mx-auto mt-[14px] max-w-[580px] text-pretty text-brown-500 md:mt-[18px]">
            預錄課程永久回放；想跟她一起練，有直播與台北工作坊。
          </p>

          <div className="mt-[22px] flex flex-col gap-[10px] md:mt-[28px] md:flex-row md:justify-center md:gap-[16px]">
            <LinkButton
              href="/courses?cat=recorded"
              variant="primary"
              size="lg"
              fullWidth
              className="gap-[8px] md:w-auto"
            >
              <MonitorPlay aria-hidden="true" strokeWidth={1.8} className="h-[21px] w-[21px]" />
              看預錄課程
            </LinkButton>
            <LinkButton
              href="/workshops"
              variant="outline"
              size="lg"
              fullWidth
              className="gap-[8px] md:w-auto"
            >
              <Video aria-hidden="true" strokeWidth={1.8} className="h-[21px] w-[21px] text-caramel-dk" />
              看直播與工作坊
            </LinkButton>
          </div>
        </div>
      </section>

      <CallBand note="適不適合、哪天開班，用 LINE 問就好。" />

      <MobileActionBar href="/courses" label="開始線上練習" />
    </div>
  );
}
