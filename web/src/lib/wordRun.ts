// The edit engine's word pattern, defined once for every module that splits
// verse text into words: replace.ts (edit tiers), alignmentReassembly.ts
// (reassembly) and curlyVerse.ts (quote reconciliation). If these disagreed,
// the modules would draw word boundaries differently and alignments would be
// lost silently (#1290/#1293), so there is exactly one copy (#1301).
//
// This module imports nothing, so any lib module can import it without a
// cycle (replace.ts imports alignmentReassembly.ts; curlyVerse.ts imports
// replace.ts).

// Word characters: Unicode letters/marks/numbers plus the zero-width joiner
// (U+200D) and word-joiner (U+2060) that ride inside some Hebrew/Greek tokens.
// Kept as a bracketed character class: replace.ts builds WORD_CORE_RE from it
// and slices the brackets off for its negated class.
export const WORD_CHAR = "[\\p{L}\\p{M}\\p{N}\\u200d\\u2060]";

// A word run plus its intra-word connectors. \p{N} is required because the UST
// writes literal counts (`\w 30\w*`) for measurements — "30" must be a
// draggable chip. Connectors bind two runs into ONE token: hyphen, straight /
// curly apostrophe (don't, hello-world, Isaiah's), and — ONLY between digits —
// the grouping comma, so "300,000" aligns as one chip instead of splitting like
// the legacy tools (string-punctuation-tokenizer / tCreate) did. A comma not
// flanked by digits ("a, b") stays a separator. ‘ (U+2018) is not a connector.
//
// Global and shared: callers use it only through matchAll / String#match /
// .source, which leave lastIndex at 0. Never call .exec or .test on it; build
// a local RegExp from .source instead.
export const WORD_RUN_RE = new RegExp(
  `${WORD_CHAR}+(?:[-'’]${WORD_CHAR}+|(?<=\\p{N}),\\p{N}+)*`,
  "gu",
);
