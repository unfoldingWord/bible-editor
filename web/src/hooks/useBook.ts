// useBook — lazily loads chapters of a book and caches them so the BookView
// can render an entire book as one continuous scroll. The chapter list comes
// from the BookSummary endpoint up-front; each chapter's full payload (verses
// + tn/tq/twl + statuses) loads only when something asks for it (typically
// an IntersectionObserver hooked to chapter sentinels in BookView).
//
// Edits in book mode flow through the same outbox; the verse version used
// for `If-Match` comes from this cache. Server responses are adopted via
// onOutboxResult so the cache stays current alongside useChapter.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  type BookSummary,
  type ChapterPayload,
  type TnRow,
  type TqRow,
  type TwlRow,
  type VerseDto,
} from "../sync/api";
import { fetchWithRetry } from "../sync/fetchWithRetry";
import { onOutboxResult } from "../sync/outbox";
import { applyBridged, applySplit, applyUpdated, reduceVerses, type ChapterData } from "../lib/verseStructure";

export type ChapterState =
  | { kind: "unloaded" }
  | { kind: "loading" }
  // ChapterData = ChapterPayload + client-only verse tombstones; a fresh load
  // carries none (see lib/verseStructure.ts).
  | { kind: "ready"; data: ChapterData }
  | { kind: "error"; error: string };

export interface UseBookReturn {
  summary: BookSummary | null;
  summaryStatus: "idle" | "loading" | "ready" | "error";
  chapters: Map<number, ChapterState>;
  loadChapter: (ch: number) => void;
  /** Book-mode twin of useChapter.applyLocalVerse (own edit; tombstone-aware). */
  applyLocalVerse: (verse: VerseDto) => void;
  /** Book-mode twin of useChapter.applyRemoteVerse (version- and tombstone-gated). */
  applyRemoteVerse: (verse: VerseDto) => void;
  /** Book-mode twin of useChapter.applyLocalVerseBridge (verse-bridge create). */
  applyLocalVerseBridge: (bridge: VerseDto, removedVerse: number, absorbedVerses: number[], removedVersion?: number) => void;
  /** Book-mode twin of useChapter.applyLocalVerseSplit (verse-bridge break). */
  applyLocalVerseSplit: (start: VerseDto, newVerses: VerseDto[]) => void;
  applyLocalRowPatch: (
    kind: "tn" | "tq" | "twl",
    chapter: number,
    id: string,
    patch: Partial<TnRow & TqRow & TwlRow>,
  ) => void;
}

