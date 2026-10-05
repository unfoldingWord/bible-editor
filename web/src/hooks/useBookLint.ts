// useBookLint — fetches the DCS-validation lint summary for a book so the
// TopBar can surface "issues to clean up" that need a human decision. The
// backend (GET /api/books/:book/lint) buckets each issue into "flag" (content
// problems a translator must resolve) and "escalate" (integrity, footnotes);
// we expose the flag list + both counts. Book-level, so it fetches once per
// book change — not per chapter — and offers a refetch for on-demand refresh.
// After a save, refetchChapter re-lints just that chapter and merges it into
// the cached report (#888, mergeChapterReport.ts), which on a big book is a
// fraction of the whole-book request.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type BookLintIssue, type BookLintReport } from "../sync/api";
import { fetchWithRetry } from "../sync/fetchWithRetry";
import { createLintRefreshQueue } from "./lintRefreshQueue";
import { mergeChapterReport } from "./mergeChapterReport";
import { lintRefreshScope, type PendingLintScope } from "./lintRefreshScope";

export interface UseBookLintReturn {
  status: "idle" | "loading" | "ready" | "error";
  flagIssues: BookLintIssue[];
  flagCount: number;
  escalateCount: number;
  // Returns completion of a fetch STARTED after this invalidation (resolves whether it lands,
  // fails, or is aborted) so a caller can await "the report I asked for has
  // now either landed or given up" — e.g. BookLintIndicator's dismiss flows
  // bound an optimistic key's lifetime to this promise rather than to a
  // shared reset effect.
  refetch: () => Promise<void>;
  // Same contract as refetch, but asks only for one chapter's lint and merges
  // it in. Falls back to the whole book when there is no report to merge into,
  // when several chapters (or a whole-book refetch) are pending together, when
  // the last request failed, or when the last whole-book lint is a minute old
  // (WHOLE_BOOK_LINT_MAX_AGE_MS), so a tab that stays focused still picks up
  // other chapters' changes.
  refetchChapter: (chapter: number) => Promise<void>;
  // Date.now() when the last WHOLE-BOOK fetch landed; 0 before the first and
  // after a failed one, so a failure never suppresses the next retry. Lets the
  // caller skip a focus-driven refetch that would re-pull a report it just got
  // (#887). A chapter merge does not count: it only refreshes the saved
  // chapter, so other chapters' changes (other users, AI apply, nightly sync)
  // still need the focus refresh to come due (#888).
  lastSettledAt: () => number;
}

