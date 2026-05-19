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

import { useMemo } from "react";
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
import { collectTargetTokens, buildQuoteFromSelection } from "../lib/quoteBuilder";
import type { HighlightKey } from "../lib/highlight";

interface Props {
  open: boolean;
  anchorEl: HTMLElement | null;
  book: string;
  chapter: number;
  verse: number;
  uhbVerseObjects: unknown[] | null;
  ultVerseObjects: unknown[] | null;
  ustVerseObjects: unknown[] | null;
  selectedKeys: Set<HighlightKey>;
  onToggleKey: (key: HighlightKey) => void;
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
  selectedKeys,
  onToggleKey,
  onCancel,
  onCommit,
}: Props) {
  const uhbTokens = useMemo(() => collectUhbWords(uhbVerseObjects), [uhbVerseObjects]);
  const ultTokens = useMemo(() => collectTargetTokens(ultVerseObjects), [ultVerseObjects]);
  const ustTokens = useMemo(() => collectTargetTokens(ustVerseObjects), [ustVerseObjects]);

  // Preview of the would-be quote string. Re-runs cheaply on every toggle
  // since collectUhbWords / matchGroupsAt scan an in-memory tree.
  const preview = useMemo(
    () => buildQuoteFromSelection(uhbVerseObjects, selectedKeys),
    [uhbVerseObjects, selectedKeys],
  );

  const handleEnglishClick = (sources: Array<{ content: string; occurrence: number }>) => {
    if (sources.length === 0) return;
    // Compute current chain coverage. If every ancestor is already in the
    // set, treat the click as "remove the chain"; otherwise add the
    // missing pieces. Avoids the awkward middle state where one click adds
    // some and the next click toggles them back individually.
    const keys = sources.map((a) => `${a.content}|${a.occurrence}` as HighlightKey);
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
            <IconButton size="small" onClick={onCancel} aria-label="close">
              <CloseIcon fontSize="small" />
            </IconButton>
          </Stack>

          {/* UHB row */}
          <Section label="UHB" rtl>
            {uhbTokens.length === 0 ? (
              <EmptyHint>no source words for this verse</EmptyHint>
            ) : (
              uhbTokens.map((tok) => {
                const key: HighlightKey = `${tok.text}|${tok.occurrence}`;
                const selected = selectedKeys.has(key);
                return (
                  <SourceChip
                    key={`${key}|${tok.position}`}
                    text={tok.text}
                    occurrence={tok.occurrence}
                    selected={selected}
                    rtl
                    onClick={() => onToggleKey(key)}
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
              ultTokens.map((tok) => (
                <TargetChip
                  key={`ult|${tok.position}`}
                  text={tok.text}
                  occurrence={tok.occurrence}
                  selected={chainSelected(tok.sources, selectedKeys)}
                  hasChain={tok.sources.length > 0}
                  onClick={() => handleEnglishClick(tok.sources)}
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
              ustTokens.map((tok) => (
                <TargetChip
                  key={`ust|${tok.position}`}
                  text={tok.text}
                  occurrence={tok.occurrence}
                  selected={chainSelected(tok.sources, selectedKeys)}
                  hasChain={tok.sources.length > 0}
                  onClick={() => handleEnglishClick(tok.sources)}
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
                  fontSize: 18,
                  direction: "rtl",
                  textAlign: "right",
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
          justifyContent: rtl ? "flex-end" : "flex-start",
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
}: {
  text: string;
  occurrence: number;
  selected: boolean;
  rtl?: boolean;
  onClick: () => void;
}) {
  return (
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
        fontSize: rtl ? 18 : 13,
        height: rtl ? 30 : 26,
        cursor: "pointer",
        userSelect: "none",
        "& .MuiChip-label": { px: 1 },
      }}
      title={occurrence > 1 ? `occurrence ${occurrence}` : undefined}
    />
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
  onClick: () => void;
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
  sources: Array<{ content: string; occurrence: number }>,
  selectedKeys: Set<HighlightKey>,
): boolean {
  if (sources.length === 0) return false;
  return sources.every((a) => selectedKeys.has(`${a.content}|${a.occurrence}`));
}

// Helper analogue of collectUhbWords (which is private in quoteBuilder).
// We need the same shape here so the picker's UHB row mirrors what the
// quote builder operates on. Kept tiny / inline rather than exporting the
// internal helper.
function collectUhbWords(
  verseObjects: unknown[] | null,
): Array<{ text: string; occurrence: number; position: number }> {
  if (!Array.isArray(verseObjects)) return [];
  const out: Array<{ text: string; occurrence: number; position: number }> = [];
  function walk(nodes: unknown[]) {
    for (const node of nodes ?? []) {
      const o = node as Record<string, unknown> | null;
      if (!o) continue;
      if (o["type"] === "word" && o["tag"] === "w") {
        const text = String(o["text"] ?? "");
        const occurrence = parseInt(String(o["occurrence"] ?? "1"), 10) || 1;
        out.push({ text, occurrence, position: out.length });
      } else if (o["type"] === "milestone") {
        const children = (o["children"] as unknown[] | undefined) ?? [];
        walk(children);
      }
    }
  }
  walk(verseObjects);
  return out;
}
