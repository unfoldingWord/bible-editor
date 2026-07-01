import { Fragment, type Ref, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Stack, Typography, Chip, Button, IconButton, Tooltip } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import PushPinIcon from "@mui/icons-material/PushPin";
import PushPinOutlinedIcon from "@mui/icons-material/PushPinOutlined";
import type { TnRow, TqRow, TwlRow, VerseDto, TwlSuggestion } from "../sync/api";
import { NoteCard, type DropPosition } from "./NoteCard";
import { WordsTable, type WordDropPosition } from "./WordsTable";
import { TwlSuggestions } from "./TwlSuggestions";
import { QuestionsTable } from "./QuestionsTable";
import { AlignmentPanel, type AlignmentPanelHandle } from "./AlignmentPanel";
import CheckIcon from "@mui/icons-material/Check";
import { LANE_FILL, type LaneShade } from "../lib/laneChecks";

export type PanelMode = "resources" | "alignment" | "search";

// In-context checkoff for the resource panels (Notes/Words/Questions), scoped to
// the active verse. Shell computes these from the lane-check state.
export type ResourceLane = "tn" | "tw" | "tq";
export interface ResourceCheckoff {
  canCheck: boolean;
  shade: (lane: ResourceLane) => LaneShade;
  applicable: (lane: ResourceLane) => boolean;
  attribution: (lane: ResourceLane) => string;
  onToggle: (lane: ResourceLane) => void;
  // Bulk "all this chapter" — Shell decides direction (check-all unless every
  // applicable verse is already mine, then clear-all).
  onBulkToggle: (lane: ResourceLane) => void;
}

// External search tool embedded in the Search tab. Allow-listed in the API's
// CSP frame-src (api/src/index.ts) — adding a different host requires updating
// both.
const SEARCH_IFRAME_URL = "https://swunrow.pythonanywhere.com/";

// Candidate slot for the reorder "stoplight" — the moved note plus the note
// ids that would become its predecessor / successor at the current drag target
// (or after an arrow move). Shell resolves these ids to quotes and lights the
// active verse green (prev) / red (next). null prev/next means "no neighbour on
// that side" (moved note is first / last in its verse).
export interface ReorderPreview {
  verse: number;
  movedId: string;
  prevId: string | null;
  nextId: string | null;
}

export interface AlignmentTabProps {
  book: string;
  chapter: number;
  verseNum: number;
  bibleVersion: string;
  verse: VerseDto | null;
  sourceVerse: VerseDto | null;
  sourceLabel: string;
  twlForVerse: TwlRow[];
  onSave: (newContent: unknown, plainText: string, expectedVersion: number) => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  // Confirm-before-save when the edit would unalign a previously aligned word
  // (forwarded to AlignmentPanel; see its onConfirmUnalign prop).
  onConfirmUnalign?: (lostWords: string[], commit: () => void) => void;
  panelRef?: Ref<AlignmentPanelHandle>;
  onOpenDual?: () => void;
  // Restore a previously-saved verse version from the panel's history button.
  onRestoreVersion?: (content: unknown, plainText: string | null) => void;
}

