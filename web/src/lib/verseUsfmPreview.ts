// Renders one verse's stored content_json to USFM text for the verse-history
// dialog's "USFM" view (issue #951). The dialog's existing snapshot/diff modes
// compare only `plain_text`, so a version that changed only markers or
// alignment — a re-pointed `\zaln`, a trailing `\p` or `\ts\*` a nightly
// Door43 sync added — reads identical to the version before it. This module
// is read-only display support: nothing here ever feeds a save.

import usfm from "usfm-js";

// Render a single verse's content_json to a USFM string, scoped to just that
// verse (no chapter/header wrapper). Returns null when `content` isn't a
// usable verseObjects tree — older AI/reimport history entries only logged
// `plain_text`, never `content` (see VerseHistoryEntry.restorable).
export function renderVerseUsfm(
  content: unknown,
  chapter: number,
  verseNum: number,
): string | null {
  const verseObjects = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
  if (!Array.isArray(verseObjects) || verseObjects.length === 0) return null;
  const verseKey = verseNum === 0 ? "front" : String(verseNum);
  const rendered = usfm.toUSFM(
    { chapters: { [String(chapter)]: { [verseKey]: { verseObjects } } } },
    { forcedNewLines: true },
  );
  // toUSFM always prefixes the chapter marker for the chapter it was given —
  // strip it, since the dialog already shows chapter:verse in its header.
  return rendered.replace(/^\\c\s+\d+\n?/, "").trimEnd();
}

// Matches a `\zaln-s |attr="…" …\*` opening milestone, attributes included.
const ZALN_START_RE = /\\zaln-s\s*\|[^\n]*?\\\*/g;
// Matches the bare `\zaln-e\*` closing milestone (it carries no attributes).
const ZALN_END_RE = /\\zaln-e\\\*/g;
// Matches `\w text|attr="…" …\w*`, capturing the word text so it survives.
const WORD_ATTRS_RE = /\\w ([^|\\]*)\|[^\\]*?\\w\*/g;

// Strip `\zaln-s`/`\zaln-e` alignment milestones and `\w` attribute payloads
// from rendered USFM, leaving the bare word text and every other marker
// (`\p`, `\q`, `\ts\*`, …) untouched. Alignment carries Strong's numbers,
// morph codes and occurrence counts that swamp the structural changes this
// view exists to surface. Display-only — never touches storage.
export function stripAlignmentNoise(usfmText: string): string {
  return usfmText
    .replace(ZALN_START_RE, "")
    .replace(ZALN_END_RE, "")
    .replace(WORD_ATTRS_RE, (_m, word: string) => `\\w ${word.trimEnd()}\\w*`);
}
