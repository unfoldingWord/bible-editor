// Inline "saved/saving/issues" pill (lives in the top bar) plus a floating
// bottom-right action panel that only appears when there are conflicts or
// failed ops that need user input. Without this, a 409 from the server
// marked the op "conflict" in IndexedDB and the queue silently stalled —
// there was no call site for outbox.resolveConflict anywhere in the app.
// A proper diff/merge UI is docs/plan.md territory and out of scope here.

import { useEffect, useState, type ReactNode } from "react";
import { Box, Button, Chip, Stack, Tooltip } from "@mui/material";
import CloudDoneIcon from "@mui/icons-material/CloudDone";
import CloudQueueIcon from "@mui/icons-material/CloudQueue";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { onOutboxResult, outbox, type OutboxOp } from "../sync/outbox";

// If we believe we're online but haven't seen a successful save in this
// long while pending ops exist, treat it as effectively offline —
// navigator.onLine returns true on any LAN even with no real internet.
// Picked 30s because outbox backoff caps there: by then at least one full
// retry has been attempted and failed.
const STALE_PROGRESS_MS = 30_000;

interface FreshRow {
  version: number;
}

function isFreshRow(x: unknown): x is FreshRow {
  return typeof x === "object" && x !== null && typeof (x as { version?: unknown }).version === "number";
}

export function SyncStatusBar() {
  const [ops, setOps] = useState<OutboxOp[]>([]);
  useEffect(() => outbox.subscribe(setOps), []);

  // Track navigator.onLine + last successful drain so we can distinguish
  // "actively saving" from "queueing because we have no internet". A separate
  // "stale-progress" check guards against navigator.onLine lying (it goes
  // true on any LAN regardless of actual reachability).
  const [online, setOnline] = useState<boolean>(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [lastSuccessAt, setLastSuccessAt] = useState<number>(() => Date.now());
  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);
  useEffect(() =>
    onOutboxResult((_op, result) => {
      if (result.kind === "ok") setLastSuccessAt(Date.now());
    }),
  []);

  const pending = ops.filter((o) => o.status === "pending" || o.status === "in_flight").length;
  const conflicts = ops.filter((o) => o.status === "conflict");
  const failed = ops.filter((o) => o.status === "failed");

  // Tick once a second when pending > 0 so the "stale progress" heuristic
  // can flip the pill to offline-style without waiting for the next outbox
  // event. Cheap: 1Hz timer only when there's actually work outstanding.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (pending === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pending]);
  const effectivelyOffline = !online || (pending > 0 && now - lastSuccessAt > STALE_PROGRESS_MS);

  const resolveAllConflicts = async () => {
    for (const op of conflicts) {
      // The 409 response includes the server's current row in op.conflictCurrent —
      // re-queue against its version so the next dispatch sails through. The
      // user's local patch overwrites the upstream change (last-edit-wins).
      // If the server didn't return a current row, drop the op rather than
      // strand it forever.
      if (isFreshRow(op.conflictCurrent)) {
        await outbox.resolveConflict(op.id, op.conflictCurrent.version);
      } else {
        await outbox.drop(op.id);
      }
    }
  };

  // Priority: conflicts > failed > offline > saving > saved.
  // Conflicts and failed always win because they need user action regardless
  // of connection state. Offline outranks "saving N" because they describe
  // the same fact (ops queued, no progress) — offline is the honest framing.
  let inline: ReactNode;
  if (conflicts.length > 0) {
    inline = (
      <Tooltip title="some edits conflict with the server — resolve below">
        <Chip
          icon={<WarningAmberIcon />}
          label={`${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`}
          size="small"
          variant="outlined"
          color="warning"
        />
      </Tooltip>
    );
  } else if (failed.length > 0) {
    inline = (
      <Tooltip title="some edits failed permanently — discard below">
        <Chip
          icon={<ErrorOutlineIcon />}
          label={`${failed.length} failed`}
          size="small"
          variant="outlined"
          color="error"
        />
      </Tooltip>
    );
  } else if (effectivelyOffline) {
    const offlineLabel = pending > 0
      ? `${pending} queued — ${online ? "reconnecting…" : "offline"}`
      : online ? "reconnecting…" : "offline";
    const offlineTooltip = pending > 0
      ? `${pending} edit${pending === 1 ? "" : "s"} queued locally. ${online ? "Trying to reach the server…" : "Will save when back online."}`
      : online ? "trying to reach the server…" : "you are offline";
    // Kindle warning accent (#E59D33 from CLAUDE.md brand palette) — offline
    // is a transient state, not a failure, so the MUI default error red is
    // wrong tone.
    inline = (
      <Tooltip title={offlineTooltip}>
        <Chip
          icon={<CloudQueueIcon />}
          label={offlineLabel}
          size="small"
          variant="outlined"
          sx={{
            color: "#E59D33",
            borderColor: "#E59D33",
            "& .MuiChip-icon": { color: "#E59D33" },
          }}
        />
      </Tooltip>
    );
  } else if (pending > 0) {
    inline = (
      <Tooltip title={`saving ${pending} edit${pending === 1 ? "" : "s"} to the cloud…`}>
        <Chip
          icon={<CloudQueueIcon />}
          label={`saving ${pending}`}
          size="small"
          variant="outlined"
          color="primary"
        />
      </Tooltip>
    );
  } else {
    inline = (
      <Tooltip title="all your edits are saved to the cloud">
        <Chip
          icon={<CloudDoneIcon />}
          label="saved"
          size="small"
          variant="outlined"
          color="success"
          sx={{ opacity: 0.6, "&:hover": { opacity: 1 } }}
        />
      </Tooltip>
    );
  }

  const showFloating = conflicts.length > 0 || failed.length > 0;

  return (
    <>
      {inline}
      {showFloating && (
        <Box
          sx={{
            position: "fixed",
            right: 12,
            bottom: 12,
            bgcolor: "background.paper",
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 1,
            boxShadow: 2,
            px: 1.25,
            py: 0.75,
            zIndex: (t) => t.zIndex.snackbar,
          }}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            {conflicts.length > 0 && (
              <Tooltip title="version mismatch — retry with current server version (your edit wins)">
                <Button
                  size="small"
                  variant="contained"
                  color="warning"
                  startIcon={<WarningAmberIcon />}
                  onClick={resolveAllConflicts}
                >
                  resolve {conflicts.length} conflict{conflicts.length === 1 ? "" : "s"}
                </Button>
              </Tooltip>
            )}
            {failed.length > 0 && (
              <Tooltip title="these edits will not be retried — click to discard">
                <Button
                  size="small"
                  variant="outlined"
                  color="error"
                  startIcon={<ErrorOutlineIcon />}
                  onClick={async () => {
                    for (const op of failed) await outbox.drop(op.id);
                  }}
                >
                  {failed.length} failed
                </Button>
              </Tooltip>
            )}
          </Stack>
        </Box>
      )}
    </>
  );
}