interface Props {
  // Active location — needed by the per-verse TWL suggestions fetch.
  book: string;
  chapter: number;
  activeVerse: number;
  // Inclusive [start, end] of verses to surface in TN/TQ/TWL panels. Equals
  // [activeVerse, activeVerse] for the common singleton case; widens to the
  // span of any multi-verse row (e.g. UST 6-9) that covers activeVerse so
  // notes/words for verses 6,7,8,9 all show when the user navigates to v=7.
  displayVerseRange: readonly [number, number];
  tn: TnRow[];
  tq: TqRow[];
  twl: TwlRow[];
  activeNoteId: string | null;
  activeWordId: string | null;
  // Find-in-notes highlight: query marks every match in each note body; the
  // active match (by note id + occurrence index) is emphasized + scrolled to.
  findNoteQuery?: { find: string; regex: boolean; caseSensitive: boolean } | null;
  activeNoteMatch?: { noteId: string; occurrence: number } | null;
  // Bumped by Shell's "go to active" button so the resource column can
  // recentre on the active note / word / verse group alongside the
  // scripture column.
  scrollNonce: number;
  onNoteChange: (id: string, patch: Partial<TnRow>) => void;
  onNoteSave: (
    id: string,
    patch: Partial<TnRow>,
    opts?: { restoredFromVersion?: number },
  ) => void;
  onNoteDelete: (id: string) => void;
  onNoteRestore: (id: string) => void;
  onNoteInsertAfter: (refId: string) => void;
  onNoteReorder: (draggedId: string, refId: string, position: DropPosition) => void;
  // Verse numbers in the loaded chapter, offered in each note's reference
  // picker; onNoteChangeVerse retargets a note to a different verse.
  verseOptions: number[];
  onNoteChangeVerse: (id: string, verse: number) => void;
  // Report the moved note's candidate neighbours so Shell can paint the
  // active-verse stoplight. Fired live as a drag hovers each slot (sticky =
  // false; cleared on drop), and once after an arrow move (sticky = true,
  // auto-clears in Shell after ~3s). null clears the preview.
  onReorderPreview?: (preview: ReorderPreview | null, sticky?: boolean) => void;
  onNoteFocus: (row: TnRow) => void;
  onNoteCreate: () => void;
  // Async AI-draft wiring. All optional — when absent, sparkles hides.
  // start fires the request (returns immediately); the result lands
  // later via the row patch pipeline. The two read-only accessors let
  // each NoteCard show its spinner / pulse independently. Visibility
  // bubbles up to Shell so it can route completions to either the
  // in-place pulse or the off-screen toast stack.
  onNoteStartAi?: (
    row: TnRow,
    live: { quote: string; note: string; support_reference: string | null },
  ) => void;
  isNoteAiPending?: (rowId: string) => boolean;
  noteAiRecentlyCompletedAt?: (rowId: string) => number | null;
  onNoteVisibilityChange?: (rowId: string, isVisible: boolean) => void;
  onWordSave: (id: string, patch: Partial<TwlRow>) => void;
  onWordDelete: (id: string) => void;
  onWordCreate: () => void;
  onWordFocus: (row: TwlRow) => void;
  onWordReorder: (draggedId: string, refId: string, position: WordDropPosition) => void;
  onQuestionSave: (id: string, patch: Partial<TqRow>) => void;
  onQuestionDelete: (id: string) => void;
  onQuestionCreate: () => void;
  // Chapter is locked for editing because an AI pipeline is mid-flight.
  // Hides "new" buttons, propagates read-only to children.
  locked?: boolean;
  // Toggle the TN's preserve bit ("survive future AI pipeline sweeps").
  // Threaded through to NoteCard. Always available, regardless of lock.
  onSetNotePreserve?: (id: string, value: boolean) => void;
  // Toggle the TN's hint bit ("queue as AI-pipeline directive"). Threaded
  // through to NoteCard.
  onSetNoteHint?: (id: string, value: boolean) => void;
  // Translate English in a note's quote field to source-language text using
  // ULT alignment. Returns null when no alignment match is found.
  onNoteTranslateQuote?: (row: TnRow, english: string) => string | null;
  // Same translate flow but for the TWL quote (orig_words) column.
  onWordTranslateQuote?: (row: TwlRow, english: string) => string | null;
  // Read-only English (ULT) gloss for a TWL row's saved orig_words (alignment-
  // derived). Shell owns the verse objects, so it computes the gloss.
  onWordGloss?: (row: TwlRow) => string;
  // Quote-builder session. Shell owns the selection state + the picker
  // popup; the note cards / word rows just surface a button that opens it.
  quoteBuildActiveNoteId?: string | null;
  // Same session, but when the active target is a TWL word row instead of a note.
  quoteBuildActiveWordId?: string | null;
  quoteBuildSelectionCount?: number;
  onStartQuoteBuild?: (noteId: string) => void;
  // Open the quote-builder for a TWL word row (writes orig_words + occurrence).
  onStartWordQuoteBuild?: (wordId: string) => void;
  // Promote a per-verse TWL suggestion to a real link (resolve + createRow). When
  // absent, the Suggestions section hides.
  onAddTwlSuggestion?: (suggestion: TwlSuggestion, chosenArticleId: string) => void;
  // Drop suggestions already linked on the active verse (resolved-OL identity).
  isTwlSuggestionExcluded?: (suggestion: TwlSuggestion) => boolean;
  // Article ids the unlinked deny-list blocks for a suggestion's resolved quote
  // — pruned from its picker; the whole suggestion hides when all are blocked.
  twlBlockedArticleIds?: (suggestion: TwlSuggestion, candidateIds?: string[]) => Set<string>;
  // Whether the TWL deny-lists have settled (loaded or failed). Suggestions hold
  // off rendering until then so a blocked link can't show before filters arrive.
  twlFiltersReady?: boolean;
  // Per-note commit signal — its nonce bumps when a quote-build commits for
  // that note, telling the matching card to land the built quote in the box.
  quoteBuildAppliedTo?: { noteId: string; nonce: number } | null;
  // Tab + alignment-panel wiring. When mode === "alignment", the Resources
  // column body swaps to the AlignmentPanel; the Notes/Words/Questions tabs
  // stay in the strip but their click acts as a scroll-to in resources mode.
  panelMode?: PanelMode;
  onSetPanelMode?: (mode: PanelMode) => void;
  alignmentProps?: AlignmentTabProps;
  alignmentBadge?: string;
  // Per-resource checkoff for the active verse (in-context "done" + bulk).
  checkoff?: ResourceCheckoff;
}

type PinKey = "notes" | "words" | "questions";
type Pinned = Record<PinKey, boolean>;
type ResourceTab = "notes" | "words" | "questions";

const PINNED_KEY = "be:pinned";

// Drag auto-scroll: begin scrolling when the pointer is within this many px of
// the list's top/bottom edge, advancing this many px per animation frame.
const DRAG_SCROLL_EDGE_PX = 56;
const DRAG_SCROLL_SPEED_PX = 12;

function loadPinned(): Pinned {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Pinned>;
      return {
        notes: !!parsed.notes,
        words: !!parsed.words,
        questions: !!parsed.questions,
      };
    }
  } catch {
    /* ignore */
  }
  return { notes: false, words: false, questions: false };
}

