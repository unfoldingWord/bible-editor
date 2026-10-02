// Pure pieces of HebrewLine (#899). HebrewLine renders each \w as a plain
// <span className> with static classes instead of a per-word sx callback, and
// one hover box per line reads the hovered word back from its data-w index.
// The classes and the line stylesheet that paints them live here so the
// highlight precedence can be tested without React.

import type { SourceWord } from "./alignment";
import { roleLineSx, wordHighlightStyles } from "./highlightStyles.ts";

export type WordMarks = {
  find: boolean; // a Find match (orange)
  activeFind: boolean; // the Find match the user is on (stronger orange)
  note: boolean; // in the active note's quote (yellow)
  prev: boolean; // reorder stoplight: the previous note's quote (green underline)
  next: boolean; // reorder stoplight: the next note's quote (red dashed underline)
};

// Find > note > reorder stoplight. A Find hit owns the word: it drops both the
// note fill and the stoplight lines, matching the <mark> render path. The note
// fill and the two stoplight lines paint different properties, so they combine.
export function hebrewWordClass(m: WordMarks): string {
  if (m.activeFind) return "be-hw be-hw-fa";
  if (m.find) return "be-hw be-hw-f";
  let c = "be-hw";
  if (m.note) c += " be-hw-hl";
  if (m.prev) c += " be-hw-prev";
  if (m.next) c += " be-hw-next";
  return c;
}

// The stylesheet for those classes, set once on the line (not per word).
// Same colors as wordHighlightStyles / roleLineSx, which the <mark> path uses.
export function hebrewLineSx(mode: "light" | "dark") {
  const hl = wordHighlightStyles(mode);
  return {
    "& .be-hw": { cursor: "help" },
    "& .be-hw-hl": hl.hl,
    "& .be-hw-f": hl.find,
    "& .be-hw-fa": hl.findActive,
    "& .be-hw-prev": roleLineSx(mode, true, false),
    "& .be-hw-next": roleLineSx(mode, false, true),
  };
}

// The hover box's and pinned box's view of one usfm-js \w node.
export function sourceWordOf(o: Record<string, unknown>): SourceWord {
  return {
    id: "",
    strong: String(o["strong"] ?? ""),
    lemma: String(o["lemma"] ?? ""),
    morph: String(o["morph"] ?? ""),
    occurrence: String(wordOccurrence(o)),
    occurrences: String(o["occurrences"] ?? "1"),
    content: String(o["text"] ?? ""),
  };
}

export function wordOccurrence(o: Record<string, unknown>): number {
  return parseInt(String(o["occurrence"] ?? "1"), 10) || 1;
}
