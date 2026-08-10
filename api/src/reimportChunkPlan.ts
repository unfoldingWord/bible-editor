// Pure chunk-boundary planner for runChunkedReimport (bookReimport.ts). Split
// into its own zero-dependency module — like reimportClassify.ts /
// reimportSyncGate.ts — specifically so it can be unit-tested directly under
// plain node (bookReimport.ts's own extensionless imports don't resolve
// outside the Workers bundler, so nothing there can be `import`ed by a
// `--experimental-strip-types` test; see reimportChapterZero.test.mjs).

// Chapters per Workflow step in the chunked reimport. Sized so even the largest
// book (Psalms, 150 ch) stays well under Cloudflare's 600 000 ms per-step limit
// that the old whole-book reimport blew on Isaiah. In steady state the
// per-resource SHA gate skips unchanged files entirely, so this rarely bites.
export const REIMPORT_CHAPTER_CHUNK = 8;

// Chunk boundaries for runChunkedReimport's per-chapter-range Workflow steps,
// 1-based over [1, maxChapter] — EXCEPT the first chunk's start is widened to
// 0 so it also picks up chapter 0 (refParts("front:intro") in
// importParsers.ts: a book-level intro TN/TQ/TWL row, not a sentinel).
// Chapter 0 rides along ADDITIVELY on chunk 1 rather than shifting every
// chunk's boundary down by one chapter — that would change the total chunk
// count for a normal book (e.g. maxChapter=8 would go from 1 chunk to 2), and
// REIMPORT_CHAPTER_CHUNK's sizing exists specifically to bound each step's
// subrequests under Cloudflare's ~1000-subrequest cap, so chunks 2+ must keep
// exactly the same chapter count they always had. A book's front:intro rows
// are a handful of rows, not a full chapter's worth, so chunk 1 carrying one
// extra chapter is negligible against that budget.
//
// Without this, chapter 0 could never enter this loop at all: it flowed one
// way only (D1 → master, via the nightly export, which has no chapter
// filter), so a hand-edit made directly on master's front:intro was reverted
// by the very next night's export, forever. A DCS maintainer hit exactly
// this — measured survival of his front:intro edits was 0 of 2.
export function reimportChunkBoundaries(
  maxChapter: number,
  chunkSize: number = REIMPORT_CHAPTER_CHUNK,
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (let start = 1; start <= maxChapter; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, maxChapter);
    out.push({ start: start === 1 ? 0 : start, end });
  }
  return out;
}
