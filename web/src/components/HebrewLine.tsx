// Renders a Hebrew (UHB) or Greek (UGNT) verse one \w token at a time so
// each carries a lexicon Tooltip on hover, while still respecting the
// note-quote highlight set from highlight.ts. Used by the main scripture
// column in stacked, columns, and book modes — these versions are
// read-only, so we don't have to maintain a contentEditable cursor.

import { Tooltip, Box } from "@mui/material";
import type { LexiconEntry } from "../hooks/useLexicon";
import type { SourceWord } from "../lib/alignment";
import type { HighlightKey } from "../lib/highlight";
import type { TwlRow } from "../sync/api";
import { roleLineSx, wordHighlightStyles } from "../lib/highlightStyles";
import { SourceTooltipBody } from "./SourceTooltipBody";
import { buildTwHintMap, twHintFromMap } from "./UhbStrip";

interface Props {
  verseObjects: unknown[] | undefined | null;
  lexiconMap: Map<string, LexiconEntry | null>;
  highlights?: Set<HighlightKey> | null;
  // Reorder stoplight: words belonging to the moved note's candidate
  // predecessor (solid green underline) / successor (dashed red underline).
  // Composed on top of the active fill via inset box-shadow (green) + dashed
  // border-bottom (red); suppressed while a find hit owns the token (find
  // precedence, same as the yellow note highlight).
  prevHighlights?: Set<HighlightKey> | null;
  nextHighlights?: Set<HighlightKey> | null;
  // Find-overlay matches that should paint orange (be-find), overriding
  // any yellow note highlight on the same token. Keyed `${text}|${occ}`.
  findHighlights?: Set<HighlightKey> | null;
  // The single active match in this verse (the one the user is currently
  // navigated to via prev/next). Painted with a stronger color than the
  // other find hits so the user can see which one is "selected".
  activeFindKey?: HighlightKey | null;
  // Used when the parent supplies a flat fallback string (e.g. when the
  // verseObjects tree is missing or invalid).
  fallbackText?: string;
  // The chapter's TWL rows + this verse's number. When both are present each
  // \w token's tooltip gains the "tW" hint (translationWords link) — the same
  // hint the aligner's UHB strip / cards show. Optional so non-source columns
  // (ULT/UST) and callers without TWL data render exactly as before.
  twl?: TwlRow[];
  verseNum?: number;
}

export function HebrewLine({ verseObjects, lexiconMap, highlights, prevHighlights, nextHighlights, findHighlights, activeFindKey, fallbackText, twl, verseNum }: Props) {
  if (!Array.isArray(verseObjects)) {
    return <>{fallbackText ?? ""}</>;
  }
  // Precompute the per-verse orig-word → tw hint lookup once (see buildTwHintMap)
  // so the token walk is an O(1) Map.get per \w instead of re-splitting every
  // TWL row's orig_words per token.
  const twHints = twl && verseNum != null ? buildTwHintMap(twl, verseNum) : null;
  const items: React.ReactNode[] = [];
  const walk = (nodes: unknown[]) => {
    for (const n of nodes ?? []) {
      const o = n as Record<string, unknown> | null;
      if (!o) continue;
      if (o["type"] === "text") {
        items.push(
          <span key={`t${items.length}`}>{String(o["text"] ?? "")}</span>,
        );
      } else if (o["type"] === "word" && o["tag"] === "w") {
        const text = String(o["text"] ?? "");
        const strong = String(o["strong"] ?? "");
        const occ = parseInt(String(o["occurrence"] ?? "1"), 10) || 1;
        const key: HighlightKey = `${text}|${occ}`;
        const isFindHit = !!findHighlights && findHighlights.has(key);
        const isActiveFind = !!activeFindKey && activeFindKey === key;
        const isHighlighted = !!highlights && highlights.has(key);
        const isPrev = !!prevHighlights && prevHighlights.has(key);
        const isNext = !!nextHighlights && nextHighlights.has(key);
        const src: SourceWord = {
          id: "",
          strong,
          lemma: String(o["lemma"] ?? ""),
          morph: String(o["morph"] ?? ""),
          occurrence: String(occ),
          occurrences: String(o["occurrences"] ?? "1"),
          content: text,
        };
        const wordSpan = (
          <Box
            component="span"
            sx={(theme) => {
              const mode = theme.palette.mode;
              const hl = wordHighlightStyles(mode);
              // Find hits own the token (orange) and suppress both the yellow
              // note fill and the reorder stoplight lines, matching the <mark>
              // render path's find precedence.
              const roleSx =
                !isFindHit && !isActiveFind ? roleLineSx(mode, isPrev, isNext) : undefined;
              return {
                cursor: "help",
                ...(isActiveFind
                  ? hl.findActive
                  : isFindHit
                    ? hl.find
                    : isHighlighted
                      ? hl.hl
                      : {}),
                ...(roleSx ?? {}),
              };
            }}
          >
            {text}
          </Box>
        );
        items.push(
          <Tooltip
            key={`w${items.length}`}
            title={<SourceTooltipBody source={src} lex={lexiconMap.get(strong) ?? null} twHint={twHints ? twHintFromMap(twHints, text) : null} />}
            enterDelay={0}
            enterNextDelay={0}
            slotProps={{ popper: { sx: { pointerEvents: "none" } } }}
          >
            {wordSpan}
          </Tooltip>,
        );
      } else if (o["type"] === "milestone") {
        walk((o["children"] as unknown[] | undefined) ?? []);
      }
    }
  };
  walk(verseObjects);
  return <>{items}</>;
}

// Collect every \w token's raw Strong's from a verseObjects tree. Used by
// callers that want to pre-load lexicon entries for a chapter at a time.
export function collectStrongs(verseObjects: unknown[] | null | undefined): string[] {
  if (!Array.isArray(verseObjects)) return [];
  const out: string[] = [];
  const walk = (nodes: unknown[]) => {
    for (const n of nodes ?? []) {
      const o = n as Record<string, unknown> | null;
      if (!o) continue;
      if (o["type"] === "word" && o["tag"] === "w") {
        const s = String(o["strong"] ?? "");
        if (s) out.push(s);
      } else if (o["type"] === "milestone") {
        walk((o["children"] as unknown[] | undefined) ?? []);
      }
    }
  };
  walk(verseObjects);
  return out;
}
