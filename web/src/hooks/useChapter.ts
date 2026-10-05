// useChapter — pulls the whole chapter payload from the API and provides
// helpers for optimistic local mutations. Listens to outbox results so a
// successful drain refreshes the affected row in place without a full
// re-fetch (cheap and avoids flicker).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  type ChapterPayload,
  type TnRow,
  type TqRow,
  type TwlRow,
  type VerseDto,
  type VerseStatus,
  type VerseLaneCheck,
  type CheckLane,
  type LaneCheckState,
  type TwlOrderLock,
} from "../sync/api";
import { fetchWithRetry } from "../sync/fetchWithRetry";
import { onOutboxDiscard, onOutboxResult, outbox } from "../sync/outbox";
import { hidingPendingRowDeletes, isOwnRowDelete } from "../sync/pendingRowDeletes";
import { createChapterFetchSequencer, type ChapterFetchSequencer } from "./chapterFetchSequencer";
import { currentRouteFetcher, isChapterLocked, trackNavigation, updateIfCurrent, type ChapterRoute, type NavigationGen } from "../lib/chapterStale";
import {
  applyStep,
  applyUpdated,
  keepStepAcrossSupersede,
  mergeRefetched,
  reduceVerses,
  replaySteps,
  type ChapterData,
  type StructureStep,
} from "../lib/verseStructure";

type Status = "idle" | "loading" | "ready" | "error" | "retrying";

export interface RefetchOptions {
  /**
   * Merge the fetched payload with the current one instead of replacing it:
   * a verse the tab holds at an equal-or-newer version, or a tn/tq/twl row at a
   * strictly newer one (rows change without a version bump), stays
   * (see lib/verseStructure.ts `mergeRefetched`). For the WS open refetch (Shell's
   * `onOpen`, every open incl. the first), whose reconnect case races the
   * outbox drain on the same `online` moment — a stale GET must not regress a
   * verse the tab's own PATCH just advanced. Every other
   * caller wants the plain replace (default): they refetch precisely because
   * the server changed rows/versions out from under the tab.
   */
  keepNewerLocal?: boolean;
}