function savePinned(p: Pinned) {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

function sortBySortOrder<
  T extends { sort_order: number | null; id: string; trashed_at?: number | null },
>(rows: T[]): T[] {
  // Trashed notes always sort to the bottom of the verse, preserving their
  // relative order. Purely presentational — sort_order is untouched, so a
  // Restore drops the note straight back to its original position. Rows
  // without a trashed_at field (twl) are treated as not trashed.
  return [...rows].sort(
    (a, b) =>
      (a.trashed_at != null ? 1 : 0) - (b.trashed_at != null ? 1 : 0) ||
      (a.sort_order ?? Number.MAX_SAFE_INTEGER) -
        (b.sort_order ?? Number.MAX_SAFE_INTEGER) ||
      a.id.localeCompare(b.id),
  );
}

function groupByVerse<T extends { verse: number }>(rows: T[]): Array<[number, T[]]> {
  const map = new Map<number, T[]>();
  for (const r of rows) {
    const bucket = map.get(r.verse) ?? [];
    bucket.push(r);
    map.set(r.verse, bucket);
  }
  return [...map.entries()].sort(([a], [b]) => a - b);
}

export function ResourceColumn({
  book,
  chapter,
  activeVerse,
  displayVerseRange,
  tn,
  tq,
  twl,
  activeNoteId,
  activeWordId,
  findNoteQuery,
  activeNoteMatch,
  scrollNonce,
  onNoteChange,
  onNoteSave,
  onNoteDelete,
  onNoteRestore,
  onNoteInsertAfter,
  onNoteReorder,
  verseOptions,
  onNoteChangeVerse,
  onReorderPreview,
  onNoteFocus,
  onNoteCreate,
  onNoteStartAi,
  isNoteAiPending,
  noteAiRecentlyCompletedAt,
  onNoteVisibilityChange,
  onWordSave,
  onWordDelete,
  onWordCreate,
  onWordFocus,
  onWordReorder,
  onQuestionSave,
  onQuestionDelete,
  onQuestionCreate,
  locked = false,
  onSetNotePreserve,
  onSetNoteHint,
  onNoteTranslateQuote,
  onWordTranslateQuote,
  onWordGloss,
  quoteBuildActiveNoteId,
  quoteBuildActiveWordId,
  quoteBuildSelectionCount = 0,
  onStartQuoteBuild,
  onStartWordQuoteBuild,
  onAddTwlSuggestion,
  isTwlSuggestionExcluded,
  twlBlockedArticleIds,
  twlFiltersReady,
  quoteBuildAppliedTo,
  panelMode = "resources",
  onSetPanelMode,
  alignmentProps,
  alignmentBadge,
  checkoff,
}: Props) {
  const [pinned, setPinned] = useState<Pinned>(() => loadPinned());
  const togglePinned = (k: PinKey) => {
    const next = { ...pinned, [k]: !pinned[k] };
    setPinned(next);
    savePinned(next);
  };

  // Which resource the body shows when panelMode === "resources". Splitting
  // Notes / Words / Questions into separate views keeps the Notes column free
  // of TWL/TQ clutter; the tabs now switch the view instead of scroll-jumping
  // within one stacked body.
  const [resourceTab, setResourceTab] = useState<ResourceTab>("notes");
  const showResource = (tab: ResourceTab) => {
    if (panelMode !== "resources") onSetPanelMode?.("resources");
    setResourceTab(tab);
  };

  // Lazily mount the Search iframe on first visit, then keep it alive (the body
  // toggles its visibility rather than unmounting). Avoids loading the external
  // tool on every page load for users who never open the tab.
  const [searchVisited, setSearchVisited] = useState(false);
  useEffect(() => {
    if (panelMode === "search") setSearchVisited(true);
  }, [panelMode]);

  const [rangeStart, rangeEnd] = displayVerseRange;
  // When a UST verse bridge widens the range to span multiple verses (e.g. ISA
  // 33:15-16, UST row verse=15/verse_end=16 while UHB/ULT keep them separate),
  // the union must render grouped by verse — all of v15 then all of v16 — not
  // interleaved by sort_order. Each verse numbers sort_order from 100
  // independently, so a flat sort scrambles them (v15@100, v16@100, v15@200…).
  // groupByVerse orders the buckets by verse ascending; within a verse each
  // resource sorts by sort_order (the per-verse ordinal assigned in TSV file
  // order at import). Singletons (the common case) reduce to the prior behavior.
  const tnForVerse = useMemo(
    () =>
      groupByVerse(tn.filter((r) => r.verse >= rangeStart && r.verse <= rangeEnd)).flatMap(
        ([, rows]) => sortBySortOrder(rows),
      ),
    [tn, rangeStart, rangeEnd],
  );
  const tqForVerse = useMemo(
    () =>
      groupByVerse(tq.filter((r) => r.verse >= rangeStart && r.verse <= rangeEnd)).flatMap(
        ([, rows]) => sortBySortOrder(rows),
      ),
    [tq, rangeStart, rangeEnd],
  );
  const twlForVerse = useMemo(
    () =>
      groupByVerse(twl.filter((r) => r.verse >= rangeStart && r.verse <= rangeEnd)).flatMap(
        ([, rows]) => sortBySortOrder(rows),
      ),
    [twl, rangeStart, rangeEnd],
  );

  // Pinned sections show the whole chapter, grouped by verse. Within each
  // verse the row order matches the unpinned view.
  const tnGroups = useMemo(
    () =>
      pinned.notes
        ? groupByVerse(tn).map(([v, rows]) => [v, sortBySortOrder(rows)] as [number, TnRow[]])
        : null,
    [pinned.notes, tn],
  );
  const tqGroups = useMemo(
    () =>
      pinned.questions
        ? groupByVerse(tq).map(([v, rows]) => [v, sortBySortOrder(rows)] as [number, TqRow[]])
        : null,
    [pinned.questions, tq],
  );
  const twlGroups = useMemo(
    () =>
      pinned.words
        ? groupByVerse(twl).map(([v, rows]) => [v, sortBySortOrder(rows)] as [number, TwlRow[]])
        : null,
    [pinned.words, twl],
  );

  const totalTn = pinned.notes ? tn.length : tnForVerse.length;
  const totalTwl = pinned.words ? twl.length : twlForVerse.length;
  const totalTq = pinned.questions ? tq.length : tqForVerse.length;

  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<
    { targetId: string; position: DropPosition } | null
  >(null);

  // Arrow-reorder focus + visible hint (mirrors WordsTable). React preserves
  // the moved card's keyed DOM node, so focus already rides along and Enter/
  // Space repeats the move — but a mouse click shows no focus ring, so we
  // re-assert focus on the moved note's arrow and flash a ring to make that
  // discoverable. tnRowsRef/scrollBodyRef are the query root.
  const noteFocusRef = useRef<{ id: string; dir: "up" | "down" } | null>(null);
  const [recentNoteMove, setRecentNoteMove] = useState<{ id: string; dir: "up" | "down" } | null>(null);
  const noteFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    const pending = noteFocusRef.current;
    if (!pending) return;
    noteFocusRef.current = null;
    const root = scrollBodyRef.current;
    if (!root) return;
    const find = (d: "up" | "down") =>
      root.querySelector<HTMLButtonElement>(
        `[data-note-id="${pending.id}"] [data-reorder-arrow="${d}"]`,
      );
    const btn = find(pending.dir);
    // Reached the top/bottom: the arrow we were moving with is now disabled.
    // Don't hop focus to the opposite arrow — that turns repeated Space into an
    // endless up-to-top-then-down-to-bottom loop. Drop focus instead so the run
    // simply stops at the edge.
    if (!btn || btn.disabled) {
      (document.activeElement as HTMLElement | null)?.blur?.();
      return;
    }
    btn.focus();
    setRecentNoteMove({ id: pending.id, dir: pending.dir });
    if (noteFlashTimer.current) clearTimeout(noteFlashTimer.current);
    noteFlashTimer.current = setTimeout(() => setRecentNoteMove(null), 1600);
  });
  useEffect(() => () => { if (noteFlashTimer.current) clearTimeout(noteFlashTimer.current); }, []);

  // Resolve the moved note's candidate neighbours at a given drop target —
  // shared by the live drag hover and the arrow moves. Scoped to the moved
  // note's verse, excluding the moved note and any trashed notes (the same
  // per-verse, non-trashed ordering the reorder itself renumbers).
  const computeNeighbors = useCallback(
    (movedId: string, targetId: string, position: DropPosition): ReorderPreview | null => {
      const moved = tn.find((r) => r.id === movedId);
      if (!moved) return null;
      const list = sortBySortOrder(
        tn.filter((r) => r.verse === moved.verse && r.trashed_at == null && r.id !== movedId),
      );
      const ti = list.findIndex((r) => r.id === targetId);
      const insertion = ti < 0 ? list.length : position === "before" ? ti : ti + 1;
      return {
        verse: moved.verse,
        movedId,
        prevId: list[insertion - 1]?.id ?? null,
        nextId: list[insertion]?.id ?? null,
      };
    },
    [tn],
  );

  // Live drag preview: as the dragged card hovers each slot, report the
  // neighbours it would land between. dragOver only changes ref when the slot
  // actually changes (see onCardDragOver), so this fires once per slot. The
  // preview is cleared on dragend (onDragEnd below), not here — returning early
  // when the drag stops avoids wiping a sticky arrow-move preview.
  useEffect(() => {
    if (!onReorderPreview || !dragId || !dragOver) return;
    const preview = computeNeighbors(dragId, dragOver.targetId, dragOver.position);
    if (preview) onReorderPreview(preview, false);
  }, [dragId, dragOver, computeNeighbors, onReorderPreview]);

  const scrollBodyRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll the list while a reorder drag hovers near its top/bottom edge.
  // Native HTML5 DnD only auto-scrolls the window, never a nested overflow
  // container, so without this a note/word can't be dropped onto a card that
  // started scrolled out of view. Direction lives in a ref the rAF loop reads;
  // a drag can end on a card, outside the list, or via Esc, but the global
  // `dragend` always fires, so it's the reliable place to kill the loop.
  const autoScrollRaf = useRef<number | null>(null);
  const autoScrollDir = useRef(0);
  useEffect(() => {
    const stop = () => {
      if (autoScrollRaf.current != null) {
        cancelAnimationFrame(autoScrollRaf.current);
        autoScrollRaf.current = null;
      }
      autoScrollDir.current = 0;
    };
    window.addEventListener("dragend", stop);
    return () => {
      window.removeEventListener("dragend", stop);
      stop();
    };
  }, []);
  const handleDragAutoScroll = (e: React.DragEvent) => {
    const el = scrollBodyRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    autoScrollDir.current =
      e.clientY < rect.top + DRAG_SCROLL_EDGE_PX
        ? -1
        : e.clientY > rect.bottom - DRAG_SCROLL_EDGE_PX
          ? 1
          : 0;
    if (autoScrollDir.current !== 0 && autoScrollRaf.current == null) {
      const step = () => {
        const node = scrollBodyRef.current;
        if (!node || autoScrollDir.current === 0) {
          autoScrollRaf.current = null;
          return;
        }
        node.scrollTop += autoScrollDir.current * DRAG_SCROLL_SPEED_PX;
        autoScrollRaf.current = requestAnimationFrame(step);
      };
      autoScrollRaf.current = requestAnimationFrame(step);
    }
  };

  // Keep the resource column lined up with the active selection. We fire on:
  //   - scrollNonce (Shell's "go to active" button)
  //   - activeNoteId / activeWordId (focus shifts that came from elsewhere)
  //   - activeVerse (timeline click, especially relevant when a section is
  //     pinned and the user wants to jump into that verse's group)
  //   - pinned.* (pin toggles, so the user lands on the same conceptual
  //     spot they were viewing before the layout reshuffled)
  // Priority: active note > active word > active-verse group in any pinned
  // section. Without any of those, no scroll.
  const prevNonceRef = useRef(scrollNonce);
  const prevVerseRef = useRef(activeVerse);
  const prevPinnedRef = useRef(pinned);
  useEffect(() => {
    const root = scrollBodyRef.current;
    if (!root) return;
    const fromButton = prevNonceRef.current !== scrollNonce;
    prevNonceRef.current = scrollNonce;
    const verseChanged = prevVerseRef.current !== activeVerse;
    prevVerseRef.current = activeVerse;
    const pinChanged =
      prevPinnedRef.current.notes !== pinned.notes ||
      prevPinnedRef.current.words !== pinned.words ||
      prevPinnedRef.current.questions !== pinned.questions;
    prevPinnedRef.current = pinned;
    // The verse-group / verse-end fallbacks below reposition the whole list to
    // a verse boundary. They're meant for navigation (button, verse change, pin
    // toggle) — NOT for incidental re-runs like clearing the active note when a
    // card is trashed, which would otherwise jerk the list back to the top of
    // the verse's note group.
    const navTriggered = fromButton || verseChanged || pinChanged;
    let target: HTMLElement | null = null;
    let isVerseGroup = false;
    if (activeNoteId) {
      target = root.querySelector<HTMLElement>(`[data-note-id="${activeNoteId}"]`);
    } else if (activeWordId) {
      target = root.querySelector<HTMLElement>(`[data-word-id="${activeWordId}"]`);
    }
    if (navTriggered && !target && (pinned.notes || pinned.words || pinned.questions)) {
      target = root.querySelector<HTMLElement>(`[data-verse-group="${activeVerse}"]`);
      isVerseGroup = !!target;
    }
    // Pinned notes, active verse has no notes of its own: there's no group
    // head to land on, so fall back to the end of the previous verse's notes
    // (the last note card before the active verse's slot in the chapter).
    let atVerseEnd = false;
    if (navTriggered && !target && pinned.notes) {
      const heads = [...root.querySelectorAll<HTMLElement>('[data-vg-section="notes"]')];
      const prevHead = heads
        .filter((el) => Number(el.dataset.verseGroup) < activeVerse)
        .at(-1);
      if (prevHead) {
        // Walk forward over the previous verse's note cards, stopping at the
        // next verse group head; the last card is the end of that verse.
        let lastNote = prevHead;
        for (
          let el = prevHead.nextElementSibling;
          el && !el.hasAttribute("data-verse-group");
          el = el.nextElementSibling
        ) {
          if (el.hasAttribute("data-note-id")) lastNote = el as HTMLElement;
        }
        target = lastNote;
        atVerseEnd = true;
      }
    }
    // Individual-verse mode (nothing pinned): the list only ever shows the
    // active verse's resources, so a verse change swaps the whole list and
    // there's no target to land on. Reset to the top instead of stranding the
    // scroll wherever the previous verse left it.
    if (!target && verseChanged && !pinned.notes && !pinned.words && !pinned.questions) {
      root.scrollTo({ top: 0, behavior: "auto" });
      return;
    }
    target?.scrollIntoView({
      behavior: "smooth",
      block: isVerseGroup ? "start" : atVerseEnd ? "end" : fromButton ? "center" : "nearest",
    });
  }, [
    scrollNonce,
    activeNoteId,
    activeWordId,
    activeVerse,
    pinned.notes,
    pinned.words,
    pinned.questions,
  ]);

  return (
    <Box
      sx={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <Stack
        direction="row"
        spacing={0.25}
        alignItems="center"
        sx={{
          px: 1.5,
          pt: 0.5,
          borderBottom: "1px solid",
          borderColor: "divider",
          bgcolor: "grey.50",
        }}
      >
        <Typography
          variant="subtitle2"
          sx={{ fontSize: 12, color: "text.secondary", mr: 0.5 }}
        >
          Resources · {activeVerse === 0 ? "i" : activeVerse}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <PanelTab
          label="Notes"
          count={totalTn}
          countSuffix={pinned.notes ? " · ch" : ""}
          active={panelMode === "resources" && resourceTab === "notes"}
          accent={false}
          onClick={() => showResource("notes")}
        />
        <PanelTab
          label="Words"
          count={totalTwl}
          countSuffix={pinned.words ? " · ch" : ""}
          active={panelMode === "resources" && resourceTab === "words"}
          accent={false}
          onClick={() => showResource("words")}
        />
        <PanelTab
          label="Questions"
          count={totalTq}
          countSuffix={pinned.questions ? " · ch" : ""}
          active={panelMode === "resources" && resourceTab === "questions"}
          accent={false}
          onClick={() => showResource("questions")}
        />
        <PanelTab
          label="Alignment"
          countLabel={alignmentBadge}
          active={panelMode === "alignment"}
          accent
          onClick={() => onSetPanelMode?.("alignment")}
        />
        <PanelTab
          label="Search"
          active={panelMode === "search"}
          accent={false}
          onClick={() => onSetPanelMode?.("search")}
        />
      </Stack>
      {panelMode === "alignment" ? (
        alignmentProps ? (
          <AlignmentPanel
            // Remount on any target change (version OR verse). Without a key,
            // React reuses the instance and the panel's `state` only resets via
            // a passive useEffect that runs AFTER paint — leaving a window where
            // `state` still holds the PREVIOUS version's alignment while `verse`
            // / `onSave` are already bound to the new target. A save landing in
            // that window writes the old content to the new row (e.g. UST
            // alignment saved onto the ULT verse). Keying forces a fresh mount
            // whose useState(computedInitial) seeds the correct state
            // synchronously, closing the race.
            key={`${alignmentProps.bibleVersion}:${alignmentProps.chapter}:${alignmentProps.verseNum}`}
            ref={alignmentProps.panelRef}
            book={alignmentProps.book}
            chapter={alignmentProps.chapter}
            verseNum={alignmentProps.verseNum}
            bibleVersion={alignmentProps.bibleVersion}
            verse={alignmentProps.verse}
            sourceVerse={alignmentProps.sourceVerse}
            sourceLabel={alignmentProps.sourceLabel}
            twlForVerse={alignmentProps.twlForVerse}
            onSave={alignmentProps.onSave}
            onConfirmUnalign={alignmentProps.onConfirmUnalign}
            onCancel={alignmentProps.onCancel}
            onDirtyChange={alignmentProps.onDirtyChange}
            onOpenDual={alignmentProps.onOpenDual}
            onRestoreVersion={alignmentProps.onRestoreVersion}
          />
        ) : (
          <Box sx={{ p: 3 }}>
            <Typography variant="body2" color="text.secondary">
              Click the link icon on a ULT or UST verse to start aligning.
            </Typography>
          </Box>
        )
      ) : panelMode === "resources" ? (
      <Box
        ref={scrollBodyRef}
        onDragOver={handleDragAutoScroll}
        // scrollbarGutter:stable reserves the scrollbar's width whether or not
        // it's showing, so the cards' content width never changes as the
        // scrollbar appears/disappears. Without it, a card header sitting right
        // at its flex-wrap boundary can flip-flop a line as the gutter toggles.
        sx={{ flex: 1, overflowY: "auto", scrollbarGutter: "stable", px: 2, py: 1 }}
      >
        {resourceTab === "notes" && (
          <>
            <SectionHead
              title="Notes"
              count={totalTn}
              pinned={pinned.notes}
              onTogglePin={() => togglePinned("notes")}
              onAdd={onNoteCreate}
              sticky
              hideAdd={locked}
              lane="tn"
              checkoff={checkoff}
            />
            {tnGroups ? (
              tnGroups.length === 0 ? (
                <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
                  no notes in this chapter
                </Typography>
              ) : (
                tnGroups.map(([verse, rows]) => (
                  <Fragment key={`tn-${verse}`}>
                    <VerseGroupHead verse={verse} active={verse === activeVerse} section="notes" />
                    {rows.map((r) => renderNoteCard(r, rows))}
                  </Fragment>
                ))
              )
            ) : tnForVerse.length === 0 ? (
              <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
                no notes for this verse
              </Typography>
            ) : (
              tnForVerse.map((r) => renderNoteCard(r, tnForVerse))
            )}
          </>
        )}

        {resourceTab === "words" && (
          // Flex column filling the scroll viewport so the suggestions block
          // (mt:auto) is pushed to the bottom even when the Words list is short.
          <Box sx={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
            <SectionHead
              title="Words"
              count={totalTwl}
              pinned={pinned.words}
              onTogglePin={() => togglePinned("words")}
              onAdd={onWordCreate}
              sticky
              hideAdd={locked}
              lane="tw"
              checkoff={checkoff}
            />
            {twlGroups ? (
              twlGroups.length === 0 ? (
                <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
                  no words in this chapter
                </Typography>
              ) : (
                twlGroups.map(([verse, rows]) => (
                  <Fragment key={`twl-${verse}`}>
                    <VerseGroupHead verse={verse} active={verse === activeVerse} section="words" />
                    <WordsTable
                      rows={rows}
                      activeId={activeWordId}
                      onSave={onWordSave}
                      onDelete={onWordDelete}
                      onFocus={onWordFocus}
                      onReorder={onWordReorder}
                      locked={locked}
                      onTranslateQuote={onWordTranslateQuote}
                      onWordGloss={onWordGloss}
                      activeQuoteBuildId={quoteBuildActiveWordId}
                      quoteBuildSelectionCount={quoteBuildSelectionCount}
                      onStartQuoteBuild={onStartWordQuoteBuild}
                    />
                  </Fragment>
                ))
              )
            ) : (
              <WordsTable
                rows={twlForVerse}
                activeId={activeWordId}
                onSave={onWordSave}
                onDelete={onWordDelete}
                onFocus={onWordFocus}
                onReorder={onWordReorder}
                locked={locked}
                onTranslateQuote={onWordTranslateQuote}
                onWordGloss={onWordGloss}
                activeQuoteBuildId={quoteBuildActiveWordId}
                quoteBuildSelectionCount={quoteBuildSelectionCount}
                onStartQuoteBuild={onStartWordQuoteBuild}
              />
            )}
            {/* Per-verse suggestions — only in the active-verse (unpinned) view.
                refreshKey is the verse's current link set so adding/removing a
                link re-scans and drops/recovers it. */}
            {!twlGroups && onAddTwlSuggestion && (
              // Pin the suggestions to the bottom of the scroll viewport: mt:auto
              // pushes it to the bottom of the flex column (so it stays there even
              // when the Words list is short), and sticky bottom:-8 keeps it pinned
              // while scrolling a long list. mx/px:2 + pb:1 extend the paper
              // background; bottom:-8 sits it flush against the scroll body's py:1.
              <Box
                sx={{
                  mt: "auto",
                  position: "sticky",
                  bottom: -8,
                  zIndex: 1,
                  bgcolor: "background.paper",
                  mx: -2,
                  px: 2,
                  pb: 1,
                  boxShadow: "0 -6px 8px -6px rgba(0,0,0,0.12)",
                }}
              >
                <TwlSuggestions
                  book={book}
                  chapter={chapter}
                  verse={activeVerse}
                  refreshKey={twlForVerse.map((r) => `${r.tw_link ?? ""}|${r.orig_words ?? ""}|${r.occurrence ?? 1}`).join("~")}
                  onAdd={onAddTwlSuggestion}
                  isExcluded={isTwlSuggestionExcluded}
                  blockedArticleIds={twlBlockedArticleIds}
                  filtersReady={twlFiltersReady}
                  locked={locked}
                  paused={!!checkoff && checkoff.applicable("tw") && checkoff.shade("tw") !== "open"}
                />
              </Box>
            )}
          </Box>
        )}

        {resourceTab === "questions" && (
          <>
            <SectionHead
              title="Questions"
              count={totalTq}
              pinned={pinned.questions}
              onTogglePin={() => togglePinned("questions")}
              onAdd={onQuestionCreate}
              sticky
              hideAdd={locked}
              lane="tq"
              checkoff={checkoff}
            />
            {tqGroups ? (
              tqGroups.length === 0 ? (
                <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
                  no questions in this chapter
                </Typography>
              ) : (
                tqGroups.map(([verse, rows]) => (
                  <Fragment key={`tq-${verse}`}>
                    <VerseGroupHead verse={verse} active={verse === activeVerse} section="questions" />
                    <QuestionsTable rows={rows} onSave={onQuestionSave} onDelete={onQuestionDelete} locked={locked} />
                  </Fragment>
                ))
              )
            ) : (
              <QuestionsTable rows={tqForVerse} onSave={onQuestionSave} onDelete={onQuestionDelete} locked={locked} />
            )}
          </>
        )}
      </Box>
      ) : null}
      {/* Search tab: external tool in an iframe. Kept mounted once first
          visited (toggled via display, not unmount) so switching to Notes and
          back doesn't reload the page and lose an in-progress search. */}
      {searchVisited && (
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: panelMode === "search" ? "block" : "none",
          }}
        >
          <iframe
            src={SEARCH_IFRAME_URL}
            title="Search"
            style={{ width: "100%", height: "100%", border: 0 }}
          />
        </Box>
      )}
    </Box>
  );

  function renderNoteCard(r: TnRow, peers: TnRow[]) {
    const showBefore =
      dragId && dragId !== r.id && dragOver?.targetId === r.id && dragOver.position === "before";
    const showAfter =
      dragId && dragId !== r.id && dragOver?.targetId === r.id && dragOver.position === "after";
    // Only navigate within the same verse — displayVerseRange can span multiple
    // verses, but onNoteReorder in Shell operates per-verse via sortedForVerse.
    const samePeers = peers.filter((p) => p.verse === r.verse);
    const idx = samePeers.indexOf(r);
    const prevNote = idx > 0 ? samePeers[idx - 1] : null;
    const nextNote = idx < samePeers.length - 1 ? samePeers[idx + 1] : null;
    return (
      <Fragment key={r.id}>
        {showBefore && <DropIndicator />}
        <NoteCard
          row={r}
          active={r.id === activeNoteId}
          // Only the active-match note needs the query (it's the only one that
          // renders the highlight read view) — scoping it here keeps a find
          // keystroke from re-rendering every note card.
          findQuery={activeNoteMatch && activeNoteMatch.noteId === r.id ? (findNoteQuery ?? null) : null}
          activeMatchOccurrence={
            activeNoteMatch && activeNoteMatch.noteId === r.id ? activeNoteMatch.occurrence : null
          }
          dragging={dragId === r.id}
          isDropTarget={dragId !== null && dragId !== r.id}
          onChange={(p) => onNoteChange(r.id, p)}
          onSave={(p, opts) => onNoteSave(r.id, p, opts)}
          onDelete={() => onNoteDelete(r.id)}
          onRestore={() => onNoteRestore(r.id)}
          onInsertAfter={() => onNoteInsertAfter(r.id)}
          verseOptions={verseOptions}
          onChangeVerse={(v) => onNoteChangeVerse(r.id, v)}
          onFocus={() => onNoteFocus(r)}
          onGripDragStart={() => setDragId(r.id)}
          onMoveUp={
            prevNote
              ? () => {
                  noteFocusRef.current = { id: r.id, dir: "up" };
                  onNoteReorder(r.id, prevNote.id, "before");
                  onReorderPreview?.(computeNeighbors(r.id, prevNote.id, "before"), true);
                }
              : undefined
          }
          onMoveDown={
            nextNote
              ? () => {
                  noteFocusRef.current = { id: r.id, dir: "down" };
                  onNoteReorder(r.id, nextNote.id, "after");
                  onReorderPreview?.(computeNeighbors(r.id, nextNote.id, "after"), true);
                }
              : undefined
          }
          flashArrow={recentNoteMove?.id === r.id ? recentNoteMove.dir : null}
          onReorderHover={
            onReorderPreview
              ? (entering) =>
                  onReorderPreview(
                    entering
                      ? { verse: r.verse, movedId: r.id, prevId: prevNote?.id ?? null, nextId: nextNote?.id ?? null }
                      : null,
                    false,
                  )
              : undefined
          }
          onDragEnd={() => {
            setDragId(null);
            setDragOver(null);
            onReorderPreview?.(null, false);
          }}
          onCardDragOver={(position) => {
            setDragOver((cur) =>
              cur && cur.targetId === r.id && cur.position === position
                ? cur
                : { targetId: r.id, position },
            );
          }}
          onCardDragLeave={() => {
            // Don't clear on leave — the next onDragOver from the
            // adjacent card or the same card's other half will
            // immediately overwrite this. Clearing here causes flicker.
          }}
          onCardDrop={(position) => {
            if (dragId && dragId !== r.id) {
              onNoteReorder(dragId, r.id, position);
            }
            setDragId(null);
            setDragOver(null);
          }}
          onStartAi={onNoteStartAi ? (live) => onNoteStartAi(r, live) : undefined}
          isAiPending={isNoteAiPending?.(r.id) ?? false}
          aiRecentlyCompletedAt={noteAiRecentlyCompletedAt?.(r.id) ?? null}
          onVisibilityChange={onNoteVisibilityChange}
          locked={locked}
          onSetPreserve={
            onSetNotePreserve ? (value) => onSetNotePreserve(r.id, value) : undefined
          }
          onSetHint={onSetNoteHint ? (value) => onSetNoteHint(r.id, value) : undefined}
          onTranslateQuote={
            onNoteTranslateQuote ? (english) => onNoteTranslateQuote(r, english) : undefined
          }
          quoteBuildMode={quoteBuildActiveNoteId === r.id}
          quoteBuildSelectionCount={
            quoteBuildActiveNoteId === r.id ? quoteBuildSelectionCount : 0
          }
          quoteBuildAppliedAt={
            quoteBuildAppliedTo?.noteId === r.id ? quoteBuildAppliedTo.nonce : null
          }
          onStartQuoteBuild={onStartQuoteBuild ? () => onStartQuoteBuild(r.id) : undefined}
        />
        {showAfter && <DropIndicator />}
      </Fragment>
    );
  }
}

