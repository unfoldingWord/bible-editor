import {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Box,
  Typography,
  Stack,
  Chip,
  IconButton,
  Paper,
  Tooltip,
  Button,
  Snackbar,
  useTheme,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import HistoryIcon from "@mui/icons-material/History";
import { assignChipHues, chipAccentColor, chipSupColor } from "../lib/highlightStyles";
import {
  alignmentPlainText,
  cardKey,
  clearAll,
  clearGroup,
  extractSource,
  mergeGroupsToGroups,
  moveSourceToGroups,
  moveTargets,
  parseAlignment,
  serializeAlignment,
  sourceKey,
  type AlignmentGroup,
  type AlignmentState,
  type SourceWord,
} from "../lib/alignment";
import {
  buildDisplayGroups,
  buildPosMaps,
  buildSourceIndexMap,
  buildTargetIdToGroupId,
  groupPositionKey,
  groupsForCard as groupsForCardId,
  makeEnglishHover,
  makeHebrewHover,
  resolveEnglishHighlight,
  resolveHebrewHighlight,
  resolveSourcePos,
  type HoverCtx,
} from "../lib/alignmentHover";
import type { TwlRow, VerseDto } from "../sync/api";
import { alignmentDrafts, alignmentDraftKey } from "../sync/alignmentDrafts";
import { isVersionOnlyRebase, lostAlignedWords } from "../lib/alignmentDelta";
import { useLexicon, type LexiconEntry } from "../hooks/useLexicon";
import { useAlignmentSuggestions } from "../hooks/useAlignmentSuggestions";
import {
  computeGhosts,
  dismissedGhostKey,
  ghostPipColor,
  suggestKey,
  type Ghost,
  type StreamWord,
} from "../lib/alignmentSuggest";
import { SourceTooltipBody } from "./SourceTooltipBody";
import { UhbStrip, buildTwHintMap, twHintFromMap } from "./UhbStrip";
import {
  type HoverHighlight,
  type HighlightCtx,
  hoverShadow,
} from "../lib/highlightTypes";

const WORD_IDS_MIME = "text/word-ids";
const SOURCE_ID_MIME = "text/source-id";
const GROUP_ID_MIME = "text/group-id";

// Storage keys for sticky toolbar prefs.
const LS_HIDE_UHB = "be:alignmentHideUhb";
const LS_COLORIZE = "be:alignmentColorize";
const LS_HOVERLINK = "be:alignmentHoverLink";
const LS_INVENTORY_HEIGHT = "be:alignmentInventoryHeight";

const DEFAULT_INVENTORY_HEIGHT = 112;
const MIN_INVENTORY_HEIGHT = 56;
const MAX_INVENTORY_HEIGHT = 480;

function readFlag(key: string, fallback = false): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return fallback;
  }
}
function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}
function readNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}
function writeNumber(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}
function clampInventoryHeight(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_INVENTORY_HEIGHT;
  return Math.max(MIN_INVENTORY_HEIGHT, Math.min(MAX_INVENTORY_HEIGHT, Math.round(n)));
}

export interface AlignmentPanelHandle {
  isDirty: () => boolean;
  // Returns true if committed synchronously, false if deferred behind the unalign
  // confirm. `afterCommit` runs only once the save actually lands (never on cancel).
  save: (afterCommit?: () => void) => boolean;
  reset: () => void;
  discard: () => void;
  // Union-relative positions of the group that owns `unionPos` in THIS panel's
  // grouping (empty when the position isn't aligned here). Lets a shared source
  // strip, which has no grouping, ask each panel which Hebrew belongs together.
  sourceGroupPositions: (unionPos: number) => number[];
}

interface Props {
  book: string;
  chapter: number;
  verseNum: number;
  bibleVersion: string;
  verse: VerseDto | null;
  sourceVerse: VerseDto | null;
  sourceLabel: string;
  twlForVerse: TwlRow[];
  // draftGeneration (#508): the generation of the crash-draft this save
  // captured (see alignmentDrafts.ts), so the caller can thread it through to
  // the outbox op for generation-gated cleanup on PATCH success.
  onSave: (
    newContent: unknown,
    plainText: string,
    expectedVersion: number,
    draftGeneration?: string,
  ) => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  // Confirm-before-save for an alignment edit that would leave a previously
  // aligned word bare. alignment_edit is exempt from the collateral-loss save
  // guard (re-aligning legitimately changes sources), so without this an
  // accidental unlink saves silently and only surfaces when the nightly export
  // refuses it. When provided and a save would unalign words, the panel calls
  // this with the affected words + a `commit` that performs the save; the parent
  // surfaces a confirm and runs `commit` only if the user proceeds. Absent ⇒ the
  // save commits straight through (preserves prior behavior for any caller that
  // doesn't wire the confirm).
  onConfirmUnalign?: (lostWords: string[], commit: () => void) => void;
  // Side-by-side mode (all optional; absent = standalone single-panel behavior).
  // When `hover`/`onHoverChange` are provided the hover state is controlled by a
  // shared parent so two panels cross-highlight the same Hebrew. Likewise
  // `hoverLink`/`onToggleHoverLink` let the parent keep both toolbars in sync.
  // `renderUhbStrip={false}` suppresses the per-panel source strip (the parent
  // renders one shared strip). `onOpenDual` adds a "Side-by-side" action.
  hover?: HoverHighlight;
  onHoverChange?: (h: HoverHighlight) => void;
  hoverLink?: boolean;
  onToggleHoverLink?: () => void;
  renderUhbStrip?: boolean;
  onOpenDual?: () => void;
  // Restore a previously-saved version of this verse (content tree, alignment
  // included). When present, the action bar shows a version-history button that
  // opens the same dialog as rows mode. Absent ⇒ no history button (e.g. the
  // side-by-side panels, whose lifecycle/saves are parent-owned).
  onRestoreVersion?: (content: unknown, plainText: string | null) => void;
  // Hide the panel's own Cancel button. In side-by-side mode the panel's
  // lifecycle is owned by the parent (one shared close + dirty gate); the
  // per-panel Cancel would call handleReset() before that gate runs, wiping
  // this side's edits so a later "Save" can't recover them.
  hideCancel?: boolean;
  // When false, Hebrew source words don't show their lexical tooltip on hover.
  showSourceInfo?: boolean;
  // Offset of this panel's first source token within the side-by-side
  // aligner's union source span. Hover positions travel union-relative so the
  // shared strip and the opposite panel agree on which Hebrew token is meant
  // even when the two versions cover different verse ranges. 0 standalone.
  posOffset?: number;
}

const VerseHistoryDialog = lazy(() =>
  import("./VerseHistoryDialog").then((m) => ({ default: m.VerseHistoryDialog })),
);

