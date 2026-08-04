import { useEffect, useState } from "react";
import { fetchAlignmentAttention, type AlignAttentionRef } from "../sync/api";

// Sticky "alignment needs attention" state for the top bar. Fetches once per
// book change (gated by auth-ready so we don't fire a 401 before the cookie
// is set) — no polling, since this only changes at the next nightly export
// and a reload covers that (mirrors useAlerts.ts).
//
// A failed fetch must never break the top bar, so errors swallow to an empty
// list rather than surfacing.
export function useAlignmentAttention(book: string, authReady: boolean): { refs: AlignAttentionRef[] } {
  const [refs, setRefs] = useState<AlignAttentionRef[]>([]);

  useEffect(() => {
    if (!authReady) return;
    let live = true;
    setRefs([]);
    void fetchAlignmentAttention(book)
      .then((r) => {
        // Guard against a slow response for a PREVIOUS book landing after the
        // user has already navigated on — that would show one book's refs
        // under another book's name.
        if (live) setRefs(r);
      })
      .catch(() => {
        // Non-critical — swallow rather than blocking the app.
      });
    return () => {
      live = false;
    };
  }, [authReady, book]);

  return { refs };
}
