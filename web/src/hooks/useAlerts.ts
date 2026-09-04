import { useCallback, useEffect, useRef, useState } from "react";
import { dismissAlert, fetchAlerts, type SystemAlert } from "../sync/api";

// Alerts for the current user: comment mentions/replies (top-right bell) and
// sync warnings (collapsed indicator). Fetches on mount (gated by auth-ready
// so we don't fire a 401 before the cookie is set), refetches when the tab
// becomes visible, and polls while the tab is visible.
//
// Polling is what makes comment replies two-way: the chapter WebSocket only
// carries events for the chapter in view, so a reply to your GEN 1 thread
// while you edit MAT 5 has no realtime path at all. One indexed query per
// user per POLL_MS is cheap; a user-scoped socket can replace it if it ever
// stops being cheap. Callers can also `refresh()` on a comment event so an
// in-chapter reply reaches the bell immediately.
const POLL_MS = 30_000;

// Alerts created more than this long before the first load are never "fresh",
// even if the first load did not list them (a 401 on that fetch comes back as
// an empty list, and a sign-out/sign-in as another user keeps this hook
// mounted). Without it, a whole backlog could toast at once on the next poll.
const FRESH_SKEW_S = 60;

export type FreshAlert = SystemAlert & {
  // Wall-clock ms when this tab first saw the alert; drives the toast timer.
  seenAt: number;
};

function sameAlerts(a: SystemAlert[], b: SystemAlert[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false;
  return true;
}

export function useAlerts(authReady: boolean): {
  alerts: SystemAlert[];
  // Alerts that arrived AFTER the first successful load — new during this
  // session, so worth an unobtrusive nudge. Alerts already pending at sign-in
  // are not "fresh": the bell badge covers them without a pop-up.
  fresh: FreshAlert[];
  // Drop an alert from `fresh` without dismissing it (toast closed/expired).
  ackFresh: (id: number) => void;
  dismiss: (id: number) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [alerts, setAlerts] = useState<SystemAlert[]>([]);
  const [fresh, setFresh] = useState<FreshAlert[]>([]);
  // Ids seen in any successful fetch; null until the first one lands.
  const knownIdsRef = useRef<Set<number> | null>(null);
  // Unix seconds of the first successful load (see FRESH_SKEW_S).
  const firstLoadAtRef = useRef(0);
  // Responses can land out of order (poll + visibility + socket-triggered
  // refresh in flight together); only the newest request may apply.
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const list = await fetchAlerts();
      if (seq !== seqRef.current) return;
      const known = knownIdsRef.current;
      if (known) {
        const cutoff = firstLoadAtRef.current - FRESH_SKEW_S;
        const now = Date.now();
        const arrived: FreshAlert[] = list
          .filter((a) => !known.has(a.id) && a.createdAt >= cutoff)
          .map((a) => ({ ...a, seenAt: now }));
        for (const a of list) known.add(a.id);
        const live = new Set(list.map((a) => a.id));
        // Prune entries the server no longer lists (dismissed in another tab).
        setFresh((prev) => {
          const kept = prev.filter((f) => live.has(f.id));
          return arrived.length === 0 && kept.length === prev.length ? prev : [...kept, ...arrived];
        });
      } else {
        knownIdsRef.current = new Set(list.map((a) => a.id));
        firstLoadAtRef.current = Math.floor(Date.now() / 1000);
      }
      // Keep the previous array identity when nothing changed, so a quiet
      // poll does not re-render the whole app every 30s.
      setAlerts((prev) => (sameAlerts(prev, list) ? prev : list));
    } catch {
      // Non-critical — swallow rather than blocking the app.
    }
  }, []);

  useEffect(() => {
    if (!authReady) {
      // Signed out or session expired: nothing to show, and the next sign-in
      // (possibly as someone else) starts from a clean first load.
      seqRef.current++;
      knownIdsRef.current = null;
      setAlerts([]);
      setFresh([]);
      return;
    }
    void refresh();
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.clearInterval(timer);
    };
  }, [authReady, refresh]);

  const ackFresh = useCallback((id: number) => {
    setFresh((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const dismiss = useCallback(
    async (id: number) => {
      // Optimistic remove; refetch to reconcile if the server disagrees.
      setAlerts((prev) => prev.filter((a) => a.id !== id));
      setFresh((prev) => prev.filter((a) => a.id !== id));
      try {
        await dismissAlert(id);
      } catch {
        void refresh();
      }
    },
    [refresh],
  );

  return { alerts, fresh, ackFresh, dismiss, refresh };
}