export interface UseChapterReturn {
  status: Status;
  /**
   * The payload on screen. After a chapter change this is still the PREVIOUS
   * chapter's payload until the new one lands (#892): check `stale`.
   */
  data: ChapterPayload | null;
  /**
   * True while `data` belongs to a different (book, chapter) than the one this
   * hook was asked for, or matches it but was not fetched for the current
   * navigation (A → B → A before B lands). It is shown so the view doesn't
   * blank, but it must be locked against new input (#531). Local applies are
   * no-ops while it belongs to another chapter.
   */
  stale: boolean;
  error: string | null;
  /** Incremented every failed attempt during the current retry loop. Useful for showing "reconnecting…". */
  retryAttempts: number;
  refetch: (opts?: RefetchOptions) => Promise<void>;
  applyLocalRowPatch: (kind: "tn" | "tq" | "twl", id: string, patch: Partial<TnRow & TqRow & TwlRow>) => void;
  applyLocalRowReplacement: (kind: "tn" | "tq" | "twl", row: TnRow | TqRow | TwlRow) => void;
  applyLocalRowDelete: (kind: "tn" | "tq" | "twl", id: string) => void;
  applyLocalRowInsert: (
    kind: "tn" | "tq" | "twl",
    row: TnRow | TqRow | TwlRow,
    position?: { afterId?: string },
  ) => void;
  /**
   * Put back a row whose own DELETE the server refused or the user discarded
   * (#1108): forget its queued `rowDelete` replay step so a pending merging
   * refetch cannot hide it again, then re-insert the server's row.
   */
  restoreRow: (
    kind: "tn" | "tq" | "twl",
    row: TnRow | TqRow | TwlRow,
    position?: { afterId?: string },
  ) => void;
  /**
   * This tab's own edit (optimistic, or the outbox's confirmed result for it):
   * applied regardless of version, EXCEPT that it can never resurrect a verse
   * another tab has already bridged away (tombstone — lib/verseStructure.ts).
   */
  applyLocalVerse: (verse: VerseDto) => void;
  /**
   * A verse row from elsewhere (WS `verse.updated`, an outbox result): applied
   * only if strictly newer than the local row and above the verse number's
   * tombstone. Both checks live in the reducer so every caller agrees.
   */
  applyRemoteVerse: (verse: VerseDto) => void;
  /**
   * A verse-bridge was created: replace the start verse with the combined
   * bridge DTO, drop the absorbed verse's map key, and prune the now-orphaned
   * per-verse status / lane-checks for every absorbed verse. Applied after the
   * server confirms (a 409 must not leave a half-formed bridge), and reused by
   * the WS `verse.bridged` handler for other tabs. `removedVersion` (the
   * deleted row's version) becomes the tombstone that lets a reordered
   * `verse.updated` / `verse.split` for that verse be told apart from a real
   * recreation (#729).
   */
  applyLocalVerseBridge: (bridge: VerseDto, removedVerse: number, absorbedVerses: number[], removedVersion?: number) => void;
  /**
   * A verse-bridge was broken: replace the start verse with the de-bridged DTO
   * and add the freshly-seeded singleton rows. Applied after the server
   * confirms; reused by the WS `verse.split` handler.
   */
  applyLocalVerseSplit: (start: VerseDto, newVerses: VerseDto[]) => void;
  /** `updatedAt`: the server's timestamp, when the status came from the server (WS / outbox result). */
  applyLocalVerseStatus: (verse: number, done: boolean, updatedAt?: number) => void;
  /** Optimistically add/remove my own stamp on a (verse, lane). */
  applyLocalLaneCheck: (verse: number, lane: CheckLane, userId: number, checked: boolean) => void;
  /** Authoritative: replace a (verse, lane)'s checker set (server result / WS). */
  applyLaneCheckers: (verse: number, lane: CheckLane, checkers: number[]) => void;
  /** Authoritative: replace every check for one lane in the chapter (bulk result). */
  replaceLaneChecksForLane: (lane: CheckLane, checks: VerseLaneCheck[]) => void;
  /**
   * Set or clear a verse's TWL manual-order lock locally. `null` clears it.
   * Applied after the server call confirms — not optimistically: the lock is
   * what stops automatic ordering from reverting a manual move, so showing it
   * as taken before the server agrees would be a lie the user acts on.
   */
  applyLocalTwlOrderLock: (verse: number, lock: TwlOrderLock | null) => void;
}

