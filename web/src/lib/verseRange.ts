// Helpers for verses that span multiple Bible verses (USFM `\v 6-9`).
//
// One D1 row covers the whole range: `verse=6, verse_end=9`. PR 1 preserves
// this through import/export. PR 2 makes the UI render the range as one card
// and resolve "verse 7" inside a UST 6-9 block to the canonical row at v=6.
//
// The hook layer (useChapter) exposes both shapes:
//   - versesByVersion: raw, keyed by verse_start (the wire shape)
//   - versesIndexByVersion: pre-expanded — verses 7,8,9 in a 6-9 range all map
//     to the same DTO reference, so lookups by any integer in the range work
//
// All renderers and the AlignmentPanel go through this module rather than
// reading `verses[bv][n]` directly.

import type { VerseDto } from "../sync/api";

export type VerseSpan = readonly [start: number, end: number];

export function verseSpan(dto: VerseDto): VerseSpan {
  const end = dto.verse_end ?? dto.verse;
  return [dto.verse, end];
}

export function isRangeRow(dto: VerseDto): boolean {
  return dto.verse_end != null && dto.verse_end > dto.verse;
}

// "7" for singletons (and verse 0 "front" — caller decides how to render that),
// "6-9" for range rows.
export function formatVerseLabel(dto: VerseDto): string {
  if (isRangeRow(dto)) return `${dto.verse}-${dto.verse_end}`;
  return String(dto.verse);
}

// Expand a per-version map keyed by verse_start into one keyed by every
// integer verse covered. Range rows contribute multiple keys; all keys for
// the same range point at the same DTO reference. Singletons contribute one
// key. Non-overlapping ranges across versions are fine — this only operates
// on a single version's slice.
export function buildVerseIndex(
  byVerseStart: Record<number, VerseDto> | undefined,
): Record<number, VerseDto> {
  if (!byVerseStart) return {};
  const out: Record<number, VerseDto> = {};
  for (const key of Object.keys(byVerseStart)) {
    const dto = byVerseStart[Number(key)];
    if (!dto) continue;
    const [start, end] = verseSpan(dto);
    for (let v = start; v <= end; v++) {
      // First-writer-wins on overlap. PR 1 import doesn't produce overlaps
      // (extractor only emits one row per source key), so this only matters
      // if a future writer inserts an overlapping singleton.
      if (out[v] == null) out[v] = dto;
    }
  }
  return out;
}

// True when this integer verse is the *start* of a range (or a singleton).
// Renderers use this to avoid double-rendering verses 7,8,9 under a UST 6-9
// block: only the cell at v=6 paints the card; subsequent verses skip.
export function isFirstOfRange(dto: VerseDto, v: number): boolean {
  return v === dto.verse;
}

// Size of the range in integer verses. 1 for singletons. 4 for "6-9".
export function rangeSize(dto: VerseDto): number {
  const [start, end] = verseSpan(dto);
  return end - start + 1;
}

// Concatenate per-verse source rows (UHB/UGNT) into a single synthetic DTO
// covering [start, end]. Used by AlignmentPanel when the target is a UST 6-9
// block — the source side joins verses 6,7,8,9 of UHB into one combined
// verseObjects array so the aligner sees a flat token stream.
//
// Punctuation between verses is preserved via a `\v` boundary marker — usfm-js
// emits these naturally but we'd be combining post-parse, so we just splice
// them together verbatim with a separator text node. The aligner doesn't
// care about verse boundaries inside the combined source.
export function concatSourceRange(
  sourceByVerseStart: Record<number, VerseDto> | undefined,
  start: number,
  end: number,
): VerseDto | null {
  if (!sourceByVerseStart) return null;
  const first = sourceByVerseStart[start];
  if (!first) return null;
  if (start === end) return first;

  const combined: unknown[] = [];
  let lastVerseSeen: VerseDto | null = null;
  for (let v = start; v <= end; v++) {
    const row = sourceByVerseStart[v];
    if (!row) continue;
    lastVerseSeen = row;
    const content = row.content as { verseObjects?: unknown[] } | null;
    if (!content || !Array.isArray(content.verseObjects)) continue;
    if (combined.length > 0) {
      // Light separator so consecutive sources don't run together visually.
      combined.push({ type: "text", text: " " });
    }
    combined.push(...content.verseObjects);
  }
  if (combined.length === 0 || !lastVerseSeen) return null;

  // Return a synthetic DTO; never persisted, never PATCHed. Carries the
  // span so the AlignmentPanel title can show "UHB 6-9".
  return {
    ...first,
    verse_end: end,
    plain_text: null,
    content: { verseObjects: combined },
  };
}
