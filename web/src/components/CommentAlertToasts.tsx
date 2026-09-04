// Unobtrusive nudge for a comment reply or @-mention that arrived while this
// tab was open. Small filled Alerts stacked in the bottom-left corner (above
// UnsavedToasts' slot), auto-hiding after a few seconds; the bell keeps the
// alert until the user reads the thread or dismisses it. "View" follows the
// same `?c=<id>` deep link the bell uses. Mirrors AiCompletionToasts.

import { useEffect, useRef } from "react";
import { Alert, Box, Button, IconButton, Stack } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import type { SystemAlert } from "../sync/api";

const AUTO_HIDE_MS = 10_000;

interface Props {
  alerts: SystemAlert[];
  // Toast closed or expired — the alert itself stays in the bell.
  onAck: (id: number) => void;
  // "View": follow the link and clear the alert.
  onView: (alert: SystemAlert) => void;
}

export function CommentAlertToasts({ alerts, onAck, onView }: Props) {
  const armed = useRef<Set<number>>(new Set());
  useEffect(() => {
    const timers: number[] = [];
    for (const a of alerts) {
      if (armed.current.has(a.id)) continue;
      armed.current.add(a.id);
      timers.push(
        window.setTimeout(() => {
          armed.current.delete(a.id);
          onAck(a.id);
        }, AUTO_HIDE_MS),
      );
    }
    return () => {
      timers.forEach((t) => clearTimeout(t));
    };
  }, [alerts, onAck]);

  if (alerts.length === 0) return null;

  return (
    <Box
      sx={{
        position: "fixed",
        left: 12,
        // UnsavedToasts sits at bottom: 12. Stack above it.
        bottom: 60,
        zIndex: (t) => t.zIndex.snackbar,
        maxWidth: 360,
        pointerEvents: "none",
      }}
    >
      <Stack spacing={1} sx={{ pointerEvents: "auto" }}>
        {alerts.map((a) => (
          <Alert
            key={a.id}
            severity="info"
            variant="filled"
            icon={<ChatBubbleOutlineIcon fontSize="small" />}
            sx={{ boxShadow: 3, alignItems: "center" }}
            action={
              <>
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => onView(a)}
                  sx={{ fontWeight: 600 }}
                >
                  View
                </Button>
                <IconButton
                  color="inherit"
                  size="small"
                  aria-label="close"
                  onClick={() => onAck(a.id)}
                >
                  <CloseIcon fontSize="inherit" />
                </IconButton>
              </>
            }
          >
            {a.message}
          </Alert>
        ))}
      </Stack>
    </Box>
  );
}
