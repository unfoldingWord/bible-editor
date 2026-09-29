// Tests for mergeChapterReport.ts — the client-side half of issue #888
// (per-chapter lint refresh). Run from web/:
//   node --experimental-strip-types --no-warnings src/hooks/mergeChapterReport.test.mjs
//
// The case this pins down hardest: a tn issue's `ref` is NOT reliably
// "<chapter>:<verse>" (see bookImport.ts's lint route and mergeChapterReport's
// own comment), so a naive merge that parsed `ref` to decide chapter
// membership would either strand a stale row-derived issue in the merged
// report (never replaced) or drop a live one from a different chapter that
// happens to share ref text. `chapterRowIds` is what makes this exact.

import assert from "node:assert/strict";
import { mergeChapterReport } from "./mergeChapterReport.ts";

function report(overrides) {
  return { book: "ZEC", total: 0, flagCount: 0, escalateCount: 0, issues: [], ...overrides };
}

// 1. A verse-derived (ult/ust) issue is replaced by ref-parsed chapter, and
// issues from OTHER chapters are left untouched.
{
  const prev = report({
    issues: [
      { check: "Footnote", bucket: "escalate", ref: "1:1", resource: "ult" },
      { check: "Footnote", bucket: "escalate", ref: "2:1", resource: "ult" },
    ],
  });
  const chapter1 = report({
    chapter: 1,
    chapterRowIds: { tn: [], tq: [], twl: [] },
    issues: [{ check: "Opening punctuation", bucket: "flag", ref: "1:1", resource: "ult" }],
  });
  const merged = mergeChapterReport(prev, chapter1);
  assert.deepEqual(
    merged.issues,
    [
      { check: "Footnote", bucket: "escalate", ref: "2:1", resource: "ult" },
      { check: "Opening punctuation", bucket: "flag", ref: "1:1", resource: "ult" },
    ],
    "chapter 1's old verse-derived issue is replaced; chapter 2's is untouched",
  );
  assert.equal(merged.flagCount, 1);
  assert.equal(merged.escalateCount, 1);
  assert.equal(merged.book, "ZEC", "book carries over from prev, not from the (bookless-by-convention) chapter report");
}
console.log("  ok: verse-derived issues merge by ref-parsed chapter");

// 2. A tn row whose `ref` is NOT "<chapter>:<verse>" (a malformed ref_raw,
// same shape as the "6. Reference" check) is correctly identified as stale
// and dropped via chapterRowIds — NOT left stranded because its ref didn't
// parse to the requested chapter.
{
  const prev = report({
    issues: [
      { check: "6. Reference", bucket: "flag", ref: "not-a-ref", rowId: "tn01", resource: "tn" },
    ],
  });
  // tn01 was fixed (its ref is now valid, no issue); chapter=1's response
  // still lists it in chapterRowIds because the row still exists in chapter 1.
  const chapter1 = report({ chapter: 1, chapterRowIds: { tn: ["tn01"], tq: [], twl: [] }, issues: [] });
  const merged = mergeChapterReport(prev, chapter1);
  assert.deepEqual(merged.issues, [], "the stale malformed-ref issue is dropped even though its ref never named chapter 1");
}
console.log("  ok: row-derived issue chapter membership comes from chapterRowIds, not ref parsing");

// 3. The mirror of #2: a "front:intro" ref (no numeric chapter at all) for a
// row NOT in the requested chapter's chapterRowIds must survive the merge.
{
  const prev = report({
    issues: [{ check: "Empty note", bucket: "flag", ref: "front:intro", rowId: "tn02", resource: "tn" }],
  });
  const chapter1 = report({ chapter: 1, chapterRowIds: { tn: [], tq: [], twl: [] }, issues: [] });
  const merged = mergeChapterReport(prev, chapter1);
  assert.deepEqual(
    merged.issues,
    [{ check: "Empty note", bucket: "flag", ref: "front:intro", rowId: "tn02", resource: "tn" }],
    "a chapter-0/front row not in chapterRowIds for chapter 1 is left alone",
  );
}
console.log("  ok: an unrelated row-derived issue with a non-numeric ref survives an unrelated chapter's merge");

// 4. New issues from the chapter response are appended even when nothing in
// `prev` was stale (the common "fixed one thing, chapter now has one fewer
// issue plus a newly-introduced one" case).
{
  const prev = report({ issues: [{ check: "Empty note", bucket: "flag", ref: "1:2", rowId: "tn02", resource: "tn" }] });
  const chapter1 = report({
    chapter: 1,
    chapterRowIds: { tn: ["tn02"], tq: [], twl: [] },
    issues: [{ check: "13. Paired Square Bracket", bucket: "flag", ref: "1:2", rowId: "tn02", resource: "tn" }],
  });
  const merged = mergeChapterReport(prev, chapter1);
  assert.deepEqual(merged.issues, [
    { check: "13. Paired Square Bracket", bucket: "flag", ref: "1:2", rowId: "tn02", resource: "tn" },
  ]);
}
console.log("  ok: a row's old issue is replaced by its new one, not accumulated alongside it");

// 5. chapterRowIds absent (defensive — should not happen in practice, but
// must not throw) degrades to "no row-derived issue is considered stale".
{
  const prev = report({
    issues: [{ check: "Empty note", bucket: "flag", ref: "1:2", rowId: "tn02", resource: "tn" }],
  });
  const chapter1 = report({ chapter: 1, issues: [] });
  const merged = mergeChapterReport(prev, chapter1);
  assert.deepEqual(merged.issues, [{ check: "Empty note", bucket: "flag", ref: "1:2", rowId: "tn02", resource: "tn" }]);
}
console.log("  ok: a missing chapterRowIds degrades to keeping every cached row-derived issue, never throws");

console.log("mergeChapterReport: all checks passed");
