import { lazy, Suspense, memo, useEffect, useRef, useState } from "react";
import {
  Paper,
  Stack,
  Chip,
  IconButton,
  InputAdornment,
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
  Menu,
  MenuItem,
  ListItemText,
} from "@mui/material";
import PushPinOutlinedIcon from "@mui/icons-material/PushPinOutlined";
import LightbulbOutlinedIcon from "@mui/icons-material/LightbulbOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import RestoreFromTrashIcon from "@mui/icons-material/RestoreFromTrash";
import AddIcon from "@mui/icons-material/Add";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import SaveIcon from "@mui/icons-material/Save";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import TranslateIcon from "@mui/icons-material/Translate";
import UndoIcon from "@mui/icons-material/Undo";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import type { TnRow } from "../sync/api";
import { useCatalogs } from "../hooks/useCatalogs";
import { useNoteTemplates } from "../hooks/useNoteTemplates";
import { CatalogPicker } from "./CatalogPicker";
import { shortSupport } from "../lib/supportReference";
import { TCM, buildSH } from "../lib/noteTemplates";
import { drafts, rowKey, draftDirtyBorderSx } from "../sync/drafts";

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
  onRestore: () => void;
  onInsertAfter: () => void;
  onFocus?: () => void;
  onGripDragStart: () => void;
  onDragEnd: () => void;
  onCardDragOver: (position: DropPosition) => void;
  onCardDragLeave: () => void;
  onCardDrop: (position: DropPosition) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  // Verse numbers in this chapter, offered in the reference picker so a note
  // can be retargeted to a different verse ("change reference"). Absent/empty
  // => the ref shows as a static label with no picker.
  verseOptions?: number[];
  onChangeVerse?: (verse: number) => void;
  // Hovering the reorder controls (grip / up / down) previews this note's
  // current slot in the scripture stoplight without moving it: fires true on
  // enter, false on leave.
  onReorderHover?: (entering: boolean) => void;
  // Async AI-draft lifecycle. State lives in Shell so the call can
  // survive the card un-focusing / scrolling off-screen. NoteCard is
  // purely presentational w.r.t. AI: shows spinner while pending,
  // pulses briefly when a result lands.
  isAiPending?: boolean;
  aiRecentlyCompletedAt?: number | null;
  // Fires the request. Returns immediately; result lands later via the
  // row patch pipeline. Absent => sparkles is hidden. Carries the LIVE
  // (unsaved) note fields so Shell builds the request from what's on
  // screen rather than the cached row — see buildAiLive below.
  onStartAi?: (live: { quote: string; note: string; support_reference: string | null }) => void;
  // Reported on intersection changes so Shell can decide whether an
  // arriving AI result needs the persistent off-screen toast or just
  // the in-place pulse. Default root (viewport) is good enough for our
  // resource column scroll setup.
  onVisibilityChange?: (rowId: string, isVisible: boolean) => void;
  // Chapter has an active AI pipeline (state from pipelineStore). When true
  // and the row is neither preserved nor a hint, the card is read-only.
  // Preserved or hinted rows stay editable even during a run.
  locked?: boolean;
  // Toggle the row's "survive future AI pipeline sweeps" bit. Always
  // available — these are pre-run intent signals, not in-run claims.
  // Fires POST /api/rows/tn/:id/preserve upstream.
  onSetPreserve?: (value: boolean) => void;
  // Toggle the row's "queue as AI-pipeline hint" bit. hint=1 rows are sent
  // to the chapter-wide AI run as directives and are excluded from the
  // sweep until the AI expansion lands. Fires POST /api/rows/tn/:id/hint.
  onSetHint?: (value: boolean) => void;
  // Translate English in the quote field to source-language text via ULT
  // alignment. Returns the derived Hebrew/Greek string, or null if no
  // alignment match was found.
  onTranslateQuote?: (english: string) => string | null;
  // Quote-builder workflow: the "build from source" button opens a picker
  // popup mounted at Shell level. While the picker is open for this note,
  // quoteBuildMode is true and the button label reflects the selection
  // count. Shell owns the selection state + cancel/commit handlers — the
  // card just opens the picker.
  quoteBuildMode?: boolean;
  quoteBuildSelectionCount?: number;
  onStartQuoteBuild?: () => void;
  // Bumps to a fresh value each time Shell commits a quote-build for THIS
  // note. The picker only opens while the card is active, so the row→quote
  // sync effect is blocked by the open session guard; this signal is the
  // escape hatch (mirrors aiRecentlyCompletedAt) that lands the committed
  // quote in the box. Shell applies the quote to row optimistically before
  // bumping this, so the effect just reads the now-current row.quote.
  quoteBuildAppliedAt?: number | null;
}

// Notes coming from TSV imports use literal "\n" (two characters) as the
// line-break marker. tcCreate renders those as real newlines; we do the same
// on read, and on save we write back whatever the user typed verbatim. The
// data in D1 transitions to true newlines as users edit.
function tsvToDisplay(s: string | null): string {
  return (s ?? "").replace(/\\n/g, "\n");
}

// Detect the primary script of a string for directing RTL/LTR rendering and
// showing the translate icon. Only Hebrew (U+0590–U+05FF) is RTL; Greek is
// LTR and is grouped with Latin for detection purposes.
const RTL_CHAR = /[֐-׿]/;
const LTR_CHAR = /[a-zA-ZͰ-Ͽἀ-῿]/;

type QuoteScript = "empty" | "rtl" | "ltr";

