// Bottom-right pill that surfaces outbox state. Without this, a 409 from the
// server marked the op "conflict" in IndexedDB and the queue silently
// stalled — there was no call site for outbox.resolveConflict anywhere in
// the app. This component is intentionally minimal: it shows pending /
// failed / conflict counts and lets the user re-arm conflicted ops against
// the server's current version (last-edit-wins). A proper diff/merge UI is
// docs/plan.md territory and out of scope here.

import { useEffect, useState } from "react";
import { Box, Button, Chip, Stack, Tooltip } from "@mui/material";
import CloudDoneIcon from "@mui/icons-material/CloudDone";
import CloudQueueIcon from "@mui/icons-material/CloudQueue";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { outbox, type OutboxOp } from "../sync/outbox";

interface FreshRow {
  version: number;
}

function isFreshRow(x: unknown): x is FreshRow {
  return typeof x === "object" && x !== null && typeof (x as { version?: unknown }).version === "number";
}

export function SyncStatusBar() {
  const [ops, setOps] = useState<OutboxOp[]>([]);
  useEffect(() => outbox.subscribe(setOps), []);

  const pending = ops.filter((o) => o.status === "pending" || o.status === "in_flight").length;
  const conflicts = ops.filter((o) => o.status === "conflict");
  const failed = ops.filter((o) => o.status === "failed");

  const idle = pending === 0 && conflicts.length === 0 && failed.length === 0;
  if (idle) {
    return (
      <Tooltip title="all edits saved" placement="left">
        <Chip
          icon={<CloudDoneIcon />}
          label="synced"
          size="small"
          variant="outlined"
          sx={{ position: "fixed", right: 12, bottom: 12, opacity: 0.5, "&:hover": { opacity: 1 } }}
        />
      </Tooltip>
    );
  }

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

  return (
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
        {pending > 0 && (
          <Chip
            icon={<CloudQueueIcon />}
            label={`saving ${pending}`}
            size="small"
            color="primary"
            variant="outlined"
          />
        )}
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
  );
}
