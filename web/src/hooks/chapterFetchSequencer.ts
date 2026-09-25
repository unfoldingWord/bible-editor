// Request sequencing for useChapter's chapter GETs. Framework-free so the
// strip-types runner can drive every ordering case with hand-resolved
// promises (chapterFetchSequencer.test.mjs); the hook owns React state and
// hands this module a loader plus callbacks.
//
// Rules, in the order refetch() applies them:
//
// 1. A merging refetch (`merge`, Shell's WS `onOpen`) that arrives while a
//    PLAIN request is in flight and nothing has landed since the last reset
//    (the mount GET of a freshly opened chapter) is DEFERRED, not started:
//    the mount GET is left to land and render, and the merging GET is issued
//    right after it. Aborting the mount GET instead (the old behavior) made
//    the loading screen last socket-open time plus a full GET (#902). The
//    invariant from sync/wsOpen.ts still holds — the verse map is reconciled
//    by a merging refetch issued after the room subscription (the deferred
//    one is issued later still) — and steps (WS bridged / split / updated)
//    that arrive from the deferral onward are queued for replay, over the
//    mount payload and again over the merge.
// 2. Otherwise a new request aborts the in-flight one: only the LATEST
//    request's result is ever committed, so a slower earlier response cannot
//    overwrite a newer one.
// 3. `reset()` (chapter change, unmount) aborts the in-flight request and
//    drops the replay queue and any deferred merge, so nothing from the old
//    chapter can land afterwards.
//
// Replay queue: reducer steps (WS bridged / split / updated, outbox results)
// that reach the tab while a merging refetch is pending (in flight or
// deferred); non-null exactly then. `mergeRefetched` can only judge verses
// the GET's snapshot contains, so a split that recreated a verse AFTER the
// snapshot but BEFORE the response landed would be silently discarded (the
// response has no row for it); replaying the queue over the merged map puts
// it back. One queue, owned by the latest request: a merging
// refetch that supersedes another inherits it (steps the first collected are
// either newer than the second GET's rows and kept by the merge anyway, or
// stale echoes that are no-ops on replay — every step is version-gated, see
// lib/verseStructure.ts). A plain refetch or a reset drops it; the resolving
// or failing latest request clears it.

export type ChapterLoader<P> = (signal: AbortSignal, onAttempt: (attempts: number) => void) => Promise<P>;

export interface ChapterFetchCallbacks<P, S> {
  /** A request started (status → loading). */
  onStart(): void;
  /** The latest request failed an attempt and is retrying. */
  onAttempt(attempts: number): void;
  /**
   * The latest request's payload landed. `merge`: merge it into what the tab
   * holds rather than replace. `queued`: steps to replay over the result
   * (empty for a plain refetch with no merge pending).
   */
  onLanded(payload: P, merge: boolean, queued: S[]): void;
  /** The latest request failed for good (never called for an abort). */
  onError(err: unknown): void;
}

interface InFlight<P> {
  ctrl: AbortController;
  merge: boolean;
  load: ChapterLoader<P>;
}

export interface ChapterFetchSequencer<P, S> {
  /**
   * Fetch the chapter with `load` (`merge`: a keepNewerLocal refetch).
   * Resolves when this request has settled; a deferred merge resolves when
   * the merge issued after the mount GET settles.
   */
  refetch(load: ChapterLoader<P>, merge: boolean): Promise<void>;
  /** Record a step for replay while a merging refetch is pending. */
  record(step: S): void;
  /** Chapter change or unmount: abort and forget everything in flight. */
  reset(): void;
}

export function createChapterFetchSequencer<P, S>(cb: ChapterFetchCallbacks<P, S>): ChapterFetchSequencer<P, S> {
  let current: InFlight<P> | null = null;
  // True once any request has landed since the last reset — i.e. the tab is
  // rendering this chapter's data, so there is no first paint to protect.
  let loaded = false;
  let queue: S[] | null = null;
  let deferred: { promise: Promise<void>; resolve: () => void } | null = null;

  function settleDeferred() {
    const d = deferred;
    deferred = null;
    d?.resolve();
  }

  async function start(load: ChapterLoader<P>, merge: boolean): Promise<void> {
    current?.ctrl.abort();
    const ctrl = new AbortController();
    const self: InFlight<P> = { ctrl, merge, load };
    current = self;
    queue = merge ? (queue ?? []) : null;
    // A plain request issued now postdates any open that deferred a merge,
    // so its snapshot already satisfies that merge.
    if (!merge) settleDeferred();
    const isLatest = () => current === self && !ctrl.signal.aborted;

    cb.onStart();
    let payload: P;
    try {
      payload = await load(ctrl.signal, (attempts) => {
        if (isLatest()) cb.onAttempt(attempts);
      });
    } catch (e) {
      // A superseded request leaves the queue to its successor; only the
      // latest request's failure drops it.
      if (current !== self) return;
      current = null;
      queue = null;
      // Data is still absent after a failed mount GET, so any later
      // successful load (the Retry button) postdates the subscription too.
      settleDeferred();
      if (ctrl.signal.aborted) return;
      cb.onError(e);
      return;
    }
    if (!isLatest()) return;
    current = null;
    loaded = true;
    const pending = deferred;
    deferred = null;
    // Take the queue synchronously: a step that arrives after this point is
    // applied by its own state update, ordered after this one.
    const queued = queue ?? [];
    // With a merge deferred, the queue stays alive for it.
    if (!pending) queue = null;
    cb.onLanded(payload, merge, pending ? [...queued] : queued);
    // Not awaited: this request's caller is done once its payload landed;
    // the deferring caller's promise settles when the merge does.
    if (pending) void start(load, true).then(pending.resolve);
  }

  return {
    refetch(load: ChapterLoader<P>, merge: boolean): Promise<void> {
      if (merge && current && !current.merge && !loaded) {
        if (!deferred) {
          let resolve!: () => void;
          const promise = new Promise<void>((r) => { resolve = r; });
          deferred = { promise, resolve };
          queue = queue ?? [];
        }
        return deferred.promise;
      }
      return start(load, merge);
    },
    record(step: S): void {
      queue?.push(step);
    },
    reset(): void {
      current?.ctrl.abort();
      current = null;
      loaded = false;
      queue = null;
      settleDeferred();
    },
  };
}
