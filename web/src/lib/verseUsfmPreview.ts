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

// Render a single verse to USFM, starting at its `\v` marker. `verseEnd` >
// `verseNum` renders a bridge (`\v 6-9`), matching exportUsfm's "N-M" key.
export function renderVerseUsfm(
  content: unknown,
  chapter: number,
  verseNum: number,
  verseEnd?: number | null,
): VerseUsfm {
  const verseObjects = (content as { verseObjects?: unknown } | null)?.verseObjects;
  if (!Array.isArray(verseObjects) || verseObjects.length === 0) return { kind: "none" };
  const verseKey =
    verseNum === 0
      ? "front"
      : verseEnd != null && verseEnd > verseNum
        ? `${verseNum}-${verseEnd}`
        : String(verseNum);
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

// What a version changed that plain text can't show, relative to its
// predecessor. "markers": the USFM differs even with alignment attributes
// hidden (a `\p`, `\q1`, `\ts\*`). "alignment": only the attributes /
// milestones differ, so the reader must turn attributes on to see it.
// null: plain text changed, is missing, or either side has no USFM.
export function classifyHiddenChange(
  prevPlain: string | null,
  plain: string | null,
  prevUsfm: VerseUsfm,
  usfmNow: VerseUsfm,
): "markers" | "alignment" | null {
  if (prevPlain == null || plain == null || prevPlain !== plain) return null;
  if (prevUsfm.kind !== "usfm" || usfmNow.kind !== "usfm") return null;
  if (prevUsfm.text === usfmNow.text) return null;
  return stripAlignmentNoise(prevUsfm.text) !== stripAlignmentNoise(usfmNow.text) ? "markers" : "alignment";
}
