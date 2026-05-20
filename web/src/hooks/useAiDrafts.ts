// Async lifecycle for /api/tn-quick drafts.
//
// The request is owned at the Shell level (not in NoteCard) so the call
// can survive the user navigating away from the originating note,
// scrolling it off-screen, or editing a different note. When the result
// lands we update the row through the existing pipeline (in-memory
// patch + outbox), then surface completion two ways:
//
//   - in viewport: NoteCard reads `recentlyCompletedAt(rowId)` and
//     pulses for ~4 s, no toast.
//   - off-screen: a sticky entry in `notifications`; user clicks "View"
//     to scroll the card back into focus. The notification persists
//     across other edits until the user dismisses it.
//
// In-flight calls abort if Shell unmounts (chapter or book change).
// Cross-chapter persistence is intentionally a v3 — for now the
// expectation is "click sparkles, stay in this chapter until it lands."

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type TnRow, type TnQuickRequest, type TnQuickResponse } from "../sync/api";

const PULSE_MS = 4000;
const RETRY_DELAY_MS = 2000;

export interface AiDraftNotification {
  id: string;            // stable per-(rowId, startedAt); used as React key
  rowId: string;
  verse: number;
  kind: "success" | "error";
  message: string;       // for errors; for success it's a fixed "AI draft ready"
  bornAt: number;
}

interface PendingRecord {
  controller: AbortController;
  startedAt: number;
  // The TnRow snapshot at the moment we fired. We need .version to
  // pass the right If-Match through outbox, and the verse for the
  // toast text.
  row: TnRow;
}

export interface UseAiDraftsAPI {
  isPending: (rowId: string) => boolean;
  recentlyCompletedAt: (rowId: string) => number | null;
  notifications: AiDraftNotification[];
  start: (row: TnRow, request: TnQuickRequest, opts: StartOptions) => void;
  // Synthetic error path used by Shell when buildTnQuickRequest fails
  // before we even fire the call (missing ULT/UST, unalignable English).
  // Keeps all AI-flavored errors flowing through the same toast stack.
  pushError: (row: TnRow, message: string) => void;
  dismiss: (notificationId: string) => void;
  abortAll: () => void;
}

export interface StartOptions {
  // Called when the request returns with a successful result, BEFORE
  // we set the recently-completed flag. Shell wires this to
  // applyLocalRowPatch + outbox.enqueueRow.
  onSuccess: (row: TnRow, result: TnQuickResponse) => void;
  // Read at COMPLETION time: true when the card is currently in
  // viewport. If true, no toast; only the pulse. If false, a toast is
  // appended so the user knows the result landed.
  getIsVisible: (rowId: string) => boolean;
}

function mapAiError(err: unknown): string {
  if (err instanceof ApiError) {
    const code =
      err.body && typeof err.body === "object" && "error" in err.body
        ? String((err.body as { error?: unknown }).error)
        : "";
    switch (code) {
      case "unknown_issue_type":
        return "Issue type not recognized.";
      case "unknown_book":
        return "Unknown book code.";
      case "no_rtl":
        return "Quote has no Hebrew characters.";
      case "hebrew_words_not_in_verse":
        return "Couldn't validate Hebrew against the verse.";
      case "body_too_large":
        return "Verse context too large.";
      case "rate_limited":
        return "Rate limited — wait 30 s.";
      case "model_call_failed":
        return "AI service unavailable.";
      case "tn_quick_disabled":
        return "AI not configured — admin must set BT_API_TOKEN.";
      case "anthropic_api_key_missing":
        return "AI not configured — admin must set the Anthropic API key.";
      case "cache_unavailable":
        return "AI cache unavailable — try again shortly.";
      case "uhb_missing_for_verse":
        return "Hebrew source not available for this verse.";
      case "unauthorized":
        return "Session expired — sign in again.";
      default:
        return `AI request failed (HTTP ${err.status}).`;
    }
  }
  if (err instanceof DOMException && err.name === "AbortError") return "";
  if (err instanceof Error && err.message) return err.message;
  return "Network error.";
}

