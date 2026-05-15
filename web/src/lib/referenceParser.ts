import { resolveBook } from "./bookNames";

// Parse a free-form scripture reference like:
//   "5"           → verse 5 (current book + chapter)
//   "5:5"         → chapter 5 verse 5 (current book)
//   "zec 5:5"     → ZEC 5:5
//   "ps 119"      → PSA 119:1
//   "1 cor 13:4"  → 1CO 13:4
//
// The book token may include a leading digit (1sa, 2ki, 1 cor, etc.).

export interface ParsedReference {
  book: string | null;     // null = keep current book
  chapter: number | null;  // null = keep current chapter
  verse: number;
}

export type ParseRefResult =
  | { ok: true; ref: ParsedReference }
  | { ok: false; error: string };

// Optional book group: one digit then letters (or `i`/`ii`/`iii` ordinals)
// followed by letters, with an optional space inside. Then chapter or
// chapter:verse.
const PATTERN = /^(?:((?:[123]|i{1,3})\s*[a-z]+|[a-z]+)\s+)?(\d+)(?:\s*:\s*(\d+))?$/i;

export function parseReference(input: string): ParseRefResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "empty" };
  const m = PATTERN.exec(trimmed);
  if (!m) return { ok: false, error: "format: 5 | 5:5 | zec 5:5" };
  const bookTok = m[1];
  const n1 = parseInt(m[2], 10);
  const n2 = m[3] !== undefined ? parseInt(m[3], 10) : null;

  let book: string | null = null;
  if (bookTok) {
    book = resolveBook(bookTok);
    if (!book) return { ok: false, error: `unknown book: "${bookTok.trim()}"` };
  }

  if (book) {
    return { ok: true, ref: { book, chapter: n1, verse: n2 ?? 1 } };
  }
  if (n2 !== null) {
    return { ok: true, ref: { book: null, chapter: n1, verse: n2 } };
  }
  return { ok: true, ref: { book: null, chapter: null, verse: n1 } };
}
