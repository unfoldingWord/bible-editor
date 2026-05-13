import { useEffect, useRef, useState } from "react";
import { Paper, Stack, Chip, IconButton, Typography, Box, TextField, Tooltip } from "@mui/material";
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
import { NoteHistoryDialog } from "./NoteHistoryDialog";

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
  // (active going false), on manual save, or on unmount.
  onSave: (patch: Partial<TnRow>) => void;
  onDelete: () => void;
  onInsertAfter: () => void;
  onFocus?: () => void;
  onGripDragStart: () => void;
  onDragEnd: () => void;
  onCardDragOver: (position: DropPosition) => void;
  onCardDragLeave: () => void;
  onCardDrop: (position: DropPosition) => void;
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
}: Props) {
  const [quote, setQuote] = useState(tsvToDisplay(row.quote));
  const [note, setNote] = useState(tsvToDisplay(row.note));
  const [supportRef, setSupportRef] = useState<string | null>(row.support_reference);
  const [historyOpen, setHistoryOpen] = useState(false);

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
  const handleUseVersion = (snap: {
    quote: string | null;
    note: string | null;
    support_reference: string | null;
  }) => {
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
    onSave(patch);
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
        <Typography variant="caption" sx={{ color: "text.disabled", fontFamily: "monospace" }}>
          {row.ref_raw}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip
          title={`v${row.version}${hasNetChanges ? " · unsaved edits" : ""} — saved ${row.version - 1} time${row.version - 1 === 1 ? "" : "s"}; last update ${new Date(row.updated_at * 1000).toLocaleString()}. Click to view history.`}
        >
          <Chip
            label={`v${row.version}${hasNetChanges ? "*" : ""}`}
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
            <Tooltip title={canUndo ? "discard every edit since this note became active" : "no changes since this note became active"}>
              <span>
                <IconButton
                  size="small"
                  onClick={handleUndo}
                  disabled={!canUndo}
                  sx={{ p: 0.25, color: canUndo ? "warning.main" : "action.disabled" }}
                >
                  <UndoIcon fontSize="inherit" />
                </IconButton>
              </span>
            </Tooltip>
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
            <Tooltip title="generate this note with AI (not wired up yet)">
              <IconButton size="small" disabled sx={{ p: 0.25, color: "secondary.main" }}>
                <AutoAwesomeIcon fontSize="inherit" />
              </IconButton>
            </Tooltip>
          </Stack>
          <TextField
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              stashEdit({ note: e.target.value });
            }}
            multiline
            fullWidth
            minRows={2}
            size="small"
            spellCheck
            onFocus={onFocus}
            inputProps={{ style: { fontSize: 13, lineHeight: 1.5, fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif' } }}
          />
        </Stack>
      </Box>
      {historyOpen && (
        <NoteHistoryDialog
          open={historyOpen}
          noteId={row.id}
          currentVersion={row.version}
          onClose={() => setHistoryOpen(false)}
          onUseVersion={handleUseVersion}
        />
      )}
    </Paper>
  );
}

function shortSupport(s: string): string {
  // 'rc://*/ta/man/translate/figs-explicit' -> 'figs-explicit'
  const m = s.match(/\/([^/]+)$/);
  return m ? m[1] : s;
}
