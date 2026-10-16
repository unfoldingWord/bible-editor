// Parse a user-typed chapter reference like "PSA 130", "PSA 130-135",
// "130", or "130-135" into a normalized scope. Used by the AI pipeline
// dialog so translators can extend a single-chapter run to a contiguous
// range (the client then fans out N single-chapter requests).
//
// - Book defaults to `currentBook` when omitted.
// - Book is normalized to uppercase.
// - Single-chapter input ("PSA 130") → endChapter equals startChapter.
// - Cross-book ranges ("GEN 50-EXO 2") are out of scope.

export interface ChapterRange {
  book: string;
  startChapter: number;
  endChapter: number;
}

export type ParseResult =
  | { ok: true; range: ChapterRange }
  | { ok: false; error: string };

const PATTERN = /^([A-Za-z0-9]{3})?\s*(\d+)(?:\s*-\s*(\d+))?$/;

export function parseChapterRange(input: string, currentBook: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "enter a chapter (e.g. 130 or 130-135)" };
  const m = PATTERN.exec(trimmed);
  if (!m) return { ok: false, error: "format: CH or CH-CH (e.g. 130-135)" };
  const book = (m[1] ?? currentBook).toUpperCase();
  const startChapter = Number.parseInt(m[2], 10);
  const endChapter = m[3] !== undefined ? Number.parseInt(m[3], 10) : startChapter;
  if (!Number.isFinite(startChapter) || startChapter < 1) {
    return { ok: false, error: "chapter must be a positive number" };
  }
  if (!Number.isFinite(endChapter) || endChapter < startChapter) {
    return { ok: false, error: "end chapter must be ≥ start chapter" };
  }
  return { ok: true, range: { book, startChapter, endChapter } };
}

// The AI-pipeline dialog's reference box (issue #1160). Same as
// parseChapterRange, plus a verse range inside ONE chapter ("36:10-15",
// "JER 36:10-15", "36:12") when `allowVerses` is set — the notes pipeline
// only. The bot applies a verse filter to every chapter in its range, so a
// verse range must stay in one chapter; it also caps verses at 200.
export interface PipelineRange extends ChapterRange {
  verseStart?: number;
  verseEnd?: number;
}

export type PipelineParseResult =
  | { ok: true; range: PipelineRange }
  | { ok: false; error: string };

const VERSE_PATTERN = /^([A-Za-z0-9]{3})?\s*(\d+)\s*:\s*(\d+)(?:\s*-\s*(\d+))?$/;
const MAX_VERSE = 200;

export function parsePipelineRange(
  input: string,
  currentBook: string,
  allowVerses: boolean,
): PipelineParseResult {
  const trimmed = input.trim();
  if (!trimmed.includes(":")) return parseChapterRange(trimmed, currentBook);
  if (!allowVerses) return { ok: false, error: "verse ranges work only for translation notes" };
  const m = VERSE_PATTERN.exec(trimmed);
  if (!m) return { ok: false, error: "format: CH:V-V in one chapter (e.g. 36:10-15)" };
  const book = (m[1] ?? currentBook).toUpperCase();
  const chapter = Number.parseInt(m[2], 10);
  const verseStart = Number.parseInt(m[3], 10);
  const verseEnd = m[4] !== undefined ? Number.parseInt(m[4], 10) : verseStart;
  if (chapter < 1) return { ok: false, error: "chapter must be a positive number" };
  if (verseStart < 1 || verseEnd > MAX_VERSE) {
    return { ok: false, error: `verses must be between 1 and ${MAX_VERSE}` };
  }
  if (verseEnd < verseStart) return { ok: false, error: "end verse must be ≥ start verse" };
  return { ok: true, range: { book, startChapter: chapter, endChapter: chapter, verseStart, verseEnd } };
}
