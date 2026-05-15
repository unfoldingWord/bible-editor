import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  Stack,
  Chip,
  IconButton,
  Paper,
  Tooltip,
} from "@mui/material";
import LinkIcon from "@mui/icons-material/Link";
import CloseIcon from "@mui/icons-material/Close";
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
import { nfc } from "../lib/hebrew";
import { SourceTooltipBody } from "./SourceTooltipBody";

const WORD_IDS_MIME = "text/word-ids";
const SOURCE_ID_MIME = "text/source-id";

interface Props {
  open: boolean;
  book: string;
  chapter: number;
  verseNum: number;
  bibleVersion: string;
  verse: VerseDto | null;
  contextOther: VerseDto | null; // the "other" gateway translation (UST when editing ULT, etc.)
  sourceVerse: VerseDto | null;  // UHB/UGNT verse for context
  sourceLabel: string;           // "UHB" or "UGNT"
  twlForVerse: TwlRow[];         // chapter twl rows filtered to this verse, for TW-article hints
  onClose: () => void;
  onSave: (newContent: unknown, plainText: string, expectedVersion: number) => void;
  // Switching to the other gateway-language version reframes the alignment
  // session — caller swaps which version's verse + contextOther it ships in.
  // Undefined disables the switch affordance.
  onSwitchVersion?: (bibleVersion: string) => void;
  // Inline edit on ULT / UST in the verse strip — fires per-debounce-window
  // with the new plain text. Caller PATCHes via outbox; the new verse
  // payload flows back through `verse`/`contextOther` and re-initializes
  // the alignment state from the re-tokenized content.
  onEditVerseText?: (bibleVersion: string, plain: string, base: VerseDto) => void;
}