function DropIndicator() {
  return (
    <Box
      sx={{
        height: 3,
        my: 0.5,
        bgcolor: "primary.main",
        borderRadius: 1,
        boxShadow: "0 0 4px rgba(49,173,227,0.5)",
      }}
    />
  );
}

function VerseGroupHead({
  verse,
  active,
  section,
}: {
  verse: number;
  active: boolean;
  section: PinKey;
}) {
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      data-verse-group={verse}
      data-vg-section={section}
      sx={{
        // Clear the sticky SectionHead when scrollIntoView lands here with
        // block: "start", so the verse number stays visible rather than
        // tucking behind the pinned header.
        scrollMarginTop: "40px",
        mt: 1,
        mb: 0.25,
        py: 0.25,
        px: 0.5,
        borderBottom: "1px dashed",
        borderColor: active ? "primary.main" : "divider",
      }}
    >
      <Typography
        variant="caption"
        sx={{
          fontFamily: "monospace",
          fontWeight: 700,
          color: active ? "primary.main" : "text.secondary",
          letterSpacing: 0.5,
        }}
      >
        {verse === 0 ? "intro" : `v${verse}`}
      </Typography>
    </Stack>
  );
}

function SectionHead({
  title,
  count,
  pinned,
  onTogglePin,
  onAdd,
  sticky,
  hideAdd,
  lane,
  checkoff,
}: {
  title: string;
  count: number;
  pinned: boolean;
  onTogglePin: () => void;
  onAdd: () => void;
  sticky?: boolean;
  hideAdd?: boolean;
  lane?: ResourceLane;
  checkoff?: ResourceCheckoff;
}) {
  const laneApplicable = checkoff && lane ? checkoff.applicable(lane) : false;
  const shade = checkoff && lane && laneApplicable ? checkoff.shade(lane) : "open";
  const fill = shade !== "open" ? LANE_FILL[shade as Exclude<LaneShade, "open">] : null;
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{
        pb: 0.25,
        mb: 0.25,
        borderBottom: "1px solid",
        borderColor: "divider",
        ...(sticky
          ? {
              position: "sticky",
              top: 0,
              bgcolor: "background.paper",
              zIndex: 2,
              pt: 0.25,
            }
          : {}),
      }}
    >
      <Typography variant="subtitle2">{title}</Typography>
      <Chip
        label={count}
        size="small"
        variant="outlined"
        sx={{ height: 18, fontFamily: "monospace", fontSize: 10 }}
      />
      <Tooltip
        title={pinned ? `unpin — show ${title.toLowerCase()} for the active verse only` : `pin — show ${title.toLowerCase()} for every verse in this chapter`}
      >
        <IconButton size="small" onClick={onTogglePin} sx={{ p: 0.25, color: pinned ? "primary.main" : "text.disabled" }}>
          {pinned ? <PushPinIcon fontSize="inherit" sx={{ fontSize: 16 }} /> : <PushPinOutlinedIcon fontSize="inherit" sx={{ fontSize: 16 }} />}
        </IconButton>
      </Tooltip>
      {checkoff && lane && laneApplicable && checkoff.canCheck && !pinned && (
        <Tooltip
          title={`${title} for this verse — ${checkoff.attribution(lane)} · click to ${shade === "me" || shade === "both" ? "uncheck" : "check"}`}
        >
          <Box
            role="checkbox"
            aria-checked={shade !== "open"}
            onClick={() => checkoff.onToggle(lane)}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.5,
              cursor: "pointer",
              px: 0.75,
              height: 20,
              borderRadius: 1,
              fontSize: 11,
              userSelect: "none",
              bgcolor: fill ? fill.bg : "transparent",
              color: fill ? fill.fg : "text.secondary",
              border: fill ? "none" : "1px solid",
              borderColor: fill ? "transparent" : "divider",
            }}
          >
            <CheckIcon sx={{ fontSize: 13 }} /> done
          </Box>
        </Tooltip>
      )}
      {checkoff && lane && laneApplicable && checkoff.canCheck && (
        <Tooltip title={`check ${title.toLowerCase()} for every applicable verse in this chapter`}>
          <Typography
            variant="caption"
            onClick={() => checkoff.onBulkToggle(lane)}
            sx={{ color: "primary.main", cursor: "pointer", whiteSpace: "nowrap", ml: 0.25 }}
          >
            all
          </Typography>
        </Tooltip>
      )}
      <Box sx={{ flex: 1 }} />
      {hideAdd ? null : (
        <Button
          size="small"
          startIcon={<AddIcon fontSize="small" />}
          color="success"
          variant="outlined"
          sx={{ minWidth: 0, fontSize: 11 }}
          onClick={onAdd}
        >
          new
        </Button>
      )}
    </Stack>
  );
}

