// Parses the "see how you translated this" markdown links that translationNote
// bodies carry — same-book `[2:5](../02/05.md)` and cross-book
// `[Book 2:5](../../bok/02/05.md)` — into a flat list of text/link segments a
// renderer can walk without re-deriving the regex logic. Pure + unit-tested
// (see noteLinks.test.mjs) because this repo has no JSX test harness —
// extraction is how logic like this gets covered at all (mirrors noteGuard.ts).
//
// Issue #715: every "See how you translated ... in [2:5](../02/05.md)" note
// carries one of these, and the bp-bot pipeline is about to emit many more.
// They render as inert markdown today; NoteCard turns matched segments into
// in-app navigation instead.

import { resolveBook } from "./bookNames.ts";

export interface NoteLinkTarget {
  // Uppercase 3-letter USFM book code.
  book: string;
  chapter: number;
  verse: number;
}

export type NoteSegment =
  | { type: "text"; text: string; start: number; end: number }
  | { type: "link"; text: string; start: number; end: number; target: NoteLinkTarget };

// Chapter/verse folder-and-file segments are 2 digits for every book except
// PSA, whose chapter folder runs to 150 and is zero-padded to 3 (e.g.
// "150/006.md") — so both groups accept 2 or 3 digits. The book segment, when
// present, is a lowercase 3-letter USFM code (cross-book links use one extra
// "../" to climb out of the chapter folder first, but the leading "../"s
// themselves aren't load-bearing here, so the count isn't checked). Labels
// exclude "]" and newlines; anything else (rc://, ta links, unmatched book
// codes) is left untouched by falling through to a plain "text" segment.
const NOTE_LINK_RE = /\[([^\]\n]*)\]\((?:\.\.\/)+(?:([a-z]{3})\/)?(\d{2,3})\/(\d{2,3})\.md\)/g;

export function parseNoteSegments(text: string, currentBook: string): NoteSegment[] {
  const segments: NoteSegment[] = [];
  const re = new RegExp(NOTE_LINK_RE.source, NOTE_LINK_RE.flags);
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const [full, label, bookCode, chapterStr, verseStr] = m;
    const start = m.index;
    const end = start + full.length;
    // Cross-book: resolve against the canonical book list so a garbage code
    // (or something that merely looks like one) falls back to plain text
    // rather than becoming a dead link. Same-book: always the row's own book.
    const targetBook = bookCode ? resolveBook(bookCode) : currentBook.toUpperCase();
    if (!targetBook) {
      if (full.length === 0) re.lastIndex++;
      continue;
    }
    const chapter = parseInt(chapterStr, 10);
    const verse = parseInt(verseStr, 10);
    if (chapter < 1 || verse < 1) {
      if (full.length === 0) re.lastIndex++;
      continue;
    }
    if (start > lastIndex) {
      segments.push({ type: "text", text: text.slice(lastIndex, start), start: lastIndex, end: start });
    }
    segments.push({ type: "link", text: label, start, end, target: { book: targetBook, chapter, verse } });
    lastIndex = end;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", text: text.slice(lastIndex), start: lastIndex, end: text.length });
  }
  return segments;
}
