// #1075: the dual aligner keys each side's reading line and alignment panel by
// the ROW it edits (start verse + bridge end, #1067 / #1074). When another
// editor bridges or splits that row, the slot moves onto a different row and
// both remount, dropping whatever was unsaved on the old one. That drop is
// right (the edit was made against a row that no longer exists), but it must
// not be silent. This decides when to say so, and what.

// Where one side of the dual aligner stood at a render.
export interface DualSideRow {
  chapter: number;
  // The verse the popup is open on (moves only by in-dialog navigation).
  verseNum: number;
  // alignmentPanelRowKey of the side's row.
  rowKey: string;
  // The old row's label as the translator saw it ("7", "6-7"), or null when
  // the side had no row.
  label: string | null;
}

// The notice for a side that moved from `prev` to `cur`, or null for none.
// Only a row change under the same open verse counts: a verse navigation
// also changes the row, but it goes through the unsaved-changes gate first.
export function droppedEditNotice(
  book: string,
  bibleVersion: string,
  prev: DualSideRow | undefined,
  cur: DualSideRow,
  dirty: { reading: boolean; panel: boolean },
): string | null {
  if (!prev || prev.label === null) return null;
  if (prev.chapter !== cur.chapter || prev.verseNum !== cur.verseNum) return null;
  if (prev.rowKey === cur.rowKey) return null;
  if (!dirty.reading && !dirty.panel) return null;
  const what =
    dirty.reading && dirty.panel
      ? "reading text and alignment changes there were"
      : dirty.reading
        ? "reading text there was"
        : "alignment changes there were";
  return `Another editor joined or split ${book} ${prev.chapter}:${prev.label} ${bibleVersion}, so your unsaved ${what} dropped. Make the change again on the verse as it is now.`;
}
