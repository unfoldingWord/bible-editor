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
