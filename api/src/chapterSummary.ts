// Book summary rows as GET /api/chapters/:book returns them. The client builds
// the chapter picker, prev/next buttons, and the rail from this list, so a
// chapter absent here is unreachable in the UI.
export interface ChapterSummaryRow {
  chapter: number;
  verses: number;
  tn: number;
  tq: number;
  twl: number;
}

// Chapter 0 (the book intro, `front:intro`) has no ULT verses, so it appeared
// in the summary only while a live tn/tq/twl row existed for it. Trashing the
// lone intro note — the very card the Restore button lives on — dropped
// chapter 0 from the list, so the trashed card could not be reached to restore
// it before the nightly finalize made the delete permanent (ZEC and DAN,
// 2026-09-09). Always offer chapter 0 for an imported book: the chapter view
// renders an empty intro with the notes Add button, and shows any trashed
// intro card with its Restore button.
export function withChapterZero(rows: ChapterSummaryRow[]): ChapterSummaryRow[] {
  if (rows.length === 0 || rows.some((r) => r.chapter === 0)) return rows;
  return [{ chapter: 0, verses: 0, tn: 0, tq: 0, twl: 0 }, ...rows];
}