export const AlignmentPanel = forwardRef<AlignmentPanelHandle, Props>(
  function AlignmentPanel(
    {
      book,
      chapter,
      verse,
      verseNum,
      bibleVersion,
      sourceVerse,
      sourceLabel,
      twlForVerse,
      onSave,
      onCancel,
      onDirtyChange,
      onConfirmUnalign,
      hover: hoverProp,
      onHoverChange,
      hoverLink: hoverLinkProp,
      onToggleHoverLink,
      renderUhbStrip = true,
      onOpenDual,
      onRestoreVersion,
      hideCancel = false,
      showSourceInfo = true,
      posOffset = 0,
    },
    ref,
  ) {
    const [historyOpen, setHistoryOpen] = useState(false);
    // Extracted so the crash-draft hydration effect re-parses against the same
    // source tree computedInitial uses (parse needs the UHB/UGNT to re-anchor
    // milestones).
    const sourceVerseObjects = useMemo<unknown[] | null>(() => {
      return sourceVerse?.content &&
        Array.isArray((sourceVerse.content as { verseObjects?: unknown[] }).verseObjects)
        ? (sourceVerse.content as { verseObjects: unknown[] }).verseObjects
        : null;
    }, [sourceVerse]);
    const computedInitial = useMemo<AlignmentState | null>(() => {
      if (!verse?.content) return null;
      const verseObjects = (verse.content as { verseObjects?: unknown[] }).verseObjects;
      if (!Array.isArray(verseObjects)) return null;
      return parseAlignment(verseObjects, sourceVerseObjects);
    }, [verse, sourceVerseObjects]);

    const [initial, setInitial] = useState<AlignmentState | null>(computedInitial);
    const [state, setState] = useState<AlignmentState | null>(computedInitial);
    // Latest committed `state`, mirrored for the async crash-draft hydration:
    // the IDB read resolves after the panel has rendered, and the user may have
    // already dragged in that window — the hydration guards on this ref so a
    // restore never clobbers a fresh edit (see the reset/hydration effect).
    const stateRef = useRef(state);
    useEffect(() => {
      stateRef.current = state;
    });
    // (target key, verse.content) the panel last synced `initial`/`state` to.
    // Lets the reset effect tell a version-only bump (our own save
    // round-tripping through the outbox: V -> V+1, same bytes) apart from a
    // genuine content change (a foreign edit, a different verse) — see #488.
    // `sourceContent` tracks the UHB/UGNT source verse alongside the target so
    // a source reimport (isVersionOnlyRebase in alignmentDelta.ts) is never
    // mistaken for a version-only bump either — see #508. Starts null so the
    // very first run (mount / crash-recovery load) always takes the
    // full-reset path, same as before this fix.
    const lastSyncRef = useRef<{ key: string; content: unknown; sourceContent: unknown } | null>(
      null,
    );
    // The generation (see alignmentDrafts.ts) of the most recently PERSISTED
    // crash-draft for the CURRENT dirty session, or undefined if nothing has
    // been persisted yet (e.g. Save fires before the 400ms debounce below
    // ever writes one). Captured by handleSave and threaded through the
    // outbox op so the eventual PATCH success only clears that exact
    // generation — never a newer draft written by continued dragging after
    // Save (#508). Reset to undefined whenever the panel resyncs to a
    // genuinely different target/content or the user explicitly discards.
    const lastDraftGenerationRef = useRef<string | undefined>(undefined);
    const [selectedUnaligned, setSelectedUnaligned] = useState<Set<string>>(new Set());
    const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
    const [showOnlyUnaligned, setShowOnlyUnaligned] = useState(false);
    const [hideUhbStrip, setHideUhbStrip] = useState<boolean>(() => readFlag(LS_HIDE_UHB));
    const [colorize, setColorize] = useState<boolean>(() => readFlag(LS_COLORIZE));
    // hover + hoverLink are controlled when the side-by-side parent passes them
    // in; otherwise they're local (standalone single-panel behavior unchanged).
    const [localHoverLink, setLocalHoverLink] = useState<boolean>(() => readFlag(LS_HOVERLINK));
    const hoverLink = hoverLinkProp !== undefined ? hoverLinkProp : localHoverLink;
    const [localHover, setLocalHover] = useState<HoverHighlight>(null);
    const hover = hoverProp !== undefined ? hoverProp : localHover;
    const setHover: (h: HoverHighlight) => void = onHoverChange ?? setLocalHover;
    // Session-scoped ghost rejections (keyed by dismissedGhostKey). Suppresses a
    // suggestion the user dismissed via the chip's × so it can't immediately
    // regenerate on the next render — the "predicted alignment" circle fix.
    const [dismissedGhosts, setDismissedGhosts] = useState<Set<string>>(new Set());
    // Whole-card merge: the group id currently being dragged by its grip
    // (drives merge-target highlighting), plus a one-tap-undo snapshot of the
    // state from just before the last merge.
    const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
    const [mergeUndo, setMergeUndo] = useState<AlignmentState | null>(null);
    // Set true when this mount restored a crash-saved draft (see the hydration
    // effect) so the user gets a non-blocking "restored unsaved alignment"
    // notice. Cleared on the next verse reset.
    const [restored, setRestored] = useState(false);

    const toggleHideUhbStrip = () => {
      setHideUhbStrip((cur) => {
        const next = !cur;
        writeFlag(LS_HIDE_UHB, next);
        return next;
      });
    };
    const toggleColorize = () => {
      setColorize((cur) => {
        const next = !cur;
        writeFlag(LS_COLORIZE, next);
        return next;
      });
    };
    const toggleHoverLink = () => {
      if (onToggleHoverLink) {
        onToggleHoverLink();
        return;
      }
      setLocalHoverLink((cur) => {
        const next = !cur;
        writeFlag(LS_HOVERLINK, next);
        if (!next) setHover(null);
        return next;
      });
    };

    // Sync to upstream verse changes (find/replace, version swap, etc.). On a
    // genuine content change, in-memory drag state is dropped from React
    // state here; but if a crash-saved draft exists for this verse it is
    // re-hydrated below, so an unsaved edit survives a reload/crash (and a
    // normal navigation-away that wasn't saved or discarded) rather than
    // being silently lost.
    //
    // #488: that full reset is also what used to fire when the panel's OWN save
    // round-trips through the outbox — Shell applies an optimistic VerseDto,
    // then useChapter's onOutboxResult applies the server-confirmed row
    // (same content, version+1, new object identity). Both re-arrivals carry
    // byte-identical content, so wiping `state` here would silently discard
    // any drags the user made in the seconds/minutes between clicking Save
    // and the PATCH landing — and if a crash-draft picked those up, the
    // hydration guard below would then read it, see the draft's
    // `expectedVersion` (the pre-save version) doesn't match the now-bumped
    // `verse.version`, and delete the very draft that would have recovered
    // them. `lastSyncRef` tracks (target, content, sourceContent) the panel
    // last synced to so a same-target/same-content/same-source re-arrival is
    // treated as a REBASE (rebase `initial`, and `state` too if the panel
    // wasn't mid-drag) rather than a foreign change — leaving in-flight drags
    // and their crash-draft alone. A target content change, a SOURCE content
    // change (#508 — a UHB/UGNT reimport landing under pending drags), or a
    // different verse target all still take the full reset path below.
    useEffect(() => {
      const targetKey = `${book}|${chapter}|${verseNum}|${bibleVersion}`;
      const currentSourceContent = sourceVerseObjects;
      const isRebase =
        lastSyncRef.current !== null &&
        lastSyncRef.current.key === targetKey &&
        verse != null &&
        isVersionOnlyRebase(lastSyncRef.current, {
          content: verse.content,
          sourceContent: currentSourceContent,
        });

      if (isRebase) {
        // Same verse/version target, content AND source unchanged from what
        // the panel already synced to — a version-only bump. Rebase the
        // baseline: if the panel wasn't mid-drag (state === initial, not
        // dirty), carry `state` along too so it stays not-dirty; if the user
        // kept aligning after Save, leave `state` untouched so those drags
        // (and the crash-draft persist effect tracking them) survive. `dirty`
        // is pure reference identity (`state !== initial`), so either branch
        // keeps it reporting the truth.
        if (stateRef.current === initial) setState(computedInitial);
        setInitial(computedInitial);
        lastSyncRef.current = { key: targetKey, content: verse.content, sourceContent: currentSourceContent };
        return;
      }

      setInitial(computedInitial);
      setState(computedInitial);
      setSelectedUnaligned(new Set());
      setSelectionAnchor(null);
      setMergeUndo(null);
      setDraggingGroupId(null);
      setRestored(false);
      // A genuine reset (not a rebase) also invalidates whatever crash-draft
      // generation this panel was tracking — see lastDraftGenerationRef's doc
      // comment. The persist effect below will mint a fresh one on the next
      // drag against this new baseline.
      lastDraftGenerationRef.current = undefined;
      lastSyncRef.current =
        verse != null ? { key: targetKey, content: verse.content, sourceContent: currentSourceContent } : null;

      if (!computedInitial || !verse) return;
      // Attempt to restore a crash-saved alignment draft (Fix C — a browser
      // crash can't be caught by the beforeunload guard, so in-progress
      // drags are persisted per-change to alignmentDrafts). The reset above
      // runs synchronously to computedInitial; the draft load is async, so
      // its setState resolves AFTER and wins — that is deliberate. Three
      // guards: (1) the draft's version must still match the current base
      // (otherwise the base changed under it — another tab's save, a
      // reimport — and applying it would clobber newer content; a
      // mismatched draft is discarded — this branch only runs on a genuine
      // content change per the isRebase gate above, so that's the correct
      // call here); (2) the user must not have started editing in the
      // async-read window (stateRef still === computedInitial) so a restore
      // never overwrites a fresh drag; (3) the `cancelled` flag drops a
      // resolution whose verse changed again. `initial` stays computedInitial
      // so the restored state reads as dirty (state !== initial) and can be
      // saved or reset.
      const draftKey = alignmentDraftKey(book, chapter, verseNum, bibleVersion);
      const baseVersion = verse.version;
      let cancelled = false;
      void alignmentDrafts.get(draftKey).then((rec) => {
        if (cancelled || !rec) return;
        if (rec.expectedVersion !== baseVersion) {
          void alignmentDrafts.clear(draftKey);
          return;
        }
        // The user dragged during the async read — keep their edit; the persist
        // effect will overwrite the draft with it. Don't restore over it.
        if (stateRef.current !== computedInitial) return;
        const vo = (rec.content as { verseObjects?: unknown[] }).verseObjects;
        if (!Array.isArray(vo)) return;
        setState(parseAlignment(vo, sourceVerseObjects));
        setRestored(true);
      });
      return () => {
        cancelled = true;
      };
    }, [computedInitial, verse, book, chapter, verseNum, bibleVersion, sourceVerseObjects]);

    // Dismissals are per (verse, version) and only for this session — reset when
    // the user navigates to a different verse / edits a different bible, but NOT
    // on same-verse re-sync after a save (computedInitial churns then; the
    // coordinate doesn't), so rejected ghosts stay rejected across a save.
    useEffect(() => {
      setDismissedGhosts(new Set());
    }, [verseNum, bibleVersion]);

    const dirty = state !== initial && state !== null;
    useEffect(() => {
      onDirtyChange?.(dirty);
    }, [dirty, onDirtyChange]);

    // Fix C — persist in-progress drags to IndexedDB so a browser crash (which
    // beforeunload can't intercept) doesn't lose them. Debounced so a burst of
    // drags coalesces into one write. Only writes while dirty; a non-dirty
    // state means the panel is at baseline or was just reset, and the draft is
    // cleared explicitly on save/reset (never here) so navigating INTO a verse
    // that has a persisted draft doesn't wipe it before hydration reads it.
    useEffect(() => {
      if (!dirty || !state || !verse) return;
      const key = alignmentDraftKey(book, chapter, verseNum, bibleVersion);
      const baseVersion = verse.version;
      const t = setTimeout(() => {
        const content = { verseObjects: serializeAlignment(state) };
        void alignmentDrafts.set(key, content, baseVersion).then((generation) => {
          lastDraftGenerationRef.current = generation;
        });
      }, 400);
      return () => clearTimeout(t);
    }, [state, dirty, verse, book, chapter, verseNum, bibleVersion]);

    const handleTargetsDrop = (dest: string, wordIds: string[]) => {
      if (!state || wordIds.length === 0) return;
      setState(moveTargets(state, wordIds, dest));
      setSelectedUnaligned(new Set());
      setSelectionAnchor(null);
    };
    const handleSourceDrop = (destGroupId: string, sourceId: string) => {
      if (!state) return;
      // The drop target is a DISPLAY card, which may have collapsed several
      // state groups sharing a source position (occ 1/2 + 2/2 over-count → one
      // physical token, see displayGroups/mergeSamePositionGroups). Add the
      // word to EVERY group the card fused — by sourceKey OR position, the same
      // identity handleClearGroup uses — so the card stays one card instead of
      // splitting the hidden siblings back out (ZEC 10:2 UST duplicate-teraphim).
      const target = state.groups.find((g) => g.id === destGroupId);
      if (!target) return;
      const key = sourceKey(target);
      const posKey = groupPositionKey(target, sourceIndexMap);
      const destGroupIds = [
        destGroupId,
        ...state.groups
          .filter(
            (g) =>
              g.id !== destGroupId &&
              (sourceKey(g) === key ||
                (posKey !== null && groupPositionKey(g, sourceIndexMap) === posKey)),
          )
          .map((g) => g.id),
      ];
      setState(
        moveSourceToGroups(state, sourceId, destGroupIds, (s) =>
          resolveSourcePos(s, sourceIndexMap),
        ),
      );
    };
    const handleExtractSource = (sourceId: string) => {
      if (!state) return;
      setState(extractSource(state, sourceId));
    };
    // Resolve a DISPLAY card id back to EVERY state group it collapsed — by
    // sourceKey OR source position, the same identity handleClearGroup /
    // handleSourceDrop use. A card fuses groups by source identity
    // (mergeAdjacentSameSource) AND by position (mergeSamePositionGroups → the
    // occ 1/2 + 2/2 over-count), so the carried id alone under-counts it.
    // Shared logic lives in alignmentHover.ts's groupsForCard so the census
    // script (scripts/scan-reused-token-visibility.mjs) can reuse it.
    const groupsForCard = (cardId: string): string[] => {
      if (!state) return [cardId];
      return groupsForCardId(state.groups, cardId, sourceIndexMap);
    };
    // Merge a whole card (the dragged group) into the card it was dropped on.
    // survivor = the earlier-positioned of the two, so the combined Hebrew
    // chain reads in verse order regardless of drag direction. Each side may be
    // a position-fused card standing for several state groups (see
    // mergeGroupsToGroups), so resolve both to all their underlying groups.
    const handleMergeGroups = (dropTargetId: string, draggedId: string) => {
      if (!state || dropTargetId === draggedId) return;
      const order = displayGroups.map((g) => g.id);
      const ti = order.indexOf(dropTargetId);
      const di = order.indexOf(draggedId);
      const [survivor, eaten] =
        ti !== -1 && di !== -1 && di < ti
          ? [draggedId, dropTargetId]
          : [dropTargetId, draggedId];
      const next = mergeGroupsToGroups(
        state,
        groupsForCard(survivor),
        groupsForCard(eaten),
        (s) => resolveSourcePos(s, sourceIndexMap),
      );
      if (next === state) return;
      setMergeUndo(state);
      setState(next);
      setDraggingGroupId(null);
      setSelectedUnaligned(new Set());
      setSelectionAnchor(null);
    };
    const handleUndoMerge = () => {
      if (!mergeUndo) return;
      setState(mergeUndo);
      setMergeUndo(null);
    };
    const handleClearGroup = (groupId: string) => {
      if (!state) return;
      const target = state.groups.find((g) => g.id === groupId);
      if (!target) return;
      // Clear EVERY underlying group the displayed card collapsed together, not
      // just the one whose id the card carries. A card fuses groups by source
      // identity (mergeAdjacentSameSource → sourceKey) AND by source position
      // (mergeSamePositionGroups → positionKey); an AI over-count (occ 1/2 +
      // 2/2 → one physical token) hides a second group under a DIFFERENT
      // sourceKey, so clearing by sourceKey alone left its targets aligned.
      const key = sourceKey(target);
      const posKey = groupPositionKey(target, sourceIndexMap);
      let next = state;
      for (const g of state.groups) {
        if (sourceKey(g) === key || (posKey !== null && groupPositionKey(g, sourceIndexMap) === posKey)) {
          next = clearGroup(next, g.id);
        }
      }
      setState(next);
    };
    const handleClearSelection = () => {
      setSelectedUnaligned(new Set());
      setSelectionAnchor(null);
    };
    const handleChipClick = (id: string, shift: boolean) => {
      if (!state) return;
      if (shift && selectionAnchor) {
        const all = state.unaligned.map((w) => w.id);
        const a = all.indexOf(selectionAnchor);
        const b = all.indexOf(id);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          const range = all.slice(lo, hi + 1);
          setSelectedUnaligned((prev) => {
            const next = new Set(prev);
            for (const w of range) next.add(w);
            return next;
          });
          return;
        }
      }
      setSelectedUnaligned((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setSelectionAnchor(id);
    };
    const idsForUnalignedDrag = (id: string) =>
      selectedUnaligned.has(id) && selectedUnaligned.size > 1
        ? Array.from(selectedUnaligned)
        : [id];

    const themeMode = useTheme().palette.mode;

    // Per-(text|occurrence) hue assignment for the "match instances by
    // color" toggle. Same lemma → distinct hues spaced around the OKLCH
    // wheel; chips with a single occurrence get no entry. Stream order
    // anchors left-to-right hue progression within each duplicate group.
    const matchHues = useMemo(() => {
      if (!state) return new Map<string, number>();
      const items: Array<{ key: string; lemma: string }> = [];
      for (const item of state.stream) {
        if (item.kind !== "word") continue;
        const w = item.word;
        const n = parseInt(w.occurrences, 10);
        if (!Number.isFinite(n) || n <= 1) continue;
        items.push({ key: `${w.text}|${w.occurrence}`, lemma: w.text });
      }
      return assignChipHues(items);
    }, [state]);

    // Map Hebrew tokens to alignment groups by source-token POSITION.
    // `strong|occurrence` is NOT unique: occurrence numbers the exact surface
    // text (cantillation included), so same-Strong words with different
    // pointing all carry occurrence 1 (three אֶל forms in ZEC 1:3 are each
    // H0413|1 — 236 such collisions across ZEC) and the strong-keyed map lit
    // the wrong word. Each group source word resolves to a position via the
    // same text→strong fallback chain displayGroups sorts by; the strip's
    // tokens carry their walk position natively. Positions in `hover` are
    // union-relative (see highlightTypes.ts); these maps are own-relative and
    // translate via posOffset at the comparison sites.
    const sourceIndexMap = useMemo(() => buildSourceIndexMap(sourceVerse), [sourceVerse]);

    // Display groups, the id/position hover maps, and the two highlight
    // resolvers all live in ../lib/alignmentHover — pure, and unit-tested there
    // (alignmentHover.test.mjs). The comments explaining WHY each map is derived
    // the way it is live with the code, not here.
    const displayGroups = useMemo(
      () => buildDisplayGroups(state, sourceIndexMap),
      [state, sourceIndexMap],
    );

    const targetIdToGroupId = useMemo(() => buildTargetIdToGroupId(displayGroups), [displayGroups]);

    const posMaps = useMemo(
      () => buildPosMaps(state, displayGroups, sourceIndexMap),
      [state, displayGroups, sourceIndexMap],
    );

    const hoverCtx = useMemo<HoverCtx>(
      () => ({ hoverLink, bibleVersion, targetIdToGroupId, posMaps, posOffset }),
      [hoverLink, bibleVersion, targetIdToGroupId, posMaps, posOffset],
    );

    // Hover handlers. They no-op when hoverLink is off so the chips can fire
    // them unconditionally; the payloads themselves are built in alignmentHover.
    const onEnglishHover = useCallback(
      (wordId: string, text: string, occurrence: string, groupIdOverride?: string) => {
        if (!hoverLink) return;
        setHover(makeEnglishHover(hoverCtx, wordId, text, occurrence, groupIdOverride));
      },
      [hoverLink, hoverCtx, setHover],
    );
    const onHebrewHover = useCallback(
      (pos: number, groupIdOverride?: string) => {
        if (!hoverLink) return;
        if (pos < 0 && !groupIdOverride) return;
        setHover(makeHebrewHover(hoverCtx, pos, groupIdOverride));
      },
      [hoverLink, hoverCtx, setHover],
    );
    const onHoverLeave = useCallback(() => {
      setHover(null);
    }, [setHover]);

    const englishHighlight = useCallback(
      (wordId: string, text: string, occurrence: string, groupIdOverride?: string) =>
        resolveEnglishHighlight(hoverCtx, hover, wordId, text, occurrence, groupIdOverride),
      [hoverCtx, hover],
    );
    const hebrewHighlight = useCallback(
      (pos: number, groupIdOverride?: string) =>
        resolveHebrewHighlight(hoverCtx, hover, pos, groupIdOverride),
      [hoverCtx, hover],
    );

    const hctx: HighlightCtx = useMemo(
      () => ({
        colorize,
        hoverLink,
        showSourceInfo,
        matchHues,
        themeMode,
        onEnglishEnter: onEnglishHover,
        onHebrewEnter: onHebrewHover,
        onLeave: onHoverLeave,
        englishHighlight,
        hebrewHighlight,
      }),
      [
        colorize,
        hoverLink,
        showSourceInfo,
        matchHues,
        themeMode,
        onEnglishHover,
        onHebrewHover,
        onHoverLeave,
        englishHighlight,
        hebrewHighlight,
      ],
    );

    const allStrongs = useMemo(() => {
      const strongs = new Set<string>();
      const keys = new Set<string>(); // "<strong>~<morphClass>" suggestion keys
      const add = (strong: string, morph: string | undefined) => {
        if (!strong) return;
        strongs.add(strong);
        keys.add(suggestKey(strong, morph));
      };
      if (state) {
        for (const g of state.groups) for (const s of g.source) add(s.strong, s.morph);
      }
      const sourceObjects = (sourceVerse?.content as { verseObjects?: unknown[] } | null)
        ?.verseObjects;
      if (Array.isArray(sourceObjects)) {
        const walk = (nodes: unknown[]) => {
          for (const n of nodes ?? []) {
            const o = n as Record<string, unknown> | null;
            if (!o) continue;
            if (o["type"] === "word" && o["tag"] === "w") {
              add(String(o["strong"] ?? ""), o["morph"] as string | undefined);
            } else if (o["type"] === "milestone") {
              walk((o["children"] as unknown[] | undefined) ?? []);
            }
          }
        };
        walk(sourceObjects);
      }
      return { strongs: [...strongs], keys: [...keys] };
    }, [state, sourceVerse]);
    const lexiconMap = useLexicon(allStrongs.strongs);

    // Non-AI alignment suggestions over the canonical corpus (see hook). The
    // source-strong set is stable across alignment edits within a verse, so
    // this fetches once per verse; ghostByGroup is recomputed locally as words
    // get aligned. Ghosts only appear on still-empty groups.
    const suggestions = useAlignmentSuggestions(bibleVersion, allStrongs.keys);
    // Document-order word tokens with their aligned state — phrase ghosts need
    // adjacency, so this is the basis for the contiguous-run match.
    const streamWords = useMemo<StreamWord[]>(
      () =>
        state
          ? state.stream.flatMap((it) =>
              it.kind === "word"
                ? [{ id: it.word.id, text: it.word.text, aligned: it.alignedTo !== null }]
                : [],
            )
          : [],
      [state],
    );
    const ghostByGroup = useMemo(
      () => computeGhosts(displayGroups, streamWords, suggestions, dismissedGhosts),
      [displayGroups, streamWords, suggestions, dismissedGhosts],
    );
    const handleAcceptGhost = (groupId: string, wordIds: string[]) => {
      handleTargetsDrop(`g:${groupId}`, wordIds);
    };
    const handleDismissGhost = (ghost: Ghost) => {
      const g = displayGroups.find((x) => x.id === ghost.groupId);
      if (!g) return;
      const key = dismissedGhostKey(g, ghost.text);
      setDismissedGhosts((prev) => {
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        return next;
      });
    };
    const handleAcceptAllGhosts = () => {
      if (!state || ghostByGroup.size === 0) return;
      let next = state;
      for (const gh of ghostByGroup.values()) {
        next = moveTargets(next, gh.wordIds, `g:${gh.groupId}`);
      }
      setState(next);
      setSelectedUnaligned(new Set());
      setSelectionAnchor(null);
    };

    const handleReset = useCallback(() => {
      setState(initial);
      setSelectedUnaligned(new Set());
      setSelectionAnchor(null);
      setRestored(false);
      // Explicit discard of unsaved work — drop the crash-draft too so it can't
      // rehydrate on reopen, and forget its generation (there is nothing left
      // for a landed save to reconcile against).
      void alignmentDrafts.clear(alignmentDraftKey(book, chapter, verseNum, bibleVersion));
      lastDraftGenerationRef.current = undefined;
    }, [initial, book, chapter, verseNum, bibleVersion]);
    const handleClearAll = () => {
      if (!state) return;
      setState(clearAll(state));
      setSelectedUnaligned(new Set());
      setSelectionAnchor(null);
    };
    // Returns true if the save COMMITTED synchronously, false if it was deferred
    // behind the unalign confirm. `afterCommit` runs once the save actually lands
    // — immediately on a clean save, or after "Save anyway"; it never runs if the
    // user cancels. Callers that navigate/close after saving (the dirty gates in
    // Shell) pass the nav as `afterCommit` so it waits for the real commit instead
    // of firing while the confirm is still open.
    const handleSave = useCallback((afterCommit?: () => void): boolean => {
      if (!state || !verse) {
        afterCommit?.();
        return true;
      }
      const newVerseObjects = serializeAlignment(state);
      const newContent = { verseObjects: newVerseObjects };
      const plain = alignmentPlainText(state);
      // The commit closure captures `state`, so when it runs after a confirm the
      // optimistic baseline reset still uses the state that was saved.
      const commit = () => {
        // Capture the generation of whatever pre-save draft this commit
        // represents (undefined if the 400ms debounce never got to persist
        // one) and thread it through the outbox op — see
        // lastDraftGenerationRef's doc comment and alignmentDrafts.ts's
        // onOutboxResult listener (#508).
        onSave(newContent, plain, verse.version, lastDraftGenerationRef.current);
        // Optimistic: the freshly-saved state is now the baseline. When the
        // chapter cache eventually round-trips the new content, computedInitial
        // recomputes and the useEffect resets state to it (idempotent).
        setInitial(state);
        setRestored(false);
        // The alignment is now queued in the outbox; drop the crash-draft
        // immediately. onOutboxResult also clears it when the PATCH lands
        // (belt-and-suspenders in alignmentDrafts.ts) — generation-gated, so a
        // draft written by continued dragging AFTER this point (a newer
        // generation) survives both this clear and that later one.
        void alignmentDrafts.clear(alignmentDraftKey(book, chapter, verseNum, bibleVersion));
        lastDraftGenerationRef.current = undefined;
        afterCommit?.();
      };
      // Warn before unaligning a previously-aligned word. On "Cancel" the parent
      // runs nothing, so `commit` (and thus setInitial + afterCommit) never fires
      // and the panel stays dirty — the user can re-align and save again.
      const lostWords = lostAlignedWords(verse.content, newContent);
      if (lostWords.length > 0 && onConfirmUnalign) {
        onConfirmUnalign(lostWords, commit);
        return false;
      }
      commit();
      return true;
    }, [state, verse, onSave, onConfirmUnalign, book, chapter, verseNum, bibleVersion]);

    // Same two maps hebrewHighlight/onEnglishHover use, in the same roles:
    // posOwners (display-derived) says which CARD(s) own the position, and
    // groupPositions (state-derived) gives each of those groups' full union —
    // including a source word stripCompoundOverlaps removed from the rendered
    // chain, which must still bridge on hover. Positions travel union-relative.
    //
    // EVERY owner contributes, not just the first: a reused source token sits on
    // a standalone card AND a compound card at once (see buildPositionOwners /
    // AMO 3:7), and answering with only the first owner's union would reproduce
    // on the shared strip exactly the first-wins blindness the cards no longer
    // have — the strip would light one card's siblings and not the other's.
    //
    // KNOWN AND DELIBERATE: mixing the two derivations means the strip can light
    // a token no card lights. ZEC 2:8 UST (state group כִּי+כֹה+אָמַר) was the
    // measured example of this until stripCompoundOverlaps started exempting
    // flagged reused tokens from the strip via `protectedIds` — אָמַר there is a
    // flagged reused token, so it is now protected and is NOT stripped, and the
    // cards and strip agree on that verse. The mechanism itself (a stripped
    // compound's strip-vs-card disagreement) is unchanged for any UNFLAGGED
    // overlap; only the specific example moved. Do NOT "fix" this
    // by making the union display-derived. Two reasons: it would sever the
    // #410 bridge (a source word stripped from a rendered chain is still bound to
    // its group and must still light), and the shared strip's ENGLISH-hover path
    // already lights this same state-derived union on these same tokens
    // (makeEnglishHover reads groupPositions), so a display-derived Hebrew path
    // would make the strip disagree with itself depending on hover direction.
    // The strip reports "these tokens are bound together in the data"; the cards
    // report "this is what I render". On a flagged verse those genuinely differ,
    // and that difference IS the defect the red marker is pointing at.
    const sourceGroupPositions = useCallback(
      (unionPos: number): number[] => {
        const gids = posMaps.posOwners.get(unionPos - posOffset);
        if (!gids || gids.size === 0) return [];
        const out = new Set<number>();
        for (const gid of gids) {
          for (const p of posMaps.groupPositions.get(gid) ?? []) out.add(p + posOffset);
        }
        return [...out];
      },
      [posMaps, posOffset],
    );

    useImperativeHandle(
      ref,
      () => ({
        isDirty: () => dirty,
        save: handleSave,
        reset: handleReset,
        discard: handleReset,
        sourceGroupPositions,
      }),
      [dirty, handleSave, handleReset, sourceGroupPositions],
    );


    return (
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          // Fill the remaining height of the flex-column parent (the resource
          // column below its tabs header, or a side-by-side panel wrapper)
          // rather than `height: 100%`, which overflowed by the header's height
          // in the single-panel mount and clipped the footer. minHeight: 0 lets
          // the inner cards area shrink and scroll on short viewports.
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          bgcolor: "background.paper",
        }}
      >
        {!state && (
          <Box sx={{ p: 3 }}>
            <Typography variant="body2" color="text.secondary">
              no alignment data for this verse — either the source has no `\zaln-s` markers,
              or the verse was recently edited and alignment was cleared.
            </Typography>
          </Box>
        )}
        {state && (
          <>
            {renderUhbStrip && (
              <UhbStrip
                sourceVerse={sourceVerse}
                sourceLabel={sourceLabel}
                lexiconMap={lexiconMap}
                twlForVerse={twlForVerse}
                verseNum={verseNum}
                hidden={hideUhbStrip}
                onToggleHidden={toggleHideUhbStrip}
                hctx={hctx}
              />
            )}
            <InventoryStrip
              state={state}
              bibleVersion={bibleVersion}
              selectedIds={selectedUnaligned}
              showOnlyUnaligned={showOnlyUnaligned}
              onToggleShowOnlyUnaligned={() => setShowOnlyUnaligned((v) => !v)}
              onChipClick={handleChipClick}
              idsForDrag={idsForUnalignedDrag}
              onClearSelection={handleClearSelection}
              onDrop={(ids) => handleTargetsDrop("u", ids)}
              colorize={colorize}
              hoverLink={hoverLink}
              onToggleColorize={toggleColorize}
              onToggleHoverLink={toggleHoverLink}
              hctx={hctx}
            />
            <SectionHeader count={displayGroups.length} />
            <Box
              sx={{
                flex: 1,
                // Allow this scroller to shrink below its content height so it
                // actually scrolls (and the footer stays visible) when the
                // strips above it leave little room on a short viewport.
                minHeight: 0,
                overflowY: "auto",
                px: 1.5,
                pb: 1.5,
              }}
            >
              <AlignmentCards
                groups={displayGroups}
                ghostByGroup={ghostByGroup}
                onAcceptGhost={handleAcceptGhost}
                onDismissGhost={handleDismissGhost}
                twlForVerse={twlForVerse}
                lexiconMap={lexiconMap}
                verseNum={verseNum}
                onTargetsDrop={handleTargetsDrop}
                onSourceDrop={handleSourceDrop}
                onExtractSource={handleExtractSource}
                onClearGroup={handleClearGroup}
                onMerge={handleMergeGroups}
                draggingGroupId={draggingGroupId}
                onGroupDragStart={setDraggingGroupId}
                onGroupDragEnd={() => setDraggingGroupId(null)}
                hctx={hctx}
                sourcePos={posMaps.sourcePosById}
                posOffset={posOffset}
                reusedSourceIds={posMaps.reusedSourceIds}
              />
            </Box>
            <ActionBar
              dirty={dirty}
              ghostCount={ghostByGroup.size}
              onAcceptAll={handleAcceptAllGhosts}
              onClear={handleClearAll}
              onReset={handleReset}
              onCancel={() => {
                handleReset();
                onCancel();
              }}
              hideCancel={hideCancel}
              onSave={handleSave}
              bibleVersion={bibleVersion}
              onOpenDual={onOpenDual}
              version={verse?.version}
              onOpenHistory={onRestoreVersion ? () => setHistoryOpen(true) : undefined}
            />
            <Snackbar
              open={mergeUndo !== null}
              autoHideDuration={6000}
              onClose={() => setMergeUndo(null)}
              anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
              message="merged groups"
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={handleUndoMerge}
                  sx={{ fontWeight: 700 }}
                >
                  UNDO
                </Button>
              }
            />
            <Snackbar
              open={restored}
              autoHideDuration={6000}
              onClose={() => setRestored(false)}
              anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
              message="restored unsaved alignment"
            />
          </>
        )}
        {historyOpen && verse && (
          <Suspense fallback={null}>
            <VerseHistoryDialog
              open={historyOpen}
              book={book}
              chapter={chapter}
              verseNum={verseNum}
              bibleVersion={bibleVersion}
              currentVersion={verse.version}
              onClose={() => setHistoryOpen(false)}
              onUseVersion={(content, plainText) => onRestoreVersion?.(content, plainText)}
            />
          </Suspense>
        )}
      </Box>
    );
  },
);

