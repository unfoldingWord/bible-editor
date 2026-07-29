// Highlight palettes used by ScriptureColumn, DocColumn, BookView,
// HebrewLine, and AlignmentPanel. In light mode these are saturated
// pastels that read with dark text on top. In dark mode the text is
// light, so saturated pastels become unreadable — we drop to translucent
// washes of the same hue so the dark surface bleeds through and the
// light text stays legible. Outlines stay saturated to keep the marker
// visible.

type Mode = "light" | "dark";

// Reorder "stoplight" channel colours. The moved note keeps the yellow be-hl
// fill; its predecessor and successor both ride the BOTTOM edge so they compose
// with the fill (and each other) instead of fighting for one background.
// Green/red are the conventional stoplight pair, but the meaning is carried by
// the LINE STYLE (prev = solid green underline, next = dashed red underline) so
// it survives red/green colour-blindness now that both sit on the same edge — a
// word claimed by both shows a green-solid-over-red-dashed double underline.
// Dark mode lifts the hues so they read on the dark canvas.
const ROLE_PREV_COLOR = { light: "#2e7d32", dark: "#66bb6a" }; // green — previous note
const ROLE_NEXT_COLOR = { light: "#d32f2f", dark: "#ef5350" }; // red — next note

// sx fragment for a token that belongs to the prev and/or next note. Prev draws
// a solid green underline via inset box-shadow (no reflow); next draws a dashed
// red underline via border-bottom — on an inline element this paints without
// shifting surrounding line boxes. The two properties don't collide, so a word
// claimed by both composes into a double underline. Returns undefined when
// neither role applies. Shared by the <mark> stylesheet (markHighlightSx) and
// HebrewLine's per-token sx so both channels match.
export function roleLineSx(
  mode: Mode,
  isPrev: boolean,
  isNext: boolean,
): { boxShadow?: string; borderBottom?: string } | undefined {
  if (!isPrev && !isNext) return undefined;
  const sx: { boxShadow?: string; borderBottom?: string } = {};
  if (isPrev) sx.boxShadow = `inset 0 -3px 0 ${mode === "dark" ? ROLE_PREV_COLOR.dark : ROLE_PREV_COLOR.light}`;
  if (isNext) sx.borderBottom = `3px dashed ${mode === "dark" ? ROLE_NEXT_COLOR.dark : ROLE_NEXT_COLOR.light}`;
  return sx;
}

// `& mark.be-hl-prev` / `.be-hl-next` channel rules for the reorder stoplight,
// spread into both light/dark markHighlightSx branches. The :not(.be-hl) reset
// clears the browser-default <mark> yellow on prev/next-ONLY words without
// touching the active fill (active+prev keeps yellow bg + green underline).
// Prev and next now paint different CSS properties (box-shadow vs border-bottom)
// so they compose without conflict; the combined selector is kept for clarity.
function roleMarkSx(mode: Mode) {
  return {
    "& mark.be-hl-prev:not(.be-hl), & mark.be-hl-next:not(.be-hl)": {
      backgroundColor: "transparent",
      color: "inherit",
      padding: "0 2px",
    },
    "& mark.be-hl-prev": { ...roleLineSx(mode, true, false), borderRadius: 0 },
    "& mark.be-hl-next": { ...roleLineSx(mode, false, true), borderRadius: 0 },
    "& mark.be-hl-prev.be-hl-next": { ...roleLineSx(mode, true, true) },
  };
}

