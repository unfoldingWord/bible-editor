// Pulled out of useBookLint.ts so its merge logic can be unit-tested without
// pulling React into the test (see mergeChapterReport.test.mjs) — the same
// reason chapterFetchSequencer.ts is a standalone module.

import type { BookLintIssue, BookLintReport } from "../sync/api";

// Merge a `?chapter=N` response (issue #888) into a cached full-book report,
// replacing that chapter's issues in place. A row-derived issue's `ref` is
// not reliably "<chapter>:<verse>" (e.g. a tn "6. Reference" issue reports
// the row's raw, possibly malformed ref_raw verbatim, and "front:intro" has
// no numeric chapter at all — see the route's own comment in bookImport.ts),
// so chapter membership for tn/tq/twl issues is decided from
// `chapterRowIds` (every row id the server read for that chapter, issue or
// not) rather than by parsing `ref`. A verse-derived (ult/ust) issue's `ref`
// IS always "<chapter>:<verse>", built from the row's own numeric
// chapter/verse, so parsing it is safe and exact for those.
export function mergeChapterReport(prev: BookLintReport, chapterReport: BookLintReport): BookLintReport {
  const chapter = chapterReport.chapter;
  const rowIds = chapterReport.chapterRowIds ?? { tn: [], tq: [], twl: [] };
  const inChapter = (issue: BookLintIssue): boolean => {
    if (issue.resource === "ult" || issue.resource === "ust") {
      return Number(issue.ref.slice(0, issue.ref.indexOf(":"))) === chapter;
    }
    const ids = rowIds[issue.resource as "tn" | "tq" | "twl"];
    return issue.rowId !== undefined && (ids?.includes(issue.rowId) ?? false);
  };
  const issues = [...prev.issues.filter((i) => !inChapter(i)), ...chapterReport.issues];
  return {
    book: prev.book,
    total: issues.length,
    flagCount: issues.filter((i) => i.bucket === "flag").length,
    escalateCount: issues.filter((i) => i.bucket === "escalate").length,
    issues,
  };
}
