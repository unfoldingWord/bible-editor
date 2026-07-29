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
import { isInFlowMarker, isTsMilestone, PARAGRAPH_TAGS } from "./usfm.ts";

// Tags that count as opening a chapter. PARAGRAPH_TAGS minus `b`: a `\b` is a
// blank line, not a paragraph opener. `\ts\*` is excluded by isInFlowMarker's
// companion check below — a chunk divider is not a line-layout marker either.
const OPENING_TAGS: ReadonlySet<string> = new Set(
  [...PARAGRAPH_TAGS].filter((t) => t !== "b"),
);

function isOpeningMarker(node: unknown): boolean {
  if (!isInFlowMarker(node) || isTsMilestone(node)) return false;
  const tag = (node as Record<string, unknown>)["tag"];
  return typeof tag === "string" && OPENING_TAGS.has(tag);
}

// Transparent to the edge scans: whitespace-only text (including the editor's
// U+200B placeholder) and `\ts\*` dividers. Mirrors trailingMarkerRunStart.
function isTransparent(node: unknown): boolean {
  const t = (node as Record<string, unknown> | null)?.["text"];
  if (typeof t === "string" && /^[\s​]*$/.test(t)) return true;
  return isTsMilestone(node);
}

// True when nothing introduces verse 1 — i.e. the chapter opens bare.
//
// CLIENT-SIDE TWIN of lintChapterOpeningMarkers in api/src/lint.ts; keep the two
// in sync. The server owns the authoritative flag, but the chapter rail needs the
// same answer locally to decide whether to offer an intro slot at all: when NO
// version has a verse-0 row and no note sits on the intro, there is otherwise no
// intro tile, and the server's flag would point at something the user cannot open.
//
// Position matters, exactly as it does server-side: the marker must TRAIL the
// front matter or LEAD verse 1. A mid-verse `\q1` (every poetry verse has them)
// must not count, or this silently answers "fine" for every poetic chapter.
export function chapterOpensWithoutMarker(
  frontVerseObjects: unknown[] | null | undefined,
  firstVerseObjects: unknown[] | null | undefined,
): boolean {
  if (!Array.isArray(firstVerseObjects)) return false; // no verse 1 → nothing to judge
  if (Array.isArray(frontVerseObjects)) {
    for (let i = frontVerseObjects.length - 1; i >= 0; i--) {
      if (isOpeningMarker(frontVerseObjects[i])) return false;
      if (isTransparent(frontVerseObjects[i])) continue;
      break;
    }
  }
  for (const node of firstVerseObjects) {
    if (isOpeningMarker(node)) return false;
    if (isTransparent(node)) continue;
    break;
  }
  return true;
}

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
