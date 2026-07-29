// Unit tests for the chapter-intro helpers (verseIntro.ts).
// Run: node --experimental-strip-types --no-warnings src/lib/verseIntro.test.mjs
//
// chapterOpensWithoutMarker is the CLIENT-SIDE TWIN of lintChapterOpeningMarkers
// in api/src/lint.ts — these cases mirror the ones in api/src/lint.test.mjs so a
// divergence between the two shows up as a failing test on one side.

import assert from "node:assert/strict";
import { chapterOpensWithoutMarker, introEditBase } from "./verseIntro.ts";

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const text = (s) => ({ type: "text", text: s });
const q1 = { type: "quote", tag: "q1" };
const p = { type: "paragraph", tag: "p" };
const word = { type: "word", tag: "w", text: "word" };

t("front matter ending in \\q1 opens the chapter", () => {
  assert.equal(chapterOpensWithoutMarker([q1], [word]), false);
});
t("front matter ending in \\p opens the chapter", () => {
  assert.equal(chapterOpensWithoutMarker([p], [word]), false);
});
t("no front matter at all → opens bare", () => {
  assert.equal(chapterOpensWithoutMarker(null, [word]), true);
  assert.equal(chapterOpensWithoutMarker(undefined, [word]), true);
});
t("front matter with no opening marker → opens bare", () => {
  // \d Psalm superscription is chapter-front content but not a paragraph marker.
  assert.equal(chapterOpensWithoutMarker([{ type: "section", tag: "d", text: "A psalm." }], [word]), true);
});
t("marker leading verse 1 itself counts", () => {
  assert.equal(chapterOpensWithoutMarker([], [p, word]), false);
});
t("mid-verse \\q1 in verse 1 does NOT count (poetry trap)", () => {
  // The api-side twin regressed on exactly this: a whole-array scan passes every
  // poetic chapter, because poetry verses carry their own line breaks.
  assert.equal(chapterOpensWithoutMarker(null, [word, q1, text("more")]), true);
});
t("marker before a trailing \\d does NOT count (position matters)", () => {
  assert.equal(chapterOpensWithoutMarker([q1, { type: "section", tag: "d", text: "t" }], [word]), true);
});
t("whitespace does not hide the marker at either edge", () => {
  assert.equal(chapterOpensWithoutMarker([q1, text("\n")], [word]), false);
  assert.equal(chapterOpensWithoutMarker([], [text("  "), p, word]), false);
});
t("a \\ts\\* after the marker does not hide it (all three shapes)", () => {
  for (const ts of [{ tag: "ts\\*" }, { tag: "ts*" }, { tag: "ts", content: "\\*" }]) {
    assert.equal(chapterOpensWithoutMarker([q1, ts], [word]), false, JSON.stringify(ts));
  }
});
t("\\ts\\* alone is not an opening marker", () => {
  assert.equal(chapterOpensWithoutMarker([{ tag: "ts\\*" }], [word]), true);
});
t("\\b alone is not an opening marker (blank line, not a paragraph)", () => {
  assert.equal(chapterOpensWithoutMarker([{ type: "paragraph", tag: "b" }], [word]), true);
});
t("no verse 1 → nothing to judge", () => {
  assert.equal(chapterOpensWithoutMarker([q1], null), false);
  assert.equal(chapterOpensWithoutMarker(null, undefined), false);
});

t("introEditBase returns the real dto untouched when one exists", () => {
  const dto = { book: "MIC", chapter: 5, verse: 0, version: 3 };
  assert.equal(introEditBase(dto, "MIC", 5, 0, "ULT"), dto);
});
t("introEditBase synthesizes a version-0 base for a missing intro row", () => {
  const b = introEditBase(undefined, "MIC", 5, 0, "ULT");
  assert.ok(b);
  // version 0 is the API's "I expect no row here" create assertion.
  assert.equal(b.version, 0);
  assert.equal(b.verse, 0);
  assert.equal(b.bible_version, "ULT");
  assert.deepEqual(b.content, { verseObjects: [] });
});
t("introEditBase refuses real verses and source texts", () => {
  assert.equal(introEditBase(undefined, "MIC", 5, 1, "ULT"), undefined);
  assert.equal(introEditBase(undefined, "MIC", 5, 0, "UHB"), undefined);
  assert.equal(introEditBase(undefined, "MIC", 5, 0, "UGNT"), undefined);
  assert.equal(introEditBase(undefined, undefined, 5, 0, "ULT"), undefined);
});

console.log(`\n${passed} verseIntro tests passed`);
