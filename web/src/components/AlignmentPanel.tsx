import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
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
  useTheme,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { assignChipHues, chipAccentColor, chipSupColor } from "../lib/highlightStyles";
import {
  alignmentPlainText,
  clearAll,
  clearGroup,
  extractSource,
  moveSource,
  moveTargets,
  parseAlignment,
  serializeAlignment,
  type AlignmentGroup,
  type AlignmentState,
  type SourceWord,
} from "../lib/alignment";
import type { TwlRow, VerseDto } from "../sync/api";
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
import { nfc } from "../lib/hebrew";
import { SourceTooltipBody } from "./SourceTooltipBody";

const WORD_IDS_MIME = "text/word-ids";
const SOURCE_ID_MIME = "text/source-id";

// Storage keys for sticky toolbar prefs.
const LS_HIDE_UHB = "be:alignmentHideUhb";
const LS_COLORIZE = "be:alignmentColorize";
const LS_HOVERLINK = "be:alignmentHoverLink";
const LS_INVENTORY_HEIGHT = "be:alignmentInventoryHeight";

const DEFAULT_INVENTORY_HEIGHT = 112;
const MIN_INVENTORY_HEIGHT = 56;
const MAX_INVENTORY_HEIGHT = 480;

type HoverHighlight =
  | { kind: "english"; key: string; groupId: string | null }
  | { kind: "hebrew"; key: string; groupId: string | null }
  | null;

type HighlightTone = "exact" | "linked" | null;

