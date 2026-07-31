// Quote-picker popup. Replaces the inline UHB click mode shipped in
// d17bea0a: instead of toggling tokens directly on the scripture column,
// the translator opens a Popper anchored beside the active note card
// that shows UHB / ULT / UST as three rows of clickable chips.
//
// Why a popper: clicking the contentEditable ULT/UST in-place would fight
// the cursor; a dedicated picker is clearer when the goal is "pick which
// instance of this token I mean," especially for repeated words (the
// three "the"s in NUM 20:1 each map to a different Hebrew word).
//
// Selection is keyed by `${text}|${occurrence}` against the UHB tokens —
// the same shape buildQuoteFromSelection consumes. Clicking a UHB chip
// toggles its key directly; clicking an ULT/UST chip toggles its FULL
// ancestor chain (outer-to-inner zaln milestones), so a click on "first"
// inside zaln(בַחֹדֶשׁ) > zaln(הָרִאשׁוֹן) toggles both Hebrew words at once.

import { useEffect, useMemo, useState } from "react";
import {
  Popper,
  Paper,
  Stack,
  Box,
  Chip,
  Button,
  IconButton,
  Typography,
  Divider,
  ClickAwayListener,
  Tooltip,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { collectTargetTokens, buildQuoteFromSelection, tokenKey } from "../lib/quoteBuilder";
import type { HighlightKey } from "../lib/highlight";
import { collectSourceWords } from "../lib/highlight";
import type { SourceAncestor, TargetToken } from "../lib/quoteBuilder";
import type { LexiconEntry } from "../hooks/useLexicon";
import type { SourceWord } from "../lib/alignment";
import { isHebrewBook } from "../lib/sourceSearch";
import { SourceTooltipBody } from "./SourceTooltipBody";

// Which row a shift-click range is anchored in. A range never spans rows.
type Row = "src" | "ult" | "ust";

interface Props {
  open: boolean;
  anchorEl: HTMLElement | null;
  book: string;
  chapter: number;
  verse: number;
  uhbVerseObjects: unknown[] | null;
  ultVerseObjects: unknown[] | null;
  ustVerseObjects: unknown[] | null;
  // Pre-loaded Strong's → lexicon entry map. Shell already maintains this
  // for the scripture column's HebrewLine hover tooltips; the picker
  // reuses it so the UHB chips show the same gloss/morphology card.
  lexiconMap: Map<string, LexiconEntry | null>;
  selectedKeys: Set<HighlightKey>;
  onToggleKey: (key: HighlightKey) => void;
  // Additive range select for shift-click — adds every key in the range
  // without toggling already-selected words off.
  onSelectKeys: (keys: HighlightKey[]) => void;
  onCancel: () => void;
  onCommit: () => void;
}

export function QuoteBuilderPopper({
  open,
  anchorEl,
  book,
  chapter,
  verse,
  uhbVerseObjects,
  ultVerseObjects,
  ustVerseObjects,
  lexiconMap,
  selectedKeys,
  onToggleKey,
  onSelectKeys,
  onCancel,
  onCommit,
}: Props) {
  const uhbTokens = useMemo(() => collectUhbChips(uhbVerseObjects), [uhbVerseObjects]);
  const ultTokens = useMemo(
    () => collectTargetTokens(ultVerseObjects, uhbVerseObjects),
    [ultVerseObjects, uhbVerseObjects],
  );
  const ustTokens = useMemo(
    () => collectTargetTokens(ustVerseObjects, uhbVerseObjects),
    [ustVerseObjects, uhbVerseObjects],
  );

  // OT books read their source from UHB (Hebrew, RTL); NT books from UGNT
  // (Greek, LTR). Shell hands us whichever exists, so label and direction
  // derive from the book code rather than hardcoding Hebrew.
  const sourceIsHebrew = isHebrewBook(book);
  const sourceLabel = sourceIsHebrew ? "UHB" : "UGNT";

  // Preview of the would-be quote string. Re-runs cheaply on every toggle
  // since collectUhbChips / matchGroupsAt scan an in-memory tree.
  const preview = useMemo(
    () => buildQuoteFromSelection(uhbVerseObjects, selectedKeys),
    [uhbVerseObjects, selectedKeys],
  );

  // Anchor for shift-click range selection — the last chip clicked without
  // shift. Scoped to a row ("src" | "ult" | "ust") so a shift-click only
  // extends a range within the same row it was started in. Reset whenever the
  // picker re-targets a different verse so a stale index can't span the wrong
  // token list.
  const [anchor, setAnchor] = useState<{ row: Row; index: number } | null>(null);
  useEffect(() => {
    setAnchor(null);
  }, [book, chapter, verse]);

  // UHB/UGNT source row: plain click toggles one word; shift-click adds the
  // inclusive range from the anchor to the clicked chip.
  const handleSourceClick = (index: number, e: React.MouseEvent) => {
    const tok = uhbTokens[index];
    const key = tokenKey(tok.text, tok.occurrence);
    if (e.shiftKey && anchor?.row === "src") {
      const [lo, hi] = anchor.index <= index ? [anchor.index, index] : [index, anchor.index];
      onSelectKeys(uhbTokens.slice(lo, hi + 1).map((t) => tokenKey(t.text, t.occurrence)));
    } else {
      onToggleKey(key);
    }
    setAnchor({ row: "src", index });
  };

  // ULT/UST target row: plain click toggles the clicked word's full source
  // chain (handleEnglishClick); shift-click adds the union of source chains
  // across the inclusive range from the anchor to the clicked chip.
  const handleTargetClick = (
    row: "ult" | "ust",
    tokens: TargetToken[],
    index: number,
    e: React.MouseEvent,
  ) => {
    const tok = tokens[index];
    if (tok.sources.length === 0) return;
    if (e.shiftKey && anchor?.row === row) {
      const [lo, hi] = anchor.index <= index ? [anchor.index, index] : [index, anchor.index];
      onSelectKeys(tokens.slice(lo, hi + 1).flatMap((t) => t.sources.map((s) => s.key)));
    } else {
      handleEnglishClick(tok.sources);
    }
    setAnchor({ row, index });
  };

  const handleEnglishClick = (sources: SourceAncestor[]) => {
    if (sources.length === 0) return;
    // Compute current chain coverage. If every ancestor is already in the
    // set, treat the click as "remove the chain"; otherwise add the
    // missing pieces. Avoids the awkward middle state where one click adds
    // some and the next click toggles them back individually.
    // Keys are nfc-normalized via tokenKey() so they match what
    // buildQuoteFromSelection's UhbWord lookup expects.
    const keys = sources.map((a) => a.key);
    const allPresent = keys.every((k) => selectedKeys.has(k));
    for (const k of keys) {
      const present = selectedKeys.has(k);
      if (allPresent && present) onToggleKey(k);
      else if (!allPresent && !present) onToggleKey(k);
    }
  };

  return (
    <Popper
      open={open}
      anchorEl={anchorEl}
      placement="left-start"
      modifiers={[
        { name: "offset", options: { offset: [0, 8] } },
        { name: "preventOverflow", options: { padding: 8 } },
      ]}
      sx={{ zIndex: (t) => t.zIndex.modal }}
    >
      <ClickAwayListener onClickAway={onCancel}>
        <Paper
          elevation={8}
          sx={{
            width: 560,
            maxHeight: "80vh",
            overflow: "auto",
            border: "1px solid",
            borderColor: "divider",
          }}
        >
          {/* Header */}
          <Stack
            direction="row"
            alignItems="center"
            sx={{
              px: 1.5,
              py: 0.75,
              borderBottom: "1px solid",
              borderColor: "divider",
              bgcolor: "primary.50",
            }}
          >
            <Typography
              variant="caption"
              sx={{ fontFamily: "monospace", color: "primary.main", fontWeight: 700 }}
            >
              Build quote · {book} {chapter}:{verse}
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Typography variant="caption" color="text.secondary" sx={{ mr: 1 }}>
              shift-click for a range
            </Typography>
            <IconButton size="small" onClick={onCancel} aria-label="close">
              <CloseIcon fontSize="small" />
            </IconButton>
          </Stack>

          {/* Source row — UHB or UGNT */}
          <Section label={sourceLabel} rtl={sourceIsHebrew}>
            {uhbTokens.length === 0 ? (
              <EmptyHint>no source words for this verse</EmptyHint>
            ) : (
              uhbTokens.map((tok, i) => {
                // Always use nfc-normalized keys — UHB \w text drifts from
                // zaln x-content in combining-mark order, so a raw
                // `${text}|${occ}` comparison would miss cross-row matches.
                const key = tokenKey(tok.text, tok.occurrence);
                const selected = selectedKeys.has(key);
                const src: SourceWord = {
                  id: "",
                  strong: tok.strong,
                  lemma: tok.lemma,
                  morph: tok.morph,
                  occurrence: String(tok.occurrence),
                  occurrences: String(tok.occurrences),
                  content: tok.text,
                };
                return (
                  <SourceChip
                    key={`${key}|${tok.position}`}
                    text={tok.text}
                    occurrence={tok.occurrence}
                    selected={selected}
                    rtl={sourceIsHebrew}
                    onClick={(e) => handleSourceClick(i, e)}
                    lexiconBody={
                      <SourceTooltipBody
                        source={src}
                        lex={lexiconMap.get(tok.strong) ?? null}
                      />
                    }
                  />
                );
              })
            )}
          </Section>

          {/* ULT row */}
          <Section label="ULT">
            {ultTokens.length === 0 ? (
              <EmptyHint>no ULT alignment for this verse</EmptyHint>
            ) : (
              ultTokens.map((tok, i) => (
                <TargetChip
                  key={`ult|${tok.position}`}
                  text={tok.text}
                  occurrence={tok.occurrence}
                  selected={chainSelected(tok.sources, selectedKeys)}
                  hasChain={tok.sources.length > 0}
                  onClick={(e) => handleTargetClick("ult", ultTokens, i, e)}
                  tooltip={
                    tok.sources.length === 0
                      ? "no Hebrew alignment for this word"
                      : tok.sources.map((s) => s.content).join(" › ")
                  }
                />
              ))
            )}
          </Section>

          {/* UST row */}
          <Section label="UST">
            {ustTokens.length === 0 ? (
              <EmptyHint>no UST alignment for this verse</EmptyHint>
            ) : (
              ustTokens.map((tok, i) => (
                <TargetChip
                  key={`ust|${tok.position}`}
                  text={tok.text}
                  occurrence={tok.occurrence}
                  selected={chainSelected(tok.sources, selectedKeys)}
                  hasChain={tok.sources.length > 0}
                  onClick={(e) => handleTargetClick("ust", ustTokens, i, e)}
                  tooltip={
                    tok.sources.length === 0
                      ? "no Hebrew alignment for this word"
                      : tok.sources.map((s) => s.content).join(" › ")
                  }
                />
              ))
            )}
          </Section>

          <Divider />

          {/* Footer */}
          <Stack
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{ px: 1.5, py: 1 }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                Preview
              </Typography>
              <Typography
                sx={{
                  fontFamily: '"Times New Roman","SBL Hebrew","Cardo",serif',
                  fontSize: 19,
                  direction: sourceIsHebrew ? "rtl" : "ltr",
                  textAlign: sourceIsHebrew ? "right" : "left",
                  minHeight: 24,
                  color: preview ? "text.primary" : "text.disabled",
                }}
              >
                {preview ? preview.quote : "—"}
              </Typography>
              {preview && preview.occurrence > 1 && (
                <Typography variant="caption" color="text.secondary">
                  occurrence {preview.occurrence}
                </Typography>
              )}
            </Box>
            <Button size="small" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              size="small"
              variant="contained"
              disabled={!preview}
              onClick={onCommit}
            >
              Use selection
            </Button>
          </Stack>
        </Paper>
      </ClickAwayListener>
    </Popper>
  );
}

function Section({
  label,
  rtl,
  children,
}: {
  label: string;
  rtl?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Box sx={{ px: 1.5, py: 1, borderBottom: "1px dashed", borderColor: "divider" }}>
      <Typography
        variant="caption"
        sx={{
          fontFamily: "monospace",
          textTransform: "uppercase",
          color: "text.secondary",
          letterSpacing: 0.5,
          display: "block",
          mb: 0.5,
        }}
      >
        {label}
      </Typography>
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          gap: 0.5,
          direction: rtl ? "rtl" : "ltr",
          // justify-content stays flex-start for both directions. In RTL,
          // flex-start IS the visual right; flex-end would push wrapped
          // lines to the visual left and leave the 2nd line orphaned.
          justifyContent: "flex-start",
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="caption" color="text.disabled" sx={{ fontStyle: "italic" }}>
      {children}
    </Typography>
  );
}

function SourceChip({
  text,
  occurrence,
  selected,
  rtl,
  onClick,
  lexiconBody,
}: {
  text: string;
  occurrence: number;
  selected: boolean;
  rtl?: boolean;
  onClick: (e: React.MouseEvent) => void;
  // When provided, wraps the chip in the same SourceTooltipBody hovercard
  // the scripture column's HebrewLine uses — strong/lemma/morph/gloss.
  lexiconBody?: React.ReactNode;
}) {
  const chip = (
    <Chip
      label={text}
      size="small"
      variant={selected ? "filled" : "outlined"}
      color={selected ? "primary" : "default"}
      onClick={onClick}
      sx={{
        fontFamily: rtl
          ? '"Times New Roman","SBL Hebrew","Cardo",serif'
          : '"Roboto","Helvetica",sans-serif',
        fontSize: rtl ? 19 : 13,
        height: rtl ? 30 : 26,
        cursor: "pointer",
        userSelect: "none",
        "& .MuiChip-label": { px: 1 },
      }}
      title={!lexiconBody && occurrence > 1 ? `occurrence ${occurrence}` : undefined}
    />
  );
  if (!lexiconBody) return chip;
  return (
    <Tooltip
      title={lexiconBody}
      enterDelay={0}
      enterNextDelay={0}
      slotProps={{ popper: { sx: { pointerEvents: "none" } } }}
    >
      <Box sx={{ display: "inline-flex" }}>{chip}</Box>
    </Tooltip>
  );
}

function TargetChip({
  text,
  occurrence,
  selected,
  hasChain,
  onClick,
  tooltip,
}: {
  text: string;
  occurrence: number;
  selected: boolean;
  hasChain: boolean;
  onClick: (e: React.MouseEvent) => void;
  tooltip: string;
}) {
  const chip = (
    <Chip
      label={text}
      size="small"
      variant={selected ? "filled" : "outlined"}
      color={selected ? "primary" : "default"}
      onClick={hasChain ? onClick : undefined}
      sx={{
        fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif',
        fontSize: 13,
        height: 26,
        cursor: hasChain ? "pointer" : "not-allowed",
        opacity: hasChain ? 1 : 0.5,
        userSelect: "none",
        "& .MuiChip-label": { px: 1 },
      }}
    />
  );
  return (
    <Tooltip
      title={
        <Box sx={{ fontFamily: 'monospace', fontSize: 11 }}>
          {tooltip}
          {occurrence > 1 && <Box>occurrence {occurrence}</Box>}
        </Box>
      }
      arrow
    >
      <Box sx={{ display: "inline-flex" }}>{chip}</Box>
    </Tooltip>
  );
}

function chainSelected(
  sources: SourceAncestor[],
  selectedKeys: Set<HighlightKey>,
): boolean {
  if (sources.length === 0) return false;
  return sources.every((a) => selectedKeys.has(a.key));
}

// The picker's UHB row, decorated from the SHARED source-word walk
// (collectSourceWords in lib/highlight.ts) rather than re-walking the tree.
// This component used to keep its own private copy of the walk, purely because
// it needs per-word strong/lemma/morph for the chip's SourceTooltipBody lexicon
// hovercard and the library walker did not carry them. That copy is what PR
// #389 fixed last: with only the library walkers counting occurrence, this row
// still keyed by the (always-1) `x-occurrence` attribute, so on DAN 6:3 —
// כָּ⁠ל (U+2060 WORD JOINER) then bare כָּל, folded together by matchNorm — both
// tokens keyed `כָּל|1`, FOUR chips lit for a three-word selection, and clicking
// the phantom 4th to clear it would have dropped the real first כָּל from the
// quote. This row mints the keys the chips are PAINTED by, so any divergence
// from the builder shows up as chips whose selected state disagrees with the
// actual selection. Sharing the walk is what keeps them from diverging again.
interface UhbChip {
  text: string;
  occurrence: number;
  occurrences: number;
  position: number;
  strong: string;
  lemma: string;
  morph: string;
}

function collectUhbChips(verseObjects: unknown[] | null): UhbChip[] {
  if (!Array.isArray(verseObjects)) return [];
  return collectSourceWords(verseObjects).map((w) => ({
    text: w.text,
    // The COUNTED value, matching what buildQuoteFromSelection keys by.
    occurrence: w.surfaceOccurrence,
    // Display-only, straight off the node — the hovercard shows "n of m".
    occurrences: parseInt(String(w.node["occurrences"] ?? "1"), 10) || 1,
    position: w.position,
    strong: String(w.node["strong"] ?? ""),
    lemma: String(w.node["lemma"] ?? ""),
    morph: String(w.node["morph"] ?? ""),
  }));
}
