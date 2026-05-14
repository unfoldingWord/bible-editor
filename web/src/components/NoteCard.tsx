import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Paper,
  Stack,
  Chip,
  IconButton,
  Typography,
  Box,
  TextField,
  Tooltip,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  FormControlLabel,
  Checkbox,
} from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import AddIcon from "@mui/icons-material/Add";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import SaveIcon from "@mui/icons-material/Save";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import UndoIcon from "@mui/icons-material/Undo";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import type { TnRow } from "../sync/api";
import { useCatalogs } from "../hooks/useCatalogs";
import { CatalogPicker } from "./CatalogPicker";
import { shortSupport } from "../lib/supportReference";

const NoteHistoryDialog = lazy(() =>
  import("./NoteHistoryDialog").then((m) => ({ default: m.NoteHistoryDialog })),
);

export type DropPosition = "before" | "after";

interface Props {
  row: TnRow;
  active: boolean;
  dragging: boolean;
  isDropTarget: boolean;
  // Optimistic local-only apply, fired on every keystroke / chip pick so
  // parent state (e.g. activeQuote-driven highlighting) stays in sync. Does
  // NOT hit the outbox.
  onChange: (patch: Partial<TnRow>) => void;
  // Enqueue a row PATCH. Called once per edit session — at session end
  // (active going false), on manual save, or on unmount. When the patch
  // comes from "switch to v{N}" in the history dialog, opts carries the
  // origin version so the server can mark the new edit_log entry + row
  // column for chip-label purposes.
  onSave: (patch: Partial<TnRow>, opts?: { restoredFromVersion?: number }) => void;
  onDelete: () => void;
  onInsertAfter: () => void;
  onFocus?: () => void;
  onGripDragStart: () => void;
  onDragEnd: () => void;
  onCardDragOver: (position: DropPosition) => void;
  onCardDragLeave: () => void;
  onCardDrop: (position: DropPosition) => void;
  // Async AI-draft lifecycle. State lives in Shell so the call can
  // survive the card un-focusing / scrolling off-screen. NoteCard is
  // purely presentational w.r.t. AI: shows spinner while pending,
  // pulses briefly when a result lands.
  isAiPending?: boolean;
  aiRecentlyCompletedAt?: number | null;
  // Fires the request. Returns immediately; result lands later via the
  // row patch pipeline. Absent => sparkles is hidden.
  onStartAi?: () => void;
  // Reported on intersection changes so Shell can decide whether an
  // arriving AI result needs the persistent off-screen toast or just
  // the in-place pulse. Default root (viewport) is good enough for our
  // resource column scroll setup.
  onVisibilityChange?: (rowId: string, isVisible: boolean) => void;
  // Chapter has an active AI pipeline (state from pipelineStore). When
  // true, untouched rows (updated_by IS NULL) are read-only and show a
  // Keep checkbox; rows the user already touched (or just kept) are
  // editable and show a "Kept" chip. Off → behaves normally.
  locked?: boolean;
  // Called when the user checks the Keep box on an untouched row during a
  // run. Fires POST /api/rows/tn/:id/keep upstream.
  onKeep?: () => void;
}

// Notes coming from TSV imports use literal "\n" (two characters) as the
// line-break marker. tcCreate renders those as real newlines; we do the same
// on read, and on save we write back whatever the user typed verbatim. The
// data in D1 transitions to true newlines as users edit.
function tsvToDisplay(s: string | null): string {
  return (s ?? "").replace(/\\n/g, "\n");
}

interface SessionSnapshot {
  quote: string;
  note: string;
  support_reference: string | null;
}

// True when every pending field equals the snapshot value — i.e. the user
// edited and then reverted (or hit Undo) so there's no net change to
// persist. We use this on flush + on unmount to suppress no-op version
// bumps that would otherwise show up as "v3 → v4" on the row chip.
function pendingMatchesSnapshot(p: Partial<TnRow>, s: SessionSnapshot): boolean {
  if ("quote" in p && p.quote !== s.quote) return false;
  if ("note" in p && p.note !== s.note) return false;
  if ("support_reference" in p && p.support_reference !== s.support_reference) return false;
  return true;
}