// ─── Inventory chip strip (aligned strikethrough + unaligned interactive) ──
function InventoryStrip({
  state,
  bibleVersion,
  selectedIds,
  showOnlyUnaligned,
  onToggleShowOnlyUnaligned,
  onChipClick,
  idsForDrag,
  onClearSelection,
  onDrop,
  colorize,
  hoverLink,
  onToggleColorize,
  onToggleHoverLink,
  hctx,
}: {
  state: AlignmentState;
  bibleVersion: string;
  selectedIds: Set<string>;
  showOnlyUnaligned: boolean;
  onToggleShowOnlyUnaligned: () => void;
  onChipClick: (id: string, shift: boolean) => void;
  idsForDrag: (id: string) => string[];
  onClearSelection: () => void;
  onDrop: (wordIds: string[]) => void;
  colorize: boolean;
  hoverLink: boolean;
  onToggleColorize: () => void;
  onToggleHoverLink: () => void;
  hctx: HighlightCtx;
}) {
  const [over, setOver] = useState(false);
  const [chipAreaHeight, setChipAreaHeight] = useState<number>(() =>
    clampInventoryHeight(readNumber(LS_INVENTORY_HEIGHT, DEFAULT_INVENTORY_HEIGHT)),
  );
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = chipAreaHeight;
      let last = startHeight;
      const onMove = (ev: MouseEvent) => {
        const next = clampInventoryHeight(startHeight + (ev.clientY - startY));
        last = next;
        setChipAreaHeight(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        writeNumber(LS_INVENTORY_HEIGHT, last);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
    },
    [chipAreaHeight],
  );
  const unalignedIds = new Set(state.unaligned.map((w) => w.id));
  const streamWords = state.stream.flatMap((item, idx) =>
    item.kind === "word" ? [{ idx, word: item.word, aligned: item.alignedTo !== null }] : [],
  );
  const visible = showOnlyUnaligned ? streamWords.filter((w) => !w.aligned) : streamWords;
  const unalignedCount = state.unaligned.length;
  return (
    <Box
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const ids = readWordIds(e.dataTransfer);
        const movable = ids.filter((id) => !unalignedIds.has(id));
        if (movable.length > 0) onDrop(movable);
      }}
      sx={{
        px: 2,
        pt: 1,
        pb: 1.25,
        bgcolor: over ? "primary.50" : "grey.100",
        flexShrink: 0,
        position: "relative",
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <Typography
          variant="caption"
          sx={{
            fontFamily: "monospace",
            fontSize: 10,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: "text.secondary",
            fontWeight: 600,
          }}
        >
          {bibleVersion} words
        </Typography>
        <Chip
          label={`${unalignedCount} unaligned`}
          size="small"
          sx={{
            height: 18,
            fontFamily: "monospace",
            fontSize: 10,
            bgcolor: unalignedCount > 0 ? "warning.light" : "primary.50",
            color: unalignedCount > 0 ? "warning.contrastText" : "primary.dark",
          }}
        />
        {selectedIds.size > 0 && (
          <>
            <Typography variant="caption" sx={{ color: "text.disabled", fontFamily: "monospace" }}>
              · {selectedIds.size} selected
            </Typography>
            <Tooltip title="clear selection">
              <IconButton size="small" onClick={onClearSelection} sx={{ p: 0.25 }}>
                <CloseIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          </>
        )}
        <Box sx={{ flex: 1 }} />
        <ToolbarToggle
          label="colors"
          checked={colorize}
          onChange={onToggleColorize}
          tooltip="tint each repeated word with a unique color so matching instances are easy to find"
        />
        <ToolbarToggle
          label="hover-link"
          checked={hoverLink}
          onChange={onToggleHoverLink}
          tooltip="hover any word to highlight its matches and aligned partner everywhere"
        />
        <Button
          size="small"
          variant="text"
          onClick={onToggleShowOnlyUnaligned}
          sx={{
            fontSize: 11,
            textTransform: "none",
            color: showOnlyUnaligned ? "primary.main" : "text.secondary",
            minWidth: 0,
            px: 0.75,
            py: 0.25,
          }}
        >
          {showOnlyUnaligned ? "show all" : "show only unaligned"}
        </Button>
      </Stack>
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          gap: 0.5,
          rowGap: 1.25,
          maxHeight: chipAreaHeight,
          overflowY: "auto",
          // Extra top padding so chip superscripts (`mt: -2px` in targetLabel)
          // aren't clipped by the strip's overflow region. Also small
          // horizontal padding so the hover-link box-shadow ring on edge
          // chips doesn't get cropped by overflow-x (auto-promoted by
          // overflow-y: auto).
          pt: 1.5,
          pb: 0.5,
          px: 0.5,
        }}
      >
        {visible.length === 0 && (
          <Typography variant="caption" sx={{ color: "text.disabled", fontStyle: "italic" }}>
            {showOnlyUnaligned ? "all words aligned" : "no words in verse"}
          </Typography>
        )}
        {visible.map(({ idx, word, aligned }) =>
          aligned ? (
            <AlignedChip
              key={`${word.text}|${word.occurrence}|${idx}`}
              wordId={word.id}
              text={word.text}
              occurrence={word.occurrence}
              occurrences={word.occurrences}
              hctx={hctx}
            />
          ) : (
            <SelectableChip
              key={`${word.text}|${word.occurrence}|${idx}`}
              wordId={word.id}
              text={word.text}
              occurrence={word.occurrence}
              occurrences={word.occurrences}
              selected={selectedIds.has(word.id)}
              onClick={(shift) => onChipClick(word.id, shift)}
              idsForDrag={() => idsForDrag(word.id)}
              hctx={hctx}
            />
          ),
        )}
      </Box>
      <Box
        onMouseDown={startResize}
        title="drag to resize"
        sx={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: -4,
          height: 8,
          cursor: "ns-resize",
          zIndex: 1,
          "&::after": {
            content: '""',
            position: "absolute",
            left: 0,
            right: 0,
            top: "50%",
            height: "1px",
            bgcolor: "divider",
            transform: "translateY(-50%)",
            transition: "background-color 0.15s, height 0.15s",
          },
          "&:hover::after, &:active::after": {
            bgcolor: "primary.main",
            height: "2px",
          },
        }}
      />
    </Box>
  );
}

