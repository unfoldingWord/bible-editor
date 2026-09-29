// Which chapter a confirmed outbox save touched (issue #936), so the
// note-link preview can drop its cached server copy of that chapter. Only a
// 200 counts: the preview shows saved text only. Row targets carry no chapter,
// so it comes from the row the server returned.
export interface ChapterRef {
  book: string;
  chapter: number;
}

export function savedChapter(
  op: { target: { kind: string; book: string; chapter?: number } },
  result: { kind: string; updated?: unknown },
): ChapterRef | null {
  if (result.kind !== "ok") return null;
  if (op.target.kind !== "row") {
    return typeof op.target.chapter === "number" ? { book: op.target.book, chapter: op.target.chapter } : null;
  }
  const u = result.updated as { book?: unknown; chapter?: unknown } | null | undefined;
  return u && typeof u.book === "string" && typeof u.chapter === "number" ? { book: u.book, chapter: u.chapter } : null;
}
