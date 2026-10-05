// useBookLint — fetches the DCS-validation lint summary for a book so the
// TopBar can surface "issues to clean up" that need a human decision. The
// backend (GET /api/books/:book/lint) buckets each issue into "flag" (content
// problems a translator must resolve) and "escalate" (integrity, footnotes);
// we expose the flag list + both counts. Book-level, so it fetches once per
// book change — not per chapter — and offers a refetch for on-demand refresh.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type BookLintIssue, type BookLintReport } from "../sync/api";
import { fetchWithRetry } from "../sync/fetchWithRetry";
import { createLintRefreshQueue } from "./lintRefreshQueue";

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
  // Date.now() when the last fetch landed; 0 before the first and after a
  // failed one, so a failure never suppresses the next retry. Lets the caller
  // skip a focus-driven refetch that would re-pull a report it just got (#887).
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

  const load = useCallback((): Promise<void> => {
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
      try {
        // Bounded: a big book that times out must not retry forever (#887).
        const r = await fetchWithRetry((signal) => api.getBookLint(book, signal), { signal: ctrl.signal, maxAttempts: 3 });
        if (ctrl.signal.aborted) return;
        settledAt.current = Date.now();
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
    lastSettledAt,
  };
}
