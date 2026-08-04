import { useCallback, useEffect, useState } from "react";
import { fetchAlignmentAttention, type AlignAttentionRef } from "../sync/api";

// Sticky "alignment needs attention" state for the top bar. Fetches once per
// book change (gated by auth-ready so we don't fire a 401 before the cookie
// is set) — no polling, since this only changes at the next nightly export
// and a reload covers that (mirrors useAlerts.ts).
//
// A failed fetch must never break the top bar, so errors swallow to an empty
// list rather than surfacing.
export function useAlignmentAttention(
  book: string,
  authReady: boolean,
): {
  refs: AlignAttentionRef[];
  refresh: () => void;
} {
  const [refs, setRefs] = useState<AlignAttentionRef[]>([]);

  const refresh = useCallback(() => {
    void fetchAlignmentAttention(book)
      .then(setRefs)
      .catch(() => {
        // Non-critical — swallow rather than blocking the app.
      });
  }, [book]);

  useEffect(() => {
    if (!authReady) return;
    setRefs([]);
    refresh();
  }, [authReady, book, refresh]);

  return { refs, refresh };
}