function detectQuoteScript(text: string): QuoteScript {
  if (!text.trim()) return "empty";
  if (RTL_CHAR.test(text)) return "rtl";
  if (LTR_CHAR.test(text)) return "ltr";
  return "empty";
}

interface SessionSnapshot {
  quote: string;
  note: string;
  support_reference: string | null;
}

function NoteCardInner({
  row,
  active,
  dragging,
  isDropTarget,
  onChange,
  onSave,
  onDelete,
  onRestore,
  onInsertAfter,
  onFocus,
  onGripDragStart,
  onDragEnd,
  onCardDragOver,
  onCardDragLeave,
  onCardDrop,
  onMoveUp,
  onMoveDown,
  verseOptions,
  onChangeVerse,
  onReorderHover,
  isAiPending = false,
  aiRecentlyCompletedAt = null,
  onStartAi,
  onVisibilityChange,
  locked = false,
  onSetPreserve,
  onSetHint,
  onTranslateQuote,
  quoteBuildMode = false,
  quoteBuildSelectionCount = 0,
  onStartQuoteBuild,
  quoteBuildAppliedAt = null,
}: Props) {
  // Two explicit bits drive lock-time behavior now:
  //   - preserve=1: translator marked this row "survive AI runs"
  //   - hint=1:    this row is a stub queued for AI expansion in place
  // Either bit keeps the card editable during a locked chapter. The legacy
  // implicit "kept = updated_by IS NOT NULL" signal is folded into the
  // preserve bit on the server (see rows.ts /keep alias).
  const isPreserved = row.preserve === 1;
  const isHint = row.hint === 1;
  // Trashed: pending deletion until tonight's finalize. The card grays out,
  // drops to the bottom of the verse, and goes inert except for Restore.
  // Folding it into readOnly makes every body input non-interactive and hides
  // the add/delete buttons for free (they already gate on !readOnly).
  const trashed = row.trashed_at != null;
  const readOnly = trashed || (locked && !isPreserved && !isHint);
  const [quote, setQuote] = useState(tsvToDisplay(row.quote));
  const [note, setNote] = useState(tsvToDisplay(row.note));
  const [supportRef, setSupportRef] = useState<string | null>(row.support_reference);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [aiConfirmOpen, setAiConfirmOpen] = useState(false);
  // Template dropdown anchor (only used when a support ref has >1 variant) and
  // the body staged for the "replace existing note?" confirm dialog.
  const [templateMenuAnchor, setTemplateMenuAnchor] = useState<HTMLElement | null>(null);
  const [templateConfirmBody, setTemplateConfirmBody] = useState<string | null>(null);
  // Reference (verse) picker anchor — opened from the ref_raw label.
  const [refMenuAnchor, setRefMenuAnchor] = useState<HTMLElement | null>(null);

  // Baseline of the last server-confirmed content. stashEdit() optimistically
  // re-spreads row.{quote,note,support_reference} on every keystroke (so a
  // mid-session remount can recover live typing from props), which would
  // otherwise defeat the diff below — local state and "row" would tick in
  // lockstep and hasRowDiff would never go true. Pinning the baseline to
  // version means it only rebases on a real server confirmation (PATCH 200,
  // restore, AI completion, or WS row.upserted), all of which bump version.
  const savedRef = useRef({
    quote: row.quote,
    note: row.note,
    support_reference: row.support_reference,
    version: row.version,
  });
  const [savePendingVersion, setSavePendingVersion] = useState<number | null>(null);
  if (row.version !== savedRef.current.version) {
    savedRef.current = {
      quote: row.quote,
      note: row.note,
      support_reference: row.support_reference,
      version: row.version,
    };
  }
  // Clear the in-flight gate once the server-confirmed version moves past
  // the one we saved against. A conflict (409) keeps row.version stuck and
  // savePendingVersion stays set — that's intentional, the user has to
  // resolve via the SyncStatusBar before sending another save.
  useEffect(() => {
    if (savePendingVersion !== null && row.version > savePendingVersion) {
      setSavePendingVersion(null);
    }
  }, [row.version, savePendingVersion]);

  // Session model: when this card becomes active, snapshot the current
  // committed values so undo can revert to "what it was when I started
  // editing". Pending patches accumulate here and flush on manual save,
  // session end, or unmount. On manual save the snapshot rebases to the
  // saved state so the chip's "*" reflects "unsaved since last save".
  //
  // Backed by state (drives re-renders so the chip clears its dirty
  // asterisk) with a mirrored ref for the unmount cleanup, which runs
  // after the component is gone and can't read state from closure.
  const sessionSnapshotRef = useRef<SessionSnapshot | null>(null);
  const setSessionSnapshot = (next: SessionSnapshot | null) => {
    sessionSnapshotRef.current = next;
  };
  const pendingRef = useRef<Partial<TnRow>>({});

  // The quote field drives the scripture highlight (Shell reads the active
  // note's quote out of chapter state). Propagate quote edits to the parent
  // on a short debounce instead of on every keystroke, so typing stays local
  // to this card — every keystroke used to rebuild the whole chapter payload
  // and re-render the entire app. quoteRef mirrors the latest local value so
  // the timer always flushes the final text, even if an undo / template /
  // translate set the quote through another path before it fires. The note
  // BODY drives nothing outside this card, so it never propagates (it persists
  // via the draft store and saves through flushPending).
  const quoteRef = useRef(quote);
  quoteRef.current = quote;
  const quotePropagateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleQuotePropagate = () => {
    if (quotePropagateTimer.current !== null) clearTimeout(quotePropagateTimer.current);
    quotePropagateTimer.current = setTimeout(() => {
      quotePropagateTimer.current = null;
      onChange({ quote: quoteRef.current });
    }, 200);
  };
  useEffect(
    () => () => {
      if (quotePropagateTimer.current !== null) clearTimeout(quotePropagateTimer.current);
    },
    [],
  );

  const paperRef = useRef<HTMLDivElement | null>(null);
  const catalogs = useCatalogs();
  const noteTemplates = useNoteTemplates();

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

  // Restore unsaved typing on first mount. If a draft exists for this row,
  // overwrite local state from its patch — otherwise the user's typing
  // would be lost the first time they navigate away from this note.
  // Guarded by a ref so subsequent re-renders don't keep clobbering the
  // live state with a now-stale snapshot.
  // Flips true once the on-mount draft lookup resolves (draft or not). The
  // draft-write effect gates its *clear* branch on this so a freshly-remounted
  // card — whose state hasn't rehydrated yet — can't wipe the very draft we're
  // about to read.
  const [hydrated, setHydrated] = useState(false);
  const hydratedFromDraftRef = useRef(false);
  useEffect(() => {
    if (hydratedFromDraftRef.current) return;
    void drafts.get(rowKey("tn", row.book, row.id)).then((rec) => {
      if (hydratedFromDraftRef.current) return;
      hydratedFromDraftRef.current = true;
      const payload = rec?.payload as
        | {
            patch?: Partial<TnRow>;
            baseline?: { quote: string | null; note: string | null; support_reference: string | null };
          }
        | undefined;
      const patch = payload?.patch;
      setHydrated(true);
      if (!patch) return;
      // Restore the server baseline this draft was diffed against. Optimistic
      // applyLocalRowPatch() edits land in the cached row at an unchanged
      // version, so a no-refetch remount (e.g. pin toggle reshaping the column)
      // would otherwise initialise savedRef from that polluted row and compute
      // hasRowDiff=false — the card looks saved, the Save button disables, and
      // the draft-write effect clears the draft, stranding the edit in volatile
      // state. Pinning savedRef to the persisted baseline keeps the dirty chip /
      // Save button honest.
      const baseline = payload?.baseline;
      if (baseline) {
        savedRef.current = {
          quote: baseline.quote,
          note: baseline.note,
          support_reference: baseline.support_reference,
          version: rec?.expectedVersion ?? savedRef.current.version,
        };
      }
      if (typeof patch.quote === "string") setQuote(tsvToDisplay(patch.quote));
      if (typeof patch.note === "string") setNote(tsvToDisplay(patch.note));
      if ("support_reference" in patch) {
        setSupportRef((patch.support_reference as string | null) ?? null);
      }
    }).catch(() => {
      // An IndexedDB read failure must still flip `hydrated` true — otherwise
      // the draft-write effect's clear branch never fires and a reverted draft
      // keeps nagging. We just skip restoring any persisted draft (the card
      // falls back to the server row, and live editing still works).
      if (hydratedFromDraftRef.current) return;
      hydratedFromDraftRef.current = true;
      setHydrated(true);
    });
  }, [row.id, row.book]);

  // Session entry/exit. Snapshot is taken on active=false→true with the
  // values currently in local state (which may differ from the row if a
  // draft was hydrated). On deactivate we just clear the snapshot — no
  // PATCH fires until the user clicks Save. Edits survive in the drafts
  // store across mount/unmount, so leaving an active card doesn't lose
  // typing.
  useEffect(() => {
    if (active) {
      if (sessionSnapshotRef.current === null) {
        setSessionSnapshot({ quote, note, support_reference: supportRef });
      }
    } else if (sessionSnapshotRef.current !== null) {
      setSessionSnapshot(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Save the diff between local state and the saved row. We don't rely on
  // pendingRef anymore — a deactivate→reactivate cycle, or a draft
  // restored from IndexedDB on mount, can leave the local state differing
  // from row without any in-session stashEdit() history. Recomputing from
  // local-vs-row props makes the save button work in those cases too.
  // The picker / NoteCard JSX still call stashEdit() for the
  // applyLocalRowPatch side-effect (parents need the live preview), but
  // we no longer use pendingRef as the source of truth for what to PATCH.
  const flushPending = () => {
    const patch: Partial<TnRow> = {};
    const savedQuote = savedRef.current.quote ?? "";
    const savedNote = savedRef.current.note ?? "";
    // We send raw TSV (with literal \n escapes) so the server / DCS
    // round-trip stays stable. tsvToDisplay flips them to real newlines
    // for the UI; reverse here.
    const localQuote = quote.replace(/\n/g, "\\n");
    const localNote = note.replace(/\n/g, "\\n");
    if (localQuote !== savedQuote) patch.quote = localQuote;
    if (localNote !== savedNote) patch.note = localNote;
    if (supportRef !== savedRef.current.support_reference) patch.support_reference = supportRef;
    pendingRef.current = {};
    if (Object.keys(patch).length === 0) return;
    // Gate further Save clicks against the same baseline. Without this,
    // double-clicking Save before the server responds enqueues two PATCHes
    // with the same If-Match, the second of which lands as a phantom 409.
    setSavePendingVersion(savedRef.current.version);
    onSave(patch);
    // Rebase the snapshot so the chip stops showing "*" after a manual
    // save and a follow-up Undo reverts to the just-saved state.
    if (sessionSnapshotRef.current !== null) {
      setSessionSnapshot({ quote, note, support_reference: supportRef });
    }
  };

  const stashEdit = (patch: Partial<TnRow>) => {
    pendingRef.current = { ...pendingRef.current, ...patch };
    // Optimistic local apply so the parent's data.tn reflects the live
    // value. Required so a mid-session remount (e.g. pin toggle reshaping
    // the resource column) doesn't initialise the next instance from a
    // stale row prop — that would freeze the display at pre-edit content
    // even after the save lands as v(n+1).
    onChange(patch);
  };

  // Revert to the LAST SAVED row state — drops every unsaved keystroke
  // since the row landed on the server. We compare against savedRef
  // (not row props, which carry mid-typing optimistic values from
  // stashEdit) so Undo reaches the actual last-saved content, not the
  // dirty value the user just typed. Also clears the draft store so
  // the orange border / unsaved-toasts forget about this row.
  const handleUndo = () => {
    const savedQuote = savedRef.current.quote;
    const savedSupportRef = savedRef.current.support_reference;
    const rowQuote = tsvToDisplay(savedQuote);
    const rowNote = tsvToDisplay(savedRef.current.note);
    setQuote(rowQuote);
    setNote(rowNote);
    setSupportRef(savedSupportRef);
    pendingRef.current = {};
    // Re-baseline the session snapshot to the saved state so a follow-up
    // edit produces a fresh hasNetChanges signal rather than thinking
    // the user is undoing the previous undo.
    if (sessionSnapshotRef.current !== null) {
      setSessionSnapshot({
        quote: rowQuote,
        note: rowNote,
        support_reference: savedSupportRef,
      });
    }
    void drafts.clear(draftKey);
    onChange({
      quote: savedQuote,
      note: savedRef.current.note,
      support_reference: savedSupportRef,
    });
  };

  const handleDelete = () => {
    pendingRef.current = {};
    setSessionSnapshot(null);
    // Drop any draft so the delete doesn't get followed by a phantom save
    // from a still-dirty buffer.
    void drafts.clear(rowKey("tn", row.book, row.id));
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
      setSessionSnapshot({
        quote: displayQuote,
        note: displayNote,
        support_reference: rawSr,
      });
    }

    // Only patch the fields that actually differ from the saved server
    // state so we don't trigger a needless version bump if the user picked
    // the current version somehow. Use savedRef (not row) because row
    // carries optimistic mid-typing values from stashEdit().
    const patch: Partial<TnRow> = {};
    if (rawQuote !== (savedRef.current.quote ?? "")) patch.quote = rawQuote;
    if (rawNote !== (savedRef.current.note ?? "")) patch.note = rawNote;
    if (rawSr !== savedRef.current.support_reference) patch.support_reference = rawSr;
    if (Object.keys(patch).length === 0) return;
    onChange(patch);
    onSave(patch, { restoredFromVersion: fromVersion });
  };

  const aiPrereqsMet = !!supportRef && quote.trim().length > 0;

  const quoteScript = detectQuoteScript(quote);
  const showTranslateIcon = quoteScript === "ltr" && !readOnly && !!onTranslateQuote;

  const handleTranslateQuote = () => {
    if (!onTranslateQuote || quoteScript !== "ltr") return;
    const result = onTranslateQuote(quote);
    if (result) {
      setQuote(result);
      stashEdit({ quote: result });
    }
  };

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
      setSessionSnapshot({
        quote: newQuote,
        note: newNote,
        support_reference: supportRef,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiRecentlyCompletedAt]);

  // Quote-builder commit. The picker only opens while this card is active,
  // so the row→quote sync effect above is blocked by the open session
  // guard and the built quote (already applied to row.quote by Shell) would
  // never reach the box. When Shell signals a fresh commit for this note,
  // force the box to the new quote and rebaseline the session snapshot so
  // Undo treats the committed quote as the baseline — same shape as the AI
  // escape hatch above. Only the quote changes; note/supportRef are left as-is.
  useEffect(() => {
    if (quoteBuildAppliedAt == null) return;
    const newQuote = tsvToDisplay(row.quote);
    setQuote(newQuote);
    pendingRef.current = {};
    if (sessionSnapshotRef.current !== null) {
      setSessionSnapshot({ quote: newQuote, note, support_reference: supportRef });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteBuildAppliedAt]);

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

  // Snapshot the live note fields for the AI request. SUGGEST must work
  // before an explicit save: quote edits reach Shell's data.tn only on a
  // 200ms debounce and a freshly-created note can still be blank there, so
  // building from the cached row produced spurious "AI prerequisites
  // missing." Mirror flushPending's TSV conversion so the request sees
  // exactly what a save would persist.
  const buildAiLive = () => ({
    quote: quote.replace(/\n/g, "\\n"),
    note: note.replace(/\n/g, "\\n"),
    support_reference: supportRef,
  });

  const handleAiClick = () => {
    if (!onStartAi || !aiPrereqsMet || isAiPending) return;
    if (note.trim().length > 0) {
      setAiConfirmOpen(true);
      return;
    }
    onStartAi(buildAiLive());
  };

  // Curated templates for the selected support reference (keyed on the short
  // form, e.g. "figs-metaphor"). Empty when no support ref is picked or the
  // ref has no templates in the sheet.
  const templatesForRef = supportRef ? noteTemplates[shortSupport(supportRef)] ?? [] : [];

  // Fill the note from a template, going through stashEdit so the parent's
  // row.note reflects it (matches the TCM/SH chips). requestTemplate gates on
  // existing text: a non-empty note opens a confirm dialog first.
  const applyTemplate = (body: string) => {
    setNote(body);
    stashEdit({ note: body });
  };
  const requestTemplate = (body: string) => {
    if (note.trim().length > 0) setTemplateConfirmBody(body);
    else applyTemplate(body);
  };
  const handleTemplateClick = (e: React.MouseEvent<HTMLElement>) => {
    if (templatesForRef.length === 1) requestTemplate(templatesForRef[0].body);
    else if (templatesForRef.length > 1) setTemplateMenuAnchor(e.currentTarget);
  };

  // Sync the draft store against the diff vs server row. This is what feeds
  // the offscreen-unsaved popup and survives chapter navigation. Separate
  // from hasNetChanges because we want drafts to track divergence from the
  // *saved* state, not from the session entry point.
  const rowDiff: Partial<TnRow> = {};
  const rowQuoteDisplay = tsvToDisplay(savedRef.current.quote);
  const rowNoteDisplay = tsvToDisplay(savedRef.current.note);
  if (quote !== rowQuoteDisplay) rowDiff.quote = quote;
  if (note !== rowNoteDisplay) rowDiff.note = note;
  if (supportRef !== savedRef.current.support_reference) rowDiff.support_reference = supportRef;
  const hasRowDiff = Object.keys(rowDiff).length > 0;
  const draftKey = rowKey("tn", row.book, row.id);
  useEffect(() => {
    if (readOnly) return;
    if (hasRowDiff) {
      void drafts.set(
        draftKey,
        {
          patch: rowDiff,
          // Persist the server baseline (savedRef stays version-pinned, immune
          // to the optimistic same-version row mutations) so a remount restores
          // an honest baseline instead of inheriting a polluted row. See the
          // hydration effect above.
          baseline: {
            quote: savedRef.current.quote,
            note: savedRef.current.note,
            support_reference: savedRef.current.support_reference,
          },
        },
        row.version,
        {
          kind: "row",
          rowKind: "tn",
          id: row.id,
          book: row.book,
          chapter: row.chapter,
          verse: row.verse,
        },
      );
    } else if (hydrated) {
      // Only clear after the on-mount draft lookup has run — before that,
      // hasRowDiff is measured against an unhydrated baseline and would
      // spuriously wipe a draft we haven't had the chance to restore.
      void drafts.clear(draftKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    draftKey,
    hasRowDiff,
    hydrated,
    quote,
    note,
    supportRef,
    row.version,
    row.id,
    row.book,
    row.chapter,
    row.verse,
    readOnly,
  ]);

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
        // Trashed cards get a dashed, muted, grayed-out treatment to signal
        // "pending deletion — restorable until tonight".
        borderStyle: trashed ? "dashed" : undefined,
        borderColor: trashed ? "text.disabled" : active ? "primary.main" : "divider",
        bgcolor: trashed ? "grey.100" : active ? "primary.50" : "background.paper",
        overflow: "hidden",
        // Opacity applied without a CSS transition on purpose: trash/restore
        // re-render twice in quick succession (optimistic patch, then the
        // server-confirmed replacement), and a transition spanning those two
        // class swaps gets left in an idle state that pins the card at the
        // start opacity — a restored card would stay visibly dimmed until the
        // next reload. Instant opacity sidesteps that entirely.
        opacity: trashed ? 0.6 : dragging ? 0.4 : 1,
        ...draftDirtyBorderSx(),
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
      {/* ── Header ── */}
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{
          px: 1,
          py: 0.5,
          borderBottom: "1px solid",
          borderColor: "divider",
          bgcolor: "grey.50",
          flexWrap: "wrap",
        }}
      >
        <Box
          onMouseEnter={!trashed && onReorderHover ? () => onReorderHover(true) : undefined}
          onMouseLeave={!trashed && onReorderHover ? () => onReorderHover(false) : undefined}
          sx={{ display: "inline-flex", alignItems: "center" }}
        >
        <Tooltip title={trashed ? "restore to reorder" : "drag to reorder"}>
          <Box
            draggable={!trashed}
            onDragStart={(e) => {
              if (trashed) return;
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", row.id);
              if (paperRef.current) {
                e.dataTransfer.setDragImage(paperRef.current, 12, 12);
              }
              onGripDragStart();
            }}
            onDragEnd={onDragEnd}
            sx={{
              cursor: trashed ? "default" : "grab",
              color: "text.disabled",
              display: "inline-flex",
              alignItems: "center",
              "&:active": { cursor: trashed ? "default" : "grabbing" },
            }}
          >
            <DragIndicatorIcon fontSize="small" />
          </Box>
        </Tooltip>
        <Tooltip title="move up">
          <span>
            <IconButton
              size="small"
              onClick={(e) => { e.stopPropagation(); onMoveUp?.(); }}
              disabled={!onMoveUp}
              sx={{ p: 0.25, color: "text.disabled" }}
            >
              <ArrowUpwardIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="move down">
          <span>
            <IconButton
              size="small"
              onClick={(e) => { e.stopPropagation(); onMoveDown?.(); }}
              disabled={!onMoveDown}
              sx={{ p: 0.25, color: "text.disabled" }}
            >
              <ArrowDownwardIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </span>
        </Tooltip>
        </Box>
        <Box sx={readOnly ? { pointerEvents: "none", opacity: 0.6 } : undefined}>
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
        {onChangeVerse && verseOptions && verseOptions.length > 0 && !readOnly ? (
          <Tooltip title="change reference">
            <Chip
              label={row.ref_raw}
              size="small"
              variant="outlined"
              clickable
              deleteIcon={<ArrowDropDownIcon />}
              onDelete={(e) => {
                e.stopPropagation();
                setRefMenuAnchor(e.currentTarget.parentElement as HTMLElement);
              }}
              onClick={(e) => {
                e.stopPropagation();
                setRefMenuAnchor(e.currentTarget);
              }}
              sx={{ fontFamily: "monospace", fontSize: 11, height: 22, color: "text.secondary" }}
            />
          </Tooltip>
        ) : (
          <Typography variant="caption" sx={{ color: "text.disabled", fontFamily: "monospace" }}>
            {row.ref_raw}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        {/* Right-side action controls grouped into one non-shrinking, non-wrapping
            row. The header itself still wraps (flexWrap on the Stack), but it can
            now only break between the metadata on the left and this whole group —
            never mid-group. That stops the lone + / Save / trash icons from
            flip-flopping across the wrap boundary one at a time when a note goes
            dirty (editing injects the Undo button here, eating the row's slack):
            the group either fits on line 1 or drops to line 2 as a stable unit. */}
        <Stack direction="row" spacing={1} alignItems="center" sx={{ flexShrink: 0 }}>
        <Tooltip
          title={
            row.restored_from_version != null
              ? `v${row.restored_from_version} (restored)${hasRowDiff ? " · unsaved edits" : ""} — currently at row v${row.version}; last update ${new Date(row.updated_at * 1000).toLocaleString()}. Click to view history.`
              : `v${row.version}${hasRowDiff ? " · unsaved edits" : ""} — saved ${row.version - 1} time${row.version - 1 === 1 ? "" : "s"}; last update ${new Date(row.updated_at * 1000).toLocaleString()}. Click to view history.`
          }
        >
          <Chip
            label={`v${row.restored_from_version ?? row.version}${hasRowDiff ? "*" : ""}`}
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
              color: hasRowDiff ? "warning.main" : "text.secondary",
              borderColor: hasRowDiff ? "warning.main" : "divider",
              fontWeight: hasRowDiff ? 600 : 400,
            }}
          />
        </Tooltip>
        {/* Gated on hasRowDiff alone (not `active`): a dirty note must show
            its Undo button whether or not the card is focused. Tying it to
            `active` made the button appear only after the activating click,
            and clicking Save on an inactive-but-dirty card (the catch-up
            save) would activate the card mid-click, inject this Undo button
            to Save's left, and shove Save out from under the cursor — so the
            first click landed on nothing and a second was needed. */}
        {hasRowDiff && (
          <Tooltip
            title={
              savePendingVersion !== null
                ? "can't discard while a save is in flight — wait for it to land"
                : "discard unsaved edits — revert to the last saved version of this note"
            }
          >
            <span>
              <IconButton
                size="small"
                onClick={handleUndo}
                disabled={savePendingVersion !== null}
                sx={{
                  p: 0.25,
                  color: savePendingVersion !== null ? "action.disabled" : "warning.main",
                }}
              >
                <UndoIcon fontSize="inherit" />
              </IconButton>
            </span>
          </Tooltip>
        )}
        <Tooltip
          title={
            savePendingVersion !== null
              ? "saving…"
              : hasRowDiff
                ? "save pending edits to the server"
                : "no pending edits"
          }
        >
          <span>
            <IconButton
              size="small"
              onClick={flushPending}
              disabled={!hasRowDiff || savePendingVersion !== null}
              sx={{
                p: 0.25,
                color:
                  hasRowDiff && savePendingVersion === null
                    ? "primary.main"
                    : "action.disabled",
              }}
            >
              {hasRowDiff ? <SaveIcon fontSize="inherit" /> : <SaveOutlinedIcon fontSize="inherit" />}
            </IconButton>
          </span>
        </Tooltip>
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
        {trashed && (
          <>
            <Chip
              label="deleted"
              size="small"
              color="default"
              variant="outlined"
              sx={{ height: 22, fontSize: 11, color: "text.secondary", borderColor: "divider" }}
            />
            <Tooltip title="restore this note (otherwise removed tonight)">
              <IconButton size="small" onClick={onRestore} color="primary" sx={{ p: 0.25 }}>
                <RestoreFromTrashIcon fontSize="inherit" />
              </IconButton>
            </Tooltip>
          </>
        )}
        </Stack>
      </Stack>

      {/* ── Quote ── */}
      <Box sx={{ px: 1.5, pt: 0.75, pb: 0.5 }}>
        <Stack direction="row" alignItems="center" sx={{ mb: 0.5 }}>
          <Typography
            variant="caption"
            sx={{
              fontFamily: "monospace",
              color: "text.secondary",
              textTransform: "uppercase",
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: "0.12em",
            }}
          >
            Quote
          </Typography>
          <Box sx={{ flex: 1 }} />
          {active && !readOnly && onStartQuoteBuild && (
            <Tooltip title="open the picker to pick Hebrew/Greek words — or click ULT/UST words and the picker resolves their alignment">
              <Button
                size="small"
                variant={quoteBuildMode ? "outlined" : "text"}
                color={quoteBuildMode ? "primary" : "inherit"}
                onClick={onStartQuoteBuild}
                sx={{
                  fontSize: 11,
                  minWidth: 0,
                  py: 0.25,
                  px: 0.75,
                  color: quoteBuildMode ? "primary.main" : "text.secondary",
                }}
              >
                {quoteBuildMode
                  ? `picker open · ${quoteBuildSelectionCount} selected`
                  : "build from source"}
              </Button>
            </Tooltip>
          )}
        </Stack>
        <TextField
          value={quote}
          onChange={(e) => {
            setQuote(e.target.value);
            // Debounced parent propagation for the live highlight; no longer
            // a whole-app re-render per keystroke (see scheduleQuotePropagate).
            scheduleQuotePropagate();
          }}
          multiline
          fullWidth
          size="small"
          spellCheck={false}
          onFocus={onFocus}
          InputProps={{
            readOnly,
            ...(hasRowDiff && quote !== rowQuoteDisplay ? { "data-dirty": "true" } : {}),
            ...(showTranslateIcon && {
              endAdornment: (
                <InputAdornment position="end" sx={{ alignSelf: "flex-start" }}>
                  <Tooltip title="translate to Hebrew/Greek using ULT alignment">
                    <IconButton
                      size="small"
                      onClick={handleTranslateQuote}
                      sx={{ p: 0.25, color: "primary.main" }}
                    >
                      <TranslateIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </InputAdornment>
              ),
            }),
          }}
          inputProps={{
            dir: quoteScript === "ltr" ? "ltr" : "rtl",
            style: {
              fontFamily: '"Times New Roman","SBL Hebrew","Cardo",serif',
              fontSize: quoteScript === "rtl" ? 21 : 19,
              textAlign: quoteScript === "ltr" ? "left" : "right",
              lineHeight: quoteScript === "rtl" ? 1.9 : 1.5,
            },
          }}
        />
      </Box>

      {/* ── Note (hero) ── */}
      <Box sx={{ px: 1.5, pt: 0.75, pb: 0.75 }}>
        <Stack direction="row" alignItems="center" sx={{ mb: 0.5 }}>
          <Typography
            variant="caption"
            sx={{
              fontFamily: "monospace",
              color: "text.secondary",
              textTransform: "uppercase",
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: "0.12em",
            }}
          >
            Note
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Tooltip
            title={
              !supportRef
                ? "pick a support reference first"
                : templatesForRef.length === 0
                  ? `no template for ${shortSupport(supportRef)}`
                  : templatesForRef.length > 1
                    ? "choose a template"
                    : "fill from template"
            }
          >
            <span>
              <Button
                size="small"
                variant="text"
                onClick={handleTemplateClick}
                disabled={readOnly || !supportRef || templatesForRef.length === 0}
                startIcon={<DescriptionOutlinedIcon sx={{ fontSize: "14px !important" }} />}
                endIcon={
                  templatesForRef.length > 1 ? (
                    <ArrowDropDownIcon sx={{ fontSize: "16px !important", ml: -0.75 }} />
                  ) : undefined
                }
                sx={{ fontSize: 12, fontWeight: 500, color: "text.secondary", minWidth: 0, py: 0.25, px: 0.75 }}
              >
                Template
              </Button>
            </span>
          </Tooltip>
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
              <Button
                size="small"
                variant="text"
                onClick={handleAiClick}
                disabled={!onStartAi || !aiPrereqsMet || isAiPending || readOnly}
                startIcon={
                  isAiPending ? (
                    <CircularProgress size={12} color="inherit" />
                  ) : (
                    <AutoAwesomeIcon sx={{ fontSize: "14px !important" }} />
                  )
                }
                sx={{ fontSize: 12, fontWeight: 500, color: "text.secondary", minWidth: 0, py: 0.25, px: 0.75 }}
              >
                Suggest
              </Button>
            </span>
          </Tooltip>
        </Stack>
        <TextField
          value={note}
          onChange={(e) => {
            // Body text is consumed only by this card — keep it purely local
            // (persisted via the draft store, saved through flushPending). No
            // applyLocalRowPatch, so a keystroke doesn't re-render the app.
            setNote(e.target.value);
          }}
          multiline
          fullWidth
          minRows={2}
          size="small"
          spellCheck
          onFocus={onFocus}
          InputProps={{
            readOnly,
            ...(hasRowDiff && note !== rowNoteDisplay ? { "data-dirty": "true" } : {}),
          }}
          inputProps={{
            style: {
              fontSize: 13,
              lineHeight: 1.55,
              fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif',
            },
          }}
        />
      </Box>

      {/* ── Footer chips ── */}
      <Stack
        direction="row"
        alignItems="center"
        sx={{
          px: 1.5,
          pt: 0.75,
          pb: 1.25,
          flexWrap: "wrap",
          rowGap: 0.5,
          columnGap: 0.75,
          borderTop: "1px solid",
          borderColor: "divider",
          bgcolor: "grey.50",
        }}
      >
        {onSetPreserve && (
          <Tooltip title="Mark this note to survive future AI pipeline runs.">
            <Chip
              size="small"
              icon={<PushPinOutlinedIcon style={{ fontSize: 12 }} />}
              label="Preserve"
              variant={isPreserved ? "filled" : "outlined"}
              color={isPreserved ? "success" : "default"}
              onClick={() => {
                const next = !isPreserved;
                onSetPreserve(next);
                if (next && isHint) onSetHint?.(false);
              }}
              sx={{ fontSize: 11, height: 22, cursor: "pointer" }}
            />
          </Tooltip>
        )}
        {onSetHint && !readOnly && (
          <Tooltip title="Send this stub to the next AI pipeline run as a hint. The AI will expand it in place; the row survives the sweep.">
            <Chip
              size="small"
              icon={<LightbulbOutlinedIcon style={{ fontSize: 12 }} />}
              label="Hint"
              variant={isHint ? "filled" : "outlined"}
              color={isHint ? "warning" : "default"}
              onClick={() => {
                const next = !isHint;
                onSetHint(next);
                if (next && isPreserved) onSetPreserve?.(false);
              }}
              sx={{ fontSize: 11, height: 22, cursor: "pointer" }}
            />
          </Tooltip>
        )}

        {/* breathing room between toggle group and template group */}
        <Box sx={{ width: 12 }} aria-hidden="true" />

        <Tooltip title='Fill with "This could mean" template. Double-click any placeholder (NOTE, ALT) to replace it.'>
          <span>
            <Chip
              size="small"
              label="TCM"
              variant="outlined"
              disabled={readOnly}
              onClick={() => {
                setNote(TCM);
                stashEdit({ note: TCM });
              }}
              sx={{
                fontFamily: "monospace",
                fontSize: 11,
                height: 22,
                borderStyle: "dashed",
                color: "primary.main",
                borderColor: "primary.light",
                "&:hover": { bgcolor: "primary.50" },
              }}
            />
          </span>
        </Tooltip>
        <Tooltip title='Fill with "See how you translated" template.'>
          <span>
            <Chip
              size="small"
              label="SH"
              variant="outlined"
              disabled={readOnly}
              onClick={() => {
                const t = buildSH(row.book);
                setNote(t);
                stashEdit({ note: t });
              }}
              sx={{
                fontFamily: "monospace",
                fontSize: 11,
                height: 22,
                borderStyle: "dashed",
                color: "primary.main",
                borderColor: "primary.light",
                "&:hover": { bgcolor: "primary.50" },
              }}
            />
          </span>
        </Tooltip>

        <Box sx={{ flex: 1 }} />

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
        <Chip
          label={row.id}
          size="small"
          variant="outlined"
          sx={{ fontFamily: "monospace", fontSize: 11, height: 22 }}
        />
      </Stack>
      {historyOpen && (
        <Suspense fallback={null}>
          <NoteHistoryDialog
            open={historyOpen}
            noteId={row.id}
            book={row.book}
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
              onStartAi?.(buildAiLive());
            }}
            color="primary"
            variant="contained"
          >
            Replace
          </Button>
        </DialogActions>
      </Dialog>
      <Menu
        anchorEl={refMenuAnchor}
        open={Boolean(refMenuAnchor)}
        onClose={() => setRefMenuAnchor(null)}
        slotProps={{ paper: { sx: { maxHeight: 320 } } }}
      >
        {(verseOptions ?? []).map((v) => (
          <MenuItem
            key={v}
            selected={v === row.verse}
            onClick={() => {
              setRefMenuAnchor(null);
              if (v !== row.verse) onChangeVerse?.(v);
            }}
          >
            {v === 0 ? "intro" : `v${v}`}
          </MenuItem>
        ))}
      </Menu>
      <Menu
        anchorEl={templateMenuAnchor}
        open={Boolean(templateMenuAnchor)}
        onClose={() => setTemplateMenuAnchor(null)}
        slotProps={{ paper: { sx: { maxWidth: 380 } } }}
      >
        {templatesForRef.map((t, i) => (
          <MenuItem
            key={`${t.type}-${i}`}
            onClick={() => {
              setTemplateMenuAnchor(null);
              requestTemplate(t.body);
            }}
            sx={{ whiteSpace: "normal", alignItems: "flex-start" }}
          >
            <ListItemText
              primary={t.type || "default"}
              secondary={t.body.length > 90 ? `${t.body.slice(0, 90)}…` : t.body}
            />
          </MenuItem>
        ))}
      </Menu>
      <Dialog open={templateConfirmBody !== null} onClose={() => setTemplateConfirmBody(null)}>
        <DialogTitle>Replace existing note?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This note already has text. Filling from the template will replace it. You can hit
            Undo on the toolbar afterwards to restore the original.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTemplateConfirmBody(null)}>Cancel</Button>
          <Button
            onClick={() => {
              if (templateConfirmBody !== null) applyTemplate(templateConfirmBody);
              setTemplateConfirmBody(null);
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

// Skip re-rendering a card when only sibling cards changed. We compare the
// data + UI-state props by value and treat the callback props as stable:
// they close over this row's id plus Shell handlers, and a row whose data is
// unchanged keeps a behaviourally-correct closure. The `row` reference is the
// load-bearing check — useChapter.applyLocalRowPatch preserves identity for
// untouched rows, so an edit or save on one note doesn't churn the others.
function areNotePropsEqual(a: Props, b: Props): boolean {
  return (
    a.row === b.row &&
    a.active === b.active &&
    a.dragging === b.dragging &&
    a.isDropTarget === b.isDropTarget &&
    a.isAiPending === b.isAiPending &&
    a.aiRecentlyCompletedAt === b.aiRecentlyCompletedAt &&
    a.locked === b.locked &&
    a.quoteBuildMode === b.quoteBuildMode &&
    a.quoteBuildSelectionCount === b.quoteBuildSelectionCount
  );
}

export const NoteCard = memo(NoteCardInner, areNotePropsEqual);