// ─── Section header above cards ────────────────────────────────────────
function SectionHeader({ count }: { count: number }) {
  return (
    <Stack
      direction="row"
      alignItems="baseline"
      spacing={1}
      sx={{ px: 2, pt: 1.25, pb: 0.75, flexShrink: 0 }}
    >
      <Typography
        variant="caption"
        sx={{
          fontFamily: "monospace",
          fontSize: 10,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "text.secondary",
          fontWeight: 600,
        }}
      >
        Groups · {count}
      </Typography>
      <Box sx={{ flex: 1 }} />
      <Typography
        variant="caption"
        sx={{ color: "text.disabled", fontSize: 10.5 }}
      >
        drag chips · dbl-click Hebrew to split · dbl-click English to unalign
      </Typography>
    </Stack>
  );
}

// ─── Action bar ────────────────────────────────────────────────────────
function ActionBar({
  dirty,
  ghostCount,
  onAcceptAll,
  onClear,
  onReset,
  onCancel,
  hideCancel,
  onSave,
  bibleVersion,
  onOpenDual,
  version,
  onOpenHistory,
}: {
  dirty: boolean;
  ghostCount: number;
  onAcceptAll: () => void;
  onClear: () => void;
  onReset: () => void;
  onCancel: () => void;
  hideCancel?: boolean;
  onSave: () => void;
  bibleVersion: string;
  onOpenDual?: () => void;
  version?: number;
  onOpenHistory?: () => void;
}) {
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={0.5}
      useFlexGap
      flexWrap="wrap"
      sx={{
        px: 1.5,
        py: 1,
        rowGap: 0.5,
        borderTop: "1px solid",
        borderColor: "divider",
        bgcolor: "background.paper",
        flexShrink: 0,
      }}
    >
      <Typography
        variant="caption"
        sx={{ fontFamily: "monospace", color: "text.disabled", fontSize: 10 }}
      >
        editing {bibleVersion}
      </Typography>
      {/* Spacer keeps the actions right-aligned when the bar fits on one line;
          when it doesn't (narrow laptop screens), the actions wrap to a second
          row instead of the rightmost Save button overflowing off-screen. */}
      <Box sx={{ flex: 1, minWidth: 0 }} />
      {onOpenHistory && version != null && (
        <Tooltip title="version history — view or restore an earlier alignment">
          <Button
            size="small"
            startIcon={<HistoryIcon sx={{ fontSize: 16 }} />}
            onClick={onOpenHistory}
            sx={{
              textTransform: "none",
              fontSize: 11,
              mr: 0.5,
              color: "text.secondary",
              fontFamily: "monospace",
            }}
          >
            v{version}
          </Button>
        </Tooltip>
      )}
      {onOpenDual && (
        <Tooltip title="open ULT + UST side by side (aligned to the same Hebrew)">
          <Button
            size="small"
            onClick={onOpenDual}
            sx={{
              textTransform: "none",
              fontSize: 11,
              mr: 0.5,
              color: "text.secondary",
            }}
          >
            ⇄ Side-by-side
          </Button>
        </Tooltip>
      )}
      {ghostCount > 0 && (
        <Button
          size="small"
          variant="outlined"
          onClick={onAcceptAll}
          sx={{
            textTransform: "none",
            fontSize: 11,
            mr: 0.5,
            borderStyle: "dashed",
            color: "primary.main",
            borderColor: "primary.main",
          }}
        >
          ✓ accept {ghostCount} suggestion{ghostCount > 1 ? "s" : ""}
        </Button>
      )}
      <Button
        size="small"
        onClick={onClear}
        sx={{
          color: "error.main",
          textTransform: "uppercase",
          fontSize: 11,
          letterSpacing: "0.06em",
          fontWeight: 600,
        }}
      >
        Clear
      </Button>
      <Button
        size="small"
        onClick={onReset}
        disabled={!dirty}
        sx={{
          color: "text.secondary",
          textTransform: "uppercase",
          fontSize: 11,
          letterSpacing: "0.06em",
          fontWeight: 600,
        }}
      >
        Reset
      </Button>
      {!hideCancel && (
        <Button
          size="small"
          onClick={onCancel}
          sx={{
            color: "text.primary",
            textTransform: "uppercase",
            fontSize: 11,
            letterSpacing: "0.06em",
            fontWeight: 600,
          }}
        >
          Cancel
        </Button>
      )}
      <Button
        size="small"
        variant="contained"
        onClick={() => onSave()}
        disabled={!dirty}
        sx={{
          textTransform: "uppercase",
          fontSize: 11,
          letterSpacing: "0.06em",
          fontWeight: 700,
          px: 2,
        }}
      >
        Save {bibleVersion}
      </Button>
    </Stack>
  );
}

