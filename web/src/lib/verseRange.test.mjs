// Smoke test for verseRange.ts helpers. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/verseRange.test.mjs

import {
  verseSpan,
  isRangeRow,
  formatVerseLabel,
  buildVerseIndex,
  isFirstOfRange,
  rangeSize,
  concatSourceRange,
} from "./verseRange.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function mkVerse(verse, verseEnd, voCount = 1) {
  return {
    book: "ISA",
    chapter: 7,
    verse,
    verse_end: verseEnd,
    bible_version: "UST",
    plain_text: `verse ${verse}`,
    version: 1,
    updated_by: null,
    updated_at: 0,
    content: {
      verseObjects: Array.from({ length: voCount }, (_, i) => ({
        type: "text",
        text: `v${verse}.${i} `,
      })),
    },
  };
}

// --- verseSpan / isRangeRow / rangeSize / isFirstOfRange ---
{
  const single = mkVerse(7, null);
  const range = mkVerse(6, 9);
  assert(verseSpan(single)[0] === 7 && verseSpan(single)[1] === 7, "singleton span is [n,n]");
  assert(verseSpan(range)[0] === 6 && verseSpan(range)[1] === 9, "range span is [6,9]");
  assert(!isRangeRow(single), "singleton is not a range row");
  assert(isRangeRow(range), "6-9 is a range row");
  assert(rangeSize(single) === 1, "singleton size is 1");
  assert(rangeSize(range) === 4, "6-9 size is 4");
  assert(isFirstOfRange(range, 6), "v=6 is first of 6-9");
  assert(!isFirstOfRange(range, 7), "v=7 is not first of 6-9");
}

// --- formatVerseLabel ---
{
  assert(formatVerseLabel(mkVerse(7, null)) === "7", "singleton label is '7'");
  assert(formatVerseLabel(mkVerse(6, 9)) === "6-9", "range label is '6-9'");
  // verse_end equal to verse (defensive) → treat as singleton
  assert(formatVerseLabel(mkVerse(7, 7)) === "7", "verse_end === verse → singleton label");
}

// --- buildVerseIndex ---
{
  const byStart = {
    1: mkVerse(1, null),
    6: mkVerse(6, 9),
    10: mkVerse(10, null),
  };
  const idx = buildVerseIndex(byStart);
  assert(idx[1]?.verse === 1, "singleton 1 indexed at key 1");
  assert(idx[6]?.verse === 6, "range start indexed at 6");
  assert(idx[7] === idx[6], "verse 7 inside 6-9 resolves to same DTO reference");
  assert(idx[8] === idx[6], "verse 8 inside 6-9 resolves to same DTO reference");
  assert(idx[9] === idx[6], "verse 9 inside 6-9 resolves to same DTO reference");
  assert(idx[10]?.verse === 10, "singleton 10 indexed at key 10");
  assert(idx[11] === undefined, "verse 11 not present");
}

// --- concatSourceRange ---
{
  // Singleton range → returns input unchanged
  const single = mkVerse(7, null);
  const out = concatSourceRange({ 7: single }, 7, 7);
  assert(out === single, "single-verse range returns the input row");
}
{
  // Multi-verse range → concatenates verseObjects with separators
  const byStart = {
    6: mkVerse(6, null, 2),
    7: mkVerse(7, null, 1),
    8: mkVerse(8, null, 1),
    9: mkVerse(9, null, 1),
  };
  const combined = concatSourceRange(byStart, 6, 9);
  assert(combined !== null, "combined range produces a DTO");
  assert(combined.verse === 6 && combined.verse_end === 9, "synthetic DTO carries span 6-9");
  const vos = combined.content.verseObjects;
  // 2 from v6 + 1 sep + 1 from v7 + 1 sep + 1 from v8 + 1 sep + 1 from v9 = 8
  assert(vos.length === 8, `combined has 8 verseObjects (got ${vos.length})`);
  assert(vos[0].text === "v6.0 ", "first vo is from v6");
  assert(vos[vos.length - 1].text === "v9.0 ", "last vo is from v9");
}
{
  // Missing rows in the range → skip silently
  const byStart = {
    6: mkVerse(6, null, 1),
    9: mkVerse(9, null, 1),
  };
  const combined = concatSourceRange(byStart, 6, 9);
  assert(combined !== null, "partial range still produces a DTO");
  const vos = combined.content.verseObjects;
  // 1 from v6 + 1 sep + 1 from v9 = 3
  assert(vos.length === 3, `partial combined has 3 verseObjects (got ${vos.length})`);
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll verseRange smoke checks passed.");
