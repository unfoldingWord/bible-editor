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
}

export function useBookLint(book: string, enabled: boolean): UseBookLintReturn {
  const [report, setReport] = useState<BookLintReport | null>(null);
  const [status, setStatus] = useState<UseBookLintReturn["status"]>("idle");
  const queue = useRef<ReturnType<typeof createLintRefreshQueue> | null>(null);

  const load = useCallback((): Promise<void> => {
    return queue.current?.refresh() ?? Promise.resolve();
  }, []);

  // Refetch on book change (and reset when disabled) — lint is per-book.
  useEffect(() => {
    if (!enabled) {
      setReport(null);
      setStatus("idle");
      return;
    }
    setReport(null);
    const ctrl = new AbortController();
    const current = createLintRefreshQueue(async () => {
      setStatus("loading");
      try {
        const r = await fetchWithRetry((signal) => api.getBookLint(book, signal), { signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        setReport(r);
        setStatus("ready");
      } catch {
        if (!ctrl.signal.aborted) setStatus("error");
      }
    });
    queue.current = current;
    void current.refresh();
    return () => {
      queue.current = null;
      current.dispose();
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
  };
}
