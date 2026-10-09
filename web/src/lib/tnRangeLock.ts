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
