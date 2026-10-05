// The report behind GET /api/books/:book/lint, kept Hono-free so a node test
// can drive it (see bookLintReport.test.mjs).
//
// Two shapes (#888):
//   chapter = null — the whole book. Fetched on book load and on focus refresh.
//   chapter = N    — chapter N's chapter-local issues PLUS every book-wide
//                    issue (BOOK_WIDE_CHECKS). Fetched after a save; the client
//                    merges it into the cached whole-book report
//                    (web/src/hooks/mergeChapterReport.ts), and the result
//                    equals a fresh whole-book lint.
//
// Only "flag" issues travel: the one consumer (useBookLint) shows flag issues
// and only counts "escalate" ones. Every escalate check (footnote syntax, glued
// alignment) is per-verse, so escalate counts go per chapter
// (`escalateByChapter`) and merge the same way.
//
// What a chapter request still reads for the whole book: the ULT and UST
// verses, because the curly-quote and paired-punctuation checks follow quoted
// speech across chapter breaks (see quoteIssues / lintPairedPunctuation in
// lint.ts). tn/tq/twl rows and the source text are read for chapter N only.
// Either way it is ONE db.batch: one read snapshot, a fixed six statements.

import {
  BOOK_WIDE_CHECKS,
  lintTnQuotes,
  lintTnRows,
  lintTqRows,
  lintTranslationRows,
  lintTwlRows,
  sourceWordsByRef,
  type LintIssue,
} from "./lint.ts";
import type { TnRow, TqRow, TwlRow, VerseRow } from "./types";

export type LintResource = "tn" | "tq" | "twl" | "ult" | "ust";

export interface BookLintReportIssue extends LintIssue {
  resource: LintResource;
  /** The chapter of the row the issue came from, or null for a BOOK_WIDE_CHECKS
   *  issue (recomputed on every request, so a merge replaces all of them). Not
   *  parsed from `ref`: a tn issue's ref can be a malformed ref_raw. */
  chapter: number | null;
  /** Index of the check group in the report. Issues are emitted in
   *  (section, chapter ?? -1) order, which lets a merge restore the exact
   *  whole-book order with a stable sort. */
  section: number;
}

/** The report's schema version (#1135). Bump it whenever a change would make a
 *  report from the old code merge wrongly with one from the new: a check moved
 *  into or out of BOOK_WIDE_CHECKS, the section list reordered, or the chapter
 *  tagging changed. The client merges a chapter report into its cached
 *  whole-book report only when both carry the same version, so a deploy that
 *  lands between the two fetches costs one whole-book fetch, not a wrong chip. */
export const LINT_REPORT_VERSION = 1;

export interface BookLintReport {
  book: string;
  /** LINT_REPORT_VERSION of the server that built the report. */
  lintVersion: number;
  /** null = whole book; N = chapter N's local issues plus all book-wide ones. */
  chapter: number | null;
  /** flagCount + escalateCount, for this response's scope. */
  total: number;
  flagCount: number;
  escalateCount: number;
  /** Escalate counts by chapter; chapters with none are omitted. */
  escalateByChapter: Record<number, number>;
  /** Flag-bucket issues only. */
  issues: BookLintReportIssue[];
}

/** The `chapter` query param: null when absent, the chapter when valid,
 *  undefined when malformed (the route answers 400). Chapter 0 holds
 *  front:intro rows, so it is valid. */
