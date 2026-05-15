// Highlight palettes used by ScriptureColumn, DocColumn, BookView,
// HebrewLine, and AlignmentPanel. In light mode these are saturated
// pastels that read with dark text on top. In dark mode the text is
// light, so saturated pastels become unreadable — we drop to translucent
// washes of the same hue so the dark surface bleeds through and the
// light text stays legible. Outlines stay saturated to keep the marker
// visible.

type Mode = "light" | "dark";

// `& mark.be-*` selectors used inside <Box>/<Paper> sx blocks for the
// scripture columns and book/doc views.
export function markHighlightSx(mode: Mode) {
  if (mode === "dark") {
    return {
      "& mark.be-hl": {
        backgroundColor: "rgba(255, 244, 138, 0.22)",
        padding: "0 2px",
        borderRadius: 0.5,
        color: "inherit",
      },
      "& mark.be-find": {
        backgroundColor: "rgba(255, 217, 102, 0.28)",
        outline: "1px solid rgba(251, 191, 36, 0.9)",
        padding: "0 1px",
        borderRadius: 0.5,
        color: "inherit",
      },
      "& mark.be-find-active": {
        backgroundColor: "rgba(251, 146, 60, 0.4)",
        outline: "2px solid #fb923c",
      },
    };
  }
  return {
    "& mark.be-hl": {
      backgroundColor: "#fff48a",
      padding: "0 2px",
      borderRadius: 0.5,
      color: "inherit",
    },
    "& mark.be-find": {
      backgroundColor: "#ffd966",
      outline: "1px solid #d97706",
      padding: "0 1px",
      borderRadius: 0.5,
      color: "inherit",
    },
    "& mark.be-find-active": {
      backgroundColor: "#fb923c",
      outline: "2px solid #c2410c",
    },
  };
}

// Inline chip styles for HebrewLine — same palette, applied directly to
// a span's sx rather than via a `mark` selector.
export function wordHighlightStyles(mode: Mode) {
  if (mode === "dark") {
    return {
      hl: {
        backgroundColor: "rgba(255, 244, 138, 0.22)",
        padding: "0 2px",
        borderRadius: 0.5,
      },
      find: {
        backgroundColor: "rgba(255, 217, 102, 0.28)",
        outline: "1px solid rgba(251, 191, 36, 0.9)",
        padding: "0 1px",
        borderRadius: 0.5,
      },
      findActive: {
        backgroundColor: "rgba(251, 146, 60, 0.4)",
        outline: "2px solid #fb923c",
        padding: "0 1px",
        borderRadius: 0.5,
      },
    };
  }
  return {
    hl: {
      backgroundColor: "#fff48a",
      padding: "0 2px",
      borderRadius: 0.5,
    },
    find: {
      backgroundColor: "#ffd966",
      outline: "1px solid #d97706",
      padding: "0 1px",
      borderRadius: 0.5,
    },
    findActive: {
      backgroundColor: "#fb923c",
      outline: "2px solid #c2410c",
      padding: "0 1px",
      borderRadius: 0.5,
    },
  };
}

// Per-chip match-color treatment (Option D, per design handoff).
//
// Rule: "same word, distinct hues". When the same English word appears
// more than once in a verse, every occurrence is assigned a hue at least
// three steps away on the palette wheel from any other occurrence of
// that word. Hues may repeat across different words. Single-occurrence
// words are not colored.
//
// Visual: neutral chip body, 3px colored bottom border, colored
// superscript number. The neutral body keeps the strip readable as text
// first, color cue second.

// OKLCH hue degrees — 11 evenly-distributed positions on the wheel.
const HUES = [25, 60, 90, 130, 165, 195, 225, 260, 290, 320, 350];

// Per-(text|occurrence) hue degree assignment. Returns a map keyed by
// `${text}|${occurrence}` → hue degree, only for words whose lemma
// appears more than once in the verse.
//
// items must be supplied in stream order — assignment within a duplicate
// group walks left-to-right.
export function assignChipHues(
  items: Array<{ key: string; lemma: string }>,
): Map<string, number> {
  const groups = new Map<string, string[]>();
  for (const { key, lemma } of items) {
    let bucket = groups.get(lemma);
    if (!bucket) {
      bucket = [];
      groups.set(lemma, bucket);
    }
    bucket.push(key);
  }
  const result = new Map<string, number>();
  let startOffset = 0;
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    const step = Math.max(3, Math.floor(HUES.length / bucket.length));
    for (let i = 0; i < bucket.length; i++) {
      const idx = (startOffset + i * step) % HUES.length;
      result.set(bucket[i], HUES[idx]);
    }
    startOffset = (startOffset + 1) % HUES.length;
  }
  return result;
}

// Bottom-border accent color for a chip given its assigned hue.
export function chipAccentColor(hueDeg: number, mode: Mode): string {
  return mode === "dark"
    ? `oklch(0.72 0.16 ${hueDeg})`
    : `oklch(0.64 0.18 ${hueDeg})`;
}

// Superscript-number color for a chip given its assigned hue.
export function chipSupColor(hueDeg: number, mode: Mode): string {
  return mode === "dark"
    ? `oklch(0.82 0.18 ${hueDeg})`
    : `oklch(0.45 0.20 ${hueDeg})`;
}