export function useAiDrafts(): UseAiDraftsAPI {
  const [pending, setPending] = useState<Map<string, PendingRecord>>(() => new Map());
  const [completedAt, setCompletedAt] = useState<Map<string, number>>(() => new Map());
  const [notifications, setNotifications] = useState<AiDraftNotification[]>([]);

  // Refs so async callbacks read current values without re-binding the
  // setters every keystroke.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const isPending = useCallback((rowId: string) => pending.has(rowId), [pending]);
  const recentlyCompletedAt = useCallback(
    (rowId: string) => completedAt.get(rowId) ?? null,
    [completedAt],
  );

  const dismiss = useCallback((notificationId: string) => {
    setNotifications((cur) => cur.filter((n) => n.id !== notificationId));
  }, []);

  const pushError = useCallback((row: TnRow, message: string) => {
    if (!message) return;
    setNotifications((cur) => [
      ...cur,
      {
        id: `${row.id}-${Date.now()}-err`,
        rowId: row.id,
        verse: row.verse,
        kind: "error",
        message,
        bornAt: Date.now(),
      },
    ]);
  }, []);

  const start = useCallback(
    (row: TnRow, request: TnQuickRequest, opts: StartOptions) => {
      // Idempotent on rapid double-click: if a request is already in
      // flight for this row, abort it and start fresh. The old
      // promise's .then will see signal.aborted and bail.
      const existing = pendingRef.current.get(row.id);
      if (existing) existing.controller.abort();

      const controller = new AbortController();
      const startedAt = Date.now();
      const record: PendingRecord = { controller, startedAt, row };
      setPending((m) => {
        const next = new Map(m);
        next.set(row.id, record);
        return next;
      });

      const finishPending = () => {
        setPending((m) => {
          if (m.get(row.id)?.controller !== controller) return m;
          const next = new Map(m);
          next.delete(row.id);
          return next;
        });
      };

      const handleSuccess = (res: TnQuickResponse) => {
        if (controller.signal.aborted) return;
        opts.onSuccess(row, res);
        const now = Date.now();
        setCompletedAt((m) => {
          const next = new Map(m);
          next.set(row.id, now);
          return next;
        });
        // Clear the pulse after PULSE_MS.
        setTimeout(() => {
          setCompletedAt((m) => {
            if (m.get(row.id) !== now) return m;
            const next = new Map(m);
            next.delete(row.id);
            return next;
          });
        }, PULSE_MS);
        if (!opts.getIsVisible(row.id)) {
          setNotifications((cur) => [
            ...cur,
            {
              id: `${row.id}-${startedAt}`,
              rowId: row.id,
              verse: row.verse,
              kind: "success",
              message: "AI draft ready",
              bornAt: now,
            },
          ]);
        }
        finishPending();
      };

      const handleError = (err: unknown) => {
        if (controller.signal.aborted) return;
        const message = mapAiError(err);
        if (message) {
          setNotifications((cur) => [
            ...cur,
            {
              id: `${row.id}-${startedAt}-err`,
              rowId: row.id,
              verse: row.verse,
              kind: "error",
              message,
              bornAt: Date.now(),
            },
          ]);
        }
        finishPending();
      };

      // Auto-retry once on 502 model_call_failed per the bot's contract.
      const callOnce = () => api.tnQuick(request, controller.signal);
      callOnce()
        .then(handleSuccess)
        .catch((err: unknown) => {
          const code =
            err instanceof ApiError &&
            err.body &&
            typeof err.body === "object" &&
            "error" in err.body
              ? (err.body as { error?: unknown }).error
              : null;
          if (err instanceof ApiError && err.status === 502 && code === "model_call_failed") {
            new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, RETRY_DELAY_MS);
              controller.signal.addEventListener("abort", () => {
                clearTimeout(t);
                reject(new DOMException("aborted", "AbortError"));
              });
            })
              .then(callOnce)
              .then(handleSuccess)
              .catch(handleError);
          } else {
            handleError(err);
          }
        });
    },
    [],
  );

  const abortAll = useCallback(() => {
    for (const { controller } of pendingRef.current.values()) {
      controller.abort();
    }
  }, []);

  // Abort everything when this hook unmounts — Shell typically owns it
  // and unmounts on chapter/book changes.
  useEffect(() => () => abortAll(), [abortAll]);

  return useMemo(
    () => ({ isPending, recentlyCompletedAt, notifications, start, pushError, dismiss, abortAll }),
    [isPending, recentlyCompletedAt, notifications, start, pushError, dismiss, abortAll],
  );
}