export function AlignmentDialog({
  open,
  book,
  chapter,
  verseNum,
  bibleVersion,
  verse,
  contextOther,
  sourceVerse,
  sourceLabel,
  twlForVerse,
  onClose,
  onSave,
  onSwitchVersion,
  onEditVerseText,
}: Props) {
  const initial = useMemo<AlignmentState | null>(() => {
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

  const [state, setState] = useState<AlignmentState | null>(initial);
  const [selectedUnaligned, setSelectedUnaligned] = useState<Set<string>>(new Set());
  // Anchor for shift-range select — the last chip the user clicked without
  // shift. Cleared with the bag's × button or after a drop.
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  useEffect(() => {
    setState(initial);
    setSelectedUnaligned(new Set());
    setSelectionAnchor(null);
  }, [initial]);

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
    // The X button on a display card may represent multiple underlying
    // groups that were visually merged (same source chain, e.g. Zec 3:4's
    // two הָסִ֛ירוּ milestones). Clear them all together so the user
    // doesn't see lingering chips inside the card after one click.
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

  // Click toggles a single chip (additive); shift-click extends the selection
  // from the last-clicked anchor through the chip the user just clicked.
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

  // When the user starts dragging an unaligned chip that's part of the
  // current selection, ship all selected ids. Otherwise ship just that one.
  const idsForUnalignedDrag = (id: string) =>
    selectedUnaligned.has(id) && selectedUnaligned.size > 1
      ? Array.from(selectedUnaligned)
      : [id];

  // For DISPLAY only: order the alignment cards by where each block's first
  // source word falls in the source-language verse (Hebrew/Greek reading
  // order). Matches word-aligner-rcl's alignmentComparator. state.groups
  // itself stays in target/USFM order so serialization keeps the GL reading
  // order intact.
  const sourceIndexMap = useMemo(() => buildSourceIndexMap(sourceVerse), [sourceVerse]);
  const displayGroups = useMemo(() => {
    if (!state) return [];
    // Look up by text+occurrence, then text+1 (in case ULT/UST over-numbered
    // occurrences against the UHB), then by strong with the same fallback.
    // MAX as last resort so unrecognized sources land at the end instead of
    // jamming next to position 0.
    const sortKey = (g: (typeof state.groups)[number]) => {
      if (g.source.length === 0) return Number.MAX_SAFE_INTEGER;
      const s = g.source[0];
      const c = nfc(s.content ?? "");
      const byText =
        sourceIndexMap.get(`t:${c}|${s.occurrence}`) ??
        sourceIndexMap.get(`t:${c}|1`);
      if (byText !== undefined) return byText;
      return (
        sourceIndexMap.get(`s:${s.strong}|${s.occurrence}`) ??
        sourceIndexMap.get(`s:${s.strong}|1`) ??
        Number.MAX_SAFE_INTEGER
      );
    };
    const sorted = [...state.groups].sort((a, b) => sortKey(a) - sortKey(b));
    // Strip a compound's inner source words that ALSO appear as the sole
    // source of another group — same Hebrew token tagged twice in the USFM
    // (e.g. Zec 2:8's אָמַר֮ inside the compound + standalone milestone).
    // Display-only; state.groups keeps the full chain so save round-trips.
    const stripped = stripCompoundOverlaps(sorted);
    // Merge adjacent groups whose source chain is identical (same content +
    // occurrence per source word, in order). Two USFM milestones that point
    // to the same UHB token end up as separate AlignmentGroups so save can
    // re-emit the original split; the dialog renders them as one card.
    return mergeAdjacentSameSource(stripped);
  }, [state, sourceIndexMap]);

  // Pre-load lexicon entries for every unique Strong's referenced by the
  // current alignment AND every \w token in the source verse strip, so
  // tooltips on either don't shimmer on hover.
  const allStrongs = useMemo(() => {
    const set = new Set<string>();
    if (state) {
      for (const g of state.groups) {
        for (const s of g.source) if (s.strong) set.add(s.strong);
      }
    }
    const sourceObjects = (sourceVerse?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (Array.isArray(sourceObjects)) {
      const walk = (nodes: unknown[]) => {
        for (const n of nodes ?? []) {
          const o = n as Record<string, unknown> | null;
          if (!o) continue;
          if (o["type"] === "word" && o["tag"] === "w") {
            const s = String(o["strong"] ?? "");
            if (s) set.add(s);
          } else if (o["type"] === "milestone") {
            walk((o["children"] as unknown[] | undefined) ?? []);
          }
        }
      };
      walk(sourceObjects);
    }
    return [...set];
  }, [state, sourceVerse]);
  const lexiconMap = useLexicon(allStrongs);

  const handleReset = () => {
    setState(initial);
    setSelectedUnaligned(new Set());
    setSelectionAnchor(null);
  };
  const handleClearAll = () => {
    if (!state) return;
    setState(clearAll(state));
    setSelectedUnaligned(new Set());
    setSelectionAnchor(null);
  };
  const handleSave = () => {
    if (!state || !verse) return;
    const newVerseObjects = serializeAlignment(state);
    const newContent = { verseObjects: newVerseObjects };
    const plain = alignmentPlainText(state);
    onSave(newContent, plain, verse.version);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <LinkIcon sx={{ color: "success.main" }} />
        <Box>
          Aligning {book} {chapter}:{verseNum} · {bibleVersion}
        </Box>
        <Box sx={{ flex: 1 }} />
        <IconButton size="small" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
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
            <VerseStrip
              verse={verse}
              other={contextOther}
              source={sourceVerse}
              sourceLabel={sourceLabel}
              bibleVersion={bibleVersion}
              chapter={chapter}
              verseNum={verseNum}
              lexiconMap={lexiconMap}
              onSwitchVersion={onSwitchVersion}
              onEditVerseText={onEditVerseText}
              twlForVerse={twlForVerse}
            />
            <Box sx={{ display: "grid", gridTemplateColumns: "220px 1fr", height: 480, overflow: "hidden" }}>
              <UnalignedBag
                state={state}
                selectedIds={selectedUnaligned}
                onChipClick={handleChipClick}
                idsForDrag={idsForUnalignedDrag}
                onClearSelection={handleClearSelection}
                onDrop={(wordIds) => handleTargetsDrop("u", wordIds)}
              />
              <AlignmentGrid
                groups={displayGroups}
                twlForVerse={twlForVerse}
                lexiconMap={lexiconMap}
                verseNum={verseNum}
                onTargetsDrop={handleTargetsDrop}
                onSourceDrop={handleSourceDrop}
                onExtractSource={handleExtractSource}
                onClearGroup={handleClearGroup}
              />
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1, gap: 1 }}>
        <Box sx={{ flex: 1 }} />
        <Button onClick={handleClearAll} disabled={!state} color="warning">
          clear all
        </Button>
        <Button onClick={handleReset} disabled={!state}>
          reset
        </Button>
        <Button onClick={onClose}>cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={!state}>
          save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function VerseStrip({
  verse,
  other,
  source,
  sourceLabel,
  bibleVersion,
  chapter,
  verseNum,
  lexiconMap,
  onSwitchVersion,
  onEditVerseText,
  twlForVerse,
}: {
  verse: VerseDto | null;
  other: VerseDto | null;
  source: VerseDto | null;
  sourceLabel: string;
  bibleVersion: string;
  chapter: number;
  verseNum: number;
  lexiconMap: Map<string, LexiconEntry | null>;
  onSwitchVersion?: (bv: string) => void;
  onEditVerseText?: (bv: string, plain: string, base: VerseDto) => void;
  twlForVerse: TwlRow[];
}) {
  const otherLabel = bibleVersion === "ULT" ? "UST" : bibleVersion === "UST" ? "ULT" : "UST";
  const sourceIsHebrew = sourceLabel === "UHB";
  const switchable = !!onSwitchVersion && otherLabel !== bibleVersion && (otherLabel === "ULT" || otherLabel === "UST");
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: "54px 1fr 1fr 1fr",
        gap: 2,
        px: 3,
        py: 1.5,
        bgcolor: "background.paper",
        borderBottom: "1px solid",
        borderColor: "divider",
        fontSize: 13.5,
        lineHeight: 1.4,
      }}
    >
      <Box sx={{ fontFamily: "monospace", color: "primary.main", fontWeight: 700 }}>
        {chapter}:{verseNum}
      </Box>
      <Box>
        <Tooltip title={switchable ? `align ${otherLabel} for this verse instead` : ""}>
          <Chip
            label={otherLabel}
            size="small"
            variant="outlined"
            clickable={switchable}
            onClick={switchable ? () => onSwitchVersion?.(otherLabel) : undefined}
            sx={{
              mr: 1,
              fontFamily: "monospace",
              height: 18,
              cursor: switchable ? "pointer" : "default",
            }}
          />
        </Tooltip>
        <EditableStripCell
          verse={other}
          onEdit={onEditVerseText ? (plain, base) => onEditVerseText(otherLabel, plain, base) : undefined}
        />
      </Box>
      <Box>
        <Chip
          label={bibleVersion}
          size="small"
          color="primary"
          variant="filled"
          sx={{ mr: 1, fontFamily: "monospace", height: 18, fontWeight: 700 }}
        />
        <EditableStripCell
          verse={verse}
          onEdit={onEditVerseText ? (plain, base) => onEditVerseText(bibleVersion, plain, base) : undefined}
        />
      </Box>
      <Box>
        <Chip label={sourceLabel} size="small" sx={{ mr: 1, fontFamily: "monospace", height: 18 }} />
        <Box
          component="span"
          dir={sourceIsHebrew ? "rtl" : "ltr"}
          sx={{
            fontFamily: sourceIsHebrew
              ? '"Times New Roman","SBL Hebrew","Cardo",serif'
              : '"Times New Roman","Cardo",serif',
            fontSize: 20,
            lineHeight: 1.4,
            unicodeBidi: "isolate",
          }}
        >
          <SourceVerseTokens
            verseObjects={(source?.content as { verseObjects?: unknown[] } | null)?.verseObjects}
            lexiconMap={lexiconMap}
            twlForVerse={twlForVerse}
            verseNum={verseNum}
            fallbackText={source?.plain_text ?? ""}
          />
        </Box>
      </Box>
    </Box>
  );
}

