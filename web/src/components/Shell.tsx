import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Typography,
  CircularProgress,
  Alert,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Button,
  IconButton,
  Tooltip,
} from "@mui/material";
import LogoutIcon from "@mui/icons-material/Logout";
import { useChapter } from "../hooks/useChapter";
import { useChapterRoom } from "../hooks/useChapterRoom";
import type { UseBookReturn } from "../hooks/useBook";
import { useLexicon } from "../hooks/useLexicon";
import { useAiDrafts } from "../hooks/useAiDrafts";
import { outbox } from "../sync/outbox";
import { api } from "../sync/api";
import type { ChapterPayload, TnRow, TqRow, TwlRow, VerseDto } from "../sync/api";
import { drafts, verseKey } from "../sync/drafts";
import { smartEditVerse } from "../lib/replace";
import { extractEditableText, extractPlainText, normalizeEditable, SECTION_HEADER_TAGS } from "../lib/usfm";
import { verseHasUnalignedWork, countUnalignedTargetWords } from "../lib/alignment";
import {
  analyzeAlignmentDelta,
  guardBlocksSave,
  type AlignmentIntent,
} from "../lib/alignmentDelta";
import { buildVerseIndex, concatSourceRange, formatVerseLabel } from "../lib/verseRange";
import { buildTnQuickRequest } from "../lib/tnQuickRequest";
import { findSourceForTargetText, type HighlightKey, type ReorderHighlight } from "../lib/highlight";
import { buildQuoteFromSelection, selectionFromQuote } from "../lib/quoteBuilder";
import { nfc } from "../lib/hebrew";
import { TimelineRail } from "./TimelineRail";
import { ScriptureColumn, type ScriptureMode } from "./ScriptureColumn";
import { ResourceColumn, type AlignmentTabProps, type PanelMode, type ReorderPreview } from "./ResourceColumn";
import type { AlignmentPanelHandle } from "./AlignmentPanel";
import {
  SideBySideAligner,
  type PanelSlot,
  type ReadingLineHandle,
} from "./SideBySideAligner";
import { TopBar } from "./TopBar";
import { LogosSyncToggle } from "./LogosSyncToggle";
import { PipelineMenu } from "./PipelineMenu";
import { PipelineStatusBar } from "./PipelineStatusBar";
import { pipelineStore, type PipelineJob } from "../sync/pipelineStore";
import { onOutboxResult } from "../sync/outbox";
import { AiCompletionToasts } from "./AiCompletionToasts";
import { UnsavedToasts } from "./UnsavedToasts";
import { QuoteBuilderPopper } from "./QuoteBuilderPopper";
import { collectStrongs } from "./HebrewLine";

interface AlignerTarget {
  chapter: number;
  verse: number;
  bibleVersion: string;
}

// Per-version slice of the alignment props: target verse, the source for the
// verses that target covers (concatenated across a multi-verse range), and the
// TWL rows for that span. Used by both the single-panel aligner and the
// side-by-side popup. Resolves through buildVerseIndex so a verse INSIDE a
// range row (e.g. v7 of a UST 6-9 block) finds its covering row — the wire
// map is keyed by verse_start only.
function buildAlignerSlice(sourceData: ChapterPayload, verse: number, bibleVersion: string) {
  const sourceLabel = sourceData.verses["UHB"] ? "UHB" : "UGNT";
  const targetVerse = buildVerseIndex(sourceData.verses[bibleVersion])[verse] ?? null;
  const rangeEnd = targetVerse?.verse_end ?? targetVerse?.verse ?? verse;
  const rangeStart = targetVerse?.verse ?? verse;
  const sourceVerse =
    rangeEnd > rangeStart
      ? concatSourceRange(sourceData.verses[sourceLabel] ?? {}, rangeStart, rangeEnd)
      : sourceData.verses[sourceLabel]?.[rangeStart] ?? null;
  const twlForVerse = sourceData.twl.filter((r) => r.verse >= rangeStart && r.verse <= rangeEnd);
  return { sourceLabel, targetVerse, sourceVerse, twlForVerse, rangeStart, rangeEnd };
}