export function useBook(book: string, enabled: boolean): UseBookReturn {
  const [summary, setSummary] = useState<BookSummary | null>(null);
  const [summaryStatus, setSummaryStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [chapters, setChapters] = useState<Map<number, ChapterState>>(new Map());
  const inFlight = useRef<Set<number>>(new Set());

  // Reset everything when the book changes or the hook is disabled — the
  // cache is per-book, not global.
  useEffect(() => {
    if (!enabled) {
      setSummary(null);
      setSummaryStatus("idle");
      setChapters(new Map());
      inFlight.current.clear();
      return;
    }
    setSummary(null);
    setSummaryStatus("loading");
    setChapters(new Map());
    inFlight.current.clear();
    const ctrl = new AbortController();
    fetchWithRetry(
      (signal) => api.getBookSummary(book, signal),
      { signal: ctrl.signal },
    )
      .then((s) => {
        if (ctrl.signal.aborted) return;
        setSummary(s);
        setSummaryStatus("ready");
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
        setSummaryStatus("error");
      });
    return () => {
      ctrl.abort();
    };
  }, [book, enabled]);

  // One AbortController per chapter so a book change can cancel them all.
  const chapterCtrls = useRef<Map<number, AbortController>>(new Map());

  // When the book toggles or `enabled` drops, abort every in-flight chapter
  // load (the effect above already clears the cache).
  useEffect(() => {
    return () => {
      for (const ctrl of chapterCtrls.current.values()) ctrl.abort();
      chapterCtrls.current.clear();
    };
  }, [book, enabled]);

  const loadChapter = useCallback(
    (ch: number) => {
      if (!enabled) return;
      if (inFlight.current.has(ch)) return;
      setChapters((prev) => {
        const cur = prev.get(ch);
        if (cur && cur.kind !== "unloaded") return prev;
        const next = new Map(prev);
        next.set(ch, { kind: "loading" });
        return next;
      });
      inFlight.current.add(ch);
      const ctrl = new AbortController();
      chapterCtrls.current.set(ch, ctrl);
      fetchWithRetry(
        (signal) => api.getChapter(book, ch, signal),
        { signal: ctrl.signal },
      )
        .then((data) => {
          inFlight.current.delete(ch);
          chapterCtrls.current.delete(ch);
          if (ctrl.signal.aborted) return;
          setChapters((prev) => {
            const next = new Map(prev);
            next.set(ch, { kind: "ready", data });
            return next;
          });
        })
        .catch((e) => {
          inFlight.current.delete(ch);
          chapterCtrls.current.delete(ch);
          if (ctrl.signal.aborted) return;
          if (e instanceof DOMException && e.name === "AbortError") return;
          setChapters((prev) => {
            const next = new Map(prev);
            next.set(ch, {
              kind: "error",
              error: e instanceof ApiError ? `HTTP ${e.status}` : String(e),
            });
            return next;
          });
        });
    },
    [book, enabled],
  );

  // Shared shape for the verse-map updaters: reduce one loaded chapter's data
  // through lib/verseStructure.ts (the WS reorder rules live there, once) and
  // return the previous Map untouched when the reducer reports a no-op.
  const reduceChapter = useCallback(
    (chapter: number, step: (data: ChapterData) => ChapterData) => {
      setChapters((prev) => {
        const cur = prev.get(chapter);
        if (!cur || cur.kind !== "ready") return prev;
        const data = step(cur.data);
        if (data === cur.data) return prev;
        const next = new Map(prev);
        next.set(chapter, { kind: "ready", data });
        return next;
      });
    },
    [],
  );

  const applyLocalVerse = useCallback<UseBookReturn["applyLocalVerse"]>(
    (verse) => {
      reduceChapter(verse.chapter, (data) =>
        reduceVerses(data, verse.bible_version, (s) => applyUpdated(s, verse, { force: true })),
      );
    },
    [reduceChapter],
  );

  const applyRemoteVerse = useCallback<UseBookReturn["applyRemoteVerse"]>(
    (verse) => {
      reduceChapter(verse.chapter, (data) => reduceVerses(data, verse.bible_version, (s) => applyUpdated(s, verse)));
    },
    [reduceChapter],
  );

  const applyLocalVerseBridge = useCallback<UseBookReturn["applyLocalVerseBridge"]>(
    (bridge, removedVerse, absorbedVerses, removedVersion) => {
      reduceChapter(bridge.chapter, (data) => {
        const next = reduceVerses(data, bridge.bible_version, (s) => applyBridged(s, bridge, removedVerse, removedVersion));
        // Identity: an equal-or-newer picture of this bridge is already held —
        // see useChapter.applyLocalVerseBridge.
        if (next === data) return data;
        const absorbed = new Set(absorbedVerses);
        return {
          ...next,
          verseStatuses: next.verseStatuses.filter((s) => !absorbed.has(s.verse)),
          verseLaneChecks: next.verseLaneChecks.filter((c) => !absorbed.has(c.verse)),
        };
      });
    },
    [reduceChapter],
  );

  const applyLocalVerseSplit = useCallback<UseBookReturn["applyLocalVerseSplit"]>(
    (start, newVerses) => {
      reduceChapter(start.chapter, (data) =>
        reduceVerses(data, start.bible_version, (s) => applySplit(s, start, newVerses)),
      );
    },
    [reduceChapter],
  );

  const applyLocalRowPatch = useCallback<UseBookReturn["applyLocalRowPatch"]>(
    (kind, chapter, id, patch) => {
      setChapters((prev) => {
        const cur = prev.get(chapter);
        if (!cur || cur.kind !== "ready") return prev;
        const data = cur.data;
        const list = data[kind] as Array<TnRow | TqRow | TwlRow>;
        const nextList = list.map((r) => (r.id === id ? { ...r, ...patch } : r));
        const next = new Map(prev);
        next.set(chapter, { kind: "ready", data: { ...data, [kind]: nextList } as ChapterPayload });
        return next;
      });
    },
    [],
  );

  // Adopt outbox results so verses edited via book mode stay coherent with
  // the server. useChapter wires the same listener for the active chapter;
  // duplicate updates are idempotent.
  useEffect(() => {
    if (!enabled) return;
    return onOutboxResult((op, result) => {
      if (result.kind !== "ok") return;
      if (op.target.kind === "verse") {
        const v = result.updated as VerseDto;
        // Version-gated (see useChapter's outbox listener, #729).
        if (v && v.book === book) applyRemoteVerse(v);
        return;
      }
      if (op.target.kind === "row") {
        const u = result.updated as TnRow | TqRow | TwlRow;
        if (!u || u.book !== book) return;
        const rowKind = op.target.rowKind;
        setChapters((prev) => {
          const cur = prev.get(u.chapter);
          if (!cur || cur.kind !== "ready") return prev;
          const data = cur.data;
          const list = data[rowKind] as Array<TnRow | TqRow | TwlRow>;
          const nextList = list.map((r) => (r.id === u.id ? u : r));
          const next = new Map(prev);
          next.set(u.chapter, {
            kind: "ready",
            data: { ...data, [rowKind]: nextList } as ChapterPayload,
          });
          return next;
        });
      }
    });
  }, [book, enabled, applyRemoteVerse]);

  return {
    summary,
    summaryStatus,
    chapters,
    loadChapter,
    applyLocalVerse,
    applyRemoteVerse,
    applyLocalVerseBridge,
    applyLocalVerseSplit,
    applyLocalRowPatch,
  };
}
