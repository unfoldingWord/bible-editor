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
import { explainRefusal, willRetryOnItsOwn } from "../sync/refusalReason";
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

// What to print under a failed op's target line. A refusal shows the server's
// own explanation in plain words (issue #370 — "http 400" told the translator
// nothing, so a correct refusal read as data loss). A retryable failure has no
// server explanation to give, so it says what is actually happening instead.
function failureLine(op: OutboxOp): string {
  // The retry cap is consumed only by 408/425/429/5xx — the server answering,
  // just not with a success — so "could not be reached" would be wrong here.
  if (willRetryOnItsOwn(op.lastError)) return "not saved yet — several attempts did not complete";
  const explained = explainRefusal(op.lastErrorReason);
  if (explained) return explained;
  // No parseable body (an HTML error page, an empty body, or the client-side
  // bodyless read-only ApiError). Keep the bare status visible rather than
  // replacing it with a generic sentence — `http 403` is where a support
  // conversation starts, and dropping it is what issue #370 was about.
  return op.lastError
    ? `The server would not accept this change (${op.lastError}).`
    : "The server would not accept this change.";
}

// Clipboard write with the textarea fallback (the Clipboard API needs a
// focused document and rejects otherwise). Returns whether the copy actually
// landed — callers must not flip a button to "copied" on a write that failed,
// since this is the user's last copy of the edit.
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
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
      return ok;
    } catch {
      return false;
    }
  }
}

