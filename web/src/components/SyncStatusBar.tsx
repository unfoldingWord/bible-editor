// Inline "saved/saving/issues" pill (lives in the top bar) plus a floating
// bottom-right action panel that only appears when there are conflicts or
// failed ops that need user input. Without this, a 409 from the server
// marked the op "conflict" in IndexedDB and the queue silently stalled —
// there was no call site for outbox.resolveConflict anywhere in the app.
// A proper diff/merge UI is docs/plan.md territory and out of scope here.

import { useEffect, useState, type ReactNode } from "react";
import { Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Divider, IconButton, ListItemText, Menu, MenuItem, Stack, Tooltip, Typography } from "@mui/material";
import CloudDoneIcon from "@mui/icons-material/CloudDone";
import CloudQueueIcon from "@mui/icons-material/CloudQueue";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import RefreshIcon from "@mui/icons-material/Refresh";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import EditNoteIcon from "@mui/icons-material/EditNote";
import { onOutboxResult, outbox, type OutboxOp, type OpTarget } from "../sync/outbox";
import { drafts, type DraftRecord, type DraftMeta } from "../sync/drafts";

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

// Short label for the failed-ops drawer. Doesn't need to be unique — the
// op.id key handles React reconciliation — just needs to be readable enough
// that the translator can recognize which row didn't save.
function formatTarget(t: OpTarget): string {
  if (t.kind === "row") return `${t.rowKind.toUpperCase()} ${t.book} · ${t.id}`;
  if (t.kind === "verse_status") return `status ${t.book} ${t.chapter}:${t.verse}`;
  return `${t.bibleVersion} ${t.book} ${t.chapter}:${t.verse}`;
}

function formatDraftMeta(m: DraftMeta): string {
  if (m.kind === "verse") return `${m.bibleVersion} ${m.book} ${m.chapter}:${m.verse}`;
  return `${m.rowKind.toUpperCase()} ${m.book} ${m.chapter}:${m.verse}`;
}

interface Props {
  // Optional so the bar still renders standalone (e.g. in a stripped TopBar).
  // When present, the "N unsaved" chip becomes a menu that jumps to each draft.
  onNavigate?: (book: string, chapter: number, verse?: number) => void;
}