interface HighlightCtx {
  colorize: boolean;
  hoverLink: boolean;
  // Per-(text|occurrence) hue degree assignment for the "colors" toggle.
  // Only duplicate-occurrence words get an entry; missing = no accent.
  matchHues: Map<string, number>;
  themeMode: "light" | "dark";
  onEnglishEnter: (wordId: string, text: string, occurrence: string, groupIdOverride?: string) => void;
  // Hebrew is keyed by Strong number (invariant) + occurrence — content
  // text can differ between the alignment milestone and the UHB \w token
  // due to cantillation / NFC variation.
  onHebrewEnter: (strong: string, occurrence: string, groupIdOverride?: string) => void;
  onLeave: () => void;
  englishHighlight: (
    wordId: string,
    text: string,
    occurrence: string,
    groupIdOverride?: string,
  ) => HighlightTone;
  hebrewHighlight: (
    strong: string,
    occurrence: string,
    groupIdOverride?: string,
  ) => HighlightTone;
}

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
  save: () => void;
  reset: () => void;
  discard: () => void;
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
  onSave: (newContent: unknown, plainText: string, expectedVersion: number) => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export const AlignmentPanel = forwardRef<AlignmentPanelHandle, Props>(
  function AlignmentPanel(
    {
      verse,
      verseNum,
      bibleVersion,
      sourceVerse,
      sourceLabel,
      twlForVerse,
      onSave,
      onCancel,
      onDirtyChange,
    },
    ref,
  ) {
    const computedInitial = useMemo<AlignmentState | null>(() => {
      if (!verse?.content) return null;
      const verseObjects = (verse.content as { verseObjects?: unknown[] }).verseObjects;
      if (!Array.isArray(verseObjects)) return null;
      const sourceVerseObjects =
        sourceVerse?.content &&
        Array.isArray((sourceVerse.content as { verseObjects?: unknown[] }).verseObjects)
          ? (sourceVerse.content as { verseObjects: unknown[] }).verseObjects
          : null;
      return parseAlignment(verseObjects, sourceVerseObjects);
    }, [verse, sourceVerse]);

    const [initial, setInitial] = useState<AlignmentState | null>(computedInitial);
    const [state, setState] = useState<AlignmentState | null>(computedInitial);
    const [selectedUnaligned, setSelectedUnaligned] = useState<Set<string>>(new Set());
    const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
    const [showOnlyUnaligned, setShowOnlyUnaligned] = useState(false);
    const [hideUhbStrip, setHideUhbStrip] = useState<boolean>(() => readFlag(LS_HIDE_UHB));
    const [colorize, setColorize] = useState<boolean>(() => readFlag(LS_COLORIZE));
    const [hoverLink, setHoverLink] = useState<boolean>(() => readFlag(LS_HOVERLINK));
    const [hover, setHover] = useState<HoverHighlight>(null);
    // Session-scoped ghost rejections (keyed by dismissedGhostKey). Suppresses a
    // suggestion the user dismissed via the chip's × so it can't immediately
    // regenerate on the next render — the "predicted alignment" circle fix.
    const [dismissedGhosts, setDismissedGhosts] = useState<Set<string>>(new Set());

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
      setHoverLink((cur) => {
        const next = !cur;
        writeFlag(LS_HOVERLINK, next);
        if (!next) setHover(null);
        return next;
      });
    };

    // Sync to upstream verse changes (find/replace, version swap, etc.).
    // Local drag state is dropped — matches the previous dialog and keeps
    // serialize round-trip safe.
    useEffect(() => {
      setInitial(computedInitial);
      setState(computedInitial);
      setSelectedUnaligned(new Set());
      setSelectionAnchor(null);
    }, [computedInitial]);

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

    const handleTargetsDrop = (dest: string, wordIds: string[]) => {
      if (!state || wordIds.length === 0) return;
      setState(moveTargets(state, wordIds, dest));
      setSelectedUnaligned(new Set());
      setSelectionAnchor(null);
    };
    const handleSourceDrop = (destGroupId: string, sourceId: string) => {
      if (!state) return;
      setState(moveSource(state, sourceId, destGroupId));
    };
    const handleExtractSource = (sourceId: string) => {
      if (!state) return;
      setState(extractSource(state, sourceId));
    };
    const handleClearGroup = (groupId: string) => {
      if (!state) return;
      const target = state.groups.find((g) => g.id === groupId);
      if (!target) return;
      const key = sourceKey(target);
      let next = state;
      for (const g of state.groups) {
        if (sourceKey(g) === key) next = clearGroup(next, g.id);
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

    // Cross-language hover linking needs to know which alignment group each
    // chip / Hebrew word belongs to.
    const targetIdToGroupId = useMemo(() => {
      const map = new Map<string, string>();
      if (!state) return map;
      for (const item of state.stream) {
        if (item.kind !== "word") continue;
        if (item.alignedTo) map.set(item.word.id, item.alignedTo);
      }
      return map;
    }, [state]);
    // Map Hebrew tokens to alignment groups using STRONG + occurrence as
    // the key. Strong number is invariant across the \zaln-s milestone's
    // x-content and the UHB verse's \w text — content text can differ on
    // NFC ordering, cantillation marks, or maqaf attachment, which were
    // silently breaking the strip's lookup. Occurrence comes through the
    // same alignment pipeline on both sides so it lines up.
    const sourceKeyToGroupId = useMemo(() => {
      const map = new Map<string, string>();
      if (!state) return map;
      for (const g of state.groups) {
        for (const s of g.source) {
          if (!s.strong) continue;
          const key = `${s.strong}|${s.occurrence}`;
          if (!map.has(key)) map.set(key, g.id);
        }
      }
      return map;
    }, [state]);

    // Highlight resolution. `hover` may name an English or Hebrew word; we
    // mark same-language matches as "exact" and aligned cross-language
    // partners as "linked". The handlers no-op when hoverLink is off so the
    // chips can fire them unconditionally.
    const onEnglishHover = useCallback(
      (wordId: string, text: string, occurrence: string, groupIdOverride?: string) => {
        if (!hoverLink) return;
        setHover({
          kind: "english",
          key: `${text}|${occurrence}`,
          groupId: groupIdOverride ?? targetIdToGroupId.get(wordId) ?? null,
        });
      },
      [hoverLink, targetIdToGroupId],
    );
    const onHebrewHover = useCallback(
      (strong: string, occurrence: string, groupIdOverride?: string) => {
        if (!hoverLink) return;
        const key = `${strong}|${occurrence}`;
        setHover({
          kind: "hebrew",
          key,
          groupId: groupIdOverride ?? sourceKeyToGroupId.get(key) ?? null,
        });
      },
      [hoverLink, sourceKeyToGroupId],
    );
    const onHoverLeave = useCallback(() => {
      setHover(null);
    }, []);

    const englishHighlight = useCallback(
      (wordId: string, text: string, occurrence: string, groupIdOverride?: string): "exact" | "linked" | null => {
        if (!hoverLink || !hover) return null;
        const myKey = `${text}|${occurrence}`;
        if (hover.kind === "english" && hover.key === myKey) return "exact";
        const myGroupId = groupIdOverride ?? targetIdToGroupId.get(wordId) ?? null;
        if (myGroupId && hover.groupId === myGroupId && hover.kind === "hebrew") return "linked";
        return null;
      },
      [hoverLink, hover, targetIdToGroupId],
    );
    const hebrewHighlight = useCallback(
      (strong: string, occurrence: string, groupIdOverride?: string): "exact" | "linked" | null => {
        if (!hoverLink || !hover) return null;
        const myKey = `${strong}|${occurrence}`;
        if (hover.kind === "hebrew" && hover.key === myKey) return "exact";
        const myGroupId = groupIdOverride ?? sourceKeyToGroupId.get(myKey) ?? null;
        if (myGroupId && hover.groupId === myGroupId && hover.kind === "english") return "linked";
        return null;
      },
      [hoverLink, hover, sourceKeyToGroupId],
    );

    const hctx: HighlightCtx = useMemo(
      () => ({
        colorize,
        hoverLink,
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
        matchHues,
        themeMode,
        onEnglishHover,
        onHebrewHover,
        onHoverLeave,
        englishHighlight,
        hebrewHighlight,
      ],
    );

    const sourceIndexMap = useMemo(() => buildSourceIndexMap(sourceVerse), [sourceVerse]);
    const displayGroups = useMemo(() => {
      if (!state) return [];
      const sortKey = (g: (typeof state.groups)[number]) => {
        if (g.source.length === 0) return Number.MAX_SAFE_INTEGER;
        const s = g.source[0];
        const c = nfc(s.content ?? "");
        const byText =
          sourceIndexMap.get(`t:${c}|${s.occurrence}`) ?? sourceIndexMap.get(`t:${c}|1`);
        if (byText !== undefined) return byText;
        return (
          sourceIndexMap.get(`s:${s.strong}|${s.occurrence}`) ??
          sourceIndexMap.get(`s:${s.strong}|1`) ??
          Number.MAX_SAFE_INTEGER
        );
      };
      const sorted = [...state.groups].sort((a, b) => sortKey(a) - sortKey(b));
      const stripped = stripCompoundOverlaps(sorted);
      return mergeAdjacentSameSource(stripped);
    }, [state, sourceIndexMap]);

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
    }, [initial]);
    const handleClearAll = () => {
      if (!state) return;
      setState(clearAll(state));
      setSelectedUnaligned(new Set());
      setSelectionAnchor(null);
    };
    const handleSave = useCallback(() => {
      if (!state || !verse) return;
      const newVerseObjects = serializeAlignment(state);
      const newContent = { verseObjects: newVerseObjects };
      const plain = alignmentPlainText(state);
      onSave(newContent, plain, verse.version);
      // Optimistic: the freshly-saved state is now the baseline. When the
      // chapter cache eventually round-trips the new content, computedInitial
      // recomputes and the useEffect resets state to it (idempotent).
      setInitial(state);
    }, [state, verse, onSave]);

    useImperativeHandle(
      ref,
      () => ({
        isDirty: () => dirty,
        save: handleSave,
        reset: handleReset,
        discard: handleReset,
      }),
      [dirty, handleSave, handleReset],
    );


    return (
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
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
                hctx={hctx}
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
              onSave={handleSave}
              bibleVersion={bibleVersion}
            />
          </>
        )}
      </Box>
    );
  },
);

