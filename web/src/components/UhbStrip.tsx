import { type ReactNode, useMemo } from "react";
import { Box, Typography, Stack, IconButton, Tooltip } from "@mui/material";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import type { SourceWord } from "../lib/alignment";
import type { TwlRow, VerseDto } from "../sync/api";
import type { LexiconEntry } from "../hooks/useLexicon";
import { type HighlightCtx, hoverShadow } from "../lib/highlightTypes";
import { nfc } from "../lib/hebrew";
import { SourceTooltipBody } from "./SourceTooltipBody";

// ─── UHB source strip ────────────────────────────────────────────────
// The verse's Hebrew/Greek source text, rendered as hover-aware tokens. Lifted
// out of AlignmentPanel so the single-panel aligner and the side-by-side
// aligner's shared strip render the same tokenizer + tooltip.
export function UhbStrip({
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
            fontSize: 22,
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
  // Precompute the per-verse TWL hint lookup once (see buildTwHintMap) so the
  // token walk doesn't re-split + re-nfc every row's orig_words per token.
  const twHints = useMemo(
    () => buildTwHintMap(twlForVerse, verseNum),
    [twlForVerse, verseNum],
  );
  if (!Array.isArray(verseObjects)) return <>{fallbackText}</>;
  const out: ReactNode[] = [];
  // Word-token walk index — the hover identity (see highlightTypes.ts). Must
  // count exactly the nodes buildSourceIndexMap counts (word tags, descending
  // through milestones) so strip positions line up with the panel's resolved
  // group positions. In the side-by-side shared strip this verse is the union
  // span, so the index is union-relative natively.
  let wordPos = 0;
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
            pos={wordPos}
            source={src}
            lex={lexiconMap.get(strong) ?? null}
            twHint={twHintFromMap(twHints, text)}
            hctx={hctx}
          />,
        );
        wordPos++;
      } else if (
        o["type"] === "milestone" ||
        // \d (Psalm superscription) is type:"section" but its content IS
        // alignable verse body — descend so its \w tokens render and count
        // toward wordPos exactly as buildSourceIndexMap counts them. Mirrors
        // collectMilestoneRuns in highlight.ts.
        (o["type"] === "section" && o["tag"] === "d")
      ) {
        walk((o["children"] as unknown[] | undefined) ?? []);
      }
    }
  };
  walk(verseObjects);
  return <>{out}</>;
}

function SourceVerseToken({
  text,
  pos,
  source,
  lex,
  twHint,
  hctx,
}: {
  text: string;
  pos: number;
  source: SourceWord;
  lex: LexiconEntry | null;
  twHint: string | null;
  hctx: HighlightCtx;
}) {
  const tone = hctx.hebrewHighlight(pos);
  const showInfo = hctx.showSourceInfo;
  return (
    <Tooltip
      title={showInfo ? <SourceTooltipBody source={source} lex={lex} twHint={twHint} /> : ""}
      disableHoverListener={!showInfo}
      disableFocusListener={!showInfo}
      disableTouchListener={!showInfo}
      slotProps={{ popper: { sx: { pointerEvents: "none" } } }}
    >
      <Box
        component="span"
        onMouseEnter={() => hctx.onHebrewEnter(pos)}
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

// ─── TWL hint helpers (shared by the strip + the alignment cards) ───────
// Precomputed nfc(orig-word) → tw hint map for one verse, so a per-token
// lookup during hover re-renders is an O(1) Map.get instead of re-splitting
// and re-nfc-ing every TWL row's orig_words for every token on every render
// (the dual aligner rebuilds both card grids + strip on each mousemove).
// "First row wins" is preserved exactly: rows are scanned in order and a key
// already present is never overwritten, so the value (including a null hint
// from a row whose tw_link doesn't resolve) matches twHintFor's first-match
// return for the same needle.
export function buildTwHintMap(twlRows: TwlRow[], verseNum: number): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const r of twlRows) {
    if (r.verse !== verseNum) continue;
    const ow = r.orig_words ?? "";
    if (!ow) continue;
    const hint = twShort(r.tw_link);
    for (const chunk of ow.split(/\s+/).filter(Boolean)) {
      const key = nfc(chunk);
      if (!map.has(key)) map.set(key, hint);
    }
  }
  return map;
}

// Look up a precomputed map (see buildTwHintMap). Returns null both when the
// content isn't a TWL orig-word and when its first matching row's link
// didn't resolve — the same two cases twHintFor folds into a null return.
export function twHintFromMap(map: Map<string, string | null>, content: string): string | null {
  if (!content) return null;
  return map.get(nfc(content)) ?? null;
}

function twShort(link: string | null): string | null {
  if (!link) return null;
  const m = link.match(/\/bible\/([^/]+\/[^/]+)$/);
  return m ? m[1] : link;
}