// ─── Cards grid (restyled) ─────────────────────────────────────────────
function AlignmentCards({
  groups,
  ghostByGroup,
  onAcceptGhost,
  onDismissGhost,
  twlForVerse,
  lexiconMap,
  verseNum,
  onTargetsDrop,
  onSourceDrop,
  onExtractSource,
  onClearGroup,
  onMerge,
  draggingGroupId,
  onGroupDragStart,
  onGroupDragEnd,
  hctx,
  sourcePos,
  posOffset,
  reusedSourceIds,
}: {
  groups: AlignmentGroup[];
  ghostByGroup: Map<string, Ghost>;
  onAcceptGhost: (groupId: string, wordIds: string[]) => void;
  onDismissGhost: (ghost: Ghost) => void;
  twlForVerse: TwlRow[];
  lexiconMap: Map<string, LexiconEntry | null>;
  verseNum: number;
  onTargetsDrop: (dest: string, wordIds: string[]) => void;
  onSourceDrop: (destGroupId: string, sourceId: string) => void;
  onExtractSource: (sourceId: string) => void;
  onClearGroup: (groupId: string) => void;
  onMerge: (dropTargetId: string, draggedId: string) => void;
  draggingGroupId: string | null;
  onGroupDragStart: (groupId: string) => void;
  onGroupDragEnd: () => void;
  hctx: HighlightCtx;
  // Source word id → own-relative token position (-1 unresolved), and the
  // union offset — for card keys and the position-keyed hover identity.
  sourcePos: Map<string, number>;
  posOffset: number;
  // Ids of source words claimed by 2+ distinct groups — a data defect (see
  // findReusedSourceWordIds in ../lib/alignment). Keyed by id, not position,
  // because chips resolve their own `pos` through the fallback chain.
  reusedSourceIds: Set<string>;
}) {
  // Precompute the per-verse TWL hint lookup once (see buildTwHintMap) so each
  // hover re-render isn't O(sourceWords × twlRows) of re-split + re-nfc work.
  const twHints = useMemo(
    () => buildTwHintMap(twlForVerse, verseNum),
    [twlForVerse, verseNum],
  );
  return (
    <Box
      sx={{
        display: "flex",
        flexWrap: "wrap",
        gap: 1,
        alignContent: "flex-start",
        // Card visual order follows Hebrew reading flow (RTL) — the cards
        // are sorted by source position by displayGroups, and RTL lays the
        // first card to the right.
        direction: "rtl",
        pt: 0.5,
      }}
    >
      {groups.map((g) => {
        const ghost = ghostByGroup.get(g.id);
        // Stable per-card React key derived from the source chain (see cardKey
        // in ../lib/alignment — a `p{pos}`-only key collided when one source
        // token was split-aligned to two target runs, piling up cards).
        const key = cardKey(g, sourcePos);
        return (
        <DropTargetCard
          key={key}
          groupId={g.id}
          onTargetsDrop={(wordIds) => onTargetsDrop(`g:${g.id}`, wordIds)}
          onSourceDrop={(sourceId) => onSourceDrop(g.id, sourceId)}
          onMerge={(draggedId) => onMerge(g.id, draggedId)}
          draggingGroupId={draggingGroupId}
          onGroupDragStart={onGroupDragStart}
          onGroupDragEnd={onGroupDragEnd}
        >
          <Box
            dir="rtl"
            sx={{
              display: "flex",
              flexWrap: "wrap",
              gap: 0.25,
              alignItems: "baseline",
              // Reserves room for the absolute-positioned × in the top-right
              // corner so a tall Hebrew word doesn't tuck under it.
              pl: 2.5,
              mb: 0.5,
            }}
          >
            {g.source.map((s) => {
              const own = sourcePos.get(s.id) ?? -1;
              return (
                <SourceWordTypography
                  key={s.id}
                  source={s}
                  pos={own >= 0 ? own + posOffset : -1}
                  groupId={g.id}
                  lex={lexiconMap.get(s.strong) ?? null}
                  twHint={twHintFromMap(twHints, s.content ?? "")}
                  canExtract={g.source.length > 1}
                  onExtract={() => onExtractSource(s.id)}
                  hctx={hctx}
                  reused={reusedSourceIds.has(s.id)}
                />
              );
            })}
          </Box>
          {(g.targets.length > 0 || g.source.length > 1) && (
            <Tooltip title="clear this group (send English back to the word bank, split compound source)">
              <IconButton
                size="small"
                onClick={() => onClearGroup(g.id)}
                sx={{
                  p: 0.25,
                  color: "text.disabled",
                  "&:hover": { color: "error.main" },
                  position: "absolute",
                  top: 4,
                  // Top-left so it never sits on top of a Hebrew word's
                  // superscript-occurrence indicator (which lives on the
                  // upper-right of each RTL character).
                  left: 4,
                }}
              >
                <CloseIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          )}
          <Stack direction="row" spacing={0.5} flexWrap="wrap" rowGap={0.5} sx={{ direction: "ltr" }}>
            {g.targets.length === 0 ? (
              ghost ? (
                <GhostChip
                  ghost={ghost}
                  onAccept={() => onAcceptGhost(ghost.groupId, ghost.wordIds)}
                  onDismiss={() => onDismissGhost(ghost)}
                />
              ) : (
                <Box
                  sx={{
                    width: "100%",
                    border: "1px dashed",
                    borderColor: "divider",
                    borderRadius: 1,
                    py: 0.5,
                    px: 1,
                    fontSize: 11.5,
                    color: "text.disabled",
                    fontStyle: "italic",
                    textAlign: "center",
                  }}
                >
                  drop English here
                </Box>
              )
            ) : (
              g.targets.map((t, ti) => (
                <SimpleDraggableChip
                  key={`${t.text}|${t.occurrence}|${ti}`}
                  wordId={t.id}
                  text={t.text}
                  occurrence={t.occurrence}
                  occurrences={t.occurrences}
                  groupId={g.id}
                  onUnalign={() => onTargetsDrop("u", [t.id])}
                  hctx={hctx}
                />
              ))
            )}
          </Stack>
        </DropTargetCard>
        );
      })}
    </Box>
  );
}

