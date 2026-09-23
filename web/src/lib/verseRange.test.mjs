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
  noteCoveredVerses,
  coveredVersesKey,
  versesFromKey,
  noteOverlapsRange,
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
{
  // Memoized (#889): the same map + range returns the same object, so the
  // aligner's parseAlignment memo isn't busted by a props rebuild.
  const byStart = { 6: mkVerse(6, null), 7: mkVerse(7, null), 8: mkVerse(8, null) };
  const a = concatSourceRange(byStart, 6, 8);
  assert(concatSourceRange(byStart, 6, 8) === a, "repeat call on same map returns cached object");
  const b = concatSourceRange(byStart, 6, 7);
  assert(b !== a && b.verse_end === 7, "different range on same map is its own entry");
  // Same content in a fresh map (a refetch) → rebuilt, equal content.
  const copy = { ...byStart };
  const c = concatSourceRange(copy, 6, 8);
  assert(c !== a && JSON.stringify(c) === JSON.stringify(a), "new map identity rebuilds with equal content");
  // A row replaced IN PLACE under the same map must not serve the stale concat.
  byStart[7] = { ...mkVerse(7, null), content: { verseObjects: [{ type: "text", text: "NEW " }] } };
  const d = concatSourceRange(byStart, 6, 8);
  assert(d !== a, "in-place row replacement invalidates the cached entry");
  assert(d.content.verseObjects.some((o) => o.text === "NEW "), "rebuilt concat carries the replaced row");
  // A row added in place (previously missing) also invalidates.
  const sparse = { 6: mkVerse(6, null), 8: mkVerse(8, null) };
  const e = concatSourceRange(sparse, 6, 8);
  sparse[7] = mkVerse(7, null);
  const f = concatSourceRange(sparse, 6, 8);
  assert(f !== e && f.content.verseObjects.length === 5, "in-place row insertion invalidates the cached entry");
}

// --- noteCoveredVerses (tn/tq references, parsed from ref_raw) ---
{
  const cv = (verse, ref_raw) => JSON.stringify(noteCoveredVerses({ verse, ref_raw }));
  assert(cv(2, "1:2") === "[2]", "singleton ref → [2]");
  assert(cv(2, "1:2-3") === "[2,3]", "bridge 1:2-3 → [2,3]");
  assert(cv(2, "1:2-5") === "[2,3,4,5]", "bridge 1:2-5 expands → [2,3,4,5]");
  // Leading verse is authoritative for the start even if ref_raw drifts.
  assert(cv(2, "2-4") === "[2,3,4]", "colon-less range → [2,3,4]");
  // Comma-separated (discontinuous) references union each segment.
  assert(cv(2, "1:2,4") === "[2,4]", "comma list 1:2,4 → [2,4]");
  assert(cv(2, "1:2-3,5") === "[2,3,5]", "range+comma 1:2-3,5 → [2,3,5]");
  // Cross-chapter segment not supported → skipped, leading verse remains.
  assert(cv(2, "1:2-2:3") === "[2]", "cross-chapter end → leading only");
  // Descending / malformed range → leading verse only.
  assert(cv(3, "1:3-2") === "[3]", "descending range → leading only");
  assert(cv(5, null) === "[5]", "null ref → [5]");
  assert(cv(0, "1:intro") === "[0]", "intro ref → [0]");
  // Malformed huge range from free-text input is bounded (no runaway loop).
  assert(noteCoveredVerses({ verse: 1, ref_raw: "1:1-1000000000" }).length <= 402, "huge range is bounded");
}

// --- coveredVersesKey / versesFromKey ---
{
  const rows = [
    { verse: 5, ref_raw: "1:5" },
    { verse: 2, ref_raw: "1:2-3" },
    { verse: 5, ref_raw: "1:5" },
    { verse: 0, ref_raw: "1:intro" },
  ];
  assert(coveredVersesKey(rows) === "0,2,3,5", "key is sorted, unique, bridges expanded");
  // Row order / note text don't matter — only which verses are covered.
  assert(coveredVersesKey([...rows].reverse()) === coveredVersesKey(rows), "key ignores row order");
  assert(coveredVersesKey([]) === "", "no rows → empty key");
  assert(JSON.stringify([...versesFromKey("0,2,3,5")]) === "[0,2,3,5]", "versesFromKey round-trips");
  assert(versesFromKey("").size === 0, "empty key → empty set (not {0})");
}

// --- noteOverlapsRange ---
{
  const bridge = { verse: 2, ref_raw: "1:2-3" };
  assert(noteOverlapsRange(bridge, 2, 2), "bridge 2-3 shows on verse 2");
  assert(noteOverlapsRange(bridge, 3, 3), "bridge 2-3 shows on verse 3");
  assert(!noteOverlapsRange(bridge, 4, 4), "bridge 2-3 hidden on verse 4");
  assert(!noteOverlapsRange(bridge, 1, 1), "bridge 2-3 hidden on verse 1");
  // Discontinuous ref shows on its listed verses but not the gap between them.
  const gap = { verse: 2, ref_raw: "1:2,4" };
  assert(noteOverlapsRange(gap, 4, 4), "gap ref 2,4 shows on verse 4");
  assert(!noteOverlapsRange(gap, 3, 3), "gap ref 2,4 hidden on verse 3");
  const single = { verse: 5, ref_raw: "1:5" };
  assert(noteOverlapsRange(single, 5, 5), "singleton shows on its verse");
  assert(!noteOverlapsRange(single, 6, 6), "singleton hidden elsewhere");
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll verseRange smoke checks passed.");
