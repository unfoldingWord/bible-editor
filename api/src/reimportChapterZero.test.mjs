// Coverage for the chapter-0 ("front:intro") one-way-sync fix's chunk-boundary
// planner. Run from api/:
//   node --experimental-strip-types --no-warnings src/reimportChapterZero.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors reimportClassify.test.mjs
// / reimportSyncGate.test.mjs.
//
// Bug: refParts("front:intro") (importParsers.ts) parses a book-level intro
// TN/TQ/TWL row to chapter 0. The nightly export has no chapter filter, so
// D1's chapter-0 rows always flow OUT to master — but every incremental
// master→D1 reimport path filtered `chapter < 1`, so a chapter-0 row could
// never flow back IN. A hand-edit made directly on a book's front:intro note
// on master was therefore reverted by the very next night's export, forever
// (measured: a DCS maintainer's front:intro edits survived 0 of 2 nights).
//
// reimportChunkBoundaries (bookReimport.ts's chunk-loop planner, moved into
// reimportChunkPlan.ts specifically so it's importable here — see that file's
// header comment) now routes chapter 0 into the first chunk WITHOUT shifting
// any other chunk's boundary or adding an extra chunk for a normal book —
// that was the delicate part of the fix. This file pins exactly that.
//
// NOT covered here: changedTsvChapters (the diff gate in bookReimport.ts that
// decides whether a chapter-0 row counts as "changed") and
// softDeleteRemovedTsvRows (the delete-side prune). Both were hand-verified
// by reading (chapter is computed via refParts, which never returns negative,
// so widening `< 1` to `< 0` / `>= 1` to `>= 0` is a pure widening with no
// other behavior change) but could not be unit-tested directly: bookReimport.ts
// itself uses several extensionless imports (e.g. `from "./dcsSources"`) that
// only resolve inside the Workers/wrangler bundler, not under plain
// `node --experimental-strip-types` — confirmed by attempting the import here
// and getting ERR_MODULE_NOT_FOUND. That's a pre-existing property of the
// file (no other test in this suite imports bookReimport.ts either), not
// something introduced by this fix. Building a bundler-equivalent harness
// just for this was out of scope; the chunk-loop coverage below plus the full
// `npm --workspace api run test` pass (no regressions) is the verification
// this change relies on instead.

import { reimportChunkBoundaries, REIMPORT_CHAPTER_CHUNK } from "./reimportChunkPlan.ts";

let failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${msg}\n    expected ${e}\n    got      ${a}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

console.log("\n[reimportChunkBoundaries — chapter 0 rides the first chunk additively]");

// A book whose ONLY changed chapter is 0 must still get a chunk to process —
// chapter 0 is reachable even for the smallest book.
eq(reimportChunkBoundaries(1, 8), [{ start: 0, end: 1 }], "maxChapter=1 → one chunk, includes chapter 0");

// THE delicate case: maxChapter exactly fills chunk 1 under the old 1-based
// scheme (chapters 1..8). Chapter 0 must NOT push chapter 8 into a second
// chunk — that would add an extra chunk for every book whose chapter count
// is a multiple of REIMPORT_CHAPTER_CHUNK.
eq(
  reimportChunkBoundaries(8, 8),
  [{ start: 0, end: 8 }],
  "maxChapter=8 → still ONE chunk (no off-by-one), chapter 0 absorbed additively",
);

eq(
  reimportChunkBoundaries(9, 8),
  [
    { start: 0, end: 8 },
    { start: 9, end: 9 },
  ],
  "maxChapter=9 → two chunks (same count as without chapter 0), chapter 8 stays in chunk 1",
);

eq(
  reimportChunkBoundaries(50, 8),
  [
    { start: 0, end: 8 },
    { start: 9, end: 16 },
    { start: 17, end: 24 },
    { start: 25, end: 32 },
    { start: 33, end: 40 },
    { start: 41, end: 48 },
    { start: 49, end: 50 },
  ],
  "maxChapter=50 → seven chunks (same count as without chapter 0); only chunk 1 gains chapter 0",
);

// No double-processing: every chapter (0 included) must be covered by exactly
// one boundary across the whole plan.
{
  const boundaries = reimportChunkBoundaries(50, 8);
  const seen = new Set();
  let dupes = 0;
  for (const { start, end } of boundaries) {
    for (let ch = start; ch <= end; ch++) {
      if (seen.has(ch)) dupes++;
      seen.add(ch);
    }
  }
  eq(dupes, 0, "no chapter (including 0) is double-covered across chunks");
  eq(seen.has(0), true, "chapter 0 is covered somewhere in the plan");
  eq(seen.size, 51, "chapters 0..50 are each covered exactly once (51 chapters total)");
}

eq(REIMPORT_CHAPTER_CHUNK, 8, "chunk size constant unchanged by this fix");

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll reimportChapterZero assertions passed.");
