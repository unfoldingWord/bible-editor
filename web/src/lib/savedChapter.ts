// Which chapter a confirmed outbox save touched (issue #936).
// Today's behavior, pinned before the fix: the preview cache ignores saves.
export interface ChapterRef {
  book: string;
  chapter: number;
}

export function savedChapter(
  _op: { target: { kind: string; book: string; chapter?: number } },
  _result: { kind: string; updated?: unknown },
): ChapterRef | null {
  return null;
}
