// Shared hover / highlight types + the tone→box-shadow helper, used by the
// alignment editor (AlignmentPanel), the extracted UHB strip (UhbStrip), and
// the side-by-side aligner (SideBySideAligner). Extracted so those modules can
// reference the types without importing the large AlignmentPanel component.

// Hebrew hover is identified by source-token POSITION, not `strong|occurrence`:
// occurrence counts the exact surface text (cantillation included), so two
// same-Strong words with different pointing both carry occurrence "1" — 236
// such collisions across ZEC's UHB alone made strong-keyed hover light the
// wrong word. Position is unique by construction and survives multi-verse
// spans. Positions are UNION-relative in the side-by-side aligner (each panel
// translates via its `posOffset`); standalone panels have offset 0.
//
// English hover carries `positions`: the union positions of the hovered
// word's group's source words, so the shared strip and the opposite panel can
// light their counterparts without sharing group ids (ids are per-panel).
export type HoverHighlight =
  | { kind: "english"; key: string; groupId: string | null; positions: number[] }
  | { kind: "hebrew"; pos: number; groupId: string | null }
  | null;

export type HighlightTone = "exact" | "linked" | null;

export interface HighlightCtx {
  colorize: boolean;
  hoverLink: boolean;
  // When false, Hebrew source words suppress their lexical-info tooltip on
  // hover (the hover-highlight bridge still fires). Default true.
  showSourceInfo: boolean;
  // Per-(text|occurrence) hue degree assignment for the "colors" toggle.
  // Only duplicate-occurrence words get an entry; missing = no accent.
  matchHues: Map<string, number>;
  themeMode: "light" | "dark";
  onEnglishEnter: (wordId: string, text: string, occurrence: string, groupIdOverride?: string) => void;
  // Hebrew tokens identify by union-relative source position (see
  // HoverHighlight). The strip passes its walk index; alignment cards pass
  // the position resolved from the group's source word.
  onHebrewEnter: (pos: number, groupIdOverride?: string) => void;
  onLeave: () => void;
  englishHighlight: (
    wordId: string,
    text: string,
    occurrence: string,
    groupIdOverride?: string,
  ) => HighlightTone;
  hebrewHighlight: (
    pos: number,
    groupIdOverride?: string,
  ) => HighlightTone;
}

// Soft outer-ring "glow" applied to chips / Hebrew tokens when the current
// hover targets them or their alignment-group partner. Two tones so the
// exact-match and the cross-language linked partner are distinguishable.
// Dark mode lifts the ring alpha noticeably so saturated colors still
// register against the dark canvas; light mode gets a small bump.
export function hoverShadow(tone: HighlightTone, mode: "light" | "dark"): string | undefined {
  const alpha = mode === "dark" ? 1 : 0.6;
  if (tone === "exact") return `0 0 0 2px rgba(49,173,227,${alpha})`;
  if (tone === "linked") return `0 0 0 2px rgba(229,157,51,${alpha})`;
  return undefined;
}