// Inline-editable plain-text cell for the ULT/UST line of the verse
// strip. Mirrors the contentEditable + lastTextRef pattern used by
// ScriptureColumn's verse spans: outside updates only repaint the DOM
// when the user hasn't typed since the last sync, so the cursor doesn't
// jump under the user when the dialog state resets after a save.
function EditableStripCell({
  verse,
  onEdit,
}: {
  verse: VerseDto | null;
  onEdit?: (plain: string, base: VerseDto) => void;
}) {
  const elRef = useRef<HTMLSpanElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const text = verse?.plain_text ?? "";
  const lastTextRef = useRef(text);
  const lastSetRef = useRef<string | null>(null);
  useEffect(() => {
    if (!elRef.current) return;
    const dom = elRef.current.innerText;
    if (lastSetRef.current === null || dom === lastTextRef.current) {
      elRef.current.innerText = text;
      lastSetRef.current = text;
    }
    lastTextRef.current = text;
  }, [text]);
  if (!verse) return null;
  return (
    <span
      ref={elRef}
      contentEditable={!!onEdit}
      suppressContentEditableWarning
      spellCheck
      onInput={(e) => {
        if (!onEdit) return;
        const value = (e.currentTarget as HTMLSpanElement).innerText;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          onEdit(value, verse);
          lastTextRef.current = value;
          debounceRef.current = null;
        }, 350);
      }}
      style={{
        outline: "none",
        borderRadius: 3,
        padding: "1px 3px",
        background: "transparent",
      }}
    />
  );
}