export function useChapter(book: string, chapter: number): UseChapterReturn {
  // The route this render is for. Written before the state hooks so every
  // local-apply updater (run while React processes the state queue) compares
  // against the current route, not the one its callback was created under.
  const routeRef = useRef<ChapterRoute>({ book, chapter });
  routeRef.current = { book, chapter };
  // Bumped on every move to a new (book, chapter), including back to one just
  // left. `landedGen` records which navigation the last landed payload was
  // fetched for, so after A → B → A the old A copy stays locked until A's new
  // GET lands (it can carry pre-save versions; see isChapterLocked).
  // Advanced in the fetch effect, not during render, so only a committed
  // navigation counts: a render React throws away must not bump a counter
  // that no fetch will ever match. `navGen` mirrors it for rendering; until
  // the effect runs, the render is locked anyway (the payload is another
  // chapter's, or landedGen is the previous navigation's).
  const navRef = useRef<NavigationGen | null>(null);
  const [navGen, setNavGen] = useState(0);
  const [landedGen, setLandedGen] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  // ChapterData = the server payload + client-only verse tombstones. A fresh
  // payload from refetch carries none, which is how tombstones get cleared.
  const [data, setData] = useState<ChapterData | null>(null);
  // Every local apply goes through here: it lands only on the route's own
  // payload, never on the previous chapter's copy still on screen (#892).
  const mutate = useCallback((fn: (prev: ChapterData) => ChapterData) => {
    setData((prev) => updateIfCurrent(prev, routeRef.current, fn));
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [retryAttempts, setRetryAttempts] = useState(0);
  // Request ordering (abort-and-replace, the deferred first-open merge, the
  // replay queue for steps that arrive while a merging refetch is pending)
  // lives in chapterFetchSequencer.ts so every ordering case is unit-tested.
  // The callbacks only touch state setters, which React keeps stable.
  const sequencer = useRef<ChapterFetchSequencer<ChapterPayload, StructureStep> | null>(null);
  sequencer.current ??= createChapterFetchSequencer<ChapterPayload, StructureStep>({
    onStart: () => {
      setStatus("loading");
      setError(null);
      setRetryAttempts(0);
    },
    onAttempt: (attempts) => {
      setStatus("retrying");
      setRetryAttempts(attempts);
    },
    onLanded: (payload, merge, queued) => {
      // With `prev` null, or the previous chapter's stale copy (#892),
      // `mergeRefetched` is a plain replace.
      setData((prev) => replaySteps(merge ? mergeRefetched(prev, payload) : payload, queued));
      // The sequencer aborts a request on navigation, so whatever lands was
      // fetched for the current navigation.
      setLandedGen(navRef.current?.gen ?? 0);
      setStatus("ready");
      setRetryAttempts(0);
    },
    onError: (e) => {
      setError(e instanceof ApiError ? `HTTP ${e.status}` : String(e));
      setStatus("error");
    },
    // A row / status step recorded before a newer merging GET was sent is in
    // that GET's snapshot already; verse-structure steps carry over, and so do
    // row deletes, whose own DELETE may still be queued (#989).
    keepOnSupersede: keepStepAcrossSupersede,
  });

  const refetch = useCallback((opts?: RefetchOptions) => {
    // Any in-flight request is aborted and replaced (stale data must never
    // land after a newer request or a navigation), with one exception: the
    // WS first-open merging refetch (Shell's `onOpen`) arriving while the
    // mount GET is still in flight does not abort it. The mount GET lands and
    // renders, and the merging GET is issued right after it, so first paint
    // no longer waits on the socket (#902) and the verse map is still
    // reconciled by a merging refetch issued after the subscription.
    //
    // `=== true` so a caller that hands `refetch` straight to an event
    // handler (receiving a truthy event object) still gets the replace.
    //
    // The route is read when the fetch RUNS (currentRouteFetcher), so a
    // `refetch` captured on an earlier chapter (a "Refresh" toast, the
    // post-unlock refetch) fetches the current chapter instead of replacing
    // its GET with the old one and leaving the view locked (#892).
    //
    // A row whose own tq/twl DELETE (this tab's) is draining in the outbox,
    // or committed while the GET ran, is left out of whatever lands (#1107):
    // the GET can be answered before the DELETE commits (offline, then the
    // reconnect GET races the drain). A DELETE refused as chapter_locked or
    // discarded meanwhile is not hidden: Shell's #1108 rollback restores that
    // row (the same two triggers).
    const fetchRoute = currentRouteFetcher(routeRef, (b, c, s) => api.getChapter(b, c, s));
    return sequencer.current!.refetch(
      hidingPendingRowDeletes(
        (signal, onAttempt) => fetchWithRetry(fetchRoute, { signal, onAttempt }),
        () => outbox.list(),
        {
          watch: (on) => {
            const offResult = onOutboxResult((op, result) => {
              if (op.target.kind !== "row" || op.action !== "delete") return;
              if (result.kind === "ok") on.committed(op);
              else if (result.kind === "locked") on.abandoned(op);
            });
            const offDiscard = onOutboxDiscard((op) => on.abandoned(op));
            return () => {
              offResult();
              offDiscard();
            };
          },
          isOwn: isOwnRowDelete,
        },
      ),
      opts?.keepNewerLocal === true,
    );
  }, []);

  useEffect(() => {
    // The previous (book, chapter)'s payload is NOT cleared here (#892): it
    // stays on screen until the new one lands, so a chapter change doesn't
    // blank and rebuild the view. It is reported as `stale` (derived below
    // from data vs route) and Shell locks every edit path while it is: the
    // #531 rule that no edit may be typed into, or queued against, a copy of
    // a chapter the route has moved away from. Local applies are no-ops while
    // stale (`mutate`), as they were while the payload used to be null.
    navRef.current = trackNavigation(navRef.current, { book, chapter });
    setNavGen(navRef.current.gen);
    void refetch();
    // Abort the in-flight GET and drop any deferred merge or queued steps,
    // so nothing from this (book, chapter) lands after navigation/unmount.
    return () => sequencer.current?.reset();
  }, [book, chapter, refetch]);

  const applyLocalRowPatch = useCallback<UseChapterReturn["applyLocalRowPatch"]>(
    (kind, id, patch) => {
      mutate((prev) => {
        const list = prev[kind] as Array<TnRow | TqRow | TwlRow>;
        const next = list.map((r) => (r.id === id ? { ...r, ...patch } : r));
        return { ...prev, [kind]: next } as ChapterPayload;
      });
    },
    [mutate],
  );

  // Row replacements / deletes / inserts are recorded for replay while a
  // keepNewerLocal refetch is pending (#974): the merge takes row membership
  // from the fetch, so a row created or deleted in the GET's window would
  // otherwise vanish or come back. Replay applies a step over a fetched row
  // only when strictly newer (lib/verseStructure.ts `applyStep`); the live
  // update below is unchanged.
  const applyLocalRowReplacement = useCallback<UseChapterReturn["applyLocalRowReplacement"]>(
    (kind, row) => {
      sequencer.current?.record({ type: "rowReplace", kind, row });
      mutate((prev) => {
        const list = prev[kind] as Array<TnRow | TqRow | TwlRow>;
        const next = list.map((r) => (r.id === row.id ? row : r));
        return { ...prev, [kind]: next } as ChapterPayload;
      });
    },
    [mutate],
  );

  const applyLocalRowDelete = useCallback<UseChapterReturn["applyLocalRowDelete"]>(
    (kind, id) => {
      sequencer.current?.record({ type: "rowDelete", kind, id });
      mutate((prev) => {
        const list = prev[kind] as Array<TnRow | TqRow | TwlRow>;
        const next = list.filter((r) => r.id !== id);
        return { ...prev, [kind]: next } as ChapterPayload;
      });
    },
    [mutate],
  );

  const applyLocalRowInsert = useCallback<UseChapterReturn["applyLocalRowInsert"]>(
    (kind, row, position) => {
      // A late createRow response from the previous chapter must not be
      // queued for replay into this one (applyStep also refuses it).
      if (row.book === book && row.chapter === chapter) {
        sequencer.current?.record({ type: "rowInsert", kind, row, afterId: position?.afterId });
      }
      mutate((prev) => {
        const list = prev[kind] as Array<TnRow | TqRow | TwlRow>;
        // Skip if a row with this id is already present (e.g. createRow response
        // racing with an outbox replacement).
        if (list.some((r) => r.id === row.id)) return prev;
        let next: Array<TnRow | TqRow | TwlRow>;
        const afterId = position?.afterId;
        if (afterId) {
          const idx = list.findIndex((r) => r.id === afterId);
          if (idx >= 0) {
            next = [...list.slice(0, idx + 1), row, ...list.slice(idx + 1)];
          } else {
            next = [...list, row];
          }
        } else {
          next = [...list, row];
        }
        return { ...prev, [kind]: next } as ChapterPayload;
      });
    },
    [book, chapter, mutate],
  );

  const restoreRow = useCallback<UseChapterReturn["restoreRow"]>(
    (kind, row, position) => {
      sequencer.current?.forget((s) => s.type === "rowDelete" && s.kind === kind && s.id === row.id);
      applyLocalRowInsert(kind, row, position);
    },
    [applyLocalRowInsert],
  );

  // The verse map is reduced by lib/verseStructure.ts so the WS reorder rules
  // (version clock + per-verse tombstones) live in one pure, permutation-tested
  // place rather than being re-derived in each updater below.
  const applyLocalVerse = useCallback<UseChapterReturn["applyLocalVerse"]>(
    (verse) => {
      mutate((prev) => reduceVerses(prev, verse.bible_version, (s) => applyUpdated(s, verse, { force: true })));
    },
    [mutate],
  );

  // Every strictly-gated step (never the forced optimistic edit above) goes
  // through here so it is both applied now and, while a keepNewerLocal refetch
  // is in flight, recorded for replay over the merged payload. Recording
  // happens at call time, not inside the updater: updaters may run twice
  // (StrictMode) and run later than the call, and the refetch reads the queue
  // synchronously when its response lands.
  const dispatchStep = useCallback((step: StructureStep) => {
    sequencer.current?.record(step);
    mutate((prev) => applyStep(prev, step));
  }, [mutate]);

  const applyRemoteVerse = useCallback<UseChapterReturn["applyRemoteVerse"]>(
    (verse) => {
      dispatchStep({ type: "updated", bibleVersion: verse.bible_version, verse });
    },
    [dispatchStep],
  );

  const applyLocalVerseBridge = useCallback<UseChapterReturn["applyLocalVerseBridge"]>(
    (bridge, removedVerse, absorbedVerses, removedVersion) => {
      // The absorbed verses' status / lane-check prune lives in applyStep, so a
      // replayed bridge does exactly what the live one did.
      dispatchStep({
        type: "bridged",
        bibleVersion: bridge.bible_version,
        bridge,
        removedVerse,
        removedVersion,
        absorbedVerses,
      });
    },
    [dispatchStep],
  );

  const applyLocalVerseSplit = useCallback<UseChapterReturn["applyLocalVerseSplit"]>(
    (start, newVerses) => {
      dispatchStep({ type: "split", bibleVersion: start.bible_version, start, newVerses });
    },
    [dispatchStep],
  );

  const applyLocalVerseStatus = useCallback<UseChapterReturn["applyLocalVerseStatus"]>(
    (verse, done, updatedAt) => {
      // Only a server-stamped status is recorded for replay: its updated_at is
      // what proves it newer than a refetch's snapshot (#974).
      if (updatedAt != null) sequencer.current?.record({ type: "verseStatus", verse, done, updatedAt });
      mutate((prev) => {
        const existing = prev.verseStatuses.find((s) => s.verse === verse);
        const updated: VerseStatus = {
          book: prev.book,
          chapter: prev.chapter,
          verse,
          done: done ? 1 : 0,
          updated_at: updatedAt ?? Math.floor(Date.now() / 1000),
        };
        const next = existing
          ? prev.verseStatuses.map((s) => (s.verse === verse ? updated : s))
          : [...prev.verseStatuses, updated];
        return { ...prev, verseStatuses: next };
      });
    },
    [mutate],
  );

  const applyLocalLaneCheck = useCallback<UseChapterReturn["applyLocalLaneCheck"]>(
    (verse, lane, userId, checked) => {
      mutate((prev) => {
        const exists = prev.verseLaneChecks.some(
          (c) => c.verse === verse && c.lane === lane && c.checked_by === userId,
        );
        if (checked && exists) return prev;
        if (!checked && !exists) return prev;
        const next = checked
          ? [
              ...prev.verseLaneChecks,
              {
                book: prev.book,
                chapter: prev.chapter,
                verse,
                lane,
                checked_by: userId,
                checked_at: Math.floor(Date.now() / 1000),
              } as VerseLaneCheck,
            ]
          : prev.verseLaneChecks.filter(
              (c) => !(c.verse === verse && c.lane === lane && c.checked_by === userId),
            );
        return { ...prev, verseLaneChecks: next };
      });
    },
    [mutate],
  );

  const applyLaneCheckers = useCallback<UseChapterReturn["applyLaneCheckers"]>(
    (verse, lane, checkers) => {
      mutate((prev) => {
        const rest = prev.verseLaneChecks.filter((c) => !(c.verse === verse && c.lane === lane));
        const now = Math.floor(Date.now() / 1000);
        const added: VerseLaneCheck[] = checkers.map((checked_by) => ({
          book: prev.book,
          chapter: prev.chapter,
          verse,
          lane,
          checked_by,
          checked_at: now,
        }));
        return { ...prev, verseLaneChecks: [...rest, ...added] };
      });
    },
    [mutate],
  );

  const replaceLaneChecksForLane = useCallback<UseChapterReturn["replaceLaneChecksForLane"]>(
    (lane, checks) => {
      mutate((prev) => {
        const rest = prev.verseLaneChecks.filter((c) => c.lane !== lane);
        return { ...prev, verseLaneChecks: [...rest, ...checks] };
      });
    },
    [mutate],
  );

  const applyLocalTwlOrderLock = useCallback<UseChapterReturn["applyLocalTwlOrderLock"]>(
    (verse, lock) => {
      mutate((prev) => {
        const rest = (prev.twlOrderLocks ?? []).filter((l) => l.verse !== verse);
        return { ...prev, twlOrderLocks: lock ? [...rest, lock] : rest };
      });
    },
    [mutate],
  );

  // Adopt server-confirmed values when an outbox op succeeds.
  useEffect(() => {
    return onOutboxResult((op, result) => {
      if (result.kind !== "ok") return;
      if (op.target.kind === "row") {
        const u = result.updated as TnRow | TqRow | TwlRow;
        if (u && u.book === book && u.chapter === chapter) {
          applyLocalRowReplacement(op.target.rowKind, u);
        }
        return;
      }
      if (op.target.kind === "verse") {
        const v = result.updated as VerseDto;
        if (v && v.book === book && v.chapter === chapter) {
          // Version-gated: the server's row for a save that raced a bridge/
          // split must neither regress a newer row nor resurrect a tombstoned
          // verse (#729).
          applyRemoteVerse(v);
        }
        return;
      }
      if (op.target.kind === "verse_status") {
        const s = result.updated as VerseStatus;
        if (s && s.book === book && s.chapter === chapter) {
          applyLocalVerseStatus(s.verse, s.done === 1, s.updated_at);
        }
        return;
      }
      if (op.target.kind === "lane_check") {
        const s = result.updated as LaneCheckState;
        if (s && s.book === book && s.chapter === chapter) {
          applyLaneCheckers(s.verse, s.lane, s.checkers);
        }
      }
    });
  }, [book, chapter, applyLocalRowReplacement, applyRemoteVerse, applyLocalVerseStatus, applyLaneCheckers]);

  return {
    status,
    data,
    stale: isChapterLocked(data, { book, chapter }, landedGen, navGen),
    error,
    retryAttempts,
    refetch,
    applyLocalRowPatch,
    applyLocalRowReplacement,
    applyLocalRowDelete,
    applyLocalRowInsert,
    restoreRow,
    applyLocalVerse,
    applyRemoteVerse,
    applyLocalVerseBridge,
    applyLocalVerseSplit,
    applyLocalVerseStatus,
    applyLocalLaneCheck,
    applyLaneCheckers,
    replaceLaneChecksForLane,
    applyLocalTwlOrderLock,
  };
}
