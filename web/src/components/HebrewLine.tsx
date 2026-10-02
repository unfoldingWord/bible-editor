// Renders a Hebrew (UHB) or Greek (UGNT) verse one \w token at a time so
// each shows the lexical hover box, while still respecting the note-quote
// highlight set from highlight.ts. Used by the main scripture column in
// stacked, columns, and book modes — these versions are read-only, so we
// don't have to maintain a contentEditable cursor.
//
// Words are plain <span className> elements; the line carries the one
// stylesheet for their highlight classes and the one hover box, which reads
// the hovered word back from its data-w index (#899). A per-word MUI Tooltip
// and sx callback cost a Popper fiber and an emotion serialization per word —
// thousands for a long chapter in columns or book mode.

import { memo, useMemo, useState } from "react";
import { Box, Tooltip } from "@mui/material";
import type { LexiconEntry } from "../hooks/useLexicon";
import type { SourceWord } from "../lib/alignment";
import type { HighlightKey } from "../lib/highlight";
import type { TwlRow } from "../sync/api";
import { hebrewLineSx, hebrewWordClass, sourceWordOf, wordOccurrence } from "../lib/hebrewLine";
import { SourceTooltipBody } from "./SourceTooltipBody";
import { pinLex, usePinnedLexRefreshFrom } from "./PinnedLexBox";
import { lexPopperPlacement } from "./LexTooltip";
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

// Built once per mode: the line's sx is the same object every render.
const LINE_SX = {
  light: { unicodeBidi: "isolate", ...hebrewLineSx("light") },
  dark: { unicodeBidi: "isolate", ...hebrewLineSx("dark") },
} as const;

type Hover = {
  word: HTMLElement;
  source: SourceWord;
  placed: ReturnType<typeof lexPopperPlacement>;
  open: boolean;
};

export const HebrewLine = memo(function HebrewLine({ verseObjects, lexiconMap, highlights, prevHighlights, nextHighlights, findHighlights, activeFindKey, fallbackText, twl, verseNum }: Props) {
  // Precompute the per-verse orig-word → tw hint lookup once (see buildTwHintMap)
  // so a hover is an O(1) Map.get instead of re-splitting every TWL row's
  // orig_words. Memoized on [twl, verseNum] so it isn't rebuilt (re-splitting
  // + nfc()-normalizing every TWL row) on every render.
  const twHints = useMemo(
    () => (twl && verseNum != null ? buildTwHintMap(twl, verseNum) : null),
    [twl, verseNum],
  );
  // The word spans depend only on the verse and its highlight sets, so a
  // lexicon batch landing or a hover doesn't rebuild them. `words[i]` is the
  // \w node behind the span with data-w={i}.
  const { items, words } = useMemo(() => {
    const items: React.ReactNode[] = [];
    const words: Record<string, unknown>[] = [];
    if (!Array.isArray(verseObjects)) return { items, words };
    const walk = (nodes: unknown[]) => {
      for (const n of nodes ?? []) {
        const o = n as Record<string, unknown> | null;
        if (!o) continue;
        if (o["type"] === "text") {
          items.push(<span key={`t${items.length}`}>{String(o["text"] ?? "")}</span>);
        } else if (o["type"] === "word" && o["tag"] === "w") {
          const text = String(o["text"] ?? "");
          const key: HighlightKey = `${text}|${wordOccurrence(o)}`;
          const className = hebrewWordClass({
            find: !!findHighlights && findHighlights.has(key),
            activeFind: !!activeFindKey && activeFindKey === key,
            note: !!highlights && highlights.has(key),
            prev: !!prevHighlights && prevHighlights.has(key),
            next: !!nextHighlights && nextHighlights.has(key),
          });
          items.push(
            <span key={`w${items.length}`} className={className} data-w={words.length}>
              {text}
            </span>,
          );
          words.push(o);
        } else if (o["type"] === "milestone") {
          walk((o["children"] as unknown[] | undefined) ?? []);
        }
      }
    };
    walk(verseObjects);
    return { items, words };
  }, [verseObjects, highlights, prevHighlights, nextHighlights, findHighlights, activeFindKey]);
  // A word pinned before its lexicon entry loaded fills in when it arrives.
  usePinnedLexRefreshFrom(lexiconMap);
  // The hover box is mounted only while a word is hovered (and fading out).
  const [hover, setHover] = useState<Hover | null>(null);

  if (!Array.isArray(verseObjects)) {
    return <>{fallbackText ?? ""}</>;
  }

  const wordAt = (e: React.SyntheticEvent): { el: HTMLElement; source: SourceWord } | null => {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-w]") : null;
    if (!el || !e.currentTarget.contains(el)) return null;
    const node = words[Number(el.dataset.w)];
    return node ? { el, source: sourceWordOf(node) } : null;
  };
  const close = () => setHover((h) => (h && h.open ? { ...h, open: false } : h));
  const lexOf = (s: SourceWord) => lexiconMap.get(s.strong) ?? null;
  const twHintOf = (s: SourceWord) => (twHints ? twHintFromMap(twHints, s.content ?? "") : null);

  // Every caller renders Hebrew (UHB) here — UGNT/Greek goes through the
  // offset painter instead (see the callers' own "UHB renders via
  // HebrewLine" comments) — so direction is intrinsic to the component, not
  // inherited. All three current callers already wrap this in their own
  // rtl + isolate span; that's a convention, not a guarantee, so isolation
  // is set here too (#843) rather than relied on from outside.
  return (
    <Box
      component="span"
      dir="rtl"
      data-lex-line
      sx={(theme) => LINE_SX[theme.palette.mode]}
      onMouseOver={(e) => {
        const w = wordAt(e);
        if (!w) return close();
        if (hover?.open && hover.word === w.el) return;
        setHover({ word: w.el, source: w.source, placed: lexPopperPlacement(w.el), open: true });
      }}
      onMouseLeave={close}
      // Double-click pins the same lexical info into the app's one pinned
      // lexical box (PinnedLexBox), whose text can be selected and copied —
      // the hover box is pointerEvents:none and can't be.
      onDoubleClick={(e) => {
        const w = wordAt(e);
        if (w) pinLex(w.source, lexOf(w.source), twHintOf(w.source));
      }}
    >
      {items}
      {hover && (
        <Tooltip
          open={hover.open}
          onClose={close}
          disableHoverListener
          disableFocusListener
          disableTouchListener
          title={
            <SourceTooltipBody source={hover.source} lex={lexOf(hover.source)} twHint={twHintOf(hover.source)} pinHint />
          }
          slotProps={{
            popper: { sx: { pointerEvents: "none" }, ...hover.placed },
            // Unmount once faded out, so lines hovered earlier hold no Tooltip.
            // (This replaces the Popper's own onExited, which only matters
            // to a Popper that stays mounted.)
            transition: { onExited: () => setHover((h) => (h && !h.open ? null : h)) },
          }}
        >
          {/* The box is placed against the hovered word (placed.anchorEl);
              MUI just needs an element child. */}
          <span />
        </Tooltip>
      )}
    </Box>
  );
});

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