// Render the source verse's \w tokens one at a time so each carries a
// lexicon tooltip; intervening text nodes (spaces, punctuation, maqaf) pass
// through untouched.
function SourceVerseTokens({
  verseObjects,
  lexiconMap,
  twlForVerse,
  verseNum,
  fallbackText,
}: {
  verseObjects: unknown[] | undefined;
  lexiconMap: Map<string, LexiconEntry | null>;
  twlForVerse: TwlRow[];
  verseNum: number;
  fallbackText: string;
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
        const src: SourceWord = {
          id: "",
          strong,
          lemma: String(o["lemma"] ?? ""),
          morph: String(o["morph"] ?? ""),
          occurrence: String(o["occurrence"] ?? "1"),
          occurrences: String(o["occurrences"] ?? "1"),
          content: text,
        };
        out.push(
          <Tooltip
            key={`w${out.length}`}
            title={
              <SourceTooltipBody
                source={src}
                lex={lexiconMap.get(strong) ?? null}
                twHint={twHintFor(twlForVerse, verseNum, text)}
              />
            }
            slotProps={{ popper: { sx: { pointerEvents: "none" } } }}
          >
            <span style={{ cursor: "help" }}>{text}</span>
          </Tooltip>,
        );
      } else if (o["type"] === "milestone") {
        walk((o["children"] as unknown[] | undefined) ?? []);
      }
    }
  };
  walk(verseObjects);
  return <>{out}</>;
}

