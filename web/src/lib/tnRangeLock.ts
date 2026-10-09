// Which notes an AI run has locked in one chapter (issue #1165).
//
// A whole-chapter notes run locks every note in the chapter. A verse-range
// notes run (#1160) locks only notes whose ANCHOR verse (the row's `verse`) is
// inside its range, because the range import never reads or writes a note
// anchored outside it. The server decides the range per job and sends it as
// `locks_tn_verse_range` (api/src/chapterLock.ts tnLockVerseRange); this file
// only applies it, so the cards the UI greys out match what the API refuses.
// A job without the field (an optimistic row before the first list refresh,
// or an older server) locks the whole chapter: fail closed.

export interface TnLockJob {
  book: string;
  start_chapter: number;
  end_chapter: number;
  state: string;
  locks_resources?: readonly string[];
  locks_tn_verse_range?: { start: number; end: number } | null;
}

const LOCKING_STATES = new Set(["running", "paused_for_outage", "paused_for_usage_limit", "dispatching"]);

/** The tn-locking jobs covering this chapter, in list order. */
export function tnLockingJobs<T extends TnLockJob>(jobs: readonly T[], book: string, chapter: number): T[] {
  return jobs.filter(
    (j) =>
      j.book === book &&
      j.start_chapter <= chapter &&
      j.end_chapter >= chapter &&
      LOCKING_STATES.has(j.state) &&
      (j.locks_resources?.includes("tn") ?? false),
  );
}

/** Is a note anchored at `verse` locked by any of these (already filtered) jobs? */
export function isTnVerseLocked(lockingJobs: readonly TnLockJob[], verse: number): boolean {
  return lockingJobs.some((j) => {
    const r = j.locks_tn_verse_range;
    return !r || (verse >= r.start && verse <= r.end);
  });
}

/**
 * Is moving a note TO anchor `verse` refused by a verse-range run? Mirrors the
 * server's rangeLockCoveringVerse (api/src/chapterLock.ts): only a job with a
 * range blocks a move, because a whole-chapter run never refused one (a note
 * kept with Preserve can still be moved during it).
 */
export function isTnMoveBlocked(lockingJobs: readonly TnLockJob[], verse: number): boolean {
  return lockingJobs.some((j) => {
    const r = j.locks_tn_verse_range;
    return !!r && verse >= r.start && verse <= r.end;
  });
}

/**
 * The note "change reference" picker's verses, minus the ones a move would be
 * refused at. Returns the same array when nothing is removed, so a memoized
 * card does not re-render for nothing.
 */
export function movableNoteVerses(
  verseOptions: number[],
  moveBlocked: (verse: number) => boolean,
): number[] {
  const kept = verseOptions.filter((v) => !moveBlocked(v));
  return kept.length === verseOptions.length ? verseOptions : kept;
}

/**
 * How the lock banner names the notes these locking jobs cover: the union, so
 * it matches isTnVerseLocked. Any whole-chapter job means all notes.
 */
export function tnLockLabel(lockingJobs: readonly TnLockJob[]): string {
  if (lockingJobs.length === 0 || lockingJobs.some((j) => !j.locks_tn_verse_range)) return "notes";
  const ranges = lockingJobs
    .map((j) => j.locks_tn_verse_range as { start: number; end: number })
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  const parts = merged.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`));
  const single = merged.length === 1 && merged[0].start === merged[0].end;
  return `notes in ${single ? "verse" : "verses"} ${parts.join(", ")}`;
}

export interface TnPosition {
  verse: number;
  ref_raw: string | null;
  sort_order: number | null;
}

/**
 * A note move the server refused (409 chapter_locked) was already applied to
 * the chapter cache, so the card sits at the refused verse. Put back the
 * server's position (verse, ref_raw, sort_order only: the note's text and any
 * draft are left alone). Null when the op was not a move, the row is gone, or
 * the cache no longer shows the refused move (a later move or refetch won).
 */
export function planRefusedTnMoveRollback<R extends TnPosition>(args: {
  patch: Record<string, unknown>;
  serverRow: R | undefined;
  cachedRow: R | undefined;
}): Pick<R, "verse" | "ref_raw" | "sort_order"> | null {
  const { patch, serverRow, cachedRow } = args;
  if (typeof patch.verse !== "number" || !serverRow || !cachedRow) return null;
  if (cachedRow.verse !== patch.verse) return null;
  if (patch.ref_raw !== undefined && cachedRow.ref_raw !== patch.ref_raw) return null;
  if (serverRow.verse === cachedRow.verse && serverRow.ref_raw === cachedRow.ref_raw) return null;
  return { verse: serverRow.verse, ref_raw: serverRow.ref_raw, sort_order: serverRow.sort_order };
}