export function SyncStatusBar({ onNavigate }: Props = {}) {
  const [ops, setOps] = useState<OutboxOp[]>([]);
  useEffect(() => outbox.subscribe(setOps), []);

  // Draft count chip — unsaved typing the user hasn't clicked Save on yet.
  // Distinct from outbox "saving N": those are in-flight to the server;
  // drafts haven't left the browser.
  const [draftList, setDraftList] = useState<DraftRecord[]>([]);
  useEffect(() => drafts.subscribe(setDraftList), []);
  const draftCount = draftList.length;

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

  // "Discard all" permanently deletes queued edits — gate it behind an
  // explicit confirm so it can't be a one-misclick data loss.
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);

  // Anchor for the "N unsaved" jump menu (only used when onNavigate is wired).
  const [draftMenuEl, setDraftMenuEl] = useState<null | HTMLElement>(null);

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
  } else if (draftCount === 0) {
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
  } else {
    // Drafts exist but no server-side activity — the unsaved chip alone tells
    // the truth; showing "saved" next to "N unsaved" is contradictory.
    inline = null;
  }

  const showFloating = conflicts.length > 0 || failed.length > 0;

  // The drafts chip rides alongside the outbox chip. It surfaces unsaved
  // typing — distinct from "saving N" which is server in-flight. When
  // onNavigate is wired it's clickable: opens a menu that jumps to each draft;
  // otherwise it falls back to a passive tooltip listing them.
  const draftDirtyColorSx = {
    color: "#E59D33",
    borderColor: "#E59D33",
    "& .MuiChip-icon": { color: "#E59D33" },
  } as const;

  const navigateToDraft = (m: DraftMeta) => {
    onNavigate?.(m.book, m.chapter, m.verse);
    setDraftMenuEl(null);
  };

  let draftsChip: ReactNode = null;
  if (draftCount > 0 && onNavigate) {
    draftsChip = (
      <Tooltip title="jump to an unsaved edit">
        <Chip
          icon={<EditNoteIcon />}
          label={`${draftCount} unsaved`}
          size="small"
          variant="outlined"
          clickable
          onClick={(e) => setDraftMenuEl(e.currentTarget)}
          sx={draftDirtyColorSx}
        />
      </Tooltip>
    );
  } else if (draftCount > 0) {
    const draftsTooltip = (
      <Stack spacing={0.25}>
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {draftCount} unsaved edit{draftCount === 1 ? "" : "s"}:
        </Typography>
        {draftList.map((d) => (
          <Typography
            key={d.key}
            variant="caption"
            sx={{ fontFamily: "monospace", display: "block" }}
          >
            {formatDraftMeta(d.meta)}
          </Typography>
        ))}
      </Stack>
    );
    draftsChip = (
      <Tooltip title={draftsTooltip}>
        <Chip
          icon={<EditNoteIcon />}
          label={`${draftCount} unsaved`}
          size="small"
          variant="outlined"
          sx={draftDirtyColorSx}
        />
      </Tooltip>
    );
  }

  return (
    <>
      <Stack direction="row" spacing={0.5} alignItems="center">
        {draftsChip}
        {inline}
      </Stack>
      {onNavigate && (
        <Menu
          anchorEl={draftMenuEl}
          open={Boolean(draftMenuEl) && draftCount > 0}
          onClose={() => setDraftMenuEl(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
          transformOrigin={{ vertical: "top", horizontal: "right" }}
        >
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ px: 2, py: 0.5, display: "block" }}
          >
            {draftCount} unsaved edit{draftCount === 1 ? "" : "s"} — click to jump
          </Typography>
          {draftList.map((d) => (
            <MenuItem key={d.key} onClick={() => navigateToDraft(d.meta)} dense>
              <ListItemText
                primaryTypographyProps={{ sx: { fontFamily: "monospace", fontSize: 13 } }}
              >
                {formatDraftMeta(d.meta)}
              </ListItemText>
            </MenuItem>
          ))}
        </Menu>
      )}
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
            maxWidth: 360,
            zIndex: (t) => t.zIndex.snackbar,
          }}
        >
          <Stack spacing={0.75}>
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
            {failed.length > 0 && conflicts.length > 0 && <Divider flexItem />}
            {failed.length > 0 && (
              <Stack spacing={0.25}>
                <Stack direction="row" alignItems="center" justifyContent="space-between">
                  <Typography variant="caption" color="error" sx={{ fontWeight: 600 }}>
                    {failed.length} failed
                  </Typography>
                  <Tooltip title="discard all failed edits">
                    <Button
                      size="small"
                      variant="text"
                      color="error"
                      onClick={() => setConfirmDiscardAll(true)}
                      sx={{ minWidth: 0, py: 0, fontSize: 11 }}
                    >
                      discard all
                    </Button>
                  </Tooltip>
                </Stack>
                {failed.map((op) => (
                  <Stack
                    key={op.id}
                    direction="row"
                    alignItems="center"
                    spacing={0.5}
                    sx={{
                      bgcolor: "action.hover",
                      borderRadius: 0.5,
                      px: 0.75,
                      py: 0.25,
                    }}
                  >
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography
                        variant="caption"
                        sx={{
                          display: "block",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          fontFamily: "monospace",
                        }}
                      >
                        {formatTarget(op.target)}
                      </Typography>
                      {op.lastError && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{
                            display: "block",
                            fontSize: 10,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {op.lastError}
                        </Typography>
                      )}
                    </Box>
                    <Tooltip title="retry this edit">
                      <IconButton
                        size="small"
                        color="primary"
                        onClick={() => void outbox.retry(op.id)}
                        sx={{ p: 0.25 }}
                      >
                        <RefreshIcon fontSize="inherit" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="discard this edit">
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => void outbox.drop(op.id)}
                        sx={{ p: 0.25 }}
                      >
                        <DeleteOutlineIcon fontSize="inherit" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                ))}
              </Stack>
            )}
          </Stack>
        </Box>
      )}
      <Dialog
        // Auto-closes if the failed list empties out from under it (retry /
        // auto-revival) — nothing left to discard.
        open={confirmDiscardAll && failed.length > 0}
        onClose={() => setConfirmDiscardAll(false)}
      >
        <DialogTitle>
          Discard {failed.length} failed edit{failed.length === 1 ? "" : "s"}?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            These edits never reached the server. Discarding deletes them from
            this device permanently — they cannot be recovered.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDiscardAll(false)}>cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={async () => {
              for (const op of failed) await outbox.drop(op.id);
              setConfirmDiscardAll(false);
            }}
          >
            discard all
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
