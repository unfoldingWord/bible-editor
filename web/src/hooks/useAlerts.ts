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

export function useAlerts(authReady: boolean): {
  alerts: SystemAlert[];
  // Alerts that arrived AFTER the first successful load — new during this
  // session, so worth an unobtrusive nudge. Alerts already pending at sign-in
  // are not "fresh": the bell badge covers them without a pop-up.
  fresh: SystemAlert[];
  // Drop an alert from `fresh` without dismissing it (toast closed/expired).
  ackFresh: (id: number) => void;
  dismiss: (id: number) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [alerts, setAlerts] = useState<SystemAlert[]>([]);
  const [fresh, setFresh] = useState<SystemAlert[]>([]);
  // Ids seen in any successful fetch; null until the first one lands.
  const knownIdsRef = useRef<Set<number> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await fetchAlerts();
      const known = knownIdsRef.current;
      if (known) {
        const arrived = list.filter((a) => !known.has(a.id));
        if (arrived.length > 0) setFresh((prev) => [...prev, ...arrived]);
        for (const a of list) known.add(a.id);
      } else {
        knownIdsRef.current = new Set(list.map((a) => a.id));
      }
      setAlerts(list);
    } catch {
      // Non-critical — swallow rather than blocking the app.
    }
  }, []);

  useEffect(() => {
    if (!authReady) return;
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