function UnalignedBag({
  state,
  selectedIds,
  onChipClick,
  idsForDrag,
  onClearSelection,
  onDrop,
}: {
  state: AlignmentState;
  selectedIds: Set<string>;
  onChipClick: (id: string, shift: boolean) => void;
  idsForDrag: (id: string) => string[];
  onClearSelection: () => void;
  onDrop: (wordIds: string[]) => void;
}) {
  const [over, setOver] = useState(false);
  const unalignedIds = new Set(state.unaligned.map((w) => w.id));
  // Render every target word in stream (document) order so the left column
  // mirrors the verse. Aligned chips appear ghosted but stay in place —
  // this is the familiar layout from word-aligner-rcl, and it lets the
  // editor see at a glance which English words are still unattached.
  const streamWords = state.stream.flatMap((item, idx) =>
    item.kind === "word" ? [{ idx, word: item.word, aligned: item.alignedTo !== null }] : [],
  );
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
        // Reorder within the bag is intentionally a no-op: only ship ids
        // that aren't already in the unaligned pool back to the parent.
        const movable = ids.filter((id) => !unalignedIds.has(id));
        if (movable.length > 0) onDrop(movable);
      }}
      sx={{
        bgcolor: over ? "primary.50" : "grey.50",
        borderRight: "1px solid",
        borderColor: "divider",
        p: 1.5,
        overflowY: "auto",
      }}
    >
      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 1 }}>
        <Typography
          variant="caption"
          sx={{
            fontFamily: "monospace",
            color: "text.disabled",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            flex: 1,
          }}
        >
          words ({state.unaligned.length} unaligned)
          {selectedIds.size > 0 && ` · ${selectedIds.size} sel`}
        </Typography>
        {selectedIds.size > 0 && (
          <Tooltip title="clear selection">
            <IconButton size="small" onClick={onClearSelection} sx={{ p: 0.25 }}>
              <CloseIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
      <Typography
        variant="caption"
        sx={{ color: "text.disabled", display: "block", mb: 0.5, fontStyle: "italic" }}
      >
        click to add to selection · shift-click for range · drag any selected
      </Typography>
      <Stack spacing={0.5}>
        {streamWords.map(({ idx, word, aligned }) =>
          aligned ? (
            <GhostedChip
              key={`${word.id}-${idx}`}
              text={word.text}
              occurrence={word.occurrence}
              occurrences={word.occurrences}
            />
          ) : (
            <SelectableChip
              key={`${word.id}-${idx}`}
              text={word.text}
              occurrence={word.occurrence}
              occurrences={word.occurrences}
              selected={selectedIds.has(word.id)}
              onClick={(shift) => onChipClick(word.id, shift)}
              idsForDrag={() => idsForDrag(word.id)}
            />
          ),
        )}
      </Stack>
    </Box>
  );
}

function AlignmentGrid({
  groups,
  twlForVerse,
  lexiconMap,
  verseNum,
  onTargetsDrop,
  onSourceDrop,
  onExtractSource,
  onClearGroup,
}: {
  groups: AlignmentGroup[];
  twlForVerse: TwlRow[];
  lexiconMap: Map<string, LexiconEntry | null>;
  verseNum: number;
  onTargetsDrop: (dest: string, wordIds: string[]) => void;
  onSourceDrop: (destGroupId: string, sourceId: string) => void;
  onExtractSource: (sourceId: string) => void;
  onClearGroup: (groupId: string) => void;
}) {
  // Hebrew/Greek reads RTL, so order the alignment cards right-to-left to
  // match how the user reads the source verse. Card internals (the GL target
  // chips) stay LTR via `direction: ltr` on the card itself.
  return (
    <Box
      sx={{
        p: 1.5,
        overflowY: "auto",
        display: "flex",
        flexWrap: "wrap",
        gap: 1.5,
        alignContent: "flex-start",
        direction: "rtl",
      }}
    >
      {groups.map((g) => (
        <DropTargetBox
          key={g.id}
          groupId={g.id}
          onTargetsDrop={(wordIds) => onTargetsDrop(`g:${g.id}`, wordIds)}
          onSourceDrop={(sourceId) => onSourceDrop(g.id, sourceId)}
        >
          <Stack direction="row" alignItems="flex-start" sx={{ mb: 0.5, direction: "ltr" }}>
            <Stack direction="row" spacing={0.25} sx={{ flex: 1, direction: "rtl", flexWrap: "wrap" }}>
              {g.source.map((s) => (
                <SourceChip
                  key={s.id}
                  source={s}
                  lex={lexiconMap.get(s.strong) ?? null}
                  twHint={twHintFor(twlForVerse, verseNum, s.content ?? "")}
                  canExtract={g.source.length > 1}
                  onExtract={() => onExtractSource(s.id)}
                />
              ))}
            </Stack>
            {(g.targets.length > 0 || g.source.length > 1) && (
              <Tooltip title="clear alignment for this block (sends GL words back to the unaligned bag and splits compound source)">
                <IconButton
                  size="small"
                  onClick={() => onClearGroup(g.id)}
                  sx={{ ml: 0.5, p: 0.25, color: "text.disabled", "&:hover": { color: "error.main" } }}
                >
                  <CloseIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            )}
          </Stack>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" rowGap={0.5} sx={{ direction: "ltr" }}>
            {g.targets.length === 0 ? (
              <Typography
                variant="caption"
                sx={{ color: "text.disabled", fontStyle: "italic", px: 0.5 }}
              >
                drop here
              </Typography>
            ) : (
              g.targets.map((t) => (
                <SimpleDraggableChip
                  key={t.id}
                  wordId={t.id}
                  text={t.text}
                  occurrence={t.occurrence}
                  occurrences={t.occurrences}
                />
              ))
            )}
          </Stack>
        </DropTargetBox>
      ))}
    </Box>
  );
}

