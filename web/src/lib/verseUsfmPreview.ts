// Renders one verse's stored content_json to USFM text for the verse-history
// dialog's "USFM" view (issue #951). The dialog's snapshot/diff modes compare
// only `plain_text`, so a version that changed only markers or alignment (a
// trailing `\p` or `\ts\*` a nightly Door43 sync added, a re-pointed `\zaln`)
// reads identical to the version before it. Display only: nothing here feeds
// a save, and the input tree is never modified.

import usfm from "usfm-js";

// One version's USFM render. "none": no stored tree (older AI / re-import
// entries logged only plain_text). "error": usfm-js threw on the tree.
export type VerseUsfm =
  | { kind: "usfm"; text: string }
  | { kind: "none" }
  | { kind: "error" };

// Render a single verse to USFM, starting at its `\v N` marker. Always `\v N`,
// even for a bridged row: history entries don't record their own verse_end,
// and labelling every version with the live row's range showed older versions
// a `\v 6-9` (or `\v 6`) they never had (#951 review).
export function renderVerseUsfm(content: unknown, chapter: number, verseNum: number): VerseUsfm {
  const verseObjects = (content as { verseObjects?: unknown } | null)?.verseObjects;
  if (!Array.isArray(verseObjects) || verseObjects.length === 0) return { kind: "none" };
  const verseKey = verseNum === 0 ? "front" : String(verseNum);
  try {
    // Clone first: usfm.toUSFM edits the nodes it is given in place (trims a
    // paragraph's trailing whitespace, strips text/type off a whitespace node
    // after `\p`; #932, same fix as exportUsfm.ts). History entries' `content`
    // is what "Switch to vN" re-saves, so rendering must not touch it.
    const rendered = usfm.toUSFM(
      { chapters: { [String(chapter)]: { [verseKey]: { verseObjects: structuredClone(verseObjects) } } } },
      { forcedNewLines: true },
    );
    // toUSFM prefixes the chapter marker; the dialog header already shows it.
    return { kind: "usfm", text: rendered.replace(/^\\c\s+\d+\n?/, "").trimEnd() };
  } catch {
    return { kind: "error" };
  }
}

// `\zaln-s |attr="…" …\*` opening milestone, attributes included.
const ZALN_START_RE = /\\zaln-s\s*\|[^\n]*?\\\*/g;
// Bare `\zaln-e\*` closing milestone.
const ZALN_END_RE = /\\zaln-e\\\*/g;
// `\w text|attr="…" …\w*`, capturing the word text so it survives.
const WORD_ATTRS_RE = /\\w ([^|\\]*)\|[^\\]*?\\w\*/g;

// Strip `\zaln-s`/`\zaln-e` milestones and `\w` attribute payloads, leaving
// word text and every other marker (`\p`, `\q`, `\ts\*`, …) untouched.
export function stripAlignmentNoise(usfmText: string): string {
  return usfmText
    .replace(ZALN_START_RE, "")
    .replace(ZALN_END_RE, "")
    .replace(WORD_ATTRS_RE, (_m, word: string) => `\\w ${word.trimEnd()}\\w*`);
}

// `\w text\w*` left by stripAlignmentNoise, unwrapped to its text.
const BARE_WORD_RE = /\\w ([^\\]*?)\\w\*/g;

// Text and non-alignment markers only, for classifying a change. Beyond
// stripAlignmentNoise this unwraps `\w` and collapses whitespace: aligning bare
// text wraps each word in `\w` and (with forcedNewLines) breaks the words onto
// separate lines, which is alignment, not a marker change.
function markerSkeleton(usfmText: string): string {
  return stripAlignmentNoise(usfmText).replace(BARE_WORD_RE, "$1").replace(/\s+/g, " ").trim();
}

// The alignment layer alone: every `\zaln-s …\*`, `\zaln-e\*` and `\w …\w*`
// token in order, attributes included, with all other text and markers
// dropped. Two versions with the same plain text have the same word text, so
// this differs only when milestones, `\w` wrapping or attributes changed.
const ALIGNMENT_TOKEN_RE = /\\zaln-s\s*\|[^\n]*?\\\*|\\zaln-e\\\*|\\w [^\\]*?\\w\*/g;
function alignmentLayer(usfmText: string): string {
  return (usfmText.match(ALIGNMENT_TOKEN_RE) ?? []).join("\n");
}

export type HiddenChange = "markers" | "alignment" | "both";

// What a version changed that plain text can't show, relative to its
// predecessor. "markers": a non-alignment marker differs (a `\p`, `\q1`,
// `\ts\*`) and the alignment layer does not. "alignment": only `\zaln`
// milestones, `\w` wrappers / attributes, or the whitespace between aligned
// words differ, so the reader must turn attributes on to see it. "both": the
// same version changed markers and alignment.
// null: plain text changed, is missing, or either side has no USFM.
export function classifyHiddenChange(
  prevPlain: string | null,
  plain: string | null,
  prevUsfm: VerseUsfm,
  usfmNow: VerseUsfm,
): HiddenChange | null {
  if (prevPlain == null || plain == null || prevPlain !== plain) return null;
  if (prevUsfm.kind !== "usfm" || usfmNow.kind !== "usfm") return null;
  if (prevUsfm.text === usfmNow.text) return null;
  const markers = markerSkeleton(prevUsfm.text) !== markerSkeleton(usfmNow.text);
  if (!markers) return "alignment";
  return alignmentLayer(prevUsfm.text) !== alignmentLayer(usfmNow.text) ? "both" : "markers";
}
