// Export round-trip regression for verse bridges — the half verseBridge.test.mjs
// (pure math + SQL) can't cover, because it hinges on usfm-js's rendering:
//
//   1. A bridged row (verse_end set) emits `\v a-b <combined text>`.
//   2. A split seeds its emptied verses with splitSeedVerseObjects(); that
//      minimal tree must export as a clean bare `\v N` with no stray artifact
//      (the one thing that could only be confirmed by actually running the
//      exporter). If usfm-js ever changes how it treats the seed node, this
//      catches it before a split ships a malformed verse to Door43.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/verseBridgeExport.test.mjs

import { buildUsfm } from "./export.ts";
import { splitSeedVerseObjects } from "./verseBridge.ts";

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  passed++;
}
function eq(a, b, msg) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

function row(verse, verseEnd, verseObjects) {
  return {
    book: "ZEC",
    chapter: 5,
    verse,
    verse_end: verseEnd,
    bible_version: "UST",
    content_json: JSON.stringify({ verseObjects }),
    plain_text: null,
    version: 1,
    updated_at: 0,
    updated_by: 1,
  };
}

const usfm = buildUsfm({
  book: "ZEC",
  bibleVersion: "UST",
  verses: [
    row(1, 2, [{ type: "text", text: "Combined verse one and two." }]),
    row(3, null, splitSeedVerseObjects()), // an emptied split verse
    row(4, null, [{ type: "text", text: "Normal verse four." }]),
  ],
});

assert(/\\v 1-2 Combined verse one and two\./.test(usfm), "bridge emits `\\v 1-2 <text>`");
// A bare `\v 3` line with no body after it (next line is `\v 4`).
assert(/\\v 3\s*\n\\v 4 /.test(usfm), "split-seed verse emits a clean bare `\\v 3` with no artifact");
assert(/\\v 4 Normal verse four\./.test(usfm), "following singleton unaffected");
// The seed's raw "\n" text must NOT leak as visible content on the verse line.
assert(!/\\v 3 \S/.test(usfm), "no stray text on the emptied verse line");

//   3. Overlapping ranges — a `(verse=1, verse_end=2)` row beside a `(verse=2)`
//      row — must REFUSE to render. Before issue #727 buildUsfm built the
//      usfm-js keys "1-2" and "2" in the same chapter object and usfm-js
//      emitted both, shipping `\v 1-2` + `\v 2` to Door43 as if valid.
let overlapErr = null;
try {
  buildUsfm({
    book: "ZEC",
    bibleVersion: "UST",
    verses: [
      row(1, 2, [{ type: "text", text: "Bridged one and two." }]),
      row(2, null, [{ type: "text", text: "Stray standalone two." }]),
      row(3, null, [{ type: "text", text: "Verse three." }]),
    ],
  });
} catch (e) {
  overlapErr = e;
}
assert(overlapErr != null, "overlapping verse ranges in one chapter throw instead of rendering");
assert(overlapErr?.name === "VerseRangeOverlapError", `typed error, got ${overlapErr?.name}: ${overlapErr?.message}`);
assert(/ZEC/.test(overlapErr.message) && /\bUST\b/.test(overlapErr.message), "error names the book and resource");
assert(/\b5\b/.test(overlapErr.message), "error names the chapter");
assert(/1-2/.test(overlapErr.message) && /\b2\b/.test(overlapErr.message), "error names both offending ranges");
eq(overlapErr.book, "ZEC", "error carries book");
eq(overlapErr.chapter, 5, "error carries chapter");
eq(overlapErr.overlaps.length, 1, "exactly one overlapping pair reported");

console.log(`ok — ${passed} assertions passed`);