// Layout styles for paragraph / poetry / blank / section markers
// emitted by renderHighlightedHTML and renderEditableHTML. Shared across
// rows / columns / book views via markHighlightSx so any container that
// already pulls highlight styles also gets marker layout.
function paragraphLayoutSx(mode: Mode) {
  const tokenBg = mode === "dark" ? "rgba(49, 173, 227, 0.18)" : "rgba(49, 173, 227, 0.14)";
  const tokenBorder = mode === "dark" ? "rgba(49, 173, 227, 0.55)" : "rgba(1, 66, 99, 0.45)";
  const tokenText = mode === "dark" ? "#7fd1f0" : "#014263"; // Inspire/Ocean
  return {
    // `.be-*` (not `div.be-*`) so these also apply when the wrapper class is
    // put directly on the active verse's `be-verse-span` (a <span>) in columns
    // mode — that's how the leading paragraph break drifted from the previous
    // verse is restored on the active/editable verse without changing the
    // contentEditable's text. `be-blank`/`be-ts` stay div-only: they're
    // standalone spacer/divider blocks and must never style a content span.
    "& .be-line": { display: "block" },
    "& .be-para": { display: "block", marginTop: "0.6em" },
    "& .be-q": { display: "block", textIndent: 0 },
    "& .be-q-1": { paddingLeft: "1.25em" },
    "& .be-q-2": { paddingLeft: "2.5em" },
    "& .be-q-3": { paddingLeft: "3.75em" },
    "& .be-q-4": { paddingLeft: "5em" },
    "& div.be-blank": {
      display: "block",
      height: "0.6em",
      lineHeight: "0.6em",
      pointerEvents: "none",
    },
    "& .be-pi-1": { paddingLeft: "1em" },
    "& .be-pi-2": { paddingLeft: "2em" },
    "& .be-pi-3": { paddingLeft: "3em" },
    "& .be-pc": { textAlign: "center" },
    "& .be-mi": { paddingLeft: "1em" },
    "& .be-nb": { marginTop: 0 },
    "& span.be-d": {
      fontStyle: "italic",
      fontSize: "0.95em",
      color: mode === "dark" ? "#bfd5e0" : "#345e74",
    },
    "& span.be-tok": {
      display: "inline-block",
      padding: "0 4px",
      marginRight: "2px",
      fontSize: "0.78em",
      fontFamily: "Consolas, Menlo, monospace",
      color: tokenText,
      backgroundColor: tokenBg,
      border: `1px solid ${tokenBorder}`,
      borderRadius: "3px",
      verticalAlign: "0.08em",
      // Selectable + caret-targetable so users can backspace through
      // a chip's text (e.g. \q1 → \q2) instead of having to remove and
      // re-insert the marker.
      cursor: "text",
    },
    "& div.be-ts": {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      margin: "0.6em 0",
      "&::before, &::after": {
        content: '""',
        flex: 1,
        borderTop: `1px dashed ${tokenBorder}`,
        opacity: 0.6,
      },
      "& span.be-tok-ts": {
        flex: "0 0 auto",
      },
    },
  };
}

// Book mode: run the chunk-divider rule STRAIGHT ACROSS. The shared style
// splits the line either side of a centered `\ts\*` label, which reads as ragged
// once the book scroll stacks many of them down a narrow column. Here the dashed
// rule is the div's own full-width border and the label is hidden — book mode is
// a reading/scanning view, and the divider is still labelled (and editable) in
// rows mode, which is where markers are actually worked on. Hiding the label with
// `display:none` keeps its text in `textContent`, so the contentEditable save
// baseline (extractEditableText) still lines up and the divider round-trips.
export const bookTsDividerSx = {
  "& div.be-ts": {
    display: "block",
    height: 0,
    borderTop: "1px dashed",
    // A single, definite line colour rather than a faint one behind an opacity
    // multiplier — the rule has to stay comfortably visible when it's the only
    // thing marking the chunk boundary in this view.
    borderColor: "text.disabled",
    margin: "0.75em 0",
    "&::before, &::after": { content: "none", border: "none", flex: "none" },
    "& span.be-tok-ts": { display: "none" },
  },
} as const;

// Columns mode: same divider, far quieter. The parallel-column doc view is dense
// continuous prose, where a full-strength dashed rule plus a monospace label
// competes with the text for attention. Keep both — they still mark the chunk
// boundary — but drop them close to the background.
// Deliberately NOT dimmed by stacking a container opacity on top of a muted
// text colour — that compounds to near-invisible and makes people squint. One
// dimming step only: a real (readable) secondary text colour for the label, and
// the rule itself lightened via its own opacity.
// NOTE: this is a COMPLETE restatement of `div.be-ts`, not a patch. Spreading it
// after markHighlightSx replaces that key's object wholesale, so any base
// property omitted here (display:flex, the ::before/::after `content`, their
// flex:1) is simply lost — which silently deleted the rule lines the first time.
export const columnsTsDividerSx = {
  "& div.be-ts": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    margin: "0.4em 0",
    "&::before, &::after": {
      content: '""',
      flex: 1,
      borderTop: "1px dotted",
      borderColor: "text.disabled",
      opacity: 0.7,
    },
    "& span.be-tok-ts": {
      flex: "0 0 auto",
      fontSize: "0.68rem",
      border: "none",
      background: "none",
      padding: 0,
      color: "text.secondary",
    },
  },
} as const;

// `& mark.be-*` selectors used inside <Box>/<Paper> sx blocks for the
// scripture columns and book/doc views.
export function markHighlightSx(mode: Mode) {
  const layout = paragraphLayoutSx(mode);
  if (mode === "dark") {
    return {
      ...layout,
      ...roleMarkSx(mode),
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
    ...layout,
    ...roleMarkSx(mode),
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
