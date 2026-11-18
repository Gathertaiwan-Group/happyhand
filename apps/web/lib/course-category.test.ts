/**
 * 前台課程分類（lib/course-category.ts）的規則測試。
 *
 * 跑法（repo 根目錄）：
 *
 *   node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     apps/web/lib/course-category.test.ts --bundle --platform=node --format=esm \
 *     --alias:@=./apps/web --outfile=/tmp/course-category.test.mjs
 *   node --test /tmp/course-category.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cardTagLine,
  categoriesOf,
  categoryFromParams,
  sessionCategories,
} from "./course-category";

test("course／subscription 是預錄課程，就算掛了混合場次", () => {
  assert.deepEqual(categoriesOf({ type: "course", sessionFormats: ["hybrid"] }), ["recorded"]);
  assert.deepEqual(categoriesOf({ type: "subscription" }), ["recorded"]);
});

test("workshop 照場次形式分，hybrid 兩邊都算，沒有場次歸線下", () => {
  assert.deepEqual(categoriesOf({ type: "workshop", sessionFormats: ["online"] }), ["live"]);
  assert.deepEqual(categoriesOf({ type: "workshop", sessionFormats: ["onsite"] }), ["onsite"]);
  assert.deepEqual(categoriesOf({ type: "workshop", sessionFormats: ["hybrid"] }), ["live", "onsite"]);
  assert.deepEqual(categoriesOf({ type: "workshop", sessionFormats: ["online", "onsite"] }), ["live", "onsite"]);
  assert.deepEqual(categoriesOf({ type: "workshop", sessionFormats: [] }), ["onsite"]);
  assert.deepEqual(categoriesOf({ type: "workshop" }), ["onsite"]);
});

test("場次分類", () => {
  assert.deepEqual(sessionCategories("online"), ["live"]);
  assert.deepEqual(sessionCategories("hybrid"), ["live", "onsite"]);
  assert.deepEqual(sessionCategories("onsite"), ["onsite"]);
});

test("卡片標籤：分類由型態產生，自由標籤裡的分類字眼拿掉", () => {
  assert.equal(
    cardTagLine({ type: "workshop", tags: ["近期新課", "線上課程", "中醫入門"], sessionFormats: ["online"] }),
    "線上直播・近期新課・中醫入門",
  );
  assert.equal(
    cardTagLine({ type: "course", tags: ["線上課程，", "搭配實體課。"], sessionFormats: ["hybrid"] }),
    "預錄課程・搭配實體課。",
  );
  assert.equal(cardTagLine({ type: "workshop", tags: ["「線上課程」", "「初階」"] }), "線下工作坊・「初階」");
  assert.equal(cardTagLine({ type: "subscription", tags: ["訂閱", "陪伴"] }), "預錄課程・陪伴");
  assert.equal(cardTagLine({ type: "workshop", tags: ["實體工作坊", "台北"], sessionFormats: ["onsite"] }), "線下工作坊・台北");
});

test("網址參數新舊寫法都吃", () => {
  const q = (s: string) => {
    const p = new URLSearchParams(s);
    return categoryFromParams((k) => p.get(k));
  };
  assert.equal(q("cat=recorded"), "recorded");
  assert.equal(q("cat=live"), "live");
  assert.equal(q("format=online"), "live");
  assert.equal(q("format=onsite"), "onsite");
  assert.equal(q("type=subscription"), "recorded");
  assert.equal(q("type=course"), "recorded");
  assert.equal(q("type=workshop"), null);
  assert.equal(q(""), null);
});