function PanelTab({
  label,
  count,
  countLabel,
  countSuffix,
  active,
  accent,
  onClick,
}: {
  label: string;
  count?: number;
  countLabel?: string;
  countSuffix?: string;
  active: boolean;
  accent: boolean;
  onClick: () => void;
}) {
  const showCount =
    countLabel !== undefined ? countLabel : count !== undefined ? `${count}${countSuffix ?? ""}` : null;
  return (
    <Box
      component="button"
      onClick={onClick}
      sx={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 0.5,
        px: 1,
        pt: 0.75,
        pb: 1,
        border: 0,
        background: "transparent",
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: 12.5,
        fontWeight: active ? 600 : 500,
        color: active && accent ? "primary.main" : active ? "text.primary" : "text.secondary",
        borderBottom: "2px solid",
        borderColor: active ? (accent ? "primary.main" : "text.primary") : "transparent",
        marginBottom: "-1px",
        "&:hover": { color: accent ? "primary.main" : "text.primary" },
      }}
    >
      {label}
      {showCount !== null && (
        <Box
          component="span"
          sx={{
            display: "inline-flex",
            alignItems: "center",
            px: 0.75,
            py: "1px",
            borderRadius: 999,
            fontFamily: "monospace",
            fontSize: 10,
            fontWeight: 600,
            bgcolor: active && accent ? "primary.main" : "transparent",
            color: active && accent ? "primary.contrastText" : "text.disabled",
            border: active && accent ? "none" : "1px solid",
            borderColor: "divider",
            letterSpacing: "0.02em",
            lineHeight: 1.4,
          }}
        >
          {showCount}
        </Box>
      )}
    </Box>
  );
}
