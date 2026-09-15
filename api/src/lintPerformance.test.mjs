import assert from "node:assert/strict";
import {
  lintTranslationRows, lintAlignmentOccurrences, lintUsfmVerses,
  lintChapterOpeningMarkers, lintOrphanedBlankText, lintVerseTextQuality,
  lintPairedPunctuation,
} from "./lint.ts";

const row = (chapter, verse, text) => ({
  book: "EZK", chapter, verse, verse_end: null, bible_version: "ULT", version: 1,
  content_json: JSON.stringify({ verseObjects: [{ type: "text", text }] }),
});
const rows = [row(1, 1, "“He  said (hello"), row(1, 2, "world).”"), row(2, 1, "End!?")];
const source = new Map();
function separate(values) {
  return {
    alignment: lintAlignmentOccurrences(values, source),
    usfm: lintUsfmVerses(values, source),
    orphaned: lintOrphanedBlankText(values),
    quality: lintVerseTextQuality(values),
    opening: lintChapterOpeningMarkers(values),
    punctuation: lintPairedPunctuation(values),
  };
}
assert.deepEqual(lintTranslationRows(rows, source), separate(rows));
source.set("1:1", [{ text: "word", sep: " " }]);
source.set("1:2", [{ text: "other", sep: " " }]);
const bridge = { ...row(1, 1, ""), verse_end: 2, content_json: JSON.stringify({ verseObjects: [
  { type: "milestone", tag: "zaln", content: "word", occurrence: 4, occurrences: 7,
    children: [{ type: "word", tag: "w", text: "Bad" }] },
  { type: "paragraph", tag: "b" }, { type: "text", text: "orphan  text" },
  { tag: "f", endTag: "", content: "footnote" },
] }) };
const bridgeReport = lintTranslationRows([bridge, ...rows.slice(2)], source);
assert.deepEqual(bridgeReport, separate([bridge, ...rows.slice(2)]));
assert.ok(bridgeReport.alignment.length > 0);
assert.ok(bridgeReport.usfm.length > 0);
assert.ok(bridgeReport.orphaned.length > 0);
source.clear();
rows[1].content_json = JSON.stringify({ verseObjects: [{ type: "text", text: "Changed ”" }] });
assert.deepEqual(lintTranslationRows(rows, source), separate(rows), "same-version content mutation invalidates parsing");
rows[1].content_json = "{";
assert.deepEqual(lintTranslationRows(rows, source), separate(rows), "corrupt JSON retains existing tolerant behavior");
rows[1].content_json = row(1, 2, "Repaired.").content_json;
assert.deepEqual(lintTranslationRows(rows, source), separate(rows), "failure is not cached after repair");

// Quantify redundant parsing with representative aligned-sized verse payloads.
const large = Array.from({ length: 1200 }, (_, i) => ({
  ...row(1 + Math.floor(i / 25), 1 + i % 25, "Good text."),
  content_json: JSON.stringify({ verseObjects: Array.from({ length: 35 }, () => ({
    type: "milestone", tag: "zaln", content: "word", occurrence: 1, occurrences: 1,
    children: [{ type: "word", tag: "w", text: "word" }, { type: "text", text: " " }],
  })) }),
}));
const parse = JSON.parse;
let count = 0;
JSON.parse = (...args) => { count++; return parse(...args); };
try {
  const start = performance.now();
  const expected = separate(large);
  const beforeMs = performance.now() - start;
  const before = count;
  count = 0;
  const optimizedStart = performance.now();
  const actual = lintTranslationRows(large, source);
  const afterMs = performance.now() - optimizedStart;
  assert.deepEqual(actual, expected);
  assert.ok(count < before * 0.7, `${count} parses vs ${before}`);
  console.log(`lint equivalence + invalidation passed; parses ${before} -> ${count}; CPU ${beforeMs.toFixed(0)} -> ${afterMs.toFixed(0)} ms (synthetic 1200 verses)`);
} finally {
  JSON.parse = parse;
}