export function parseLintChapter(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return null;
  if (!/^\d{1,3}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n <= 150 ? n : undefined;
}

export async function buildBookLintReport(
  db: D1Database,
  book: string,
  srcVersion: "UHB" | "UGNT",
  chapter: number | null,
): Promise<BookLintReport> {
  // Chapter scope for everything except ULT/UST (see the header).
  const inChapter = chapter === null ? "" : " AND chapter = ?2";
  const bindRows = (sql: string) => {
    const stmt = db.prepare(sql);
    return chapter === null ? stmt.bind(book) : stmt.bind(book, chapter);
  };
  const results = await db.batch([
    bindRows(
      `SELECT * FROM tn_rows WHERE book = ?1${inChapter} AND deleted_at IS NULL AND trashed_at IS NULL
       ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
    ),
    // tq/twl have no trashed_at column (only tn does), so filter deleted_at only.
    bindRows(
      `SELECT * FROM tq_rows WHERE book = ?1${inChapter} AND deleted_at IS NULL
       ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
    ),
    bindRows(
      `SELECT * FROM twl_rows WHERE book = ?1${inChapter} AND deleted_at IS NULL
       ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
    ),
    db.prepare(`SELECT * FROM verses WHERE book = ?1 AND bible_version = 'ULT' ORDER BY chapter, verse`).bind(book),
    db.prepare(`SELECT * FROM verses WHERE book = ?1 AND bible_version = 'UST' ORDER BY chapter, verse`).bind(book),
    // Source verses (UHB for OT, UGNT for NT) back the quote-resolution and
    // alignment-occurrence checks. Both SKIP a verse that isn't present here, so
    // a missing source verse degrades to "not checked", never a false flag.
    chapter === null
      ? db.prepare(`SELECT * FROM verses WHERE book = ?1 AND bible_version = ?2 ORDER BY chapter, verse`)
        .bind(book, srcVersion)
      : db.prepare(`SELECT * FROM verses WHERE book = ?1 AND bible_version = ?2 AND chapter = ?3 ORDER BY chapter, verse`)
        .bind(book, srcVersion, chapter),
  ]);
  const [tn, tq, twl, ult, ust, src] = results as [
    D1Result<TnRow>, D1Result<TqRow>, D1Result<TwlRow>,
    D1Result<VerseRow>, D1Result<VerseRow>, D1Result<VerseRow>,
  ];
  const tnRows = tn.results ?? [];
  const tqRows = tq.results ?? [];
  const twlRows = twl.results ?? [];

  // Parse the source ONCE. Passing the raw rows to all three lints made each
  // re-walk every verse's content_json.
  const srcWords = sourceWordsByRef(src.results ?? []);
  const scope = chapter ?? undefined;
  const ultLint = lintTranslationRows(ult.results ?? [], srcWords, scope);
  const ustLint = lintTranslationRows(ust.results ?? [], srcWords, scope);

  // Row-derived issues take their row's chapter; verse-derived ones carry a
  // `${chapter}:${verse}` ref built from the verse row.
  const rowChapter = (rows: Array<{ id: string; chapter: number }>) => {
    const byId = new Map(rows.map((r) => [r.id, r.chapter]));
    return (i: LintIssue) => (i.rowId !== undefined ? byId.get(i.rowId) : undefined) ?? refChapter(i);
  };
  const verseChapter = (i: LintIssue) => (BOOK_WIDE_CHECKS.has(i.check) ? null : refChapter(i));
  const tnChapter = rowChapter(tnRows);
  const tqChapter = rowChapter(tqRows);
  const twlChapter = rowChapter(twlRows);

  // Same group order the route has always emitted.
  const sections: Array<[LintResource, LintIssue[], (i: LintIssue) => number | null]> = [
    ["tn", lintTnRows(tnRows), tnChapter],
    ["tn", lintTnQuotes(tnRows, srcWords), tnChapter],
    ["ult", ultLint.alignment, verseChapter],
    ["ust", ustLint.alignment, verseChapter],
    ["tq", lintTqRows(tqRows), tqChapter],
    ["twl", lintTwlRows(twlRows), twlChapter],
    ["ult", ultLint.usfm, verseChapter],
    ["ust", ustLint.usfm, verseChapter],
    ["ult", ultLint.opening, verseChapter],
    ["ust", ustLint.opening, verseChapter],
    ["ult", ultLint.orphaned, verseChapter],
    ["ust", ustLint.orphaned, verseChapter],
    ["ult", ultLint.quality, verseChapter],
    ["ust", ustLint.quality, verseChapter],
    ["ult", ultLint.punctuation, verseChapter],
    ["ust", ustLint.punctuation, verseChapter],
  ];

  const issues: BookLintReportIssue[] = [];
  const escalateByChapter: Record<number, number> = {};
  let escalateCount = 0;
  sections.forEach(([resource, found, chapterOf], section) => {
    for (const i of found) {
      const ch = chapterOf(i);
      if (i.bucket === "flag") {
        issues.push({ ...i, resource, chapter: ch, section });
      } else {
        escalateCount++;
        // Escalate checks are all per-verse, so ch is a number; -1 would only
        // show up if that ever changed, and still counts toward the total.
        const k = ch ?? -1;
        escalateByChapter[k] = (escalateByChapter[k] ?? 0) + 1;
      }
    }
  });
  return {
    book,
    lintVersion: LINT_REPORT_VERSION,
    chapter,
    total: issues.length + escalateCount,
    flagCount: issues.length,
    escalateCount,
    escalateByChapter,
    issues,
  };
}

function refChapter(i: LintIssue): number | null {
  const n = Number.parseInt(i.ref, 10);
  return Number.isFinite(n) ? n : null;
}
