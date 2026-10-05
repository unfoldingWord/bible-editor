// Merge a chapter lint response (GET /api/books/:book/lint?chapter=N) into the
// cached whole-book report (#888). The result equals a fresh whole-book lint,
// pinned by api/src/bookLintReport.test.mjs, given that only chapter N changed
// since `base` was fetched.
//
// A chapter response carries chapter N's chapter-local issues plus EVERY
// book-wide issue (chapter === null: curly-quote and paired-punctuation
// checks, which follow quoted speech across chapters). So the merge drops the
// base's chapter-N issues and all of its book-wide ones, adds the response's,
// and restores the server's order with a stable sort on (section, chapter):
// the server emits issues in that order, and every (section, chapter) run
// comes whole from one side.
//
// Returns null when the inputs can't be merged faithfully (no whole-book base,
// a different book, a report from a server without these fields, or two
// reports of different lint-schema versions, as when a deploy lands between
// the base fetch and this one, #1135); the caller then fetches the whole book
// instead.
//
// Pure, with type-only imports, so a node test can load it directly.

import type { BookLintIssue, BookLintReport } from "../sync/api";

export function mergeChapterReport(base: BookLintReport, chunk: BookLintReport): BookLintReport | null {
  const n = chunk.chapter;
  if (typeof n !== "number" || base.chapter !== null || base.book !== chunk.book) return null;
  if (!base.escalateByChapter || !chunk.escalateByChapter) return null;
  if (base.lintVersion === undefined || base.lintVersion !== chunk.lintVersion) return null;

  const order = (i: BookLintIssue): number => i.chapter ?? -1;
  const issues = [
    ...base.issues.filter((i) => i.chapter !== null && i.chapter !== n),
    ...chunk.issues,
  ].sort((a, b) => a.section - b.section || order(a) - order(b));

  // The chunk's escalate counts cover chapter N (and -1, if a book-wide
  // escalate check ever exists); every other chapter keeps the base's count.
  const escalateByChapter: Record<number, number> = {};
  for (const [k, v] of Object.entries(base.escalateByChapter)) {
    if (Number(k) !== n && Number(k) !== -1) escalateByChapter[Number(k)] = v;
  }
  for (const [k, v] of Object.entries(chunk.escalateByChapter)) escalateByChapter[Number(k)] = v;
  const escalateCount = Object.values(escalateByChapter).reduce((sum, v) => sum + v, 0);

  return {
    book: base.book,
    lintVersion: base.lintVersion,
    chapter: null,
    total: issues.length + escalateCount,
    flagCount: issues.length,
    escalateCount,
    escalateByChapter,
    issues,
  };
}