// Word-token count of one source verse row — text/punctuation nodes excluded,
// matching the position enumeration in UhbStrip/buildSourceIndexMap. Used to
// compute each dual panel's posOffset within the union span.
function countSourceWords(row: VerseDto | undefined): number {
  const verseObjects = (row?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  let n = 0;
  const walk = (nodes: unknown[]) => {
    for (const x of nodes ?? []) {
      const o = x as Record<string, unknown> | null;
      if (!o) continue;
      if (o["type"] === "word" && o["tag"] === "w") n++;
      // \d (Psalm superscription) is `type:"section"` but its content IS
      // alignable Hebrew verse body — descend it like a milestone, mirroring
      // collectMilestoneRuns in highlight.ts. Half of a cross-PR \d fix; the
      // other source-word walkers (highlight/quoteBuilder/alignment/
      // AlignmentPanel/UhbStrip) gain the same descent so posOffsets stay aligned.
      else if (
        o["type"] === "milestone" ||
        (o["type"] === "section" && o["tag"] === "d")
      )
        walk((o["children"] as unknown[] | undefined) ?? []);
    }
  };
  walk(verseObjects ?? []);
  return n;
}

const SCRIPTURE_MODE_KEY = "be:scriptureMode";
const ENABLED_VERSIONS_KEY = "be:enabledVersions";
const RAIL_COLLAPSED_KEY = "be:railCollapsed";

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveToStorage<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

// Cross-chapter TN-find jump carry. A find-overlay match in another chapter
// (book mode) navigates via the hash, which can't encode a note id, and Shell
// is keyed on book/chapter/verse so it fully remounts on arrival. Stash the
// target here just before navigating; the freshly-mounted Shell consumes it
// once its chapter payload (with that note row) has loaded, then activates +
// scrolls to the note. Module-level so it survives the remount; cleared on
// consume so a later same-location mount doesn't re-grab a stale note.
let pendingNoteJump: { book: string; chapter: number; noteId: string } | null = null;

interface Props {
  book: string;
  chapter: number;
  initialVerse?: number;
  onNavigate?: (book: string, chapter: number, verse?: number) => void;
  bookHook?: UseBookReturn;
  onLogout?: () => void;
}

export function Shell({ book, chapter, initialVerse = 1, onNavigate, bookHook, onLogout }: Props) {
  const {
    status,
    data,
    error,
    retryAttempts,
    refetch,
    applyLocalRowPatch,
    applyLocalRowReplacement,
    applyLocalRowDelete,
    applyLocalRowInsert,
    applyLocalVerse,
    applyLocalVerseStatus,
  } = useChapter(book, chapter);

  // Live cross-tab updates. The server broadcasts row writes via the
  // ChapterRoom DO; we dedupe by version so the originating user's tab
  // (whose state was already updated by the PATCH response) is a no-op.
  // NoteCard's session guard already shields an in-progress edit from
  // being clobbered when the underlying row prop changes — so we can
  // apply unconditionally here.
  const dataRef = useRef(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  useChapterRoom(book, chapter, {
    onUpsert: (kind, row) => {
      const list = dataRef.current?.[kind] as Array<TnRow | TqRow | TwlRow> | undefined;
      const existing = list?.find((r) => r.id === row.id);
      if (!existing) {
        applyLocalRowInsert(kind, row);
      } else if (row.version > existing.version) {
        applyLocalRowReplacement(kind, row);
      } else if (
        // Preserve/hint/trash toggles on TN rows don't bump version (they're
        // state flips, not content — see api/src/rows.ts setTnBit /
        // setTnTrashed). The version > existing.version guard above would drop
        // these broadcasts, leaving other tabs stale until refetch. Same-
        // version replace when an intent bit or the trash state differs.
        kind === "tn" &&
        row.version === existing.version &&
        ((row as TnRow).preserve !== (existing as TnRow).preserve ||
          (row as TnRow).hint !== (existing as TnRow).hint ||
          (row as TnRow).trashed_at !== (existing as TnRow).trashed_at)
      ) {
        applyLocalRowReplacement(kind, row);
      }
    },
    onDelete: (kind, id) => applyLocalRowDelete(kind, id),
    onVerseUpdate: (verse) => {
      const existing = dataRef.current?.verses[verse.bible_version]?.[verse.verse];
      if (!existing || verse.version > existing.version) {
        applyLocalVerse(verse);
      }
    },
    onVerseStatusUpdate: (status) => {
      applyLocalVerseStatus(status.verse, status.done === 1);
    },
  });
  const [activeVerse, setActiveVerse] = useState(initialVerse);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [activeWordId, setActiveWordId] = useState<string | null>(null);
  const [mode, setMode] = useState<ScriptureMode>(() =>
    loadFromStorage<ScriptureMode>(SCRIPTURE_MODE_KEY, "stacked"),
  );
  const [enabledVersions, setEnabledVersions] = useState<string[]>(() =>
    loadFromStorage<string[]>(ENABLED_VERSIONS_KEY, ["ULT", "UST"]),
  );
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() =>
    loadFromStorage<boolean>(RAIL_COLLAPSED_KEY, false),
  );
  const toggleRail = useCallback(() => {
    setRailCollapsed((prev) => {
      const next = !prev;
      saveToStorage(RAIL_COLLAPSED_KEY, next);
      return next;
    });
  }, []);
  const [alignerTarget, setAlignerTarget] = useState<AlignerTarget | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>("resources");
  const [alignmentDirty, setAlignmentDirty] = useState(false);
  const alignmentPanelRef = useRef<AlignmentPanelHandle | null>(null);
  // Queued action that should run after the user resolves the dirty-confirm
  // popup. Verse / version changes attempted while the alignment panel has
  // unsaved drags stash their apply() here; the dialog decides which branch
  // to invoke.
  const [pendingNav, setPendingNav] = useState<{ run: () => void } | null>(null);
  // Side-by-side aligner popup: which verse it targets (ULT + UST at once),
  // per-panel handles for the save/discard gate, and per-panel dirty flags.
  const [dualTarget, setDualTarget] = useState<{ chapter: number; verse: number } | null>(null);
  const dualLeftRef = useRef<AlignmentPanelHandle | null>(null);
  const dualRightRef = useRef<AlignmentPanelHandle | null>(null);
  const [dualLeftDirty, setDualLeftDirty] = useState(false);
  const [dualRightDirty, setDualRightDirty] = useState(false);
  // Same machinery for the editable reading lines, so the gate prompts before a
  // close/nav drops an unsaved reading-text edit.
  const dualLeftReadingRef = useRef<ReadingLineHandle | null>(null);
  const dualRightReadingRef = useRef<ReadingLineHandle | null>(null);
  const [dualLeftReadingDirty, setDualLeftReadingDirty] = useState(false);
  const [dualRightReadingDirty, setDualRightReadingDirty] = useState(false);
  // Queued action (close / verse-nav) awaiting the user's save-or-discard
  // choice when a dual panel has unsaved drags.
  const [pendingDualAction, setPendingDualAction] = useState<{ run: () => void } | null>(null);
  // Shared by the scripture + resource columns so a single "go to active"
  // click re-centers both. Bumped via requestScrollToActive (and elsewhere
  // when the active selection changes through other paths).
  const [scrollNonce, setScrollNonce] = useState(0);
  const requestScrollToActive = useCallback(() => setScrollNonce((n) => n + 1), []);

  const [splitRatio, setSplitRatio] = useState<number | null>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  // Toast state shared between the pipeline trigger menu and the status bar.
  // Cleared on dismiss or after a short auto-timeout.
  const [pipelineToast, setPipelineToast] = useState<{ id: number; text: string; kind: "success" | "error" | "info" } | null>(null);
  const pipelineToastIdRef = useRef(0);
  const pushPipelineToast = useCallback((text: string, kind: "success" | "error" | "info" = "info") => {
    pipelineToastIdRef.current += 1;
    setPipelineToast({ id: pipelineToastIdRef.current, text, kind });
  }, []);
  useEffect(() => {
    if (!pipelineToast) return;
    const id = pipelineToast.id;
    const t = setTimeout(() => {
      setPipelineToast((cur) => (cur && cur.id === id ? null : cur));
    }, 8000);
    return () => clearTimeout(t);
  }, [pipelineToast]);
  useEffect(() =>
    pipelineStore.onComplete((job, prev) => {
      const where = `${job.book} ${job.start_chapter}`;
      if (job.state === "done") {
        pushPipelineToast(`AI ${job.pipeline_type} applied to ${where}.`, "success");
      } else if (job.state === "failed" && prev !== "failed") {
        pushPipelineToast(`AI ${job.pipeline_type} failed for ${where}: ${job.error_kind ?? "error"}`, "error");
      }
    }), [pushPipelineToast]);

  // Surface a toast when the outbox drops an op because the chapter was
  // locked. The user's edit was rejected by the server (409 chapter_locked)
  // and discarded — retrying would race the auto-apply step.
  useEffect(
    () =>
      onOutboxResult((_op, result) => {
        if (result.kind === "locked") {
          pushPipelineToast(
            "Edit dropped — the AI run for this chapter is mid-flight. Try again after it finishes.",
            "error",
          );
        }
      }),
    [pushPipelineToast],
  );

  // Derive the chapter lock from active pipeline jobs. Any non-terminal job
  // whose scope covers this (book, chapter) locks the editor; the banner
  // surfaces the started-at time and the TN cards switch to keep-mode.
  const [activeJobs, setActiveJobs] = useState<PipelineJob[]>([]);
  useEffect(() => pipelineStore.subscribe(setActiveJobs), []);
  const chapterLock = useMemo(() => {
    const found = activeJobs.find(
      (j) =>
        j.book === book &&
        j.start_chapter <= chapter &&
        j.end_chapter >= chapter &&
        (j.state === "running" ||
          j.state === "paused_for_outage" ||
          j.state === "paused_for_usage_limit" ||
          j.state === "dispatching"),
    );
    if (!found) return null;
    return {
      jobId: found.job_id,
      pipelineType: found.pipeline_type,
      startedAt: found.created_at,
    };
  }, [activeJobs, book, chapter]);

  const handleSetNotePreserve = useCallback(
    async (id: string, value: boolean) => {
      try {
        const updated = await api.setPreserveNote(id, book, value);
        // Mirror server state locally so the card's chip + checkbox flip on
        // the next render without waiting for a chapter refetch.
        applyLocalRowPatch("tn", id, {
          preserve: updated.preserve,
          updated_at: updated.updated_at,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown error";
        pushPipelineToast(`Couldn't update Preserve: ${msg}`, "error");
      }
    },
    [applyLocalRowPatch, pushPipelineToast],
  );

  const handleSetNoteHint = useCallback(
    async (id: string, value: boolean) => {
      try {
        const updated = await api.setHintNote(id, book, value);
        applyLocalRowPatch("tn", id, {
          hint: updated.hint,
          updated_at: updated.updated_at,
        });
      } catch (e) {
        // Prefer the server's human-readable message (e.g. the note_required
        // 400) over the bare "HTTP 400" the ApiError carries as its message.
        const serverMsg = (e as { body?: { message?: string } } | null)?.body?.message;
        const msg = (typeof serverMsg === "string" && serverMsg) || (e instanceof Error ? e.message : "unknown error");
        pushPipelineToast(`Couldn't update Hint: ${msg}`, "error");
      }
    },
    [applyLocalRowPatch, pushPipelineToast],
  );

  // The note delete button. Trash is a reversible, visible soft-delete (the
  // card grays out, drops to the bottom of the verse, gains a Restore button)
  // — the safety net that stands in for a confirmation dialog. Optimistic flip
  // so the card grays instantly; reconcile from the server row; revert on
  // error. Clearing the active note (functional update, no dep on activeNoteId)
  // drops the active highlight off the now-trashed card.
  const handleTrashNote = useCallback(
    async (id: string) => {
      applyLocalRowPatch("tn", id, { trashed_at: Math.floor(Date.now() / 1000) });
      setActiveNoteId((cur) => (cur === id ? null : cur));
      try {
        const updated = await api.trashNote(id, book);
        applyLocalRowReplacement("tn", updated);
      } catch (e) {
        applyLocalRowPatch("tn", id, { trashed_at: null });
        const msg = e instanceof Error ? e.message : "unknown error";
        pushPipelineToast(`Couldn't delete note: ${msg}`, "error");
      }
    },
    [book, applyLocalRowPatch, applyLocalRowReplacement, pushPipelineToast],
  );

  const handleRestoreNote = useCallback(
    async (id: string) => {
      applyLocalRowPatch("tn", id, { trashed_at: null });
      try {
        const updated = await api.restoreNote(id, book);
        applyLocalRowReplacement("tn", updated);
      } catch (e) {
        applyLocalRowPatch("tn", id, { trashed_at: Math.floor(Date.now() / 1000) });
        const msg = e instanceof Error ? e.message : "unknown error";
        pushPipelineToast(`Couldn't restore note: ${msg}`, "error");
      }
    },
    [book, applyLocalRowPatch, applyLocalRowReplacement, pushPipelineToast],
  );

  // Async AI-draft lifecycle. State outlives any single NoteCard so the
  // user can scroll away / edit a different note while one is in flight.
  // visibleRowIdsRef tracks which TN cards are currently in viewport so
  // we can route arriving results to either the in-place pulse (visible)
  // or the persistent toast stack (off-screen).
  const aiDrafts = useAiDrafts();
  const visibleRowIdsRef = useRef<Set<string>>(new Set());
  const handleNoteVisibilityChange = useCallback((rowId: string, isVisible: boolean) => {
    if (isVisible) visibleRowIdsRef.current.add(rowId);
    else visibleRowIdsRef.current.delete(rowId);
  }, []);

  // Whether ANY resource row sits on verse 0 (the intro tile). The cheap
  // `.some` re-runs on every edit, but it yields a *stable boolean* so the
  // expensive tileSet below doesn't re-run when a row's text changes.
  const introHasResource = useMemo(
    () =>
      !!data &&
      (data.tn.some((r) => r.verse === 0) ||
        data.tq.some((r) => r.verse === 0) ||
        data.twl.some((r) => r.verse === 0)),
    [data],
  );

  // tileSet runs verseHasUnalignedWork (a full alignment parse) for EVERY
  // verse, so it must not recompute when only a TN/TQ/TWL row changed. Keying
  // it on the verse map + statuses + the intro flag means a note keystroke or
  // save — which leaves data.verses untouched — skips the rescan entirely (and
  // keeps verseNumbers referentially stable, so ScriptureColumn can memo-skip).
  const versesForTiles = data?.verses;
  const verseStatusesForTiles = data?.verseStatuses;
  const tileSet = useMemo(() => {
    if (!versesForTiles) return [] as Array<{ verse: number; has: boolean; done?: boolean }>;
    const versesWithSomething = new Set<number>();
    Object.values(versesForTiles).forEach((byVerse) => {
      Object.keys(byVerse).forEach((v) => versesWithSomething.add(parseInt(v, 10)));
    });
    const sourceByVerse = versesForTiles.UHB ?? versesForTiles.UGNT ?? {};
    const ult = versesForTiles.ULT ?? {};
    const ust = versesForTiles.UST ?? {};
    const getVO = (dto: VerseDto | undefined) => {
      const vo = (dto?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
      return Array.isArray(vo) ? vo : null;
    };
    const hasUnalignedFor = (verse: number) => {
      if (verse === 0) return false;
      const sourceVO = getVO(sourceByVerse[verse]);
      const ultVO = getVO(ult[verse]);
      if (ultVO && verseHasUnalignedWork(ultVO, sourceVO)) return true;
      const ustVO = getVO(ust[verse]);
      if (ustVO && verseHasUnalignedWork(ustVO, sourceVO)) return true;
      return false;
    };
    // Chapter-front USFM content (Psalm \d superscriptions, leading \p before \v 1)
    // is stored as verse 0 in the verses table. Surface the intro tile when any of
    // those exist even if no TN/TQ/TWL row is attached to verse 0.
    const introHasScripture = versesWithSomething.has(0);
    const doneMap = new Map<number, boolean>();
    for (const s of verseStatusesForTiles ?? []) doneMap.set(s.verse, !!s.done);
    const tiles: Array<{ verse: number; has: boolean; done?: boolean }> = [];
    if (introHasResource || introHasScripture) tiles.push({ verse: 0, has: false, done: doneMap.get(0) });
    const verseNums = [...versesWithSomething].filter((v) => v > 0).sort((a, b) => a - b);
    for (const v of verseNums) tiles.push({ verse: v, has: hasUnalignedFor(v), done: doneMap.get(v) });
    return tiles;
  }, [versesForTiles, verseStatusesForTiles, introHasResource]);

  const verseNumbers = useMemo(
    () => tileSet.map((t) => t.verse),
    [tileSet],
  );

  const availableVersions = useMemo(
    () => (versesForTiles ? Object.keys(versesForTiles) : []),
    [versesForTiles],
  );

  // Range-aware lookup: ChapterPayload.verses is keyed by verse_start, so a
  // row anchored mid-bridge (e.g. verse 9 of a `\v 8-9` row) misses a direct
  // verses[bv][row.verse] read. Built once per verses change and shared by
  // the quote-builder / note-anchoring lookups below.
  const verseIndexByVersion = useMemo(() => {
    const out: Record<string, Record<number, VerseDto>> = {};
    if (versesForTiles) {
      for (const bv of Object.keys(versesForTiles)) {
        out[bv] = buildVerseIndex(versesForTiles[bv]);
      }
    }
    return out;
  }, [versesForTiles]);

  // The widest range row across all versions that covers activeVerse. Used to
  // scope TN/TQ/TWL filtering in ResourceColumn — if UST 6-9 covers the active
  // verse, the user sees notes for verses 6-9, not just the navigated one.
  // For singletons (the common case) this reduces to [activeVerse, activeVerse].
  const displayVerseRange = useMemo<readonly [number, number]>(() => {
    if (!versesForTiles || activeVerse === 0) return [activeVerse, activeVerse] as const;
    let start = activeVerse;
    let end = activeVerse;
    for (const byVerse of Object.values(versesForTiles)) {
      for (const k of Object.keys(byVerse)) {
        const dto = byVerse[Number(k)];
        if (!dto) continue;
        const rEnd = dto.verse_end ?? dto.verse;
        if (dto.verse <= activeVerse && activeVerse <= rEnd) {
          if (dto.verse < start) start = dto.verse;
          if (rEnd > end) end = rEnd;
        }
      }
    }
    return [start, end] as const;
  }, [versesForTiles, activeVerse]);

  const visibleVersions = useMemo(
    () => enabledVersions.filter((v) => availableVersions.includes(v)),
    [enabledVersions, availableVersions],
  );

  // The version set actually shown (falls back to the first available when the
  // user has none enabled). Memoized so its identity is stable across row
  // edits — it's the `enabledVersions` prop ScriptureColumn's memo compares.
  const displayedVersions = useMemo(
    () => (visibleVersions.length > 0 ? visibleVersions : availableVersions.slice(0, 1)),
    [visibleVersions, availableVersions],
  );

  const colsVisible = displayedVersions.length;
  const autoSplit = mode === "columns" ? Math.min(0.75, 0.55 + (colsVisible - 1) * 0.05) : 0.5;
  const effectiveSplit = splitRatio ?? autoSplit;

  // Book-mode chapter list, memoized so ScriptureColumn isn't handed a fresh
  // array on every render (stacked / columns pass undefined — already stable).
  const bookChapterList = useMemo(
    () =>
      bookHook && mode === "book"
        ? (bookHook.summary?.chapters ?? []).map((c) => c.chapter)
        : undefined,
    [bookHook, mode, bookHook?.summary],
  );
  useEffect(() => { setSplitRatio(null); }, [colsVisible, mode]);
  useEffect(() => () => { document.body.style.cursor = ""; document.body.style.userSelect = ""; }, []);
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    const railWidth = railCollapsed ? 0 : 88;
    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const available = rect.width - railWidth;
      const offset = ev.clientX - rect.left - railWidth;
      setSplitRatio(Math.min(0.8, Math.max(0.2, offset / available)));
    };
    const onMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [railCollapsed]);

  // Pre-load lexicon entries for every UHB Strong's in the loaded chapter
  // AND every loaded chapter in book mode, so the per-word tooltips in the
  // scripture column don't have to fetch on first hover. useLexicon
  // dedupes at module level, so passing this repeatedly is cheap.
  const uhbStrongs = useMemo(() => {
    const set = new Set<string>();
    const collect = (verses: Record<number, VerseDto> | undefined) => {
      if (!verses) return;
      for (const v of Object.values(verses)) {
        const objs = (v.content as { verseObjects?: unknown[] } | null)?.verseObjects;
        if (Array.isArray(objs)) for (const s of collectStrongs(objs)) set.add(s);
      }
    };
    collect(data?.verses?.UHB);
    if (bookHook) {
      for (const cs of bookHook.chapters.values()) {
        if (cs.kind !== "ready") continue;
        collect(cs.data.verses?.UHB);
      }
    }
    return [...set];
  }, [data?.verses, bookHook?.chapters]);
  const lexiconMapRaw = useLexicon(uhbStrongs);
  // useLexicon hands back a fresh Map every render; stabilize its identity so
  // ScriptureColumn's memo can compare it. The map's CONTENT only changes when
  // a Strong's entry resolves, which bumps lexiconLoadedCount and rebases it.
  const lexiconLoadedCount = useMemo(() => {
    let c = 0;
    for (const v of lexiconMapRaw.values()) if (v) c++;
    return c;
  }, [lexiconMapRaw]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const lexiconMap = useMemo(() => lexiconMapRaw, [uhbStrongs, lexiconLoadedCount]);

  // When a tn note OR a twl word row is "active", treat its quote as the
  // highlight source. Notes and words are mutually exclusive; clicking one
  // clears the other. Words use `orig_words` (Hebrew source words) which the
  // same matcher handles directly for UHB and via \zaln-s for ULT/UST.
  const { activeQuote, activeOccurrence } = useMemo(() => {
    if (!data) return { activeQuote: null, activeOccurrence: null };
    if (activeNoteId) {
      const r = data.tn.find((r) => r.id === activeNoteId);
      return { activeQuote: r?.quote ?? null, activeOccurrence: r?.occurrence ?? null };
    }
    if (activeWordId) {
      const r = data.twl.find((r) => r.id === activeWordId);
      return { activeQuote: r?.orig_words ?? null, activeOccurrence: r?.occurrence ?? null };
    }
    return { activeQuote: null, activeOccurrence: null };
  }, [activeNoteId, activeWordId, data]);

  // Reorder "stoplight": while a note is dragged (or for ~3s after an arrow
  // move) ResourceColumn reports the moved note's candidate neighbours; we
  // resolve their quotes and hand them to the scripture column so the active
  // verse lights prev (green underline) / next (red overline) alongside the
  // moved note's existing yellow fill.
  const [reorderPreview, setReorderPreview] = useState<ReorderPreview | null>(null);
  const reorderPreviewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reorderStickyRef = useRef(false);
  const handleReorderPreview = useCallback((preview: ReorderPreview | null, sticky?: boolean) => {
    // A live (non-sticky) clear — drag end or hover-leave — must not wipe a
    // sticky arrow-move preview that's still counting down.
    if (preview === null && !sticky && reorderStickyRef.current) return;
    if (reorderPreviewTimer.current) {
      clearTimeout(reorderPreviewTimer.current);
      reorderPreviewTimer.current = null;
    }
    reorderStickyRef.current = !!(preview && sticky);
    setReorderPreview(preview);
    // Live previews (drag held / grip-or-arrow hover) pass sticky=false and are
    // cleared on release/leave; arrow moves are momentary, so they linger 5s.
    if (preview && sticky) {
      reorderPreviewTimer.current = setTimeout(() => {
        setReorderPreview(null);
        reorderStickyRef.current = false;
        reorderPreviewTimer.current = null;
      }, 5000);
    }
  }, []);
  useEffect(
    () => () => {
      if (reorderPreviewTimer.current) clearTimeout(reorderPreviewTimer.current);
    },
    [],
  );
  const reorderHighlight = useMemo<ReorderHighlight | null>(() => {
    if (!data || !reorderPreview) return null;
    const find = (id: string | null) => (id ? data.tn.find((r) => r.id === id) ?? null : null);
    const moved = find(reorderPreview.movedId);
    const prev = find(reorderPreview.prevId);
    const next = find(reorderPreview.nextId);
    if (!moved && !prev && !next) return null;
    return {
      movedQuote: moved?.quote ?? null,
      movedOccurrence: moved?.occurrence ?? null,
      prevQuote: prev?.quote ?? null,
      prevOccurrence: prev?.occurrence ?? null,
      nextQuote: next?.quote ?? null,
      nextOccurrence: next?.occurrence ?? null,
    };
  }, [data, reorderPreview]);

  // Quote-builder session: when active, clicking Hebrew words in the UHB
  // row of the active verse toggles them into selectedKeys; "Use selection"
  // on the note card converts the set into row.quote + row.occurrence.
  // Tied to a specific note id so switching notes cancels the session.
  const [quoteBuildNoteId, setQuoteBuildNoteId] = useState<string | null>(null);
  const [quoteBuildSelectedKeys, setQuoteBuildSelectedKeys] = useState<Set<HighlightKey>>(
    () => new Set(),
  );
  // Commit signal handed to the note card. The card is still active when the
  // picker commits, so its row→quote sync effect is gated by the open session
  // guard; bumping this nonce after the optimistic row patch tells that card
  // to pull the built quote into its local state. nonce increments per commit
  // so re-building the same note twice still fires the effect.
  const [quoteBuildAppliedTo, setQuoteBuildAppliedTo] = useState<
    { noteId: string; nonce: number } | null
  >(null);
  useEffect(() => {
    if (quoteBuildNoteId && activeNoteId !== quoteBuildNoteId) {
      setQuoteBuildNoteId(null);
      setQuoteBuildSelectedKeys(new Set());
    }
  }, [activeNoteId, quoteBuildNoteId]);
  const toggleQuoteBuildWord = useCallback(
    (key: HighlightKey) => {
      setQuoteBuildSelectedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [],
  );
  // Additive multi-select for shift-click range selection in the picker —
  // adds every key in the dragged range without toggling any already-selected
  // word back off (range select is "extend the selection," not "toggle each").
  const selectQuoteBuildWords = useCallback((keys: HighlightKey[]) => {
    setQuoteBuildSelectedKeys((prev) => {
      const next = new Set(prev);
      for (const key of keys) next.add(key);
      return next;
    });
  }, []);
  const startQuoteBuild = useCallback(
    (noteId: string) => {
      setQuoteBuildNoteId(noteId);
      // Pre-seed the selection from the note's existing quote so the translator
      // can ADD to it instead of starting over. Resolves the stored quote +
      // occurrence against the UHB/UGNT verse; an unresolvable quote (e.g.
      // hand-typed English) yields an empty set and the picker starts fresh.
      const row = data?.tn.find((r) => r.id === noteId);
      const uhb = row
        ? verseIndexByVersion["UHB"]?.[row.verse] ?? verseIndexByVersion["UGNT"]?.[row.verse]
        : undefined;
      const verseObjects = (uhb?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
      setQuoteBuildSelectedKeys(
        row ? selectionFromQuote(verseObjects, row.quote, row.occurrence) : new Set(),
      );
    },
    [data, verseIndexByVersion],
  );
  const cancelQuoteBuild = useCallback(() => {
    setQuoteBuildNoteId(null);
    setQuoteBuildSelectedKeys(new Set());
  }, []);

  // Anchor element for the picker popup. Resolves via the data-note-id
  // attribute set on each NoteCard's Paper — the picker mounts at Shell
  // level so it isn't clipped by the resource column overflow.
  const [quoteBuildAnchor, setQuoteBuildAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!quoteBuildNoteId) {
      setQuoteBuildAnchor(null);
      return;
    }
    setQuoteBuildAnchor(
      document.querySelector<HTMLElement>(`[data-note-id="${quoteBuildNoteId}"]`),
    );
  }, [quoteBuildNoteId]);

  // Verse objects bundled for the picker — UHB always; ULT/UST may be
  // absent for OT-only or NT-only deployments, so default to null and
  // let the picker show an empty-state hint.
  const quoteBuildContext = useMemo(() => {
    if (!quoteBuildNoteId || !data) return null;
    const row = data.tn.find((r) => r.id === quoteBuildNoteId);
    if (!row) return null;
    const grab = (bv: string): unknown[] | null => {
      const dto = verseIndexByVersion[bv]?.[row.verse];
      const vo = (dto?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
      return Array.isArray(vo) ? vo : null;
    };
    return {
      noteId: quoteBuildNoteId,
      verse: row.verse,
      uhb: grab("UHB") ?? grab("UGNT"),
      ult: grab("ULT"),
      ust: grab("UST"),
    };
  }, [quoteBuildNoteId, data, verseIndexByVersion]);

  // Materialize the in-flight quote-build selection into a row patch and
  // fire the existing note save pipe. Pulls UHB verseObjects for the
  // current verse — the buildQuoteFromSelection helper does the grouping
  // and " & " join + occurrence calculation.
  const commitQuoteBuild = useCallback(() => {
    if (!quoteBuildNoteId || !data) return;
    const row = data.tn.find((r) => r.id === quoteBuildNoteId);
    if (!row) return;
    const uhb = verseIndexByVersion["UHB"]?.[row.verse] ?? verseIndexByVersion["UGNT"]?.[row.verse];
    const verseObjects =
      (uhb?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (!Array.isArray(verseObjects)) return;
    const built = buildQuoteFromSelection(verseObjects, quoteBuildSelectedKeys);
    if (!built) return;
    // Only enqueue a save when the build actually changes the stored (quote,
    // occurrence) — re-running "build from source" over an unchanged selection
    // (or a quote that was itself built this way) must not bump the row version.
    // Compare quotes NFC-normalized: the builder emits raw UHB legacy
    // combining-mark order, while a stored quote may be NFC (typed / AI), so a
    // raw compare would false-positive on visually-identical text — same nfc()
    // rule the highlighter uses. A null stored occurrence means "first", == 1.
    const changed =
      nfc(built.quote) !== nfc(row.quote ?? "") || built.occurrence !== (row.occurrence ?? 1);
    if (changed) {
      // Optimistic row patch first so row.quote is current for the box-sync below.
      enqueueRow("tn", row, { quote: built.quote, occurrence: built.occurrence });
    }
    // Always signal the card (which stays active) to force the box to the
    // committed quote and rebaseline the session snapshot — the row→box sync
    // effect is otherwise gated by the open session. Idempotent on a true
    // no-op, and on a no-op over unsaved box edits it still lands the quote the
    // user just committed (don't gate this on `changed`).
    setQuoteBuildAppliedTo((prev) => ({ noteId: row.id, nonce: (prev?.nonce ?? 0) + 1 }));
    setQuoteBuildNoteId(null);
    setQuoteBuildSelectedKeys(new Set());
  }, [quoteBuildNoteId, quoteBuildSelectedKeys, data, verseIndexByVersion]);

  // Routes any verse / version / aligner-target change through the dirty
  // gate when the alignment panel has unsaved drags. Plain wrapper around
  // setState if the gate is clear; otherwise queues for the popup.
  //
  // The gate reads panelMode / alignmentDirty through refs, NOT the state
  // values, so its identity is stable. Memoized children (ScriptureColumn,
  // InactiveVerseRow) deliberately skip comparing callback props, so a
  // callback that closed over the state would go stale inside them and let
  // navigation bypass the gate — silently dropping unsaved alignment drags.
  // Layout effect (not passive) so the refs are current before any
  // subsequent click can read them. Browser back/forward remounts the Shell
  // entirely, so that navigation path stays ungated here.
  const panelModeRef = useRef(panelMode);
  const alignmentDirtyRef = useRef(alignmentDirty);
  useLayoutEffect(() => {
    panelModeRef.current = panelMode;
    alignmentDirtyRef.current = alignmentDirty;
  }, [panelMode, alignmentDirty]);
  const runWithDirtyGate = useCallback((apply: () => void) => {
    if (panelModeRef.current === "alignment" && alignmentDirtyRef.current) {
      setPendingNav({ run: apply });
    } else {
      apply();
    }
  }, []);

  const requestSelectVerse = useCallback(
    (v: number) => {
      runWithDirtyGate(() => {
        setActiveVerse(v);
        setActiveNoteId(null);
        setActiveWordId(null);
      });
    },
    [runWithDirtyGate],
  );

  // Notes the find overlay's TN scope searches. Single chapter in stacked /
  // columns mode; every loaded chapter in book mode. Reads dataRef so the
  // getter sees live notes (post-keystroke) without forcing the memoized
  // ScriptureColumn to re-render on every edit. Identity only churns on
  // mode / book-cache changes, both of which ScriptureColumn already re-renders
  // for, so the overlay always receives a current getter.
  // Find-in-notes highlight state, lifted from the overlay (which lives inside
  // ScriptureColumn) so the sibling ResourceColumn's note cards can paint
  // matches. `findNoteQuery` marks every match; `activeNoteMatch` emphasizes
  // the one the user is navigating to.
  const [findNoteQuery, setFindNoteQuery] = useState<
    { find: string; regex: boolean; caseSensitive: boolean } | null
  >(null);
  const [activeNoteMatch, setActiveNoteMatch] = useState<
    { noteId: string; occurrence: number } | null
  >(null);

  const getSearchNotes = useCallback((): TnRow[] => {
    if (mode === "book" && bookHook) {
      const out: TnRow[] = [];
      for (const cs of bookHook.chapters.values()) {
        if (cs.kind === "ready") out.push(...cs.data.tn);
      }
      return out;
    }
    return dataRef.current?.tn ?? [];
  }, [mode, bookHook]);

  // Navigate to + activate a TN match from the find overlay. Cross-chapter
  // (book mode) routes through the URL so the chapter payload reloads; the
  // common same-chapter case just focuses the verse + note, and the bumped
  // scrollNonce makes the resource column scroll it into view.
  const focusNoteMatch = useCallback(
    (ch: number, v: number, noteId: string) => {
      runWithDirtyGate(() => {
        if (ch !== chapter) {
          // The hash carries only book/chapter/verse; stash the note id so the
          // remounted Shell can activate + scroll to it once its payload loads.
          pendingNoteJump = { book, chapter: ch, noteId };
          onNavigate?.(book, ch, v);
          return;
        }
        setActiveVerse(v);
        setActiveWordId(null);
        setActiveNoteId(noteId);
        setScrollNonce((n) => n + 1);
      });
    },
    [runWithDirtyGate, chapter, book, onNavigate],
  );

  // App keys Shell on book only, so a cross-chapter navigation (URL /
  // back-forward / TopBar / cross-chapter find) changes the chapter +
  // initialVerse props WITHOUT remounting — useChapter keeps the prior
  // chapter's data visible while the new payload loads, so there's no loading
  // flash and find/book-view state survive. This effect does what the old
  // remount used to: reset the per-chapter transient state. Keyed on
  // [chapter, initialVerse] — internal same-chapter verse selection sets
  // activeVerse directly without an URL push, so initialVerse doesn't change
  // and this won't clobber it. Skips the initial mount.
  const chapterResetMounted = useRef(false);
  useEffect(() => {
    if (!chapterResetMounted.current) {
      chapterResetMounted.current = true;
      return;
    }
    setActiveVerse(initialVerse);
    setActiveNoteId(null);
    setActiveWordId(null);
    setAlignerTarget(null);
    setDualTarget(null);
    setPanelMode("resources");
    setAlignmentDirty(false);
    setDualLeftDirty(false);
    setDualRightDirty(false);
    setDualLeftReadingDirty(false);
    setDualRightReadingDirty(false);
    setPendingNav(null);
    setPendingDualAction(null);
  }, [chapter, initialVerse]);

  // Consume a cross-chapter TN-find jump stashed before navigation. Waits for
  // this chapter's payload (and the target note row) to load, then activates +
  // scrolls to the note. Cleared on consume; ignored if the stash targets a
  // different book/chapter (e.g. the user navigated elsewhere in the meantime).
  useEffect(() => {
    const jump = pendingNoteJump;
    if (!jump) return;
    if (jump.book !== book || jump.chapter !== chapter) return;
    if (!data) return;
    if (!data.tn.some((r) => r.id === jump.noteId)) return;
    pendingNoteJump = null;
    setActiveWordId(null);
    setActiveNoteId(jump.noteId);
    setScrollNonce((n) => n + 1);
  }, [data, book, chapter]);

  // Keep the alignment target's verse in step with the active verse while
  // we're in alignment mode. Bible version is sticky — only LinkIcon clicks
  // change it. Effect, not direct setter, so it survives both rail clicks
  // and book-mode chapter swaps.
  useEffect(() => {
    if (panelMode !== "alignment") return;
    if (!alignerTarget) return;
    if (alignerTarget.verse === activeVerse && alignerTarget.chapter === chapter) return;
    setAlignerTarget({ ...alignerTarget, chapter, verse: activeVerse });
  }, [activeVerse, chapter, panelMode, alignerTarget]);

  const openAligner = useCallback(
    (chapterNum: number, v: number, bv: string) => {
      runWithDirtyGate(() => {
        setAlignerTarget({ chapter: chapterNum, verse: v, bibleVersion: bv });
        setActiveVerse(v);
        setActiveNoteId(null);
        setActiveWordId(null);
        setPanelMode("alignment");
      });
    },
    [runWithDirtyGate],
  );

  // Open the side-by-side ULT/UST aligner on a verse. Layered over the UI as a
  // Dialog (orthogonal to panelMode), so it gates only on the single panel's
  // unsaved drags before opening.
  const openDualAligner = useCallback(
    (chapterNum: number, v: number) => {
      runWithDirtyGate(() => {
        setActiveVerse(v);
        setDualTarget({ chapter: chapterNum, verse: v });
      });
    },
    [runWithDirtyGate],
  );
  // Any action that leaves or re-targets the dual aligner gates on unsaved work
  // — alignment drags OR reading-text edits in either panel (save/discard
  // prompt) — shared by close + verse nav.
  const dualDirty =
    dualLeftDirty || dualRightDirty || dualLeftReadingDirty || dualRightReadingDirty;
  const requestDualAction = useCallback(
    (run: () => void) => {
      if (dualDirty) setPendingDualAction({ run });
      else run();
    },
    [dualDirty],
  );
  const requestCloseDual = useCallback(
    () => requestDualAction(() => setDualTarget(null)),
    [requestDualAction],
  );
  const dualNavTo = useCallback(
    (v: number) =>
      requestDualAction(() => {
        setActiveVerse(v);
        setDualTarget((t) => (t ? { ...t, verse: v } : t));
      }),
    [requestDualAction],
  );
  const resolveDualAction = useCallback(
    (choice: "save" | "discard") => {
      const action = pendingDualAction;
      setPendingDualAction(null);
      // Only touch the dirty panel(s): save() serializes + enqueues a PATCH
      // unconditionally, so calling it on the clean side would bump that
      // version row for nothing (and could 409 against a concurrent editor).
      if (choice === "save") {
        if (dualLeftDirty) dualLeftRef.current?.save();
        if (dualRightDirty) dualRightRef.current?.save();
        if (dualLeftReadingDirty) dualLeftReadingRef.current?.save();
        if (dualRightReadingDirty) dualRightReadingRef.current?.save();
      } else {
        if (dualLeftDirty) dualLeftRef.current?.discard();
        if (dualRightDirty) dualRightRef.current?.discard();
        if (dualLeftReadingDirty) dualLeftReadingRef.current?.discard();
        if (dualRightReadingDirty) dualRightReadingRef.current?.discard();
      }
      action?.run();
    },
    [pendingDualAction, dualLeftDirty, dualRightDirty, dualLeftReadingDirty, dualRightReadingDirty],
  );

  const handleSetPanelMode = useCallback(
    (mode: PanelMode) => {
      // Route through the dirty gate so leaving alignment mode with unsaved
      // drags (to Search or any sibling tab) prompts save/discard instead of
      // silently unmounting AlignmentPanel and dropping the edits. The gate is
      // a no-op unless we're currently in dirty alignment, so entering
      // alignment and all clean switches still apply immediately.
      runWithDirtyGate(() => {
        if (mode === "alignment" && !alignerTarget) {
          setAlignerTarget({ chapter, verse: activeVerse, bibleVersion: "ULT" });
        }
        setPanelMode(mode);
      });
    },
    [runWithDirtyGate, alignerTarget, chapter, activeVerse],
  );

  const dismissPendingNav = useCallback(() => setPendingNav(null), []);
  const resolvePendingNav = useCallback(
    (choice: "save" | "discard") => {
      const nav = pendingNav;
      setPendingNav(null);
      if (!nav) return;
      if (choice === "save") alignmentPanelRef.current?.save();
      else alignmentPanelRef.current?.discard();
      nav.run();
    },
    [pendingNav],
  );

  const enqueueVerseSafely = useCallback((
    chapterNum: number,
    verseNum: number,
    bibleVersion: string,
    base: VerseDto,
    content: unknown,
    plainText: string,
    intent: AlignmentIntent,
    expectedVersion = base.version,
  ): boolean => {
    const delta = analyzeAlignmentDelta(base.content, content);
    // Block any save that collaterally de-aligns untouched words. The enforced
    // predicate lives in guardBlocksSave — DO NOT inline a narrowing such as
    // `delta.wordSequenceUnchanged` here. That narrowing (commit 6980fd72) is
    // exactly what let 1CH 4:21 / NUM 24 ship: a one-word spelling edit flips
    // wordSequenceUnchanged to false, so the narrowed guard never fired and the
    // collateral loss reached master. See guardBlocksSave for the full rationale.
    if (guardBlocksSave(delta, intent)) {
      const sample = delta.unexpectedLosses
        .slice(0, 3)
        .map((loss) => loss.text)
        .join(", ");
      if (intent === "text_edit") {
        pushPipelineToast(
          `This edit can't preserve word alignment on words you didn't change, so it wasn't saved (${book} ${chapterNum}:${verseNum} ${bibleVersion}${sample ? `; affected: ${sample}` : ""}). The unsaved draft was discarded. Please note this verse (${book} ${chapterNum}:${verseNum}) for your admin to file a bug-fix review, or make the text edit more narrowly / re-align in the alignment panel.`,
          "error",
        );
        void drafts.clear(verseKey(book, chapterNum, verseNum, bibleVersion));
      } else {
        pushPipelineToast(
          `This edit can't preserve word alignment on words you didn't change, so it wasn't saved (${book} ${chapterNum}:${verseNum} ${bibleVersion}${sample ? `; affected: ${sample}` : ""}). Please note this verse (${book} ${chapterNum}:${verseNum}) for your admin to file a bug-fix review, or re-align in the alignment panel.`,
          "error",
        );
      }
      return false;
    }
    void outbox.enqueueVerse(
      book,
      chapterNum,
      verseNum,
      bibleVersion,
      expectedVersion,
      { content, plain_text: plainText, alignment_intent: intent },
    );
    return true;
  }, [book, pushPipelineToast]);

  // Compute the alignment panel's props from the current chapter cache.
  // Memoized so identity stays stable when the chapter hasn't changed under
  // it; the panel uses verse identity to re-init its internal state.
  const alignmentTabProps = useMemo<AlignmentTabProps | undefined>(() => {
    if (!alignerTarget) return undefined;
    if (!data) return undefined;
    const sameChapter = alignerTarget.chapter === chapter;
    const bookData =
      !sameChapter && bookHook
        ? (() => {
            const cs = bookHook.chapters.get(alignerTarget.chapter);
            return cs?.kind === "ready" ? cs.data : null;
          })()
        : null;
    const sourceData = sameChapter ? data : bookData;
    if (!sourceData) return undefined;
    // Multi-verse target (e.g. UST 6-9): buildAlignerSlice expands the source
    // side by concatenating per-verse UHB/UGNT rows across the span and widens
    // the TWL list to every verse the range covers.
    const { sourceLabel, targetVerse, sourceVerse, twlForVerse } = buildAlignerSlice(
      sourceData,
      alignerTarget.verse,
      alignerTarget.bibleVersion,
    );
    return {
      book,
      chapter: alignerTarget.chapter,
      verseNum: alignerTarget.verse,
      bibleVersion: alignerTarget.bibleVersion,
      verse: targetVerse,
      sourceVerse,
      sourceLabel,
      twlForVerse,
      onSave: (content, plain, _expectedVersion) => {
        // Key the PATCH by the resolved row's verse_start — alignerTarget.verse
        // may sit INSIDE a range row (v7 of a UST 6-9 block) now that the
        // slice resolves through buildVerseIndex.
        if (targetVerse) {
          enqueueVerseSafely(
            alignerTarget.chapter,
            targetVerse.verse,
            alignerTarget.bibleVersion,
            targetVerse,
            content,
            plain,
            "alignment_edit",
            _expectedVersion,
          );
        }
        // Optimistically fold the new alignment into the local chapter cache so
        // content-derived UI (the broken-alignment link, OL-anchored note
        // highlights) updates immediately instead of waiting for a refetch.
        // Mirrors the verse-text / section save paths; the outbox 200 handler
        // bumps the version, so we keep targetVerse's version here.
        if (targetVerse) {
          const newDto = { ...targetVerse, content, plain_text: plain } as VerseDto;
          bookHook?.applyLocalVerse(newDto);
          if (alignerTarget.chapter === chapter) applyLocalVerse(newDto);
        }
      },
      onCancel: () => {
        setPanelMode("resources");
      },
      onDirtyChange: setAlignmentDirty,
      panelRef: alignmentPanelRef,
      onOpenDual: () => openDualAligner(alignerTarget.chapter, alignerTarget.verse),
      onRestoreVersion: targetVerse
        ? (content, plainText) =>
            restoreVerse(
              alignerTarget.chapter,
              targetVerse.verse,
              alignerTarget.bibleVersion,
              content,
              plainText,
              targetVerse,
            )
        : undefined,
    };
  }, [alignerTarget, data, chapter, bookHook, book, openDualAligner, applyLocalVerse, enqueueVerseSafely]);

  // Props for the side-by-side popup: ULT + UST slices against one shared
  // source. Undefined (popup closed) unless a dualTarget is set and at least
  // one of the two versions exists for the verse.
  const dualAlignerProps = useMemo(() => {
    if (!dualTarget || !data) return undefined;
    const sameChapter = dualTarget.chapter === chapter;
    const bookData =
      !sameChapter && bookHook
        ? (() => {
            const cs = bookHook.chapters.get(dualTarget.chapter);
            return cs?.kind === "ready" ? cs.data : null;
          })()
        : null;
    const sourceData = sameChapter ? data : bookData;
    if (!sourceData) return undefined;
    const ult = buildAlignerSlice(sourceData, dualTarget.verse, "ULT");
    const ust = buildAlignerSlice(sourceData, dualTarget.verse, "UST");
    if (!ult.targetVerse && !ust.targetVerse) return undefined;
    const sourceLabel = ult.sourceLabel; // identical across versions
    // The shared strip shows the UNION span so a multi-verse UST and a
    // per-verse ULT both see the Hebrew they reference. Each PANEL keeps its
    // own slice's source (only the verses its target covers) — aligning to it
    // is what gets serialized into zaln milestones, and the union would let a
    // single-verse panel reference Hebrew outside its verse. posOffset bridges
    // panel positions into the union for the lifted hover.
    const rangeStart = Math.min(ult.rangeStart, ust.rangeStart);
    const rangeEnd = Math.max(ult.rangeEnd, ust.rangeEnd);
    const byStart = sourceData.verses[sourceLabel] ?? {};
    const sourceVerse =
      rangeEnd > rangeStart
        ? concatSourceRange(byStart, rangeStart, rangeEnd)
        : byStart[rangeStart] ?? null;
    const offsetFor = (ownStart: number) => {
      let off = 0;
      for (let v = rangeStart; v < ownStart; v++) off += countSourceWords(byStart[v]);
      return off;
    };
    const twlForVerse = sourceData.twl.filter((r) => r.verse >= rangeStart && r.verse <= rangeEnd);
    const labelVerse = ult.targetVerse ?? ust.targetVerse;
    const vref = `${book} ${dualTarget.chapter}:${
      labelVerse ? formatVerseLabel(labelVerse) : dualTarget.verse
    }`;
    // PATCH key is the resolved row's verse_start — dualTarget.verse may sit
    // inside a range row now that slices resolve through buildVerseIndex.
    const enqueue = (bibleVersion: string, row: VerseDto | null) =>
      (content: unknown, plain: string, _expectedVersion: number) => {
        if (!row) return;
        enqueueVerseSafely(
          dualTarget.chapter,
          row.verse,
          bibleVersion,
          row,
          content,
          plain,
          "alignment_edit",
          _expectedVersion,
        );
        // Optimistic local update so content-derived UI (the broken-alignment
        // link) refreshes immediately — same as the single-panel aligner.
        const newDto = { ...row, content, plain_text: plain } as VerseDto;
        bookHook?.applyLocalVerse(newDto);
        if (dualTarget.chapter === chapter) applyLocalVerse(newDto);
      };
    const left: PanelSlot = {
      bibleVersion: "ULT",
      verse: ult.targetVerse,
      sourceVerse: ult.sourceVerse,
      twlForVerse: ult.twlForVerse,
      posOffset: offsetFor(ult.rangeStart),
      onSave: enqueue("ULT", ult.targetVerse),
      onDirtyChange: setDualLeftDirty,
      panelRef: dualLeftRef,
      onReadingDirtyChange: setDualLeftReadingDirty,
      readingRef: dualLeftReadingRef,
    };
    const right: PanelSlot = {
      bibleVersion: "UST",
      verse: ust.targetVerse,
      sourceVerse: ust.sourceVerse,
      twlForVerse: ust.twlForVerse,
      posOffset: offsetFor(ust.rangeStart),
      onSave: enqueue("UST", ust.targetVerse),
      onDirtyChange: setDualRightDirty,
      panelRef: dualRightRef,
      onReadingDirtyChange: setDualRightReadingDirty,
      readingRef: dualRightReadingRef,
    };
    return {
      book,
      chapter: dualTarget.chapter,
      verseNum: dualTarget.verse,
      vref,
      sourceLabel,
      sourceVerse,
      twlForVerse,
      left,
      right,
    };
  }, [dualTarget, data, chapter, bookHook, book, applyLocalVerse, enqueueVerseSafely]);

  // Prev/next verse for the dual aligner's titlebar arrows, within the current
  // chapter's verse list (excluding the intro tile). Null at the ends.
  const dualNav = useMemo(() => {
    if (!dualAlignerProps || dualAlignerProps.chapter !== chapter) {
      return { prev: null as number | null, next: null as number | null };
    }
    const nums = verseNumbers.filter((v) => v > 0);
    const idx = nums.indexOf(dualAlignerProps.verseNum);
    if (idx === -1) return { prev: null, next: null };
    return { prev: nums[idx - 1] ?? null, next: nums[idx + 1] ?? null };
  }, [dualAlignerProps, chapter, verseNumbers]);

  const alignmentBadge = alignerTarget
    ? `${alignerTarget.chapter}:${
        alignerTarget.verse === 0
          ? "i"
          : alignmentTabProps?.verse
            ? formatVerseLabel(alignmentTabProps.verse)
            : alignerTarget.verse
      }`
    : undefined;

  // Initial load (or retry from scratch) — no data to show yet. Render the
  // TopBar anyway (it fetches its own book list, and includes SyncStatusBar)
  // so a bad deep link / 404 chapter still leaves the user a way to navigate
  // out and an offline user sees their connection state. Navigation here is
  // deliberately ungated — the alignment panel and the dirty-confirm dialog
  // only mount in the data branch, so runWithDirtyGate would soft-lock.
  if (!data) {
    return (
      <Box sx={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <TopBar
          book={book}
          chapter={chapter}
          onNavigate={(b, c, v) => {
            setActiveVerse(v ?? 1);
            setActiveNoteId(null);
            setActiveWordId(null);
            onNavigate?.(b, c, v);
          }}
        />
        <Box sx={{ p: 4, display: "flex", alignItems: "center", gap: 2 }}>
          {status === "error" ? (
            <Alert severity="error">failed to load {book} {chapter}: {error}</Alert>
          ) : (
            <>
              <CircularProgress size={20} />
              <Typography variant="body2">
                {status === "retrying" ? `reconnecting… (attempt ${retryAttempts})` : `loading ${book} ${chapter}…`}
              </Typography>
            </>
          )}
        </Box>
      </Box>
    );
  }

  const enqueueRow = <T extends TnRow | TqRow | TwlRow>(
    kind: "tn" | "tq" | "twl",
    row: T,
    patch: Partial<T>,
    opts?: { restoredFromVersion?: number },
  ) => {
    // Optimistic local apply mirrors what the server will do: any non-revert
    // patch clears the restored_from_version marker so the chip immediately
    // drops the v{N} override instead of waiting for the round-trip.
    const localPatch = {
      ...patch,
      restored_from_version:
        opts?.restoredFromVersion !== undefined ? opts.restoredFromVersion : null,
    } as Partial<TnRow & TqRow & TwlRow>;
    applyLocalRowPatch(kind, row.id, localPatch);
    void outbox.enqueueRow(kind, row.id, row.version, patch as Record<string, unknown>, { ...opts, book: row.book });
  };

  // Draft-write path. Every keystroke in a verse-text cell calls this; it
  // stashes the plain text in IndexedDB so unsaved typing survives tab
  // close / chapter navigation. No PATCH fires here — only on saveVerseDraft.
  const stashVerseDraft = (
    chapterNum: number,
    verseNum: number,
    bibleVersion: string,
    plain: string,
    base: VerseDto,
  ) => {
    void drafts.set(
      verseKey(book, chapterNum, verseNum, bibleVersion),
      { plainText: plain },
      base.version,
      { kind: "verse", book, chapter: chapterNum, verse: verseNum, bibleVersion },
    );
  };

  // User clicked Save on a verse cell. Runs smartEditVerse so unchanged
  // regions keep their `\zaln-s` milestones, applies the new content
  // locally so highlights re-render, then enqueues. Outbox-result listener
  // (installed in main.ts) clears the draft on 200.
  //
  // `plain` is the editable representation (paragraph / poetry markers
  // surfaced as inline "\p" / "\q1" tokens) — extractEditableText on the
  // base content produces the matching baseline for the diff. The DB
  // `plain_text` column stays marker-free, so we recompute it from the
  // resulting tree via extractPlainText.
  const saveVerseDraft = (
    chapterNum: number,
    verseNum: number,
    bibleVersion: string,
    plain: string,
    base: VerseDto,
  ) => {
    const oldEditable = extractEditableText(base.content);
    // No-op guard: a focus/blur (or any save) with no actual text change must
    // not enqueue a PATCH — it would bump the verse version server-side for
    // nothing, adding noisy history and leaving a stale expected_version that a
    // later alignment save on the same row can 409 against.
    //
    // `oldEditable` is already normalizeEditable-collapsed, but `plain` is raw
    // DOM textContent (may carry trailing \n / ZWSP / nbsp the editor emits),
    // so normalize both sides — otherwise type-a-char-then-revert never matches
    // and a version-bumping no-op PATCH fires. On a real no-op we must also
    // CLEAR the stranded keystroke draft: drafts are written on every keystroke
    // and only cleared by the outbox-200 listener, so returning without clearing
    // leaves an orphaned draft (dirty border + SyncStatusBar entry + "unsaved
    // edits" toast whose Save button re-hits this guard and never resolves).
    if (oldEditable === normalizeEditable(plain)) {
      void drafts.clear(verseKey(book, chapterNum, verseNum, bibleVersion));
      return;
    }
    const result = smartEditVerse(base.content, oldEditable, plain);
    // Heads-up when this save drops alignment. Editing a word's text or order
    // unaligns that word by design — the engine preserves only the words it
    // didn't have to touch — and the loss is otherwise easy to miss: the editor
    // shows plain text, so a translator who reworded a phrase and saved gets no
    // in-place signal that they now have words to re-align (the prompt that led
    // here: a verse reworded + repunctuated in one save came back with several
    // words unaligned, read as "changing the period unaligned them"). Compare
    // the unaligned-word count before vs after and notify only when it actually
    // INCREASED, so a pure punctuation / spacing edit — which keeps every \zaln —
    // stays silent.
    const beforeUnaligned = countUnalignedTargetWords(
      (base.content as { verseObjects?: unknown[] } | null)?.verseObjects,
    );
    const afterUnaligned = countUnalignedTargetWords(
      (result.content as { verseObjects?: unknown[] } | null)?.verseObjects,
    );
    const newlyUnaligned = afterUnaligned - beforeUnaligned;
    if (newlyUnaligned > 0) {
      pushPipelineToast(
        `This edit left ${newlyUnaligned} word${newlyUnaligned > 1 ? "s" : ""} unaligned in ${book} ${chapterNum}:${verseNum} ${bibleVersion} — re-align in the Alignment panel.`,
        "info",
      );
    }
    const newPlainText = extractPlainText(result.content);
    const newDto = {
      ...base,
      chapter: chapterNum,
      verse: verseNum,
      bible_version: bibleVersion,
      plain_text: newPlainText,
      content: result.content,
    } as VerseDto;
    if (!enqueueVerseSafely(chapterNum, verseNum, bibleVersion, base, result.content, newPlainText, "text_edit")) {
      return;
    }
    bookHook?.applyLocalVerse(newDto);
    if (chapterNum === chapter) applyLocalVerse(newDto);
  };

  // Restore a previously-saved verse version (from the history dialog). Unlike
  // saveVerseDraft, there is no smartEditVerse pass — we re-save the exact
  // stored content tree verbatim (alignment milestones included). It routes
  // through the same pipe with the alignment_edit intent: a deliberate
  // full-tree replacement legitimately changes alignment, and that is the only
  // intent the collateral-loss guard exempts (guardBlocksSave). The version
  // climbs normally, so the new entry's content matches the restored one — no
  // restored_from_version bookkeeping needed (unlike notes).
  const restoreVerse = (
    chapterNum: number,
    verseNum: number,
    bibleVersion: string,
    content: unknown,
    plainText: string | null,
    base: VerseDto,
  ) => {
    const newPlainText = plainText ?? extractPlainText(content);
    const newDto = {
      ...base,
      chapter: chapterNum,
      verse: verseNum,
      bible_version: bibleVersion,
      plain_text: newPlainText,
      content,
    } as VerseDto;
    if (!enqueueVerseSafely(chapterNum, verseNum, bibleVersion, base, content, newPlainText, "alignment_edit")) {
      return;
    }
    // Drop any stranded keystroke draft so the dirty border / "unsaved edits"
    // toast don't linger over content the restore just replaced.
    void drafts.clear(verseKey(book, chapterNum, verseNum, bibleVersion));
    bookHook?.applyLocalVerse(newDto);
    if (chapterNum === chapter) applyLocalVerse(newDto);
  };

  // Section header (\s1/\s2/\s3) edit / delete. `change.index` is the
  // i'th section header inside this verse's content per
  // splitSectionHeaders. tag === null deletes the band. The verseObjects
  // tree is mutated structurally (no smartEditVerse — there's no text
  // diff, just a structural node swap) and saved via the same outbox.
  const saveSectionEdit = (
    chapterNum: number,
    verseNum: number,
    bibleVersion: string,
    change: { index: number; tag: string | null; text: string },
    base: VerseDto,
  ) => {
    const verseObjects = (base.content as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (!Array.isArray(verseObjects)) return;
    // Walk verseObjects in order; the index counter advances each time
    // we hit a section heading. On match: swap (tag/text) or splice out.
    const next: unknown[] = [];
    let sectionIdx = 0;
    for (const node of verseObjects) {
      const o = node as Record<string, unknown> | null;
      if (
        o &&
        o["type"] === "section" &&
        typeof o["tag"] === "string" &&
        SECTION_HEADER_TAGS.has(o["tag"] as string)
      ) {
        if (sectionIdx === change.index) {
          if (change.tag !== null) {
            // usfm-js stores \s* heading text in `content` (with a
            // trailing \n that the renderer/exporter expects).
            // splitSectionHeaders prefers `content` over `text`, so we
            // must write `content` for the change to round-trip.
            const { text: _drop, ...rest } = o;
            next.push({ ...rest, tag: change.tag, content: `${change.text}\n` });
          }
          // null tag → drop the node entirely.
          sectionIdx++;
          continue;
        }
        sectionIdx++;
      }
      next.push(node);
    }
    const newContent = { ...(base.content as Record<string, unknown> | null), verseObjects: next };
    const newPlainText = extractPlainText(newContent);
    const newDto = {
      ...base,
      chapter: chapterNum,
      verse: verseNum,
      bible_version: bibleVersion,
      plain_text: newPlainText,
      content: newContent,
    } as VerseDto;
    if (!enqueueVerseSafely(chapterNum, verseNum, bibleVersion, base, newContent, newPlainText, "section_edit")) {
      return;
    }
    bookHook?.applyLocalVerse(newDto);
    if (chapterNum === chapter) applyLocalVerse(newDto);
  };

  return (
    <Box sx={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <TopBar
        book={book}
        chapter={chapter}
        onNavigate={(b, c, v) => {
          runWithDirtyGate(() => {
            setActiveVerse(v ?? 1);
            setActiveNoteId(null);
            setActiveWordId(null);
            onNavigate?.(b, c, v);
          });
        }}
        pipelineMenu={
          <PipelineMenu
            book={book}
            chapter={chapter}
            onMessage={(msg) => pushPipelineToast(msg, "info")}
            onImported={() => void refetch()}
          />
        }
        pipelineStatus={
          <PipelineStatusBar
            toast={pipelineToast}
            onToastClear={() => setPipelineToast(null)}
          />
        }
        logosSyncToggle={
          <LogosSyncToggle book={book} chapter={chapter} verse={activeVerse} />
        }
        railCollapsed={railCollapsed}
        onToggleRail={toggleRail}
      />
      {chapterLock && (
        <Alert
          severity="info"
          icon={false}
          sx={{
            borderRadius: 0,
            borderBottom: "1px solid",
            borderColor: "divider",
            py: 0.5,
            "& .MuiAlert-message": { width: "100%" },
          }}
        >
          AI {chapterLock.pipelineType} run in progress for {book} {chapter} —
          started {formatRelative(chapterLock.startedAt)}. Editing is locked
          for this chapter. You can still mark notes to keep before the new
          set lands.
        </Alert>
      )}
      <Box ref={splitContainerRef} sx={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {!railCollapsed && (
          <Box sx={{ width: 64, flexShrink: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <TimelineRail
              book={book}
              chapter={chapter}
              tiles={tileSet}
              activeVerse={activeVerse}
              showChapter={mode === "book"}
              onSelect={requestSelectVerse}
              onToggleDone={(v, done) => {
                // Through the outbox so an offline toggle isn't dropped. The
                // payload is coalesced per (book, chapter, verse) so a rapid
                // click-click only ships the final state.
                void outbox.enqueueVerseStatus(book, chapter, v, done);
                // Optimistic local update — useChapter would also reconcile on
                // the outbox "ok" callback once that handler covers
                // verse_status (currently it only mirrors row + verse). For
                // now, refetching when the queue settles keeps the rail in
                // step without a re-render race.
                applyLocalVerseStatus(v, done);
              }}
            />
            <Box
              sx={{
                flexShrink: 0,
                bgcolor: "grey.50",
                borderRight: "1px solid",
                borderColor: "divider",
                borderTop: "1px solid",
                borderTopColor: "divider",
                p: 0.5,
              }}
            >
              <Tooltip title="Sign out" placement="right">
                <IconButton
                  size="small"
                  onClick={onLogout}
                  sx={{
                    width: "100%",
                    borderRadius: 0.5,
                    color: "text.disabled",
                    "&:hover": { color: "text.secondary" },
                  }}
                >
                  <LogoutIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            </Box>
          </Box>
        )}
        <Box
          sx={{
            width: `${effectiveSplit * 100}%`,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
        <ScriptureColumn
          book={book}
          chapter={chapter}
          versesByVersion={data.verses}
          verseNumbers={verseNumbers}
          activeVerse={activeVerse}
          activeNoteQuote={activeQuote}
          activeNoteOccurrence={activeOccurrence}
          reorderHighlight={reorderHighlight}
          mode={mode}
          enabledVersions={displayedVersions}
          availableVersions={availableVersions}
          bookChapterList={bookChapterList}
          bookChapters={bookHook && mode === "book" ? bookHook.chapters : undefined}
          onLoadBookChapter={bookHook ? bookHook.loadChapter : undefined}
          onSelectBookVerse={(ch, v) => {
            // Verse click in book mode navigates via URL so the chapter
            // payload + resources reload through the existing useChapter
            // flow. App.tsx lifts the useBook cache so this round-trip is
            // cheap.
            runWithDirtyGate(() => {
              if (ch !== chapter) {
                onNavigate?.(book, ch, v);
              } else {
                setActiveVerse(v);
                setActiveNoteId(null);
                setActiveWordId(null);
              }
            });
          }}
          onEditBookVerse={(ch, verseNum, bibleVersion, plain, base) => {
            stashVerseDraft(ch, verseNum, bibleVersion, plain, base);
          }}
          onSaveBookVerse={(ch, verseNum, bibleVersion, plain, base) => {
            saveVerseDraft(ch, verseNum, bibleVersion, plain, base);
          }}
          onOpenBookAligner={(ch, v, bv) => openAligner(ch, v, bv)}
          onReplaceVerse={(ch, verseNum, bibleVersion, newContent, newPlainText, base) => {
            // Find/replace ships pre-built content from smartReplaceVerse —
            // alignment is preserved when word counts match, fully
            // re-tokenized otherwise. Dual-apply to useChapter so opening
            // ⌭ right after a replace shows the new content instead of the
            // pre-replace cache.
            const newDto = {
              ...base,
              chapter: ch,
              verse: verseNum,
              bible_version: bibleVersion,
              plain_text: newPlainText,
              content: newContent,
            } as VerseDto;
            if (!enqueueVerseSafely(ch, verseNum, bibleVersion, base, newContent, newPlainText, "find_replace")) {
              return;
            }
            bookHook?.applyLocalVerse(newDto);
            if (ch === chapter) applyLocalVerse(newDto);
          }}
          onReplaceNote={(row, newNote) => {
            // Find/replace on a translation note rewrites the BODY only (id is
            // the PK, support_reference is a structured rc:// link — both stay
            // put; the overlay enforces this). Reuse the standard note save
            // path so it gets the same outbox If-Match (on row.version),
            // restored_from_version clear, and 409 merge handling as a manual
            // edit. Also patch the book-mode cache so a cross-chapter note in
            // book view updates immediately (enqueueRow's local apply only
            // touches the active chapter's useChapter data).
            enqueueRow("tn", row, { note: newNote });
            bookHook?.applyLocalRowPatch("tn", row.chapter, row.id, {
              note: newNote,
              restored_from_version: null,
            });
          }}
          onSelectVerse={(v) => requestSelectVerse(v)}
          onModeChange={(m) => {
            setMode(m);
            saveToStorage(SCRIPTURE_MODE_KEY, m);
          }}
          onEnabledVersionsChange={(versions) => {
            setEnabledVersions(versions);
            saveToStorage(ENABLED_VERSIONS_KEY, versions);
          }}
          onEditVerse={(verseNum, bibleVersion, plain, base) => {
            stashVerseDraft(chapter, verseNum, bibleVersion, plain, base);
          }}
          onSaveVerse={(verseNum, bibleVersion, plain, base) => {
            saveVerseDraft(chapter, verseNum, bibleVersion, plain, base);
          }}
          onRestoreVerse={(verseNum, bibleVersion, content, plainText, base) => {
            restoreVerse(chapter, verseNum, bibleVersion, content, plainText, base);
          }}
          onEditSection={(verseNum, bibleVersion, change, base) => {
            saveSectionEdit(chapter, verseNum, bibleVersion, change, base);
          }}
          onEditBookSection={(ch, verseNum, bibleVersion, change, base) => {
            saveSectionEdit(ch, verseNum, bibleVersion, change, base);
          }}
          onOpenAligner={(v, bv) => openAligner(chapter, v, bv)}
          scrollNonce={scrollNonce}
          onRequestScrollToActive={requestScrollToActive}
          searchNotes={getSearchNotes}
          onScrollToNoteMatch={focusNoteMatch}
          onNoteQueryChange={setFindNoteQuery}
          onActiveNoteMatchChange={setActiveNoteMatch}
          lexiconMap={lexiconMap}
          twl={data.twl}
          locked={Boolean(chapterLock)}
        />
        </Box>
        <Box
          onMouseDown={handleDividerMouseDown}
          sx={{
            width: "8px",
            flexShrink: 0,
            cursor: "ew-resize",
            position: "relative",
            "&::after": {
              content: '""',
              position: "absolute",
              left: "50%",
              top: 0,
              bottom: 0,
              width: "1px",
              bgcolor: "divider",
              transform: "translateX(-50%)",
              transition: "background-color 0.15s",
            },
            "&:hover::after": { bgcolor: "primary.main" },
          }}
        />
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
        <ResourceColumn
          activeVerse={activeVerse}
          displayVerseRange={displayVerseRange}
          tn={data.tn}
          tq={data.tq}
          twl={data.twl}
          activeNoteId={activeNoteId}
          activeWordId={activeWordId}
          findNoteQuery={findNoteQuery}
          activeNoteMatch={activeNoteMatch}
          scrollNonce={scrollNonce}
          onNoteChange={(id, patch) => {
            applyLocalRowPatch("tn", id, patch);
          }}
          onNoteSave={(id, patch, opts) => {
            const row = data.tn.find((r) => r.id === id);
            if (row) enqueueRow("tn", row, patch, opts);
          }}
          onNoteFocus={(row) => {
            setActiveNoteId(row.id);
            setActiveWordId(null);
            if (row.verse !== activeVerse) setActiveVerse(row.verse);
          }}
          onNoteStartAi={(row, live) => {
            // Build from the live (unsaved) note fields so SUGGEST works
            // before an explicit save — the cached data.tn row can lag the
            // box (quote propagates on a debounce; a freshly-built note may
            // not be flushed at all), which is what produced the bogus "AI
            // prerequisites missing." id/version/book/verse stay from the
            // cached row so the outbox If-Match and toast targeting hold.
            const aiRow: TnRow = {
              ...row,
              quote: live.quote,
              note: live.note,
              support_reference: live.support_reference,
            };
            const built = buildTnQuickRequest(aiRow, data);
            if (!built.ok) {
              // NoteCard gates on quote + support_reference. The remaining
              // reasons (missing ULT/UST or unalignable English) need a
              // user-actionable message.
              const message =
                built.error.reason === "missing_ult_verse"
                  ? "ULT verse text unavailable for this verse."
                  : built.error.reason === "missing_ust_verse"
                    ? "UST verse text unavailable for this verse."
                    : built.error.reason === "hebrew_not_found"
                      ? "Couldn't match this English to the ULT alignment — copy the support phrase exactly from ULT."
                      : "AI prerequisites missing.";
              aiDrafts.pushError(aiRow, message);
              return;
            }
            aiDrafts.start(aiRow, built.request, {
              getIsVisible: (id) => visibleRowIdsRef.current.has(id),
              onSuccess: (r, res) => {
                const patch = { quote: res.quote, note: res.note };
                // Re-running the suggestion on an already-drafted note can
                // return a quote+note identical to what's stored; skip the
                // save so we don't bump the row version with a no-op (mirror
                // of the commitQuoteBuild guard). res.quote may be
                // source-derived Hebrew in a different combining-mark order
                // than the stored value, so NFC-normalize the quote compare;
                // the note is plain TSV text stored verbatim, so compare raw.
                const changed =
                  nfc(res.quote) !== nfc(r.quote ?? "") || res.note !== (r.note ?? "");
                if (!changed) return;
                applyLocalRowPatch("tn", r.id, patch);
                void outbox.enqueueRow("tn", r.id, r.version, patch, { book: r.book });
              },
            });
          }}
          isNoteAiPending={aiDrafts.isPending}
          noteAiRecentlyCompletedAt={aiDrafts.recentlyCompletedAt}
          onNoteVisibilityChange={handleNoteVisibilityChange}
          onNoteTranslateQuote={(row, english) => {
            const vo = (
              verseIndexByVersion["ULT"]?.[row.verse]?.content as
                | { verseObjects?: unknown[] }
                | null
                | undefined
            )?.verseObjects;
            if (!Array.isArray(vo)) return null;
            return findSourceForTargetText(vo, english) || null;
          }}
          onWordTranslateQuote={(row, english) => {
            const vo = (
              verseIndexByVersion["ULT"]?.[row.verse]?.content as
                | { verseObjects?: unknown[] }
                | null
                | undefined
            )?.verseObjects;
            if (!Array.isArray(vo)) return null;
            return findSourceForTargetText(vo, english) || null;
          }}
          onWordFocus={(row) => {
            setActiveWordId(row.id);
            setActiveNoteId(null);
            if (row.verse !== activeVerse) setActiveVerse(row.verse);
          }}
          onNoteCreate={async () => {
            const list = sortedForVerse(data.tn, activeVerse);
            const sort_order = pickSortOrder(list, null, "after");
            const created = (await api.createRow<TnRow>("tn", {
              book,
              chapter,
              verse: activeVerse,
              ref_raw: activeVerse === 0 ? `${chapter}:intro` : `${chapter}:${activeVerse}`,
              note: "",
              sort_order,
            }));
            applyLocalRowInsert("tn", created);
            setActiveNoteId(created.id);
            setActiveWordId(null);
          }}
          onNoteInsertAfter={async (refId) => {
            const ref = data.tn.find((r) => r.id === refId);
            if (!ref) return;
            const list = sortedForVerse(data.tn, ref.verse);
            const sort_order = pickSortOrder(list, refId, "after");
            // No inherited support_reference — fresh notes get an empty
            // chip so the user can typeahead in immediately.
            const created = (await api.createRow<TnRow>("tn", {
              book,
              chapter,
              verse: ref.verse,
              ref_raw: ref.ref_raw,
              note: "",
              sort_order,
            }));
            applyLocalRowInsert("tn", created, { afterId: refId });
            setActiveNoteId(created.id);
            setActiveWordId(null);
          }}
          onNoteReorder={(draggedId, refId, position) => {
            // Read the live (ref) row list, not the render-scoped `data`
            // closure: a rapid burst of arrow clicks fires several handlers
            // before React re-renders, and a stale closure would renumber from
            // an outdated order and enqueue ops carrying a stale version.
            const tn = dataRef.current?.tn ?? [];
            const dragged = tn.find((r) => r.id === draggedId);
            if (!dragged) return;
            const sorted = sortedForVerse(tn, dragged.verse);
            const changes = reorderSequential(sorted, draggedId, refId, position);
            for (const { row, sort_order } of changes) {
              enqueueRow("tn", row, { sort_order });
            }
          }}
          verseOptions={verseNumbers}
          onNoteChangeVerse={(id, verse) => {
            // Retarget a note to another verse in this chapter. Read the live
            // row (dataRef, not the render closure) so a rapid move carries the
            // current version. Recompute ref_raw + a fresh sort_order (end of
            // the target verse) so the note lands in order there; enqueueRow
            // applies it optimistically (re-bucketing the card) and PATCHes.
            const tn = dataRef.current?.tn ?? [];
            const row = tn.find((r) => r.id === id);
            if (!row || row.verse === verse) return;
            const sort_order = pickSortOrder(sortedForVerse(tn, verse), null, "after");
            const ref_raw = verse === 0 ? `${chapter}:intro` : `${chapter}:${verse}`;
            enqueueRow("tn", row, { verse, ref_raw, sort_order });
            // Follow the note to its new verse: the resource column only renders
            // notes in displayVerseRange, so without this the moved card vanishes
            // from view. Navigating there confirms the move landed.
            setActiveVerse(verse);
            setActiveNoteId(id);
          }}
          onReorderPreview={handleReorderPreview}
          onWordCreate={async () => {
            const list = sortedForVerse(data.twl, activeVerse);
            const sort_order = pickSortOrder(list, null, "after");
            const created = (await api.createRow<TwlRow>("twl", {
              book,
              chapter,
              verse: activeVerse,
              ref_raw: activeVerse === 0 ? `${chapter}:intro` : `${chapter}:${activeVerse}`,
              orig_words: "",
              tw_link: "",
              sort_order,
            }));
            applyLocalRowInsert("twl", created);
            setActiveWordId(created.id);
            setActiveNoteId(null);
          }}
          onWordReorder={(draggedId, refId, position) => {
            // See onNoteReorder: live ref list, not the stale render closure.
            const twl = dataRef.current?.twl ?? [];
            const dragged = twl.find((r) => r.id === draggedId);
            if (!dragged) return;
            const sorted = sortedForVerse(twl, dragged.verse);
            const changes = reorderSequential(sorted, draggedId, refId, position);
            for (const { row, sort_order } of changes) {
              enqueueRow("twl", row, { sort_order });
            }
          }}
          onQuestionCreate={async () => {
            const created = (await api.createRow<TqRow>("tq", {
              book,
              chapter,
              verse: activeVerse,
              ref_raw: activeVerse === 0 ? `${chapter}:intro` : `${chapter}:${activeVerse}`,
              question: "",
              response: "",
            }));
            applyLocalRowInsert("tq", created);
          }}
          onNoteDelete={handleTrashNote}
          onNoteRestore={handleRestoreNote}
          onWordSave={(id, patch) => {
            const row = data.twl.find((r) => r.id === id);
            if (row) enqueueRow("twl", row, patch);
          }}
          onWordDelete={(id) => {
            const row = data.twl.find((r) => r.id === id);
            if (!row) return;
            applyLocalRowDelete("twl", id);
            if (activeWordId === id) setActiveWordId(null);
            void outbox.enqueueDeleteRow("twl", id, row.version, row.book);
          }}
          onQuestionSave={(id, patch) => {
            const row = data.tq.find((r) => r.id === id);
            if (row) enqueueRow("tq", row, patch);
          }}
          onQuestionDelete={(id) => {
            const row = data.tq.find((r) => r.id === id);
            if (!row) return;
            applyLocalRowDelete("tq", id);
            void outbox.enqueueDeleteRow("tq", id, row.version, row.book);
          }}
          locked={Boolean(chapterLock)}
          onSetNotePreserve={handleSetNotePreserve}
          onSetNoteHint={handleSetNoteHint}
          quoteBuildActiveNoteId={quoteBuildNoteId}
          quoteBuildSelectionCount={quoteBuildSelectedKeys.size}
          quoteBuildAppliedTo={quoteBuildAppliedTo}
          onStartQuoteBuild={startQuoteBuild}
          panelMode={panelMode}
          onSetPanelMode={handleSetPanelMode}
          alignmentProps={alignmentTabProps}
          alignmentBadge={alignmentBadge}
        />
        </Box>
      </Box>
      <Dialog open={!!pendingNav} onClose={dismissPendingNav}>
        <DialogTitle>Unsaved alignment changes</DialogTitle>
        <DialogContent>
          <DialogContentText>
            You have unsaved changes in the alignment editor. Save them before switching
            verses, discard them, or cancel to stay here.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={dismissPendingNav}>Cancel</Button>
          <Button color="error" onClick={() => resolvePendingNav("discard")}>
            Discard
          </Button>
          <Button variant="contained" onClick={() => resolvePendingNav("save")}>
            Save
          </Button>
        </DialogActions>
      </Dialog>
      {dualAlignerProps && (
        <SideBySideAligner
          open
          onClose={requestCloseDual}
          book={dualAlignerProps.book}
          chapter={dualAlignerProps.chapter}
          verseNum={dualAlignerProps.verseNum}
          vref={dualAlignerProps.vref}
          sourceLabel={dualAlignerProps.sourceLabel}
          sourceVerse={dualAlignerProps.sourceVerse}
          twlForVerse={dualAlignerProps.twlForVerse}
          lexiconMap={lexiconMap}
          left={dualAlignerProps.left}
          right={dualAlignerProps.right}
          onPrevVerse={dualNav.prev != null ? () => dualNavTo(dualNav.prev!) : undefined}
          onNextVerse={dualNav.next != null ? () => dualNavTo(dualNav.next!) : undefined}
          onSaveReading={(bv, plain, base) =>
            // base.verse, not verseNum — each side's row may start at a
            // different verse (ULT v7 singleton vs UST 6-9 range row).
            saveVerseDraft(dualAlignerProps.chapter, base.verse, bv, plain, base)
          }
        />
      )}
      <Dialog open={!!pendingDualAction} onClose={() => setPendingDualAction(null)}>
        <DialogTitle>Unsaved changes</DialogTitle>
        <DialogContent>
          <DialogContentText>
            You have unsaved changes in the side-by-side aligner (alignment edits or reading text).
            Save them, discard them, or cancel to keep editing.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDualAction(null)}>Cancel</Button>
          <Button color="error" onClick={() => resolveDualAction("discard")}>
            Discard
          </Button>
          <Button variant="contained" onClick={() => resolveDualAction("save")}>
            Save
          </Button>
        </DialogActions>
      </Dialog>
      <AiCompletionToasts
        notifications={aiDrafts.notifications}
        onDismiss={aiDrafts.dismiss}
        onView={(rowId, verse) => {
          runWithDirtyGate(() => {
            setActiveVerse(verse);
            setActiveNoteId(rowId);
            setActiveWordId(null);
            requestScrollToActive();
          });
        }}
      />
      <UnsavedToasts
        book={book}
        onSaveVerseDraft={(b, ch, v, bv) => {
          if (b !== book) return;
          // Look up the latest plain from the draft (avoids racing with
          // a still-pending typing flurry) and the base from whichever
          // cache holds the chapter — current chapter via data.verses,
          // book mode via bookHook.chapters.
          void drafts.get(verseKey(b, ch, v, bv)).then((rec) => {
            const payload = rec?.payload as { plainText?: string } | undefined;
            const plain = payload?.plainText;
            if (typeof plain !== "string") return;
            const base =
              ch === chapter
                ? data?.verses[bv]?.[v]
                : bookHook?.chapters.get(ch)?.kind === "ready"
                  ? (bookHook.chapters.get(ch) as { kind: "ready"; data: { verses: Record<string, Record<number, VerseDto>> } }).data.verses[bv]?.[v]
                  : undefined;
            if (!base) return;
            saveVerseDraft(ch, v, bv, plain, base);
          });
        }}
        onJumpTo={(b, ch, v) => {
          if (b !== book) return;
          runWithDirtyGate(() => {
            if (ch !== chapter) onNavigate?.(b, ch, v);
            else {
              setActiveVerse(v);
              requestScrollToActive();
            }
          });
        }}
      />
      {quoteBuildContext && (
        <QuoteBuilderPopper
          open={!!quoteBuildAnchor}
          anchorEl={quoteBuildAnchor}
          book={book}
          chapter={chapter}
          verse={quoteBuildContext.verse}
          uhbVerseObjects={quoteBuildContext.uhb}
          ultVerseObjects={quoteBuildContext.ult}
          ustVerseObjects={quoteBuildContext.ust}
          lexiconMap={lexiconMap}
          selectedKeys={quoteBuildSelectedKeys}
          onToggleKey={toggleQuoteBuildWord}
          onSelectKeys={selectQuoteBuildWords}
          onCancel={cancelQuoteBuild}
          onCommit={commitQuoteBuild}
        />
      )}
    </Box>
  );
}

// ---------- sort_order helpers ----------

type Sortable = { id: string; verse: number; sort_order: number | null };

function formatRelative(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function sortedForVerse<T extends Sortable>(rows: T[], verse: number): T[] {
  return rows
    .filter((r) => r.verse === verse)
    .sort(
      (a, b) =>
        (a.sort_order ?? Number.MAX_SAFE_INTEGER) -
          (b.sort_order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id),
    );
}

// Pick a sort_order so the new/moved row lands at the requested slot. Falls
// back to step-of-100 gaps when neighbors lack a sort_order yet. `excludeId`
// is set when reordering an existing row — we don't want it in the list when
// computing midpoints, otherwise drop-after-self collapses to a no-op midpoint
// inside its own slot.
function pickSortOrder<T extends Sortable>(
  rows: T[],
  refId: string | null,
  position: "before" | "after",
  excludeId?: string,
): number {
  const list = excludeId ? rows.filter((r) => r.id !== excludeId) : rows;
  if (list.length === 0) return 100;
  if (!refId) {
    const last = list[list.length - 1];
    return (last.sort_order ?? list.length * 100) + 100;
  }
  const idx = list.findIndex((r) => r.id === refId);
  if (idx < 0) {
    const last = list[list.length - 1];
    return (last.sort_order ?? list.length * 100) + 100;
  }
  const target = list[idx];
  const targetSort = target.sort_order ?? (idx + 1) * 100;
  if (position === "before") {
    const prev = list[idx - 1];
    const prevSort = prev?.sort_order ?? targetSort - 200;
    return (prevSort + targetSort) / 2;
  }
  const next = list[idx + 1];
  const nextSort = next?.sort_order ?? targetSort + 200;
  return (targetSort + nextSort) / 2;
}

// Reorder by full sequential renumbering (step 100) rather than a single
// midpoint. Moving `draggedId` to the slot at (refId, position) and assigning
// every row a fresh 100,200,300,… value. Returns only the rows whose value
// changed, each paired with its new sort_order.
//
// Why renumber instead of pickSortOrder: imported rows all have sort_order =
// null, and the sort collapses every null to one key (ordered by id). A lone
// midpoint value can't be slotted *between* two nulls — it sorts before or
// after the entire null group — so a moved row jumps to an end instead of
// advancing one slot. Renumbering gives the whole verse real, ordered values
// in one pass; subsequent moves only touch the rows that actually shifted.
function reorderSequential<T extends Sortable>(
  sorted: T[],
  draggedId: string,
  refId: string | null,
  position: "before" | "after",
): Array<{ row: T; sort_order: number }> {
  const dragged = sorted.find((r) => r.id === draggedId);
  if (!dragged) return [];
  const without = sorted.filter((r) => r.id !== draggedId);
  let insertIdx: number;
  if (refId == null) {
    insertIdx = position === "before" ? 0 : without.length;
  } else {
    const refIdx = without.findIndex((r) => r.id === refId);
    insertIdx = refIdx < 0 ? without.length : position === "before" ? refIdx : refIdx + 1;
  }
  const next = [...without.slice(0, insertIdx), dragged, ...without.slice(insertIdx)];
  const changes: Array<{ row: T; sort_order: number }> = [];
  next.forEach((row, i) => {
    const sort_order = (i + 1) * 100;
    if (row.sort_order !== sort_order) changes.push({ row, sort_order });
  });
  return changes;
}