function DropTargetCard({
  groupId,
  onTargetsDrop,
  onSourceDrop,
  onMerge,
  draggingGroupId,
  onGroupDragStart,
  onGroupDragEnd,
  children,
}: {
  groupId: string;
  onTargetsDrop: (wordIds: string[]) => void;
  onSourceDrop: (sourceId: string) => void;
  onMerge: (draggedGroupId: string) => void;
  draggingGroupId: string | null;
  onGroupDragStart: (groupId: string) => void;
  onGroupDragEnd: () => void;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  const isBeingDragged = draggingGroupId === groupId;
  const isMergeTarget = over && draggingGroupId !== null && !isBeingDragged;
  const showOver = over && !isMergeTarget && !isBeingDragged;
  return (
    <Paper
      elevation={0}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        // Whole-card merge takes priority: a dragged grip carries GROUP_ID_MIME.
        // Ignore a drop of a card onto itself.
        const draggedGroupId = e.dataTransfer.getData(GROUP_ID_MIME);
        if (draggedGroupId) {
          if (draggedGroupId !== groupId) onMerge(draggedGroupId);
          return;
        }
        const wordIds = readWordIds(e.dataTransfer);
        if (wordIds.length > 0) {
          onTargetsDrop(wordIds);
          return;
        }
        const sourceId = e.dataTransfer.getData(SOURCE_ID_MIME);
        if (sourceId) onSourceDrop(sourceId);
      }}
      data-group-id={groupId}
      sx={{
        position: "relative",
        bgcolor: isMergeTarget || showOver ? "primary.50" : "background.paper",
        borderColor: isMergeTarget || showOver ? "primary.main" : "divider",
        borderWidth: 1,
        borderStyle: isMergeTarget ? "dashed" : "solid",
        borderRadius: 1.5,
        px: 1.25,
        // Extra headroom so superscript indicators (Hebrew sup occurrences,
        // chip sup-occurrence indicators) aren't clipped by the card border.
        pt: 1.5,
        // Extra bottom room for the grip handle below the chips.
        pb: 2.25,
        minWidth: 160,
        maxWidth: 260,
        flex: "0 1 auto",
        display: "flex",
        flexDirection: "column",
        direction: "ltr",
        opacity: isBeingDragged ? 0.4 : 1,
        transition: "opacity 0.12s, border-color 0.12s, background-color 0.12s",
      }}
    >
      {children}
      {/* Bottom grip — drag a whole card onto another to merge their groups.
          Sits at the bottom edge, clear of the top-right Hebrew occurrence
          superscripts and the top-left clear (×) button. */}
      <Tooltip title="drag onto another card to merge the two groups">
        <Box
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(GROUP_ID_MIME, groupId);
            e.dataTransfer.effectAllowed = "move";
            onGroupDragStart(groupId);
          }}
          onDragEnd={onGroupDragEnd}
          sx={{
            position: "absolute",
            left: "50%",
            bottom: 4,
            transform: "translateX(-50%)",
            width: 44,
            height: 11,
            cursor: "grab",
            borderRadius: "6px",
            color: "text.disabled",
            backgroundImage:
              "radial-gradient(circle, currentColor 1.3px, transparent 1.7px)",
            backgroundSize: "8px 6px",
            backgroundRepeat: "repeat-x",
            backgroundPosition: "center",
            opacity: 0.7,
            transition: "color 0.12s, opacity 0.12s",
            "&:hover": { color: "primary.main", opacity: 1 },
            "&:active": { cursor: "grabbing" },
          }}
        />
      </Tooltip>
      {isMergeTarget && (
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            bgcolor: "primary.50",
            color: "primary.dark",
            fontWeight: 600,
            fontSize: 13,
            borderRadius: 1.5,
            pointerEvents: "none",
            zIndex: 4,
          }}
        >
          ⤵ merge into this group
        </Box>
      )}
    </Paper>
  );
}