export function NoteCard({
  row,
  active,
  dragging,
  isDropTarget,
  onChange,
  onSave,
  onDelete,
  onInsertAfter,
  onFocus,
  onGripDragStart,
  onDragEnd,
  onCardDragOver,
  onCardDragLeave,
  onCardDrop,
  isAiPending = false,
  aiRecentlyCompletedAt = null,
  onStartAi,
  onVisibilityChange,
  locked = false,
  onKeep,
}: Props) {
  // updated_by != null means a human has touched the row at some point; in a
  // locked chapter that's our "keep this row" signal — kept rows stay
  // editable, the auto-apply step skips them when it sweeps untouched TNs.
  const isKept = row.updated_by !== null;
  const readOnly = locked && !isKept;
  const [quote, setQuote] = useState(tsvToDisplay(row.quote));
  const [note, setNote] = useState(tsvToDisplay(row.note));
  const [supportRef, setSupportRef] = useState<string | null>(row.support_reference);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [aiConfirmOpen, setAiConfirmOpen] = useState(false);

  // Session model: when this card becomes active, snapshot the current
  // committed values so undo can revert to "what it was when I started
  // editing", regardless of intra-session saves. Pending patches accumulate
  // here and flush once at session end (or on manual save).
  const sessionSnapshotRef = useRef<SessionSnapshot | null>(null);
  const pendingRef = useRef<Partial<TnRow>>({});
  const cancelUnmountFlushRef = useRef(false);

  const paperRef = useRef<HTMLDivElement | null>(null);
  const catalogs = useCatalogs();

  // Keep latest onSave reachable from the unmount cleanup without re-running
  // the effect each time the parent re-renders.
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const positionFromEvent = (e: React.DragEvent): DropPosition => {
    const rect = paperRef.current?.getBoundingClientRect();
    if (!rect) return "after";
    return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };

  // Re-sync from the server-confirmed row, but only when no session is in
  // progress. While a session is open, the local fields are the source of
  // truth (a server response landing mid-session would otherwise clobber
  // the user's unsaved edits).
  useEffect(() => {
    if (sessionSnapshotRef.current !== null) return;
    setQuote(tsvToDisplay(row.quote));
  }, [row.id, row.version, row.quote]);
  useEffect(() => {
    if (sessionSnapshotRef.current !== null) return;
    setNote(tsvToDisplay(row.note));
  }, [row.id, row.version, row.note]);
  useEffect(() => {
    if (sessionSnapshotRef.current !== null) return;
    setSupportRef(row.support_reference);
  }, [row.id, row.version, row.support_reference]);

  // Session entry/exit. Snapshot is taken on active=false→true with the
  // values currently in local state (which match the row when nothing is
  // pending). On active=true→false the accumulated patch is flushed and
  // the snapshot is cleared.
  useEffect(() => {
    if (active) {
      if (sessionSnapshotRef.current === null) {
        sessionSnapshotRef.current = { quote, note, support_reference: supportRef };
      }
    } else if (sessionSnapshotRef.current !== null) {
      flushPending();
      sessionSnapshotRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Flush on unmount too — handles cases where the card unmounts without
  // transitioning to inactive first (e.g. user navigates to another verse
  // while this note is still active and gets filtered out of the list).
  // Intentionally cancelled when this card itself is being deleted.
  // Compares pending against the entry snapshot so a "typed then undone"
  // session unmounts without an extra version bump.
  useEffect(() => {
    return () => {
      if (cancelUnmountFlushRef.current) return;
      const p = pendingRef.current;
      const s = sessionSnapshotRef.current;
      if (Object.keys(p).length === 0) return;
      if (s && pendingMatchesSnapshot(p, s)) return;
      onSaveRef.current(p);
    };
  }, []);

  const flushPending = () => {
    const p = pendingRef.current;
    if (Object.keys(p).length === 0) return;
    const s = sessionSnapshotRef.current;
    pendingRef.current = {};
    // If every pending field equals its snapshot value, the user typed
    // and then reverted (or hit undo) — no net change to persist.
    if (s && pendingMatchesSnapshot(p, s)) return;
    onSave(p);
  };

  const stashEdit = (patch: Partial<TnRow>) => {
    pendingRef.current = { ...pendingRef.current, ...patch };
    // Optimistic local apply so the parent's data.tn reflects the live
    // value — keeps verse highlighting / aligner quote in step.
    onChange(patch);
  };

  const stashLocalEdit = (patch: Partial<TnRow>) => {
    pendingRef.current = { ...pendingRef.current, ...patch };
  };

  const handleUndo = () => {
    const s = sessionSnapshotRef.current;
    if (!s) return;
    setQuote(s.quote);
    setNote(s.note);
    setSupportRef(s.support_reference);
    const revert: Partial<TnRow> = {
      quote: s.quote,
      note: s.note,
      support_reference: s.support_reference,
    };
    pendingRef.current = revert;
    onChange(revert);
  };

  const handleDelete = () => {
    cancelUnmountFlushRef.current = true;
    pendingRef.current = {};
    sessionSnapshotRef.current = null;
    onDelete();
  };

  // Apply a historical snapshot. The patch goes through the normal save
  // pipe so it lands as v(current+1) — every older entry stays in
  // edit_log, including the v(current) we're moving away from. Local
  // state is rewritten outright so any in-progress session is discarded
  // in favor of the chosen version.
  const handleUseVersion = (
    snap: {
      quote: string | null;
      note: string | null;
      support_reference: string | null;
    },
    fromVersion: number,
  ) => {
    const rawQuote = snap.quote ?? "";
    const rawNote = snap.note ?? "";
    const rawSr = snap.support_reference ?? null;

    const displayQuote = tsvToDisplay(rawQuote);
    const displayNote = tsvToDisplay(rawNote);
    setQuote(displayQuote);
    setNote(displayNote);
    setSupportRef(rawSr);
    pendingRef.current = {};
    // If a session is open, reset its baseline so Undo reverts to the
    // newly-applied version and the "unsaved edits" asterisk stays quiet.
    if (sessionSnapshotRef.current) {
      sessionSnapshotRef.current = {
        quote: displayQuote,
        note: displayNote,
        support_reference: rawSr,
      };
    }

    // Only patch the fields that actually differ from the live row so we
    // don't trigger a needless version bump if the user picked the
    // current version somehow.
    const patch: Partial<TnRow> = {};
    if (rawQuote !== (row.quote ?? "")) patch.quote = rawQuote;
    if (rawNote !== (row.note ?? "")) patch.note = rawNote;
    if (rawSr !== row.support_reference) patch.support_reference = rawSr;
    if (Object.keys(patch).length === 0) return;
    onChange(patch);
    onSave(patch, { restoredFromVersion: fromVersion });
  };

  const aiPrereqsMet = !!supportRef && quote.trim().length > 0;

  // When AI completes (Shell sets a fresh `aiRecentlyCompletedAt`), force
  // local fields to the new row.quote/row.note even if a session is
  // open — the user expects the AI patch to show up regardless of
  // whether they happened to be editing this note when it landed. Also
  // re-baseline the session snapshot so Undo reverts to the AI result
  // (not pre-AI), matching the user's mental model of "AI just wrote
  // this; undo would undo the writing".
  useEffect(() => {
    if (!aiRecentlyCompletedAt) return;
    const newQuote = tsvToDisplay(row.quote);
    const newNote = tsvToDisplay(row.note);
    setQuote(newQuote);
    setNote(newNote);
    pendingRef.current = {};
    if (sessionSnapshotRef.current !== null) {
      sessionSnapshotRef.current = {
        quote: newQuote,
        note: newNote,
        support_reference: supportRef,
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiRecentlyCompletedAt]);

  // Visibility reporting. Default root means "browser viewport" — close
  // enough for the resource column's scroll model and avoids threading
  // a scroll-container ref through props.
  useEffect(() => {
    if (!onVisibilityChange) return;
    const el = paperRef.current;
    if (!el) return;
    const rowId = row.id;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          onVisibilityChange(rowId, entry.isIntersecting);
        }
      },
      { threshold: 0 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      // Cards are visible right up until unmount; tell Shell they're
      // no longer in viewport so an in-flight AI doesn't think the card
      // is still rendered when it lands.
      onVisibilityChange(rowId, false);
    };
  }, [row.id, onVisibilityChange]);

  const handleAiClick = () => {
    if (!onStartAi || !aiPrereqsMet || isAiPending) return;
    if (note.trim().length > 0) {
      setAiConfirmOpen(true);
      return;
    }
    onStartAi();
  };

  // Net change vs the session snapshot. Drives the save / undo buttons
  // and the version-dirty asterisk — after Undo the local state matches
  // the snapshot again so the save button goes quiet, and accidental
  // empty-then-revert sessions don't appear dirty in the UI either.
  const snapshot = sessionSnapshotRef.current;
  const hasNetChanges =
    snapshot !== null &&
    (quote !== snapshot.quote ||
      note !== snapshot.note ||
      supportRef !== snapshot.support_reference);
  const canUndo = active && hasNetChanges;
  const showSessionButtons = active;

  return (
    <Paper
      ref={paperRef}
      elevation={0}
      variant="outlined"
      data-note-id={row.id}
      onMouseDown={onFocus}
      onFocus={onFocus}
      onDragOver={(e) => {
        if (!isDropTarget) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onCardDragOver(positionFromEvent(e));
      }}
      onDragLeave={() => {
        if (!isDropTarget) return;
        onCardDragLeave();
      }}
      onDrop={(e) => {
        if (!isDropTarget) return;
        e.preventDefault();
        onCardDrop(positionFromEvent(e));
      }}
      sx={{
        my: 1,
        border: active ? "1.5px solid" : "1px solid",
        borderColor: active ? "primary.main" : "divider",
        bgcolor: active ? "primary.50" : "background.paper",
        overflow: "hidden",
        opacity: dragging ? 0.4 : 1,
        transition: "opacity 120ms ease",
        // Glow pulse on AI completion. The flag is set by useAiDrafts
        // for ~4 s, so the animation finishes naturally and the rule
        // becomes a no-op once the flag clears.
        "@keyframes ai-pulse": {
          "0%": { boxShadow: "0 0 0 0 rgba(49,173,227,0)" },
          "30%": { boxShadow: "0 0 18px 4px rgba(49,173,227,0.55)" },
          "100%": { boxShadow: "0 0 0 0 rgba(49,173,227,0)" },
        },
        animation: aiRecentlyCompletedAt ? "ai-pulse 1.4s ease-in-out 0s 2" : "none",
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{
          px: 1,
          py: 0.5,
          borderBottom: "1px dashed",
          borderColor: "divider",
          bgcolor: "grey.100",
          flexWrap: "wrap",
        }}
      >
        <Tooltip title="drag to reorder">
          <Box
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", row.id);
              if (paperRef.current) {
                e.dataTransfer.setDragImage(paperRef.current, 12, 12);
              }
              onGripDragStart();
            }}
            onDragEnd={onDragEnd}
            sx={{
              cursor: "grab",
              color: "text.disabled",
              display: "inline-flex",
              alignItems: "center",
              "&:active": { cursor: "grabbing" },
            }}
          >
            <DragIndicatorIcon fontSize="small" />
          </Box>
        </Tooltip>
        <Chip
          label={row.id}
          size="small"
          variant="outlined"
          sx={{ fontFamily: "monospace", fontSize: 11, height: 22 }}
        />
        {row.latest_source === "ai_pipeline" && (
          <Tooltip title="Generated by an AI pipeline. Your next edit clears this label.">
            <Chip
              icon={<AutoAwesomeIcon style={{ fontSize: 12 }} />}
              label="AI"
              size="small"
              variant="outlined"
              sx={{
                fontFamily: "monospace",
                fontSize: 11,
                height: 22,
                color: "secondary.main",
                borderColor: "secondary.main",
                "& .MuiChip-icon": { color: "secondary.main", ml: 0.5, mr: -0.25 },
              }}
            />
          </Tooltip>
        )}
        {locked && !isKept && onKeep && (
          <Tooltip title="Mark this note to survive the AI run. Other notes in this chapter will be replaced.">
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={false}
                  onChange={() => onKeep()}
                  sx={{ p: 0.25 }}
                />
              }
              label={
                <Typography variant="caption" sx={{ fontWeight: 500 }}>
                  Keep
                </Typography>
              }
              sx={{ ml: 0, mr: 0 }}
            />
          </Tooltip>
        )}
        {locked && isKept && (
          <Tooltip title="This note is marked Kept — the AI run won't replace it.">
            <Chip
              label="Kept"
              size="small"
              color="success"
              variant="outlined"
              sx={{ fontFamily: "monospace", fontSize: 11, height: 22 }}
            />
          </Tooltip>
        )}
        <Box
          sx={readOnly ? { pointerEvents: "none", opacity: 0.6 } : undefined}
        >
          <CatalogPicker
            value={supportRef}
            options={catalogs.supportReferences}
            display={(v) => (v ? shortSupport(v) : "+ support ref")}
            placeholder="figs-, translate-, writing-, …"
            color="primary"
            variant={active ? "filled" : "outlined"}
            onChange={(next) => {
              setSupportRef(next);
              stashEdit({ support_reference: next });
            }}
          />
        </Box>
        <Typography variant="caption" sx={{ color: "text.disabled", fontFamily: "monospace" }}>
          {row.ref_raw}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip
          title={
            row.restored_from_version != null
              ? `v${row.restored_from_version} (restored)${hasNetChanges ? " · unsaved edits" : ""} — currently at row v${row.version}; last update ${new Date(row.updated_at * 1000).toLocaleString()}. Click to view history.`
              : `v${row.version}${hasNetChanges ? " · unsaved edits" : ""} — saved ${row.version - 1} time${row.version - 1 === 1 ? "" : "s"}; last update ${new Date(row.updated_at * 1000).toLocaleString()}. Click to view history.`
          }
        >
          <Chip
            label={`v${row.restored_from_version ?? row.version}${hasNetChanges ? "*" : ""}`}
            size="small"
            variant="outlined"
            clickable
            onClick={(e) => {
              e.stopPropagation();
              setHistoryOpen(true);
            }}
            sx={{
              fontFamily: "monospace",
              fontSize: 11,
              height: 22,
              color: hasNetChanges ? "warning.main" : "text.secondary",
              borderColor: hasNetChanges ? "warning.main" : "divider",
              fontWeight: hasNetChanges ? 600 : 400,
            }}
          />
        </Tooltip>
        {showSessionButtons && (
          <>
            {canUndo && (
              <Tooltip title="discard every edit since this note became active">
                <IconButton
                  size="small"
                  onClick={handleUndo}
                  sx={{ p: 0.25, color: "warning.main" }}
                >
                  <UndoIcon fontSize="inherit" />
                </IconButton>
              </Tooltip>
            )}
            <Tooltip title={hasNetChanges ? "save pending edits now (auto-saves when you leave this note)" : "no pending edits"}>
              <span>
                <IconButton
                  size="small"
                  onClick={flushPending}
                  disabled={!hasNetChanges}
                  sx={{ p: 0.25, color: hasNetChanges ? "primary.main" : "action.disabled" }}
                >
                  {hasNetChanges ? <SaveIcon fontSize="inherit" /> : <SaveOutlinedIcon fontSize="inherit" />}
                </IconButton>
              </span>
            </Tooltip>
          </>
        )}
        {!readOnly && (
          <>
            <Tooltip title="add a new note after this one">
              <IconButton size="small" onClick={onInsertAfter} color="success" sx={{ p: 0.25 }}>
                <AddIcon fontSize="inherit" />
              </IconButton>
            </Tooltip>
            <Tooltip title="delete this note">
              <IconButton size="small" onClick={handleDelete} color="error" sx={{ p: 0.25 }}>
                <DeleteOutlineIcon fontSize="inherit" />
              </IconButton>
            </Tooltip>
          </>
        )}
      </Stack>
      <Box sx={{ p: 1 }}>
        <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mb: 0.5 }}>
          <Typography
            variant="caption"
            sx={{
              fontFamily: "monospace",
              color: "text.secondary",
              textTransform: "uppercase",
              minWidth: 54,
              textAlign: "right",
              pt: 1.25,
              flexShrink: 0,
            }}
          >
            Quote
          </Typography>
          <TextField
            value={quote}
            onChange={(e) => {
              setQuote(e.target.value);
              stashEdit({ quote: e.target.value });
            }}
            multiline
            fullWidth
            size="small"
            spellCheck={false}
            onFocus={onFocus}
            InputProps={{ readOnly }}
            inputProps={{
              dir: "rtl",
              style: {
                fontFamily: '"Times New Roman","SBL Hebrew","Cardo",serif',
                fontSize: 19,
                textAlign: "right",
                lineHeight: 1.5,
              },
            }}
          />
        </Stack>
        <Stack direction="row" spacing={1} alignItems="flex-start">
          <Stack
            direction="column"
            alignItems="center"
            spacing={0.5}
            sx={{ minWidth: 54, flexShrink: 0, pt: 1.25 }}
          >
            <Typography
              variant="caption"
              sx={{
                fontFamily: "monospace",
                color: "text.secondary",
                textTransform: "uppercase",
              }}
            >
              Note
            </Typography>
            <Tooltip
              title={
                isAiPending
                  ? "drafting in background — feel free to edit other notes"
                  : !onStartAi
                    ? "AI generation unavailable"
                    : !supportRef
                      ? "pick a support reference first"
                      : !quote.trim()
                        ? "fill in the Quote first"
                        : "generate this note with AI"
              }
            >
              <span>
                <IconButton
                  size="small"
                  onClick={handleAiClick}
                  disabled={!onStartAi || !aiPrereqsMet || isAiPending || readOnly}
                  sx={{ p: 0.25, color: "secondary.main" }}
                >
                  {isAiPending ? (
                    <CircularProgress size={14} color="inherit" />
                  ) : (
                    <AutoAwesomeIcon fontSize="inherit" />
                  )}
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
          <TextField
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              stashLocalEdit({ note: e.target.value });
            }}
            multiline
            fullWidth
            minRows={2}
            size="small"
            spellCheck
            onFocus={onFocus}
            InputProps={{ readOnly }}
            inputProps={{ style: { fontSize: 13, lineHeight: 1.5, fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif' } }}
          />
        </Stack>
      </Box>
      {historyOpen && (
        <Suspense fallback={null}>
          <NoteHistoryDialog
            open={historyOpen}
            noteId={row.id}
            currentVersion={row.version}
            effectiveVersion={row.restored_from_version ?? row.version}
            onClose={() => setHistoryOpen(false)}
            onUseVersion={handleUseVersion}
          />
        </Suspense>
      )}
      <Dialog open={aiConfirmOpen} onClose={() => setAiConfirmOpen(false)}>
        <DialogTitle>Replace existing note?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This note already has text. Generating with AI will replace both the Quote and Note.
            You can hit Undo on the toolbar afterwards to restore the original.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAiConfirmOpen(false)}>Cancel</Button>
          <Button
            onClick={() => {
              setAiConfirmOpen(false);
              onStartAi?.();
            }}
            color="primary"
            variant="contained"
          >
            Replace
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
