// Shared validation for POST /api/rows/:kind (rows.ts) — extracted into its
// own leaf module (no other imports) so a SQL-backed regression test can
// exercise the exact production fragment without pulling in the full Hono
// route's dependency graph. See issue #491.

// D1's book columns are plain case-sensitive TEXT (migrations 0001/0015),
// and the app always sends the uppercase 3-letter code — but `book` on the
// create schema is an unconstrained z.string(), so a lowercase/mixed-case
// caller (a non-Shell client, or a client bug) could mint a row under a
// diverging (book, id) PK namespace: invisible to every read path (which all
// query the uppercase code) and to the nightly export. Normalize the same
// way comments.ts does.
export function normalizeBookCode(book: string): string {
  return book.toUpperCase();
}

// A new tn/tq/twl row must reference a chapter that actually exists in this
// book — without this, a caller posting an out-of-range chapter (e.g.
// `chapter: 999` for a real book) mints a row the nightly export renders
// straight into the TSV as a fabricated `999:1`. Mirrors the verse-0 create
// guard's sibling probe in verses.ts, which closes the same fabrication
// class for verses. Scoped to `verses` (not the row kind's own table) since
// a chapter can be real with zero existing tn/tq/twl rows — e.g. the first
// note ever added to a chapter.
//
// Chapter 0 (the book-level "front:intro" pseudo-chapter — see
// chapterZeroGuard.ts) is a deliberate exception: it is NOT a real chapter
// with verses, so it has no rows of its own to probe for. There, "does this
// BOOK have any chapter at all" is the right proof of a real book —
// isValidChapterZeroRef (chapterZeroGuard.ts) is what rejects anything but
// a kind=tn/verse=0/ref_raw="front:intro" shape at chapter 0.
export const CHAPTER_EXISTS_SQL =
  `SELECT 1 AS ok FROM verses WHERE book = ?1 AND (?2 = 0 OR chapter = ?2) LIMIT 1`;
