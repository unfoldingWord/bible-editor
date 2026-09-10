// Coverage for withChapterZero (chapterSummary.ts). Run from api/:
//   node --experimental-strip-types --no-warnings src/chapterSummary.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors reimportChapterZero.test.mjs.
import assert from "node:assert/strict";
import { withChapterZero } from "./chapterSummary.ts";

const row = (chapter, tn = 1) => ({ chapter, verses: chapter ? 5 : 0, tn, tq: 0, twl: 0 });

// Intro trashed/deleted: chapter 0 is synthesized so it stays navigable.
assert.deepEqual(withChapterZero([row(1), row(2)]), [row(0, 0), row(1), row(2)]);

// Intro live: the real chapter-0 row is kept, not duplicated.
assert.deepEqual(withChapterZero([row(0), row(1)]), [row(0), row(1)]);

// Book not imported: nothing to offer, no phantom intro.
assert.deepEqual(withChapterZero([]), []);

console.log("chapterSummary.test.mjs: 3 passed");
