// Inline "saved/saving/issues" pill (lives in the top bar) plus a floating
// bottom-right action panel that only appears when there are conflicts or
// failed ops that need user input. Without this, a 409 from the server
// marked the op "conflict" in IndexedDB and the queue silently stalled —
// there was no call site for outbox.resolveConflict anywhere in the app.
// A proper diff/merge UI is docs/plan.md territory and out of scope here.

import { useEffect, useState, type ReactNode } from "react";
import { Box, Button, Chip, Divider, IconButton, ListItemText, Menu, MenuItem, Stack, Tooltip, Typography } from "@mui/material";
import { ConfirmDialog } from "./ConfirmDialog";
import CloudDoneIcon from "@mui/icons-material/CloudDone";
import CloudQueueIcon from "@mui/icons-material/CloudQueue";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import RefreshIcon from "@mui/icons-material/Refresh";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import EditNoteIcon from "@mui/icons-material/EditNote";
import { outbox, type OutboxOp, type OpTarget } from "../sync/outbox";
import { drafts, type DraftRecord, type DraftMeta } from "../sync/drafts";

// If the oldest pending/in-flight op has been queued longer than this, treat
// it as effectively offline — navigator.onLine returns true on any LAN even
// with no real internet. Picked 30s because outbox backoff caps there: by
// then at least one full retry has been attempted and failed.
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
  if (t.kind === "lane_check") return `${t.lane} check ${t.book} ${t.chapter}:${t.verse}`;
  return `${t.bibleVersion} ${t.book} ${t.chapter}:${t.verse}`;
}

