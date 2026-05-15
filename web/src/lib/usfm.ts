// Shared USFM utilities used by both the web client and (transitively
// via the api side) the worker import path. The single source of
// truth for "the plain text of a verse" — both the importer
// (api/src/importParsers.ts) and the alignment save path
// (alignment.ts:alignmentPlainText) call this so the two never drift.

// Concatenate every `text` field in the verseObjects tree, recursing
// into children. Whitespace is collapsed to single spaces and the
// result is trimmed. Mirrors the historical behaviour of the
// importer's extractPlainText; included character-style markers
// like \qs Selah\qs* and \f ... \f* contribute their text via this
// walk (qs nodes carry `text` or `children`; \f carries `content`
// which is NOT named `text`, so footnote prose is intentionally
// excluded — matching what the importer already did).
export function extractPlainText(verseObjects: unknown): string {
  const parts: string[] = [];
  const walk = (vos: unknown[]): void => {
    for (const vo of vos ?? []) {
      if (!vo || typeof vo !== "object") continue;
      const v = vo as { text?: unknown; children?: unknown[] };
      if (typeof v.text === "string") parts.push(v.text);
      if (Array.isArray(v.children)) walk(v.children);
    }
  };
  const top = verseObjects as { verseObjects?: unknown[] } | null;
  if (top && Array.isArray(top.verseObjects)) {
    walk(top.verseObjects);
  } else if (Array.isArray(verseObjects)) {
    walk(verseObjects);
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}