// The text a discard dialog hands back to the user: what the edit targeted,
// plus the payload itself.
function opClipboardText(op: OutboxOp): string {
  return `${formatOpLabel(op)}\n${JSON.stringify(op.patch, null, 2)}`;
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
  // Two very different situations used to share one "N failed" list: a server
  // refusal that will never succeed, and a retry-cap timeout that revives by
  // itself the moment the connection or session comes back. Splitting them
  // stops the second from reading as permanent loss (issue #370).
  const refused = failed.filter((o) => !willRetryOnItsOwn(o.lastError));
  const stalled = failed.filter((o) => willRetryOnItsOwn(o.lastError));

  // "Discard all" permanently deletes queued edits — gate it behind an
  // explicit confirm so it can't be a one-misclick data loss.
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);
  const [copiedDiscardAll, setCopiedDiscardAll] = useState(false);
  // The dialog's open condition also depends on there being something to
  // discard, so an empty refused list hides it — but left the flag raised,
  // and the *next* refusal would then pop the confirm with no click behind
  // it. Lower the flag when the list empties (retry / cross-tab revival).
  useEffect(() => {
    if (refused.length === 0) {
      setConfirmDiscardAll(false);
      setCopiedDiscardAll(false);
    }
  }, [refused.length]);

  // Single-op "discard this edit" confirm — same one-misclick protection as
  // "discard all". Snapshot of the op at click time; the dialog auto-closes
  // if the op leaves the failed list (retry / auto-revival).
  const [confirmDropOp, setConfirmDropOp] = useState<OutboxOp | null>(null);
  const [copiedDropOp, setCopiedDropOp] = useState(false);
  const closeDropOp = () => { setConfirmDropOp(null); setCopiedDropOp(false); };
  // Resolve against the LIVE failed list rather than reusing the click-time
  // snapshot: a cross-tab retry can change why the op is failing, and the
  // dialog's copy now depends on that (refused vs still-trying). Still null
  // when the op leaves the failed list, so the auto-close below is unchanged,
  // and the drop itself remains guarded by onlyIfStatus at click time.
  const liveDropOp = (confirmDropOp && failed.find((f) => f.id === confirmDropOp.id)) || null;
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
    const text = liveUnresolvable.map(opClipboardText).join("\n\n");
    // This is the user's last copy of the edit — never flip to "copied" unless
    // the write actually landed.
    if (await copyText(text)) setCopiedUnresolvable(true);
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
    // Each group gets its OWN chip rather than one chip summing both. A single
    // count either mislabels (red "4 not saved" when only 1 was refused) or
    // hides (red "1 refused" while 3 more sit unsaved) — and the panel below
    // splits them anyway, so the top bar has to agree with it. Amber for the
    // still-trying group matches the offline chip: transient, not a failure.
    inline = (
      <>
        {refused.length > 0 && (
          <Tooltip title="the server refused these changes — see why below; your saved text is unchanged">
            <Chip
              icon={<ErrorOutlineIcon />}
              label={`${refused.length} refused`}
              size="small"
              variant="outlined"
              color="error"
            />
          </Tooltip>
        )}
        {stalled.length > 0 && (
          <Tooltip title="these changes have not saved yet — they retry when you return to this tab or reconnect">
            <Chip
              icon={<CloudQueueIcon />}
              label={`${stalled.length} not saved yet`}
              size="small"
              variant="outlined"
              sx={{
                color: "#E59D33",
                borderColor: "#E59D33",
                "& .MuiChip-icon": { color: "#E59D33" },
              }}
            />
          </Tooltip>
        )}
      </>
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

  // One row per failed edit: what it was, then why it didn't save. Shared by
  // both groups so a refusal and a stalled retry look and behave the same
  // apart from the sentence underneath.
  const renderFailedOp = (op: OutboxOp) => (
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
        {/* The reason can be a full sentence, so let it wrap rather than
            truncating the half that explains what to do about it. */}
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", fontSize: 10, lineHeight: 1.3 }}
        >
          {failureLine(op)}
        </Typography>
      </Box>
      <Tooltip title="try saving this change again">
        <IconButton
          size="small"
          color="primary"
          onClick={() => void outbox.retry(op.id)}
          sx={{ p: 0.25 }}
        >
          <RefreshIcon fontSize="inherit" />
        </IconButton>
      </Tooltip>
      <Tooltip title="discard this change">
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
  );

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
            {refused.length > 0 && (
              <Stack spacing={0.25}>
                <Stack direction="row" alignItems="center" justifyContent="space-between">
                  <Typography variant="caption" color="error" sx={{ fontWeight: 600 }}>
                    {refused.length} change{refused.length === 1 ? "" : "s"} refused
                  </Typography>
                  <Tooltip title="discard every change the server refused">
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
                {/* Said once, above the list, rather than on every row: the
                    reassurance is the whole point of issue #370, and the
                    per-row line is already carrying the reason. */}
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, lineHeight: 1.3 }}>
                  Nothing was lost — each verse or note still holds the text it had before.
                </Typography>
                {refused.map(renderFailedOp)}
              </Stack>
            )}
            {refused.length > 0 && stalled.length > 0 && <Divider flexItem />}
            {stalled.length > 0 && (
              <Stack spacing={0.25}>
                <Typography variant="caption" sx={{ fontWeight: 600, color: "#E59D33" }}>
                  {stalled.length} change{stalled.length === 1 ? "" : "s"} not saved yet
                </Typography>
                {/* Says when retrying happens rather than claiming it is
                    continuous. Revival fires on focus, reconnect, or a session
                    refresh (see reviveMaxAttemptsFailed) — not on a timer — and
                    the row's Retry button is the manual route. */}
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, lineHeight: 1.3 }}>
                  The server kept failing to save these. They try again when you come back to
                  this tab or reconnect — or use Retry.
                </Typography>
                {stalled.map(renderFailedOp)}
              </Stack>
            )}
          </Stack>
        </Box>
      )}
      {/* Auto-closes if the failed list empties out from under it (retry /
          auto-revival) — nothing left to discard. */}
      <ConfirmDialog
        open={confirmDiscardAll && refused.length > 0}
        title={`Discard ${refused.length} refused change${refused.length === 1 ? "" : "s"}?`}
        description={`The server did not accept ${refused.length === 1 ? "this change" : "these changes"}, so ${refused.length === 1 ? "the verse or note it belongs to" : "the verses and notes they belong to"} still hold the text they had before. Discarding removes only the unsaved change from this device — copy it first if you want to keep it.`}
        confirmLabel="discard all"
        onCancel={() => { setConfirmDiscardAll(false); setCopiedDiscardAll(false); }}
        onConfirm={async () => {
          // onlyIfRefused, not just onlyIfStatus: another tab may have retried
          // one of these since the dialog opened, so by now it can be a
          // will-retry op — which both classes report as `failed`. Discarding
          // it here would silently drop an edit this very panel promises is
          // coming back. The guard re-checks the stored record at delete time.
          for (const op of refused) {
            await outbox.drop(op.id, { onlyIfStatus: "failed", onlyIfRefused: true });
          }
          setConfirmDiscardAll(false);
          setCopiedDiscardAll(false);
        }}
        // The copy tells the user to copy first, so it has to be possible here
        // too — the single-op and unresolvable-conflict dialogs both offer it.
        extraAction={
          <Button
            onClick={async () => {
              const text = refused.map(opClipboardText).join("\n\n");
              if (await copyText(text)) setCopiedDiscardAll(true);
            }}
          >
            {copiedDiscardAll ? "copied" : "copy edits"}
          </Button>
        }
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
        title="Discard this change?"
        description={
          liveDropOp && willRetryOnItsOwn(liveDropOp.lastError)
            ? "This change has not saved yet — the server kept failing, and it will try again when you come back to this tab or reconnect. Discarding removes it from this device — copy it first if you want to keep it."
            : "The server did not accept this change, so the verse or note still holds the text it had before. Discarding removes only the unsaved change from this device — copy it first if you want to keep it."
        }
        confirmLabel="discard"
        onCancel={closeDropOp}
        onConfirm={async () => {
          if (!liveDropOp) return;
          // Pin the class the user was actually shown. The dialog's wording
          // differs for a refusal ("the verse still holds its previous text")
          // and a will-retry op ("it will try again"), so if another tab moved
          // this op between classes, the confirm no longer means what they read.
          await outbox.drop(liveDropOp.id, {
            onlyIfStatus: "failed",
            onlyIfRefused: !willRetryOnItsOwn(liveDropOp.lastError),
          });
          closeDropOp();
        }}
        extraAction={
          <Button
            onClick={async () => {
              if (!liveDropOp) return;
              if (await copyText(opClipboardText(liveDropOp))) setCopiedDropOp(true);
            }}
          >
            {copiedDropOp ? "copied" : "copy edit"}
          </Button>
        }
        sx={{ zIndex: (t) => t.zIndex.snackbar + 1 }}
      >
        {liveDropOp && (
          <Stack spacing={0.25} sx={{ mt: 1 }}>
            <Typography variant="caption" sx={{ fontFamily: "monospace", display: "block" }}>
              {formatOpLabel(liveDropOp)}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
              {failureLine(liveDropOp)}
            </Typography>
          </Stack>
        )}
      </ConfirmDialog>
    </>
  );
}
