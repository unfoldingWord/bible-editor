import type { VerseRow } from "./types";

export interface VerseContentJsonContext {
  book: string;
  chapter: number;
  verse: number;
  verseEnd: number | null;
  bibleVersion: string;
  version: number;
}

type VerseContentJsonRow = Pick<
  VerseRow,
  "book" | "chapter" | "verse" | "verse_end" | "bible_version" | "version" | "content_json"
>;

export class CorruptContentJsonError extends Error {
  readonly context: VerseContentJsonContext;
  readonly causeValue: unknown;

  constructor(context: VerseContentJsonContext, causeValue: unknown) {
    super(
      `corrupt_content_json: ${context.book} ${context.chapter}:${context.verse} ${context.bibleVersion} v${context.version}`,
    );
    this.name = "CorruptContentJsonError";
    this.context = context;
    this.causeValue = causeValue;
  }
}

function verseContentJsonContext(row: VerseContentJsonRow): VerseContentJsonContext {
  return {
    book: row.book,
    chapter: row.chapter,
    verse: row.verse,
    verseEnd: row.verse_end,
    bibleVersion: row.bible_version,
    version: row.version,
  };
}

export function parseVerseContentJson(row: VerseContentJsonRow): unknown {
  try {
    return JSON.parse(row.content_json);
  } catch (err) {
    throw new CorruptContentJsonError(verseContentJsonContext(row), err);
  }
}

// Whether a verse PATCH carrying this verseObjects tree must be refused for
// being empty. An empty tree is legitimate for verse 0 ONLY. Verse 0 is the
// chapter-front pseudo-verse (see extractVersesForRange in importParsers.ts) —
// a container for chapter-front material such as an `\s1` section heading or a
// Psalm `\d` title. When that heading is the row's only node, deleting it
// through the section-header band leaves nothing behind, so the row must be
// allowed to become empty; buildUsfm keys verse 0 as usfm-js "front", so an
// empty front emits nothing at all (no stray `\v 0` — see export.test.mjs).
// Refusing it is what made a chapter-leading heading undeletable: the PATCH
// 400'd, the outbox files 4xx as fatal, and the heading stayed in D1 (#366).
//
// For a real verse (>= 1) an empty tree would blank the verse text with no way
// to type it back, so that stays refused. The verse number is why this cannot
// live in the zod PatchSchema: zod never sees the route param. It lives here
// rather than in verses.ts because verses.ts is not importable by the
// strip-types test runner (extensionless `./auth` import).
export function refusesEmptyVerseObjects(verse: number, verseObjects: unknown[]): boolean {
  return verseObjects.length === 0 && verse !== 0;
}

export function corruptContentJsonBody(error: CorruptContentJsonError) {
  return {
    error: "corrupt_content_json" as const,
    ...error.context,
  };
}

export function logCorruptContentJson(error: CorruptContentJsonError): void {
  const cause =
    error.causeValue instanceof Error
      ? `${error.causeValue.name}: ${error.causeValue.message}`
      : String(error.causeValue);
  console.error("corrupt_content_json", { ...error.context, cause });
}