// Label for the unresolvable-conflict dialog and its clipboard copy — one
// definition so what the user reads on screen always matches what they paste.
// A delete op carries no content (patch is {}), so say what the intent was.
function formatOpLabel(op: OutboxOp): string {
  return `${formatTarget(op.target)}${op.action === "delete" ? " (delete)" : ""}`;
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

  // Track navigator.onLine so we can distinguish "actively saving" from
  // "queueing because we have no internet".
  const [online, setOnline] = useState<boolean>(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
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

  const pendingOps = ops.filter((o) => o.status === "pending" || o.status === "in_flight");
  const pending = pendingOps.length;
  const conflicts = ops.filter((o) => o.status === "conflict");
  const failed = ops.filter((o) => o.status === "failed");

  // "Discard all" permanently deletes queued edits — gate it behind an
  // explicit confirm so it can't be a one-misclick data loss.
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);

  // Single-op "discard this edit" confirm — same one-misclick protection as
  // "discard all". Snapshot of the op at click time; the dialog auto-closes
  // if the op leaves the failed list (retry / auto-revival).
  const [confirmDropOp, setConfirmDropOp] = useState<OutboxOp | null>(null);
  const [copiedDropOp, setCopiedDropOp] = useState(false);
  const closeDropOp = () => { setConfirmDropOp(null); setCopiedDropOp(false); };
  const liveDropOp = confirmDropOp && failed.some((f) => f.id === confirmDropOp.id)
    ? confirmDropOp
    : null;
  useEffect(() => {
    if (confirmDropOp && !liveDropOp) setConfirmDropOp(null);
  }, [confirmDropOp, liveDropOp]);

  // Conflicts whose 409 body carried no current row/version: resolve can't
  // re-arm them, and dropping deletes the edit — same one-misclick data-loss
  // stakes as "discard all", so they get the same confirm gate. Snapshot of
  // the ops at resolve-click time.
  const [unresolvableOps, setUnresolvableOps] = useState<OutboxOp[]>([]);
  const [copiedUnresolvable, setCopiedUnresolvable] = useState(false);
  const closeUnresolvable = () => {
    setUnresolvableOps([]);
    setCopiedUnresolvable(false);
  };

  // Live view of that snapshot: an op that has since left conflict status in
  // this tab (a same-target resolve re-armed it, or it was dropped elsewhere)
  // falls out of the dialog's count/list/copy/discard, so the user only ever
  // confirms what will actually be deleted. Cross-tab changes never reach
  // this tab's subscription — outbox.drop's onlyIfStatus guard is the
  // backstop there.
  const conflictIds = new Set(conflicts.map((c) => c.id));
  const liveUnresolvable = unresolvableOps.filter((op) => conflictIds.has(op.id));
  const oneUnresolvable = liveUnresolvable.length === 1;

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

  // Stale-progress: treat as effectively offline when the oldest pending or
  // in-flight op has been queued for longer than STALE_PROGRESS_MS. Each op
  // carries queuedAt from enqueue time, so this naturally resets when the
  // queue drains and a fresh op arrives — unlike the old lastSuccessAt clock
  // which was mount-seeded and never reset on new enqueues, causing false
  // alarms for translators who save less often than every 30s.
  const oldestQueuedAt = pendingOps.length > 0
    ? Math.min(...pendingOps.map((o) => o.queuedAt))
    : 0;
  const staleProgress = pendingOps.length > 0 && now - oldestQueuedAt > STALE_PROGRESS_MS;
  const effectivelyOffline = !online || staleProgress;

  const resolveAllConflicts = async () => {
    // The 409 response includes the server's current row in op.conflictCurrent —
    // re-queue against its version so the next dispatch sails through. The
    // user's local patch overwrites the upstream change (last-edit-wins).
    // If the server didn't return a current row we can't re-arm, and dropping
    // deletes the user's edit — never do that silently; route it through the
    // confirm dialog below (with copy-to-clipboard) instead. Partition and
    // surface the dialog BEFORE any awaits: if a resolveConflict below throws,
    // the unresolvable ops must still get their dialog rather than vanish
    // until the next click.
    const unresolvable: OutboxOp[] = [];
    const fresh: Array<{ id: string; version: number }> = [];
    for (const op of conflicts) {
      if (isFreshRow(op.conflictCurrent)) {
        fresh.push({ id: op.id, version: op.conflictCurrent.version });
      } else {
        unresolvable.push(op);
      }
    }
    // Set unconditionally — an empty result must also clear any stale
    // snapshot left from an earlier click.
    setUnresolvableOps(unresolvable);
    for (const f of fresh) {
      await outbox.resolveConflict(f.id, f.version);
    }
  };

  const copyUnresolvable = async () => {
    const text = liveUnresolvable
      .map((op) => `${formatOpLabel(op)}\n${JSON.stringify(op.patch, null, 2)}`)
      .join("\n\n");
    // This is the user's last copy of the edit — never flip to "copied" unless
    // the write actually landed. Clipboard API needs a focused document; fall
    // back to the textarea trick when it rejects.
    try {
      await navigator.clipboard.writeText(text);
      setCopiedUnresolvable(true);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        if (ok) setCopiedUnresolvable(true);
      } catch {
        /* both copy paths failed — keep the label "copy edits" rather than
           claim a copy that never landed */
      }
    }
  };

  const discardUnresolvable = async () => {
    // onlyIfStatus: another tab may have re-armed one of these ops to pending
    // (about to save) since the dialog opened — a plain drop would delete
    // that live edit. Only ops still in conflict are dropped; anything else
    // stays queued and remains visible via the normal chips.
    for (const op of liveUnresolvable) {
      await outbox.drop(op.id, { onlyIfStatus: "conflict" });
    }
    closeUnresolvable();
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
                        onClick={() => { setConfirmDropOp(op); setCopiedDropOp(false); }}
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
      {/* Auto-closes if the failed list empties out from under it (retry /
          auto-revival) — nothing left to discard. */}
      <ConfirmDialog
        open={confirmDiscardAll && failed.length > 0}
        title={`Discard ${failed.length} failed edit${failed.length === 1 ? "" : "s"}?`}
        description="These edits never reached the server. Discarding deletes them from this device permanently — they cannot be recovered."
        confirmLabel="discard all"
        onCancel={() => setConfirmDiscardAll(false)}
        onConfirm={async () => {
          for (const op of failed) await outbox.drop(op.id, { onlyIfStatus: "failed" });
          setConfirmDiscardAll(false);
        }}
        sx={{ zIndex: (t) => t.zIndex.snackbar + 1 }}
      />
      {/* Auto-closes when every unresolvable op leaves conflict status. */}
      <ConfirmDialog
        open={liveUnresolvable.length > 0}
        title={`Discard ${liveUnresolvable.length} unresolvable conflict${oneUnresolvable ? "" : "s"}?`}
        description={`The server did not send back its current version for ${oneUnresolvable ? "this edit" : "these edits"}, so ${oneUnresolvable ? "it" : "they"} cannot be retried automatically. Discarding deletes ${oneUnresolvable ? "it" : "them"} from this device permanently — copy ${oneUnresolvable ? "it" : "them"} first if you want to keep the text.`}
        confirmLabel="discard"
        onCancel={closeUnresolvable}
        onConfirm={() => void discardUnresolvable()}
        extraAction={
          <Button onClick={() => void copyUnresolvable()}>
            {copiedUnresolvable ? "copied" : "copy edits"}
          </Button>
        }
        sx={{ zIndex: (t) => t.zIndex.snackbar + 1 }}
      >
        <Stack spacing={0.25} sx={{ mt: 1 }}>
          {liveUnresolvable.map((op) => (
            <Typography
              key={op.id}
              variant="caption"
              sx={{ fontFamily: "monospace", display: "block" }}
            >
              {formatOpLabel(op)}
            </Typography>
          ))}
        </Stack>
      </ConfirmDialog>
      {/* Single-op discard — auto-closes when the op leaves failed status. */}
      <ConfirmDialog
        open={liveDropOp !== null}
        title="Discard this edit?"
        description="This edit never reached the server. Discarding deletes it from this device permanently — copy it first if you want to keep the text."
        confirmLabel="discard"
        onCancel={closeDropOp}
        onConfirm={async () => {
          if (!liveDropOp) return;
          await outbox.drop(liveDropOp.id, { onlyIfStatus: "failed" });
          closeDropOp();
        }}
        extraAction={
          <Button
            onClick={async () => {
              if (!liveDropOp) return;
              const text = `${formatOpLabel(liveDropOp)}\n${JSON.stringify(liveDropOp.patch, null, 2)}`;
              try {
                await navigator.clipboard.writeText(text);
                setCopiedDropOp(true);
              } catch {
                try {
                  const ta = document.createElement("textarea");
                  ta.value = text;
                  ta.style.position = "fixed";
                  ta.style.opacity = "0";
                  document.body.appendChild(ta);
                  ta.select();
                  const ok = document.execCommand("copy");
                  ta.remove();
                  if (ok) setCopiedDropOp(true);
                } catch { /* keep button label as-is */ }
              }
            }}
          >
            {copiedDropOp ? "copied" : "copy edit"}
          </Button>
        }
        sx={{ zIndex: (t) => t.zIndex.snackbar + 1 }}
      >
        {liveDropOp && (
          <Typography
            variant="caption"
            sx={{ fontFamily: "monospace", display: "block", mt: 1 }}
          >
            {formatOpLabel(liveDropOp)}
          </Typography>
        )}
      </ConfirmDialog>
    </>
  );
}
