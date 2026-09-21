// Single source of truth for RTL/LTR direction of scripture/quote CONTENT
// (not app-chrome localization — see #843's out-of-scope note). Before this
// module, direction was derived independently 7 different ways across the
// codebase: `bibleVersion === "UHB"` (BookView), a loop-variable equivalent
// (ScriptureColumn), `!!versesByVersion["UHB"]` (ScriptureColumn), `sourceLabel
// === "UHB"` (UhbStrip), an OT book-code set (sourceSearch's isHebrewBook),
// a Unicode range sniff duplicated verbatim in NoteCard.tsx and
// WordsTable.tsx, and a hardcoded `rtl: true` in rowHistoryFields.ts that
// disagreed with NoteCard's own sniff of the same field. This module gives
// each of those three underlying questions ("what bible_version is this",
// "what book is this", "what script is this string") exactly one answer.

export type Direction = "rtl" | "ltr";

// UHB is the only right-to-left bible_version in this app; every other
// version code (ULT, UST, UGNT, ...) reads left-to-right. Replaces every
// `bibleVersion === "UHB"` / `v === "UHB"` / `sourceLabel === "UHB"` check.
export function directionForVersion(bibleVersion: string | null | undefined): Direction {
  return bibleVersion === "UHB" ? "rtl" : "ltr";
}

// 39 OT book codes — anything else (NT, front/back matter, an unrecognized
// code) reads left-to-right. This is the canonical list; sourceSearch.ts's
// isHebrewBook delegates to isOtBookCode rather than keeping its own copy.
const OT_BOOKS = new Set([
  "GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT", "1SA", "2SA",
  "1KI", "2KI", "1CH", "2CH", "EZR", "NEH", "EST", "JOB", "PSA", "PRO",
  "ECC", "SNG", "ISA", "JER", "LAM", "EZK", "DAN", "HOS", "JOL", "AMO",
  "OBA", "JON", "MIC", "NAM", "HAB", "ZEP", "HAG", "ZEC", "MAL",
]);

export function isOtBookCode(bookCode: string | null | undefined): boolean {
  if (!bookCode) return false;
  return OT_BOOKS.has(bookCode.toUpperCase());
}

// A pure direction API defaults an unrecognized book to LTR: failing an
// unknown code toward the rest of the (LTR) app chrome is the smaller
// mistake. This is a DELIBERATE change from isHebrewBook's own default of
// `true` ("OT") — that default exists for a different contract (a bare-digit
// Strong's query has to guess H vs G *somehow*, and ZEC is the seeded dev
// fixture) and is preserved unchanged in sourceSearch.ts.
export function directionForBook(bookCode: string | null | undefined): Direction {
  return isOtBookCode(bookCode) ? "rtl" : "ltr";
}

// Detects the primary script actually typed into a string — for content
// whose direction depends on what's there rather than which version/book
// it belongs to (a TN/TWL quote can hold Hebrew, Greek, or a translator's
// English gloss). Was duplicated verbatim as `detectQuoteScript` in
// NoteCard.tsx and WordsTable.tsx; both now import this instead.
//
// "empty" (blank, digits-only, punctuation-only — no directional signal) is
// its own outcome rather than folded into "ltr": callers that need a plain
// two-way split (e.g. `dir` / `textAlign`) intentionally treat non-"ltr" as
// rtl, since these fields' natural resting state (before anyone types) is a
// Hebrew/Greek source quote — but callers deciding whether to show a
// "translate this" affordance must NOT treat empty text as English.
export type TextScript = "empty" | Direction;

const RTL_CHAR = /[֐-׿]/;
const LTR_CHAR = /[a-zA-ZͰ-Ͽἀ-῿]/;

export function directionForText(text: string | null | undefined): TextScript {
  const s = text ?? "";
  if (!s.trim()) return "empty";
  if (RTL_CHAR.test(s)) return "rtl";
  if (LTR_CHAR.test(s)) return "ltr";
  return "empty";
}
