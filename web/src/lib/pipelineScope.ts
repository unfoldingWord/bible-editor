// A pipeline job's scope as the AI menu and status list show it (issue #1166).
//
// verse_range comes from the server (api/src/pipelines.ts publicVerseRange):
// null = whole chapter, { start, end } = a verse-range notes run, "invalid" =
// a stored range the server could not read. An invalid one is labelled as
// unknown and never matches anything, so it is never shown or treated as the
// whole chapter.

export type JobVerseRange = { start: number; end: number } | "invalid" | null;

export interface ScopedJob {
  book: string;
  start_chapter: number;
  end_chapter: number;
  /** Absent on rows from an older server or a pre-list optimistic seed: read as whole chapter. */
  verse_range?: JobVerseRange;
}

/** "ZEC 1", "ZEC 1–3", "ZEC 1:3-5", "ZEC 1:4", or "ZEC 1 (verses unknown)". */
export function jobScopeLabel(job: ScopedJob): string {
  const chapters =
    job.start_chapter === job.end_chapter
      ? `${job.start_chapter}`
      : `${job.start_chapter}–${job.end_chapter}`;
  const vr = job.verse_range;
  if (vr === "invalid") return `${job.book} ${chapters} (verses unknown)`;
  if (vr) {
    return `${job.book} ${job.start_chapter}:${vr.start}${vr.end !== vr.start ? `-${vr.end}` : ""}`;
  }
  return `${job.book} ${chapters}`;
}

/**
 * True when `job` is the same run the user is asking for: same book, same
 * chapter span, and the same verse range (both whole chapter, or the same
 * start and end). Mirrors the server's /start duplicate check
 * (findSameScopeJob in api/src/pipelines.ts), which queues anything else.
 */
export function sameNotesScope(
  job: ScopedJob,
  request: {
    book: string;
    startChapter: number;
    endChapter: number;
    verseRange: { start: number; end: number } | null;
  },
): boolean {
  if (job.book !== request.book) return false;
  if (job.start_chapter !== request.startChapter || job.end_chapter !== request.endChapter) {
    return false;
  }
  const vr = job.verse_range ?? null;
  if (vr === "invalid") return false;
  if (vr === null || request.verseRange === null) return vr === request.verseRange;
  return vr.start === request.verseRange.start && vr.end === request.verseRange.end;
}
