// Unit tests for the chapter-0 create guard (chapterZeroGuard.ts).
// Run: node --experimental-strip-types --no-warnings src/chapterZeroGuard.test.mjs

import assert from "node:assert/strict";
import { isValidChapterZeroRef } from "./chapterZeroGuard.ts";

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

t("tn: chapter 0, verse 0, front:intro is valid", () => {
  assert.equal(isValidChapterZeroRef("tn", 0, 0, "front:intro"), true);
});
t("tn: chapter 0 with a numeric verse is invalid (the ISA ee2w shape)", () => {
  assert.equal(isValidChapterZeroRef("tn", 0, 1, "0:1"), false);
});
t("tn: chapter 0, verse 0, but ref_raw 0:intro is invalid", () => {
  assert.equal(isValidChapterZeroRef("tn", 0, 0, "0:intro"), false);
});
t("tn: chapter 0, verse 3, front:intro is invalid (verse must be 0 too)", () => {
  assert.equal(isValidChapterZeroRef("tn", 0, 3, "front:intro"), false);
});
t("tq: chapter 0 is always invalid, even as verse 0 front:intro", () => {
  assert.equal(isValidChapterZeroRef("tq", 0, 0, "front:intro"), false);
  assert.equal(isValidChapterZeroRef("tq", 0, 1, "0:1"), false);
});
t("twl: chapter 0 is always invalid, even as verse 0 front:intro", () => {
  assert.equal(isValidChapterZeroRef("twl", 0, 0, "front:intro"), false);
  assert.equal(isValidChapterZeroRef("twl", 0, 1, "0:1"), false);
});
t("non-zero chapter is never gated by this check", () => {
  assert.equal(isValidChapterZeroRef("tn", 1, 1, "1:1"), true);
  assert.equal(isValidChapterZeroRef("tq", 1, 1, "anything"), true);
  assert.equal(isValidChapterZeroRef("twl", 1, 1, "anything"), true);
});

console.log(`${passed} passed`);
