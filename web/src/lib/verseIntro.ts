// Create-on-save base for a chapter-intro row that does not exist yet (#379).
//
// A chapter whose source USFM carried no opening `\p`/`\q1` has no verse-0 row at
// all, so there is nothing to edit and the missing marker cannot be added. See
// lintChapterOpeningMarkers in api/src/lint.ts for why the marker lives there.
//
// `version: 0` is the assertion the API's create path requires ("I expect no row
// here"). It flows through unchanged as the outbox's `If-Match`, so a row that
// appears underneath us comes back a 409 rather than silently overwriting. Note it
// is a PLACEHOLDER version, not a real one — server versions start at 1, and UI
// that keys off a version (e.g. the history chip) must treat 0 as "no row yet".
//
// Lives in lib/ rather than beside one component because two callers need the
// same base and must agree on it: the intro cell in ScriptureColumn (so the save
// button appears at all) and the "unsaved edits" toast in Shell (which resolves a
// base from the chapter cache and would otherwise find nothing, silently stranding
// the draft it is offering to save).

import type { VerseDto } from "../sync/api";

export function introEditBase(
  dto: VerseDto | undefined,
  book: string | undefined,
  chapter: number,
  verse: number,
  bibleVersion: string,
): VerseDto | undefined {
  if (dto) return dto;
  // Intro only, and only for the editable translations. A synthetic base for a
  // real verse would let the UI invent scripture the source doesn't have, and the
  // API refuses it anyway.
  if (verse !== 0 || !book) return undefined;
  if (bibleVersion !== "ULT" && bibleVersion !== "UST") return undefined;
  return {
    book,
    chapter,
    verse: 0,
    verse_end: null,
    bible_version: bibleVersion,
    plain_text: "",
    version: 0,
    updated_by: null,
    updated_at: 0,
    content: { verseObjects: [] },
  };
}