export function useBookLint(book: string, enabled: boolean): UseBookLintReturn {
  const [report, setReport] = useState<BookLintReport | null>(null);
  const [status, setStatus] = useState<UseBookLintReturn["status"]>("idle");
  // The effect below owns the queue's whole lifecycle (create in setup,
  // dispose in cleanup) so setup and cleanup stay symmetric under a React
  // StrictMode replay (setup → cleanup → setup) — see that effect's comment.
  // `load()`/the book-change effect below tolerate a momentarily-null queue
  // (there is none between a real unmount and the hook itself going away).
  // The effect below swaps `runner.current` instead of recreating the queue, so
  // an in-flight refresh() from before a book change still resolves against
  // whichever run() the queue picks up next (the queue's own coalescing).
  const runner = useRef<() => Promise<void>>(() => Promise.resolve());
  const queue = useRef<ReturnType<typeof createLintRefreshQueue> | null>(null);
  // Serialized last-applied report, so an identical refetch skips setReport
  // (and the Shell re-render it causes); null = no report yet.
  const reportJson = useRef<string | null>(null);
  const settledAt = useRef(0);
  const lastSettledAt = useCallback(() => settledAt.current, []);
  // The report a chapter response merges into (state can lag a render).
  const reportRef = useRef<BookLintReport | null>(null);
  // What the next run must refresh. A run takes and clears it, so requests
  // that pile up during a run are served together by the follow-up run.
  const pending = useRef<PendingLintScope>({ whole: false, chapters: new Set<number>() });

  const load = useCallback((): Promise<void> => {
    pending.current.whole = true;
    return queue.current ? queue.current.refresh() : Promise.resolve();
  }, []);
  const loadChapter = useCallback((chapter: number): Promise<void> => {
    pending.current.chapters.add(chapter);
    return queue.current ? queue.current.refresh() : Promise.resolve();
  }, []);

  // Created in setup, disposed in cleanup — a one-way `disposed` latch used
  // to survive a React StrictMode replay by reviving a queue created once in
  // the render body, which made correctness depend on this effect being
  // declared before the book-change effect below (#842 step 4). Owning the
  // whole lifecycle here removes both: cleanup always undoes exactly what
  // setup just did, in dev and in production alike, in any declaration order.
  useEffect(() => {
    queue.current = createLintRefreshQueue(() => runner.current());
    return () => {
      queue.current?.dispose();
      queue.current = null;
    };
  }, []);

  // Refetch on book change (and reset when disabled) — lint is per-book.
  useEffect(() => {
    reportJson.current = null;
    reportRef.current = null;
    pending.current = { whole: false, chapters: new Set() };
    if (!enabled) {
      setReport(null);
      setStatus("idle");
      runner.current = () => Promise.resolve();
      return;
    }
    setReport(null);
    const ctrl = new AbortController();
    runner.current = async () => {
      // A refetch keeps showing the current report; only the first load of a
      // book is "loading".
      if (reportJson.current === null) setStatus("loading");
      const scope = pending.current;
      pending.current = { whole: false, chapters: new Set() };
      const base = reportRef.current;
      // One chapter only when that is all that changed, there is a report to
      // merge it into, and the last whole-book lint is recent; anything else
      // re-lints the whole book (see lintRefreshScope).
      const chapter = lintRefreshScope(scope, base !== null, settledAt.current, Date.now());
      try {
        // Bounded: a big book that times out must not retry forever (#887).
        const fetchLint = (ch?: number) =>
          fetchWithRetry((signal) => api.getBookLint(book, signal, ch), { signal: ctrl.signal, maxAttempts: 3 });
        let r = await fetchLint(chapter);
        if (ctrl.signal.aborted) return;
        let wholeBook = chapter === undefined;
        if (chapter !== undefined && base) {
          const merged = mergeChapterReport(base, r);
          if (merged) {
            r = merged;
          } else {
            r = await fetchLint();
            if (ctrl.signal.aborted) return;
            wholeBook = true;
          }
        }
        reportRef.current = r;
        if (wholeBook) settledAt.current = Date.now();
        const json = JSON.stringify(r);
        if (json !== reportJson.current) {
          reportJson.current = json;
          setReport(r);
        }
        setStatus("ready");
      } catch {
        if (ctrl.signal.aborted) return;
        settledAt.current = 0;
        setStatus("error");
        // The cached report missed this refresh, so it can no longer be patched
        // one chapter at a time: the next refresh re-lints the whole book.
        pending.current.whole = true;
      }
    };
    void queue.current?.refresh();
    return () => {
      ctrl.abort();
    };
  }, [book, enabled]);

  // Only the flag bucket needs a human decision; escalate (footnotes) is a
  // secondary count. Recompute the list from the report so the dropdown and the
  // badge can never disagree, but trust the server's flagCount as the source.
  // Memoized on `report` so this array keeps a stable identity across
  // unrelated re-renders of the caller, changing only when a fresh report
  // actually lands.
  const flagIssues = useMemo(
    () => (report?.issues ?? []).filter((i) => i.bucket === "flag"),
    [report],
  );

  return {
    status,
    flagIssues,
    flagCount: report?.flagCount ?? flagIssues.length,
    escalateCount: report?.escalateCount ?? 0,
    refetch: load,
    refetchChapter: loadChapter,
    lastSettledAt,
  };
}