function DropTargetBox({
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
      variant="outlined"
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
        minWidth: 110,
        p: 0.75,
        bgcolor: over ? "primary.50" : "background.paper",
        borderColor: over ? "primary.main" : "divider",
        borderWidth: over ? 1.5 : 1,
        borderStyle: "solid",
        display: "flex",
        flexDirection: "column",
        direction: "ltr",
      }}
    >
      {children}
    </Paper>
  );
}

function SourceChip({
  source,
  lex,
  twHint,
  canExtract,
  onExtract,
}: {
  source: SourceWord;
  lex: LexiconEntry | null;
  twHint: string | null;
  canExtract: boolean;
  onExtract: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <Tooltip
      title={<SourceTooltipBody source={source} lex={lex} twHint={twHint} />}
      slotProps={{ popper: { sx: { pointerEvents: "none" } } }}
    >
      <Box
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        sx={{ position: "relative" }}
      >
        <Paper
          elevation={0}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(SOURCE_ID_MIME, source.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          sx={{
            position: "relative",
            bgcolor: "grey.900",
            color: "grey.50",
            px: 2,
            py: 0.75,
            minWidth: 70,
            fontFamily: '"Times New Roman", "SBL Hebrew", "Cardo", serif',
            fontSize: 26,
            lineHeight: 1.3,
            textAlign: "center",
            direction: "rtl",
            borderRadius: 0.5,
            cursor: "grab",
            "&:active": { cursor: "grabbing" },
          }}
        >
          {sourceShowsOccurrence(source) && (
            <Box
              sx={{
                position: "absolute",
                top: 2,
                right: 6,
                fontFamily: "monospace",
                fontSize: 11,
                fontWeight: 700,
                lineHeight: 1,
                color: "primary.light",
                direction: "ltr",
                pointerEvents: "none",
              }}
            >
              {source.occurrence}
            </Box>
          )}
          {source.content}
        </Paper>
        {canExtract && hover && (
          <Tooltip title="split this word out of the compound (creates a new alignment box)">
            <IconButton
              size="small"
              onClick={onExtract}
              sx={{
                position: "absolute",
                top: -8,
                right: -8,
                p: 0.125,
                bgcolor: "background.paper",
                border: "1px solid",
                borderColor: "divider",
                color: "text.secondary",
                "&:hover": { bgcolor: "error.main", color: "common.white", borderColor: "error.main" },
                boxShadow: 1,
              }}
            >
              <CloseIcon sx={{ fontSize: 12 }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>
    </Tooltip>
  );
}

function GhostedChip({ text, occurrence, occurrences }: { text: string; occurrence: string; occurrences: string }) {
  return (
    <Chip
      label={targetLabel(text, occurrence, occurrences, "text.disabled")}
      size="small"
      variant="outlined"
      sx={{
        fontFamily: '"Roboto","Helvetica",sans-serif',
        color: "text.disabled",
        bgcolor: "transparent",
        borderColor: "divider",
        borderLeft: "3px solid",
        borderLeftColor: "grey.300",
        userSelect: "none",
        opacity: 0.55,
        borderRadius: 0.5,
        "& .MuiChip-label": { overflow: "visible" },
      }}
    />
  );
}

function SelectableChip({
  text,
  occurrence,
  occurrences,
  selected,
  onClick,
  idsForDrag,
}: {
  text: string;
  occurrence: string;
  occurrences: string;
  selected: boolean;
  onClick: (shift: boolean) => void;
  idsForDrag: () => string[];
}) {
  return (
    <Chip
      label={targetLabel(text, occurrence, occurrences, selected ? "primary.contrastText" : "primary.dark")}
      size="small"
      variant={selected ? "filled" : "outlined"}
      color={selected ? "primary" : "default"}
      draggable
      onClick={(e) => onClick(e.shiftKey)}
      onDragStart={(e) => {
        const ids = idsForDrag();
        e.dataTransfer.setData(WORD_IDS_MIME, JSON.stringify(ids));
        // Also ship the legacy single-id form so the rest of the dialog
        // still works if multi-form parsing ever flakes.
        if (ids.length === 1) e.dataTransfer.setData("text/word-id", ids[0]);
        e.dataTransfer.effectAllowed = "move";
      }}
      sx={{
        cursor: "grab",
        fontFamily: '"Roboto","Helvetica",sans-serif',
        borderLeft: "3px solid",
        borderLeftColor: "primary.main",
        userSelect: "none",
        borderRadius: 0.5,
        "& .MuiChip-label": { overflow: "visible" },
      }}
    />
  );
}

function SimpleDraggableChip({
  wordId,
  text,
  occurrence,
  occurrences,
}: {
  wordId: string;
  text: string;
  occurrence: string;
  occurrences: string;
}) {
  return (
    <Chip
      label={targetLabel(text, occurrence, occurrences, "primary.dark")}
      size="small"
      variant="outlined"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(WORD_IDS_MIME, JSON.stringify([wordId]));
        e.dataTransfer.setData("text/word-id", wordId);
        e.dataTransfer.effectAllowed = "move";
      }}
      sx={{
        cursor: "grab",
        fontFamily: '"Roboto","Helvetica",sans-serif',
        borderLeft: "3px solid",
        borderLeftColor: "primary.main",
        bgcolor: "background.paper",
        borderRadius: 0.5,
        "& .MuiChip-label": { overflow: "visible" },
      }}
    />
  );
}

// Show the occurrence indicator when this Hebrew/Greek token appears
// more than once in the source verse, so the editor can tell which "כִּי"
// they're looking at.
function sourceShowsOccurrence(s: SourceWord): boolean {
  const n = parseInt(s.occurrences, 10);
  return Number.isFinite(n) && n > 1;
}

// Render a target chip's label with a small superscript occurrence number
// when the GL word repeats in the verse (e.g. "and²"). Plain string when
// the word is unique. `tone` controls the indicator color so it stays
// legible across the chip's variants (filled selected vs outlined etc.).
function targetLabel(
  text: string,
  occurrence: string,
  occurrences: string,
  tone: string,
): React.ReactNode {
  const n = parseInt(occurrences, 10);
  if (!Number.isFinite(n) || n <= 1) return text;
  return (
    <Box component="span" sx={{ display: "inline-flex", alignItems: "flex-start" }}>
      <span>{text}</span>
      <Box
        component="span"
        sx={{
          ml: "3px",
          mt: "-2px",
          fontFamily: "monospace",
          fontSize: 9,
          fontWeight: 700,
          lineHeight: 1,
          color: tone,
        }}
      >
        {occurrence}
      </Box>
    </Box>
  );
}

// Stable signature for an alignment group's source chain. Two groups with
// the same signature point at the same UHB tokens in the same order.
function sourceKey(g: AlignmentGroup): string {
  return g.source.map((s) => `${s.content}|${s.occurrence}`).join("~");
}

// Remove a compound group's inner source word(s) from DISPLAY when the same
// Hebrew content also lives in another group as the sole source. Comes up
// in Zec 2:8: the USFM nests אָמַר֮ inside the כִּי+כֹה+אָמַר֮ compound AND
// also tags it standalone (with a different occurrence) — UHB has just one
// אָמַר֮, so prod's editor shows it once. We keep the underlying compound
// intact in state.groups (so serialize round-trips); the dialog merely
// hides the overlap from the card. Compound groups never get stripped to
// zero — if every source overlaps, leave the chain as-is.
function stripCompoundOverlaps(groups: AlignmentGroup[]): AlignmentGroup[] {
  const standaloneContents = new Set<string>();
  for (const g of groups) {
    if (g.source.length === 1) {
      standaloneContents.add(nfc(g.source[0].content ?? ""));
    }
  }
  if (standaloneContents.size === 0) return groups;
  return groups.map((g) => {
    if (g.source.length <= 1) return g;
    const kept = g.source.filter((s) => !standaloneContents.has(nfc(s.content ?? "")));
    if (kept.length === g.source.length || kept.length === 0) return g;
    return { ...g, source: kept };
  });
}

// Visually collapse adjacent groups whose source chains are identical
// (same content + occurrence per source word). Two USFM milestones that
// point to the same UHB token — e.g. Zec 3:4's two `הָסִ֛ירוּ` milestones
// wrapping the split "Take ... off" phrase — become one card showing all
// the target chips together. The underlying AlignmentGroups stay separate
// in `state.groups` so serialize re-emits the original split, preserving
// GL word order.
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

// ---------- helpers ----------

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

// Find a TWL tw_link whose orig_words includes this source word, so the
// tooltip can point the editor at the article path (e.g. "names/yahweh").
// No definition text is shipped from the API yet — the link is the hint.
// TWL `orig_words` and milestone `content` come from different pipelines
// (TSV vs usfm-js JSON) and routinely differ in combining-mark order, so
// match through NFC.
function twHintFor(twlRows: TwlRow[], verseNum: number, content: string): string | null {
  if (!content) return null;
  const needle = nfc(content);
  for (const r of twlRows) {
    if (r.verse !== verseNum) continue;
    const ow = r.orig_words ?? "";
    if (!ow) continue;
    // The TWL orig_words may be a single word or a phrase. Match if any
    // whitespace-separated chunk equals our content.
    const chunks = ow.split(/\s+/).filter(Boolean).map(nfc);
    if (chunks.includes(needle)) {
      return twShort(r.tw_link);
    }
  }
  return null;
}

function twShort(link: string | null): string | null {
  if (!link) return null;
  const m = link.match(/\/bible\/([^/]+\/[^/]+)$/);
  return m ? m[1] : link;
}

// Walk the source verse's USFM tree and build an index map of every \w
// token. Each token gets two keys — by NFC text+occurrence ("t:כִּ֚י|1") and
// by strong+occurrence ("s:H3588a|2"). Text-based lookup is the primary
// path because milestones reference a specific x-content; strong-only
// collides when multiple source words share a Strong's (e.g. H0413 covers
// both אֶל and אֵלָיו in Zec 3:4, H3588a covers both כִּי in Zec 2:8).
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
