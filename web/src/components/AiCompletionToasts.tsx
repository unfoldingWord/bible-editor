// Persistent stack of AI-draft completion toasts. Sits above SyncStatusBar
// in the bottom-right corner. Success entries stay until the user
// dismisses or clicks "View" (which scrolls + activates the originating
// note). Error entries auto-hide after a few seconds. The stack persists
// even while the user is editing a different note — the whole point is
// that an editor can fire-and-forget the AI call.

import { useEffect, useRef } from "react";
import { Alert, IconButton, Stack, Button, Box } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import type { AiDraftNotification } from "../hooks/useAiDrafts";

const ERROR_AUTO_HIDE_MS = 8000;

interface Props {
  notifications: AiDraftNotification[];
  onDismiss: (id: string) => void;
  onView: (rowId: string, verse: number) => void;
}

export function AiCompletionToasts({ notifications, onDismiss, onView }: Props) {
  // Auto-dismiss errors after a delay. Track which we've already armed so
  // we don't reset the timer on every re-render.
  const armed = useRef<Set<string>>(new Set());
  useEffect(() => {
    const timers: number[] = [];
    for (const n of notifications) {
      if (n.kind !== "error") continue;
      if (armed.current.has(n.id)) continue;
      armed.current.add(n.id);
      const elapsed = Date.now() - n.bornAt;
      const remaining = Math.max(0, ERROR_AUTO_HIDE_MS - elapsed);
      timers.push(
        window.setTimeout(() => {
          armed.current.delete(n.id);
          onDismiss(n.id);
        }, remaining),
      );
    }
    return () => {
      timers.forEach((t) => clearTimeout(t));
    };
  }, [notifications, onDismiss]);

  if (notifications.length === 0) return null;

  return (
    <Box
      sx={{
        position: "fixed",
        right: 12,
        // SyncStatusBar sits at bottom: 12 with ~32 px height. Stack above it.
        bottom: 60,
        zIndex: (t) => t.zIndex.snackbar,
        maxWidth: 360,
        pointerEvents: "none",
      }}
    >
      <Stack spacing={1} sx={{ pointerEvents: "auto" }}>
        {notifications.map((n) => (
          <Alert
            key={n.id}
            severity={n.kind === "error" ? "error" : "info"}
            variant="filled"
            icon={n.kind === "success" ? <AutoAwesomeIcon fontSize="small" /> : undefined}
            sx={{ boxShadow: 3, alignItems: "center" }}
            action={
              <>
                {n.kind === "success" && (
                  <Button
                    color="inherit"
                    size="small"
                    onClick={() => {
                      onView(n.rowId, n.verse);
                      onDismiss(n.id);
                    }}
                    sx={{ fontWeight: 600 }}
                  >
                    View
                  </Button>
                )}
                <IconButton
                  size="small"
                  color="inherit"
                  onClick={() => onDismiss(n.id)}
                  aria-label="dismiss"
                >
                  <CloseIcon fontSize="small" />
                </IconButton>
              </>
            }
          >
            {n.kind === "success" ? `AI draft ready · v${n.verse}` : n.message}
          </Alert>
        ))}
      </Stack>
    </Box>
  );
}
