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

// In-flow paragraph / poetry / blank markers. These have no text payload
// (they're position-anchors only) and survive verseObjects round-trips
// as `{type:"paragraph", tag}` nodes. The display layer turns them into
// visual line breaks / indents; the edit layer surfaces them as visible
// literal `\p`/`\q1` tokens so users can add/remove them.
export const PARAGRAPH_TAGS: ReadonlySet<string> = new Set([
  "p", "m", "mi", "nb", "pi", "pi1", "pi2", "pi3", "pc",
  "q", "q1", "q2", "q3", "q4", "qm", "qm1", "qm2", "qm3",
  "b",
]);

// Section heading tags that are translator-supplied and NOT alignable to
// source words. Rendered as separate header bands above the verse body.
// `\d` (Psalm superscription) is also `type:"section"` but its text IS
// alignable Hebrew — explicitly EXCLUDED from this set so it stays in
// the verse body alongside its `\zaln-s` children.
export const SECTION_HEADER_TAGS: ReadonlySet<string> = new Set(["s1", "s2", "s3", "s4", "ms", "ms1", "ms2"]);

export interface SectionHeader {
  tag: string;
  text: string;
}

export interface SplitContent {
  sections: SectionHeader[];
  body: unknown[];
}

// Split a verse's verseObjects into:
//   - sections: leading `\s1`/`\s2`/`\s3` heading nodes, hoisted out
//     for separate header-band rendering. Source-unalignable.
//   - body: everything else, preserved in original order (paragraph
//     markers, words, milestones, `\d` Psalm superscriptions).
// USFM places section headers before the verse they introduce, so in
// practice these come from the leading slice of the verseObjects array.
// We pull section nodes from anywhere in the array defensively.
export function splitSectionHeaders(verseObjects: unknown[] | undefined | null): SplitContent {
  const sections: SectionHeader[] = [];
  const body: unknown[] = [];
  if (!Array.isArray(verseObjects)) return { sections, body };
  for (const node of verseObjects) {
    const o = node as Record<string, unknown> | null;
    if (
      o &&
      o["type"] === "section" &&
      typeof o["tag"] === "string" &&
      SECTION_HEADER_TAGS.has(o["tag"] as string)
    ) {
      // usfm-js stores the heading text as `content` on \s* nodes (not
      // `text`, which is what \d uses). Try both — strip trailing newline
      // that usfm-js often appends.
      const raw = String(o["content"] ?? o["text"] ?? "");
      sections.push({
        tag: o["tag"] as string,
        text: raw.replace(/\n+$/, "").trim(),
      });
      continue;
    }
    body.push(node);
  }
  return { sections, body };
}

// usfm-js stores poetry markers (\q1, \q2, \qm*) as `{type:"quote", tag}`
// and plain-paragraph markers (\p, \m, \pi*, \nb, \b) as
// `{type:"paragraph", tag}`. Both are inert structural anchors that we
// render and surface for editing in the same way.
export function isInFlowMarker(node: unknown): boolean {
  const o = node as Record<string, unknown> | null;
  if (!o) return false;
  const t = o["type"];
  return (t === "paragraph" || t === "quote") && typeof o["tag"] === "string";
}

// Peel trailing in-flow paragraph / quote markers off a verse's
// verseObjects array. USFM places markers BEFORE the verse they lead
// (`\q1 \v 9 ...`), but usfm-js attaches them to the PREVIOUS verse's
// content_json — so the `\q1` that visually introduces the first line
// of verse 9 actually lives at the end of verse 8. The display layer
// uses this to drift those trailing markers down to the verse they
// were meant to introduce, while the data stays USFM-correct on disk.
//
// Walks backward from the end of the array, collecting consecutive
// in-flow markers. Stops at the first non-marker node. Returns the
// markers in document order (oldest-first).
export function extractTrailingMarkers(verseObjects: unknown[] | undefined | null): unknown[] {
  if (!Array.isArray(verseObjects)) return [];
  const out: unknown[] = [];
  for (let i = verseObjects.length - 1; i >= 0; i--) {
    const node = verseObjects[i];
    if (isInFlowMarker(node)) {
      out.unshift(node);
    } else {
      const o = node as Record<string, unknown> | null;
      // Skip empty trailing text whitespace or chunk milestones (\ts\*)
      // when looking past them for the marker run. Both are layout-only
      // and shouldn't disqualify a trailing marker behind them.
      const txt = typeof o?.["text"] === "string" ? (o["text"] as string) : null;
      const tag = typeof o?.["tag"] === "string" ? (o["tag"] as string) : null;
      // Tolerate zero-width spaces (U+200B) — they crept in from the
      // editor's empty-block placeholder (&#8203;) and shouldn't block
      // marker drift just because the user saved past one.
      const isWhitespace = txt !== null && /^[\s​]*$/.test(txt);
      const isTsMarker = tag !== null && tag.startsWith("ts");
      if (isWhitespace || isTsMarker) continue;
      break;
    }
  }
  return out;
}

// Like extractPlainText but emits a literal USFM marker token (e.g.
// "\p ", "\q1 ", "\b ") inline for each in-flow marker node. Used as
// the BASELINE for diffing edits in the active-verse contenteditable
// when markers are surfaced as chips — the chip's textContent is
// exactly "\p" / "\q1", so the captured textContent stream lines up
// with this representation. Section-heading nodes (\s1/\s2/\s3) are
// skipped — they live in a separate header band.
export function extractEditableText(verseObjects: unknown): string {
  const parts: string[] = [];
  const walk = (vos: unknown[]): void => {
    for (const vo of vos ?? []) {
      if (!vo || typeof vo !== "object") continue;
      const v = vo as Record<string, unknown>;
      if (isInFlowMarker(v)) {
        parts.push(`\\${v["tag"]} `);
        continue;
      }
      if (
        v["type"] === "section" &&
        typeof v["tag"] === "string" &&
        SECTION_HEADER_TAGS.has(v["tag"] as string)
      ) {
        continue;
      }
      if (typeof v["text"] === "string") parts.push(v["text"] as string);
      if (Array.isArray(v["children"])) walk(v["children"] as unknown[]);
    }
  };
  const top = verseObjects as { verseObjects?: unknown[] } | null;
  if (top && Array.isArray(top.verseObjects)) {
    walk(top.verseObjects);
  } else if (Array.isArray(verseObjects)) {
    walk(verseObjects);
  }
  return parts.join("").replace(/[ \t\n\r\f\v]+/g, " ").trim();
}