// ─── Hebrew source word as typography (no inverted block) ──────────────
const REUSED_SOURCE_TOOLTIP =
  "This Hebrew word is aligned in more than one group — that is a data defect. A human must re-align this verse.";

function SourceWordTypography({
  source,
  pos,
  groupId,
  lex,
  twHint,
  canExtract,
  onExtract,
  hctx,
  reused,
}: {
  source: SourceWord;
  // Union-relative source position (-1 when unresolved — hover identity then
  // falls back to the group id alone).
  pos: number;
  groupId: string;
  lex: LexiconEntry | null;
  twHint: string | null;
  canExtract: boolean;
  onExtract: () => void;
  hctx: HighlightCtx;
  // True when this source token's own-relative position is claimed by 2+
  // display cards (see findReusedSourcePositions) — a data defect, not a
  // hover/link state. Must not be confusable with hoverShadow's blue/amber.
  reused: boolean;
}) {
  const [hover, setHover] = useState(false);
  const tone = hctx.hebrewHighlight(pos, groupId);
  const showInfo = hctx.showSourceInfo;
  return (
    <Tooltip
      enterDelay={0}
      enterNextDelay={0}
      title={
        showInfo || reused ? (
          <Box>
            {/* The defect notice leads — a native `title` attribute would lose
                the hover to this popper and never be read. */}
            {reused && (
              <Box sx={{ fontSize: 11, fontWeight: 700, color: "error.light", mb: showInfo ? 0.5 : 0 }}>
                {REUSED_SOURCE_TOOLTIP}
              </Box>
            )}
            {showInfo && <SourceTooltipBody source={source} lex={lex} twHint={twHint} />}
            {showInfo && canExtract && (
              <Box sx={{ mt: 0.5, fontSize: 11, opacity: 0.85 }}>
                double-click to split out of compound
              </Box>
            )}
          </Box>
        ) : (
          ""
        )
      }
      disableHoverListener={!showInfo && !reused}
      disableFocusListener={!showInfo && !reused}
      disableTouchListener={!showInfo && !reused}
      slotProps={{ popper: { sx: { pointerEvents: "none" } } }}
    >
      <Box
        component="span"
        draggable
        onMouseEnter={() => {
          setHover(true);
          hctx.onHebrewEnter(pos, groupId);
        }}
        onMouseLeave={() => {
          setHover(false);
          hctx.onLeave();
        }}
        onDragStart={(e) => {
          e.dataTransfer.setData(SOURCE_ID_MIME, source.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDoubleClick={() => {
          if (canExtract) onExtract();
        }}
        sx={{
          position: "relative",
          display: "inline-flex",
          alignItems: "baseline",
          py: 0.25,
          px: 0.75,
          // Reserve the right gutter for EITHER superscript — without this a
          // reused token with no occurrence badge gets ~6px and the warning
          // glyph clips the rightmost (RTL) Hebrew letter.
          pr: sourceShowsOccurrence(source) || reused ? 2 : 0.75,
          bgcolor: hover ? "grey.100" : "transparent",
          borderRadius: 0.5,
          fontFamily: '"Frank Ruhl Libre", "Times New Roman", "SBL Hebrew", "Cardo", serif',
          fontSize: 23,
          lineHeight: 1.2,
          color: "text.primary",
          cursor: canExtract ? "grab" : "grab",
          whiteSpace: "nowrap",
          transition: "background-color 0.12s, box-shadow 0.12s",
          userSelect: "none",
          boxShadow: hoverShadow(tone, hctx.themeMode),
          // Data-defect marker: a standing flag, not a transient hover state.
          // MUST be `error.main` — hoverShadow's "linked" tone is the SAME
          // amber as warning.main (highlightTypes.ts), so an amber outline
          // read as a hover ring. Red is used by neither hover tone (exact is
          // blue), and it stacks with them rather than replacing them
          // (outline vs box-shadow).
          outline: reused ? "2px solid" : "none",
          outlineColor: "error.main",
          outlineOffset: 1,
          "&:active": { cursor: "grabbing" },
        }}
      >
        {source.content}
        {sourceShowsOccurrence(source) && (
          <Box
            component="sup"
            dir="ltr"
            sx={{
              position: "absolute",
              top: 0,
              right: 2,
              fontFamily: "monospace",
              fontSize: 9,
              fontWeight: 700,
              lineHeight: 1,
              color: "primary.main",
              pointerEvents: "none",
            }}
          >
            {source.occurrence}
          </Box>
        )}
        {reused && (
          <Box
            component="sup"
            dir="ltr"
            role="img"
            // The outline is pure colour and the glyph takes no pointer, so
            // this label is the only signal a screen reader gets.
            aria-label={REUSED_SOURCE_TOOLTIP}
            sx={{
              position: "absolute",
              bottom: -2,
              right: 2,
              fontFamily: "monospace",
              fontSize: 11,
              fontWeight: 900,
              lineHeight: 1,
              color: "error.main",
              pointerEvents: "none",
            }}
          >
            ⚠
          </Box>
        )}
      </Box>
    </Tooltip>
  );
}

// ─── English chips ─────────────────────────────────────────────────────
function AlignedChip({
  wordId,
  text,
  occurrence,
  occurrences,
  hctx,
}: {
  wordId: string;
  text: string;
  occurrence: string;
  occurrences: string;
  hctx: HighlightCtx;
}) {
  const tone = hctx.englishHighlight(wordId, text, occurrence);
  const hueDeg = hctx.colorize ? hctx.matchHues.get(`${text}|${occurrence}`) : undefined;
  const accent = hueDeg != null ? chipAccentColor(hueDeg, hctx.themeMode) : undefined;
  const supColor = hueDeg != null ? chipSupColor(hueDeg, hctx.themeMode) : "text.disabled";
  return (
    <Chip
      label={targetLabel(text, occurrence, occurrences, supColor)}
      size="small"
      variant="outlined"
      onMouseEnter={() => hctx.onEnglishEnter(wordId, text, occurrence)}
      onMouseLeave={hctx.onLeave}
      sx={{
        fontFamily: '"Roboto","Helvetica",sans-serif',
        color: "text.disabled",
        bgcolor: "grey.50",
        borderColor: "divider",
        userSelect: "none",
        height: 26,
        borderRadius: 0.75,
        boxShadow: hoverShadow(tone, hctx.themeMode),
        transition: "box-shadow 0.12s",
        ...(accent ? { borderBottom: `3px solid ${accent}`, pb: "2px" } : {}),
        "& .MuiChip-label": { overflow: "visible", px: 1 },
      }}
    />
  );
}

function SelectableChip({
  wordId,
  text,
  occurrence,
  occurrences,
  selected,
  onClick,
  idsForDrag,
  hctx,
}: {
  wordId: string;
  text: string;
  occurrence: string;
  occurrences: string;
  selected: boolean;
  onClick: (shift: boolean) => void;
  idsForDrag: () => string[];
  hctx: HighlightCtx;
}) {
  const tone = hctx.englishHighlight(wordId, text, occurrence);
  const hueDeg =
    !selected && hctx.colorize
      ? hctx.matchHues.get(`${text}|${occurrence}`)
      : undefined;
  const accent = hueDeg != null ? chipAccentColor(hueDeg, hctx.themeMode) : undefined;
  const supColor = selected
    ? "primary.contrastText"
    : hueDeg != null
      ? chipSupColor(hueDeg, hctx.themeMode)
      : "primary.dark";
  return (
    <Chip
      label={targetLabel(text, occurrence, occurrences, supColor)}
      size="small"
      variant={selected ? "filled" : "outlined"}
      color={selected ? "primary" : "default"}
      draggable
      onClick={(e) => onClick(e.shiftKey)}
      onMouseEnter={() => hctx.onEnglishEnter(wordId, text, occurrence)}
      onMouseLeave={hctx.onLeave}
      onDragStart={(e) => {
        const ids = idsForDrag();
        e.dataTransfer.setData(WORD_IDS_MIME, JSON.stringify(ids));
        if (ids.length === 1) e.dataTransfer.setData("text/word-id", ids[0]);
        e.dataTransfer.effectAllowed = "move";
      }}
      sx={{
        cursor: "grab",
        fontFamily: '"Roboto","Helvetica",sans-serif',
        userSelect: "none",
        height: 26,
        borderRadius: 0.75,
        bgcolor: selected ? "primary.main" : "background.paper",
        boxShadow: hoverShadow(tone, hctx.themeMode),
        transition: "box-shadow 0.12s",
        ...(accent ? { borderBottom: `3px solid ${accent}`, pb: "2px" } : {}),
        "& .MuiChip-label": { overflow: "visible", px: 1 },
        "&:active": { cursor: "grabbing" },
      }}
    />
  );
}

function SimpleDraggableChip({
  wordId,
  text,
  occurrence,
  occurrences,
  groupId,
  onUnalign,
  hctx,
}: {
  wordId: string;
  text: string;
  occurrence: string;
  occurrences: string;
  groupId: string;
  onUnalign?: () => void;
  hctx: HighlightCtx;
}) {
  const tone = hctx.englishHighlight(wordId, text, occurrence, groupId);
  const hueDeg = hctx.colorize ? hctx.matchHues.get(`${text}|${occurrence}`) : undefined;
  const accent = hueDeg != null ? chipAccentColor(hueDeg, hctx.themeMode) : undefined;
  const supColor = hueDeg != null ? chipSupColor(hueDeg, hctx.themeMode) : "primary.dark";
  return (
    <Tooltip title="double-click or drag back to the word bank to unalign">
      <Chip
        label={targetLabel(text, occurrence, occurrences, supColor)}
        size="small"
        variant="outlined"
        draggable
        onMouseEnter={() => hctx.onEnglishEnter(wordId, text, occurrence, groupId)}
        onMouseLeave={hctx.onLeave}
        onDragStart={(e) => {
          e.dataTransfer.setData(WORD_IDS_MIME, JSON.stringify([wordId]));
          e.dataTransfer.setData("text/word-id", wordId);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDoubleClick={onUnalign}
        sx={{
          cursor: "grab",
          fontFamily: '"Roboto","Helvetica",sans-serif',
          userSelect: "none",
          height: 26,
          borderRadius: 0.75,
          bgcolor: "background.paper",
          boxShadow: hoverShadow(tone, hctx.themeMode),
          transition: "box-shadow 0.12s",
          ...(accent ? { borderBottom: `3px solid ${accent}`, pb: "2px" } : {}),
          "& .MuiChip-label": { overflow: "visible", px: 1 },
          "&:active": { cursor: "grabbing" },
        }}
      />
    </Tooltip>
  );
}

// ─── Tiny checkbox-style toggle for the inventory header ──────────────
function ToolbarToggle({
  label,
  checked,
  onChange,
  tooltip,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  tooltip?: string;
}) {
  return (
    <Tooltip title={tooltip ?? ""} disableHoverListener={!tooltip}>
      <Box
        component="button"
        onClick={onChange}
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: 0.5,
          background: "transparent",
          border: 0,
          p: 0.25,
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: 11,
          color: checked ? "primary.main" : "text.secondary",
          "&:hover": { color: checked ? "primary.dark" : "text.primary" },
        }}
      >
        <Box
          component="span"
          sx={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 13,
            height: 13,
            borderRadius: "3px",
            border: "1.5px solid",
            borderColor: checked ? "primary.main" : "grey.300",
            bgcolor: checked ? "primary.main" : "transparent",
            color: "primary.contrastText",
            fontSize: 10,
            lineHeight: 1,
          }}
        >
          {checked ? "✓" : ""}
        </Box>
        {label}
      </Box>
    </Tooltip>
  );
}

// ─── Ghost (suggested alignment) chips ─────────────────────────────────
// Scoring + matching (computeGhosts, the weighted-average blend, surfaceMatch,
// ghostPipColor, the Ghost/StreamWord types) live in ../lib/alignmentSuggest so
// the offline eval harness scores exactly what ships. Below is only the chip's
// presentation: a faded, dashed, click-to-accept chip inside an empty group.
// The × (MUI onDelete) dismisses it for the session via dismissedGhosts, so a
// rejected suggestion can't immediately regenerate — the "predicted alignment"
// circle fix. Clicking × never fires onClick (MUI stops it), so reject ≠ accept.
function GhostChip({
  ghost,
  onAccept,
  onDismiss,
}: {
  ghost: Ghost;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const pct = Math.round(ghost.confidence * 100);
  const srcLabel = ghost.source === "memory" ? "wordMAP" : "lexicon";
  return (
    <Tooltip title={`suggested · ${srcLabel} · ${pct}% — click to accept, × to dismiss`}>
      <Chip
        size="small"
        variant="outlined"
        clickable
        onClick={onAccept}
        onDelete={onDismiss}
        deleteIcon={<CloseIcon />}
        label={
          <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
            <Box
              component="span"
              sx={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                bgcolor: ghostPipColor(ghost.confidence),
                flexShrink: 0,
              }}
            />
            <Box component="span" sx={{ fontStyle: "italic" }}>
              {ghost.text}
            </Box>
          </Box>
        }
        sx={{
          height: 26,
          borderRadius: 0.75,
          borderStyle: "dashed",
          borderColor: "primary.main",
          color: "text.secondary",
          bgcolor: "transparent",
          opacity: 0.72,
          cursor: "pointer",
          transition: "opacity 0.12s, background-color 0.12s",
          "&:hover": { opacity: 1, bgcolor: "primary.50" },
          "& .MuiChip-label": { px: 1 },
          "& .MuiChip-deleteIcon": {
            fontSize: 15,
            ml: "-2px",
            color: "text.disabled",
            "&:hover": { color: "error.main" },
          },
        }}
      />
    </Tooltip>
  );
}

// ─── Helpers (carried over verbatim from AlignmentDialog) ──────────────
function sourceShowsOccurrence(s: SourceWord): boolean {
  const n = parseInt(s.occurrences, 10);
  return Number.isFinite(n) && n > 1;
}

function targetLabel(
  text: string,
  occurrence: string,
  occurrences: string,
  tone: string,
): React.ReactNode {
  const n = parseInt(occurrences, 10);
  if (!Number.isFinite(n) || n <= 1) return text;
  // The superscript sits at the top of the inline-flex container with
  // vertical-align: super, so it stays fully inside the chip's bounding
  // box and never collides with the chip's top border at any zoom.
  return (
    <Box component="span" sx={{ display: "inline-flex", alignItems: "baseline" }}>
      <span>{text}</span>
      <Box
        component="span"
        sx={{
          ml: "3px",
          fontFamily: "monospace",
          fontSize: 9,
          fontWeight: 700,
          lineHeight: 1,
          color: tone,
          verticalAlign: "super",
          alignSelf: "flex-start",
          mt: "1px",
        }}
      >
        {occurrence}
      </Box>
    </Box>
  );
}

function readWordIds(dt: DataTransfer): string[] {
  const raw = dt.getData(WORD_IDS_MIME);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        return parsed;
      }
    } catch {
      /* fall through */
    }
  }
  const single = dt.getData("text/word-id");
  return single ? [single] : [];
}

