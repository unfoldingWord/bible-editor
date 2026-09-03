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
import { onOutboxResult } from "../sync/outbox";
import {
  applyStep,
  applyUpdated,
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
   * a verse the tab holds at an equal-or-newer version stays (see
   * lib/verseStructure.ts `mergeRefetched`). For the WS reconnect refetch,
   * which races the outbox drain on the same `online` moment — a stale GET
   * must not regress a verse the tab's own PATCH just advanced. Every other
   * caller wants the plain replace (default): they refetch precisely because
   * the server changed rows/versions out from under the tab.
   */
  keepNewerLocal?: boolean;
}

export interface UseChapterReturn {
  status: Status;
  data: ChapterPayload | null;
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
  applyLocalVerseStatus: (verse: number, done: boolean) => void;
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
  const [status, setStatus] = useState<Status>("idle");
  // ChapterData = the server payload + client-only verse tombstones. A fresh
  // payload from refetch carries none, which is how tombstones get cleared.
  const [data, setData] = useState<ChapterData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryAttempts, setRetryAttempts] = useState(0);
  const mounted = useRef(true);
  const fetchCtrl = useRef<AbortController | null>(null);
  // Reducer steps (WS bridged / split / updated, outbox results) that reach
  // the tab while a `keepNewerLocal` refetch is in flight. Non-null exactly
  // while such a refetch is pending. `mergeRefetched` can only judge verses
  // the GET's snapshot contains, so a split that recreated a verse AFTER the
  // snapshot but BEFORE the response landed would be silently discarded (the
  // response has no row for it); replaying the queue over the merged map puts
  // it back. Replay is idempotent — every step is version-gated (see
  // lib/verseStructure.ts `StructureStep`).
  //
  // One queue, owned by the LATEST request: a second reconnect refetch while
  // the first is in flight aborts the first (fetchCtrl) and inherits the
  // queue — steps the first collected are either newer than the second GET's
  // rows (and kept by the merge anyway) or stale echoes (no-ops on replay).
  // A plain-replace refetch or a chapter change drops it; the resolving or
  // failing latest request clears it.
  const replayQueue = useRef<StructureStep[] | null>(null);

  const refetch = useCallback(async (opts?: RefetchOptions) => {
    // Abort any in-flight retry loop from a previous (book, chapter) before
    // starting a new one — otherwise stale data could land after navigation.
    fetchCtrl.current?.abort();
    const ctrl = new AbortController();
    fetchCtrl.current = ctrl;
    // `=== true` so a caller that hands `refetch` straight to an event
    // handler (receiving a truthy event object) still gets the replace.
    const keepNewerLocal = opts?.keepNewerLocal === true;
    replayQueue.current = keepNewerLocal ? (replayQueue.current ?? []) : null;

    setStatus("loading");
    setError(null);
    setRetryAttempts(0);
    try {
      const payload = await fetchWithRetry(
        (signal) => api.getChapter(book, chapter, signal),
        {
          signal: ctrl.signal,
          onAttempt: (attempts) => {
            if (mounted.current && fetchCtrl.current === ctrl) {
              setStatus("retrying");
              setRetryAttempts(attempts);
            }
          },
        },
      );
      if (!mounted.current || fetchCtrl.current !== ctrl) return;
      // Take the queue synchronously, before the updater runs: a step that
      // arrives after this point is applied by its own setData, which React
      // orders after this one, so it must not also be replayed here.
      const queued = replayQueue.current ?? [];
      replayQueue.current = null;
      setData((prev) => (keepNewerLocal ? replaySteps(mergeRefetched(prev, payload), queued) : payload));
      setStatus("ready");
      setRetryAttempts(0);
    } catch (e) {
      // A superseded request (a newer refetch owns fetchCtrl and the queue)
      // must leave the queue to its successor; only the latest request's
      // failure drops it.
      if (!mounted.current || fetchCtrl.current !== ctrl) return;
      replayQueue.current = null;
      if (ctrl.signal.aborted) return;
      setError(e instanceof ApiError ? `HTTP ${e.status}` : String(e));
      setStatus("error");
    }
  }, [book, chapter]);

  useEffect(() => {
    mounted.current = true;
    // Clear the previous (book, chapter)'s payload before the new fetch
    // lands. `refetch` sets status to "loading" but never used to clear
    // `data`, so from the moment (book, chapter) changed until the new
    // payload arrived, Shell's `!data` gate fell through and rendered the
    // PREVIOUS chapter's verses/notes/questions/words under the new
    // book/chapter labels — and, because the editable UI only mounts in
    // that data branch, let editing happen against stale content. This
    // effect only re-runs when `refetch`'s own deps (book, chapter) change
    // (it's identity-stable otherwise), so manual refetch() calls elsewhere
    // (retry button, post-import refresh) are unaffected and keep refreshing
    // in place without this blank. See #531.
    setData(null);
    void refetch();
    return () => {
      mounted.current = false;
      fetchCtrl.current?.abort();
    };
  }, [refetch]);

  const applyLocalRowPatch = useCallback<UseChapterReturn["applyLocalRowPatch"]>(
    (kind, id, patch) => {
      setData((prev) => {
        if (!prev) return prev;
        const list = prev[kind] as Array<TnRow | TqRow | TwlRow>;
        const next = list.map((r) => (r.id === id ? { ...r, ...patch } : r));
        return { ...prev, [kind]: next } as ChapterPayload;
      });
    },
    [],
  );

  const applyLocalRowReplacement = useCallback<UseChapterReturn["applyLocalRowReplacement"]>(
    (kind, row) => {
      setData((prev) => {
        if (!prev) return prev;
        const list = prev[kind] as Array<TnRow | TqRow | TwlRow>;
        const next = list.map((r) => (r.id === row.id ? row : r));
        return { ...prev, [kind]: next } as ChapterPayload;
      });
    },
    [],
  );

  const applyLocalRowDelete = useCallback<UseChapterReturn["applyLocalRowDelete"]>(
    (kind, id) => {
      setData((prev) => {
        if (!prev) return prev;
        const list = prev[kind] as Array<TnRow | TqRow | TwlRow>;
        const next = list.filter((r) => r.id !== id);
        return { ...prev, [kind]: next } as ChapterPayload;
      });
    },
    [],
  );

  const applyLocalRowInsert = useCallback<UseChapterReturn["applyLocalRowInsert"]>(
    (kind, row, position) => {
      setData((prev) => {
        if (!prev) return prev;
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
    [],
  );

  // The verse map is reduced by lib/verseStructure.ts so the WS reorder rules
  // (version clock + per-verse tombstones) live in one pure, permutation-tested
  // place rather than being re-derived in each updater below.
  const applyLocalVerse = useCallback<UseChapterReturn["applyLocalVerse"]>(
    (verse) => {
      setData((prev) =>
        prev ? reduceVerses(prev, verse.bible_version, (s) => applyUpdated(s, verse, { force: true })) : prev,
      );
    },
    [],
  );

  // Every strictly-gated step (never the forced optimistic edit above) goes
  // through here so it is both applied now and, while a keepNewerLocal refetch
  // is in flight, recorded for replay over the merged payload. Recording
  // happens at call time, not inside the updater: updaters may run twice
  // (StrictMode) and run later than the call, and the refetch reads the queue
  // synchronously when its response lands.
  const dispatchStep = useCallback((step: StructureStep) => {
    replayQueue.current?.push(step);
    setData((prev) => (prev ? applyStep(prev, step) : prev));
  }, []);

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
    (verse, done) => {
      setData((prev) => {
        if (!prev) return prev;
        const existing = prev.verseStatuses.find((s) => s.verse === verse);
        const updated: VerseStatus = {
          book: prev.book,
          chapter: prev.chapter,
          verse,
          done: done ? 1 : 0,
          updated_at: Math.floor(Date.now() / 1000),
        };
        const next = existing
          ? prev.verseStatuses.map((s) => (s.verse === verse ? updated : s))
          : [...prev.verseStatuses, updated];
        return { ...prev, verseStatuses: next };
      });
    },
    [],
  );

  const applyLocalLaneCheck = useCallback<UseChapterReturn["applyLocalLaneCheck"]>(
    (verse, lane, userId, checked) => {
      setData((prev) => {
        if (!prev) return prev;
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
    [],
  );

  const applyLaneCheckers = useCallback<UseChapterReturn["applyLaneCheckers"]>(
    (verse, lane, checkers) => {
      setData((prev) => {
        if (!prev) return prev;
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
    [],
  );

  const replaceLaneChecksForLane = useCallback<UseChapterReturn["replaceLaneChecksForLane"]>(
    (lane, checks) => {
      setData((prev) => {
        if (!prev) return prev;
        const rest = prev.verseLaneChecks.filter((c) => c.lane !== lane);
        return { ...prev, verseLaneChecks: [...rest, ...checks] };
      });
    },
    [],
  );

  const applyLocalTwlOrderLock = useCallback<UseChapterReturn["applyLocalTwlOrderLock"]>(
    (verse, lock) => {
      setData((prev) => {
        if (!prev) return prev;
        const rest = (prev.twlOrderLocks ?? []).filter((l) => l.verse !== verse);
        return { ...prev, twlOrderLocks: lock ? [...rest, lock] : rest };
      });
    },
    [],
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
          applyLocalVerseStatus(s.verse, s.done === 1);
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
    error,
    retryAttempts,
    refetch,
    applyLocalRowPatch,
    applyLocalRowReplacement,
    applyLocalRowDelete,
    applyLocalRowInsert,
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