// ─── UHB source strip ────────────────────────────────────────────────
function UhbStrip({
  sourceVerse,
  sourceLabel,
  lexiconMap,
  twlForVerse,
  verseNum,
  hidden,
  onToggleHidden,
  hctx,
}: {
  sourceVerse: VerseDto | null;
  sourceLabel: string;
  lexiconMap: Map<string, LexiconEntry | null>;
  twlForVerse: TwlRow[];
  verseNum: number;
  hidden: boolean;
  onToggleHidden: () => void;
  hctx: HighlightCtx;
}) {
  const sourceIsHebrew = sourceLabel === "UHB";
  return (
    <Box
      sx={{
        px: 2,
        pt: 1,
        pb: hidden ? 1 : 1.5,
        borderBottom: "1px solid",
        borderColor: "divider",
        bgcolor: "background.paper",
        flexShrink: 0,
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: hidden ? 0 : 0.5 }}>
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
          {sourceLabel} · source
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title={hidden ? `show ${sourceLabel} source` : `hide ${sourceLabel} source`}>
          <IconButton size="small" onClick={onToggleHidden} sx={{ p: 0.25, color: "text.disabled" }}>
            {hidden ? (
              <ExpandMoreIcon sx={{ fontSize: 18 }} />
            ) : (
              <ExpandLessIcon sx={{ fontSize: 18 }} />
            )}
          </IconButton>
        </Tooltip>
      </Stack>
      {!hidden && (
        <Box
          component="div"
          dir={sourceIsHebrew ? "rtl" : "ltr"}
          sx={{
            fontFamily: sourceIsHebrew
              ? '"Frank Ruhl Libre", "Times New Roman", "SBL Hebrew", "Cardo", serif'
              : '"Times New Roman", "Cardo", serif',
            fontSize: 21,
            lineHeight: 1.55,
            color: "text.primary",
            unicodeBidi: "isolate",
          }}
        >
          <SourceVerseTokens
            verseObjects={(sourceVerse?.content as { verseObjects?: unknown[] } | null)?.verseObjects}
            lexiconMap={lexiconMap}
            twlForVerse={twlForVerse}
            verseNum={verseNum}
            fallbackText={sourceVerse?.plain_text ?? ""}
            hctx={hctx}
          />
        </Box>
      )}
    </Box>
  );
}

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
              key={`${word.id}-${idx}`}
              wordId={word.id}
              text={word.text}
              occurrence={word.occurrence}
              occurrences={word.occurrences}
              hctx={hctx}
            />
          ) : (
            <SelectableChip
              key={`${word.id}-${idx}`}
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
  onSave,
  bibleVersion,
}: {
  dirty: boolean;
  ghostCount: number;
  onAcceptAll: () => void;
  onClear: () => void;
  onReset: () => void;
  onCancel: () => void;
  onSave: () => void;
  bibleVersion: string;
}) {
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={0.5}
      sx={{
        px: 1.5,
        py: 1,
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
      <Box sx={{ flex: 1 }} />
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
      <Button
        size="small"
        variant="contained"
        onClick={onSave}
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
  hctx,
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
  hctx: HighlightCtx;
}) {
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
        return (
        <DropTargetCard
          key={g.id}
          groupId={g.id}
          onTargetsDrop={(wordIds) => onTargetsDrop(`g:${g.id}`, wordIds)}
          onSourceDrop={(sourceId) => onSourceDrop(g.id, sourceId)}
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
            {g.source.map((s) => (
              <SourceWordTypography
                key={s.id}
                source={s}
                groupId={g.id}
                lex={lexiconMap.get(s.strong) ?? null}
                twHint={twHintFor(twlForVerse, verseNum, s.content ?? "")}
                canExtract={g.source.length > 1}
                onExtract={() => onExtractSource(s.id)}
                hctx={hctx}
              />
            ))}
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
              g.targets.map((t) => (
                <SimpleDraggableChip
                  key={t.id}
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
  children,
}: {
  groupId: string;
  onTargetsDrop: (wordIds: string[]) => void;
  onSourceDrop: (sourceId: string) => void;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
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
        bgcolor: over ? "primary.50" : "background.paper",
        borderColor: over ? "primary.main" : "divider",
        borderWidth: 1,
        borderStyle: "solid",
        borderRadius: 1.5,
        px: 1.25,
        // Extra headroom so superscript indicators (Hebrew sup occurrences,
        // chip sup-occurrence indicators) aren't clipped by the card border.
        pt: 1.5,
        pb: 1,
        minWidth: 160,
        maxWidth: 260,
        flex: "0 1 auto",
        display: "flex",
        flexDirection: "column",
        direction: "ltr",
      }}
    >
      {children}
    </Paper>
  );
}

// ─── Hebrew source word as typography (no inverted block) ──────────────
function SourceWordTypography({
  source,
  groupId,
  lex,
  twHint,
  canExtract,
  onExtract,
  hctx,
}: {
  source: SourceWord;
  groupId: string;
  lex: LexiconEntry | null;
  twHint: string | null;
  canExtract: boolean;
  onExtract: () => void;
  hctx: HighlightCtx;
}) {
  const [hover, setHover] = useState(false);
  const tone = hctx.hebrewHighlight(source.strong, source.occurrence, groupId);
  return (
    <Tooltip
      title={
        <Box>
          <SourceTooltipBody source={source} lex={lex} twHint={twHint} />
          {canExtract && (
            <Box sx={{ mt: 0.5, fontSize: 11, opacity: 0.85 }}>
              double-click to split out of compound
            </Box>
          )}
        </Box>
      }
      slotProps={{ popper: { sx: { pointerEvents: "none" } } }}
    >
      <Box
        component="span"
        draggable
        onMouseEnter={() => {
          setHover(true);
          hctx.onHebrewEnter(source.strong, source.occurrence, groupId);
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
          pr: sourceShowsOccurrence(source) ? 2 : 0.75,
          bgcolor: hover ? "grey.100" : "transparent",
          borderRadius: 0.5,
          fontFamily: '"Frank Ruhl Libre", "Times New Roman", "SBL Hebrew", "Cardo", serif',
          fontSize: 22,
          lineHeight: 1.2,
          color: "text.primary",
          cursor: canExtract ? "grab" : "grab",
          whiteSpace: "nowrap",
          transition: "background-color 0.12s, box-shadow 0.12s",
          userSelect: "none",
          boxShadow: hoverShadow(tone, hctx.themeMode),
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
      </Box>
    </Tooltip>
  );
}

// ─── Source verse renderer for the UHB strip ───────────────────────────
function SourceVerseTokens({
  verseObjects,
  lexiconMap,
  twlForVerse,
  verseNum,
  fallbackText,
  hctx,
}: {
  verseObjects: unknown[] | undefined;
  lexiconMap: Map<string, LexiconEntry | null>;
  twlForVerse: TwlRow[];
  verseNum: number;
  fallbackText: string;
  hctx: HighlightCtx;
}) {
  if (!Array.isArray(verseObjects)) return <>{fallbackText}</>;
  const out: React.ReactNode[] = [];
  const walk = (nodes: unknown[]) => {
    for (const n of nodes ?? []) {
      const o = n as Record<string, unknown> | null;
      if (!o) continue;
      if (o["type"] === "text") {
        out.push(<span key={`t${out.length}`}>{String(o["text"] ?? "")}</span>);
      } else if (o["type"] === "word" && o["tag"] === "w") {
        const text = String(o["text"] ?? "");
        const strong = String(o["strong"] ?? "");
        const occurrence = String(o["occurrence"] ?? "1");
        const src: SourceWord = {
          id: "",
          strong,
          lemma: String(o["lemma"] ?? ""),
          morph: String(o["morph"] ?? ""),
          occurrence,
          occurrences: String(o["occurrences"] ?? "1"),
          content: text,
        };
        out.push(
          <SourceVerseToken
            key={`w${out.length}`}
            text={text}
            strong={strong}
            occurrence={occurrence}
            source={src}
            lex={lexiconMap.get(strong) ?? null}
            twHint={twHintFor(twlForVerse, verseNum, text)}
            hctx={hctx}
          />,
        );
      } else if (o["type"] === "milestone") {
        walk((o["children"] as unknown[] | undefined) ?? []);
      }
    }
  };
  walk(verseObjects);
  return <>{out}</>;
}

function SourceVerseToken({
  text,
  strong,
  occurrence,
  source,
  lex,
  twHint,
  hctx,
}: {
  text: string;
  strong: string;
  occurrence: string;
  source: SourceWord;
  lex: LexiconEntry | null;
  twHint: string | null;
  hctx: HighlightCtx;
}) {
  const tone = hctx.hebrewHighlight(strong, occurrence);
  return (
    <Tooltip
      title={<SourceTooltipBody source={source} lex={lex} twHint={twHint} />}
      slotProps={{ popper: { sx: { pointerEvents: "none" } } }}
    >
      <Box
        component="span"
        onMouseEnter={() => hctx.onHebrewEnter(strong, occurrence)}
        onMouseLeave={hctx.onLeave}
        sx={{
          cursor: "help",
          display: "inline",
          borderRadius: 0.5,
          px: tone ? 0.25 : 0,
          boxShadow: hoverShadow(tone, hctx.themeMode),
          transition: "box-shadow 0.12s",
        }}
      >
        {text}
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

// Soft outer-ring "glow" applied to chips / Hebrew tokens when the current
// hover targets them or their alignment-group partner. Two tones so the
// exact-match and the cross-language linked partner are distinguishable.
// Dark mode lifts the ring alpha noticeably so saturated colors still
// register against the dark canvas; light mode gets a small bump.
function hoverShadow(tone: HighlightTone, mode: "light" | "dark"): string | undefined {
  const alpha = mode === "dark" ? 1 : 0.6;
  if (tone === "exact") return `0 0 0 2px rgba(49,173,227,${alpha})`;
  if (tone === "linked") return `0 0 0 2px rgba(229,157,51,${alpha})`;
  return undefined;
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

function sourceKey(g: AlignmentGroup): string {
  return g.source.map((s) => `${s.content}|${s.occurrence}`).join("~");
}

function stripCompoundOverlaps(groups: AlignmentGroup[]): AlignmentGroup[] {
  const standaloneContents = new Set<string>();
  for (const g of groups) {
    if (g.source.length === 1) standaloneContents.add(nfc(g.source[0].content ?? ""));
  }
  if (standaloneContents.size === 0) return groups;
  return groups.map((g) => {
    if (g.source.length <= 1) return g;
    const kept = g.source.filter((s) => !standaloneContents.has(nfc(s.content ?? "")));
    if (kept.length === g.source.length || kept.length === 0) return g;
    return { ...g, source: kept };
  });
}

function mergeAdjacentSameSource(groups: AlignmentGroup[]): AlignmentGroup[] {
  const out: AlignmentGroup[] = [];
  for (const g of groups) {
    const last = out[out.length - 1];
    if (last && sourceKey(last) === sourceKey(g)) {
      out[out.length - 1] = { ...last, targets: [...last.targets, ...g.targets] };
    } else {
      out.push(g);
    }
  }
  return out;
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

function twHintFor(twlRows: TwlRow[], verseNum: number, content: string): string | null {
  if (!content) return null;
  const needle = nfc(content);
  for (const r of twlRows) {
    if (r.verse !== verseNum) continue;
    const ow = r.orig_words ?? "";
    if (!ow) continue;
    const chunks = ow.split(/\s+/).filter(Boolean).map(nfc);
    if (chunks.includes(needle)) return twShort(r.tw_link);
  }
  return null;
}

function twShort(link: string | null): string | null {
  if (!link) return null;
  const m = link.match(/\/bible\/([^/]+\/[^/]+)$/);
  return m ? m[1] : link;
}

function buildSourceIndexMap(sourceVerse: VerseDto | null): Map<string, number> {
  const map = new Map<string, number>();
  if (!sourceVerse?.content) return map;
  const verseObjects = (sourceVerse.content as { verseObjects?: unknown[] }).verseObjects;
  if (!Array.isArray(verseObjects)) return map;
  let idx = 0;
  const textCount = new Map<string, number>();
  const strongCount = new Map<string, number>();
  const walk = (nodes: unknown[]) => {
    for (const n of nodes ?? []) {
      const o = n as Record<string, unknown> | null;
      if (!o) continue;
      if (o["type"] === "word" && o["tag"] === "w") {
        const text = nfc(String(o["text"] ?? ""));
        const strong = String(o["strong"] ?? "");
        const tOcc = (textCount.get(text) ?? 0) + 1;
        const sOcc = (strongCount.get(strong) ?? 0) + 1;
        textCount.set(text, tOcc);
        strongCount.set(strong, sOcc);
        const textKey = `t:${text}|${tOcc}`;
        const strongKey = `s:${strong}|${sOcc}`;
        if (!map.has(textKey)) map.set(textKey, idx);
        if (!map.has(strongKey)) map.set(strongKey, idx);
        idx++;
      } else if (o["type"] === "milestone") {
        walk((o["children"] as unknown[] | undefined) ?? []);
      }
    }
  };
  walk(verseObjects);
  return map;
}
