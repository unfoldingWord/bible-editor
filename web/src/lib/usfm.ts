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
// render and surface for editing in the same way. `\ts\*` (translator-
// section chunk milestone) is parsed by usfm-js as `{tag:"ts",
// content:"\\*"}` with no `type` field — we treat it as in-flow too so
// it surfaces in the editor as a visible chunk divider.
export function isInFlowMarker(node: unknown): boolean {
  const o = node as Record<string, unknown> | null;
  if (!o) return false;
  const t = o["type"];
  if ((t === "paragraph" || t === "quote") && typeof o["tag"] === "string") return true;
  if (o["tag"] === "ts" && o["content"] === "\\*") return true;
  return false;
}

// usfm-js attaches the leading punctuation that follows an in-flow marker on
// the same source line — the opening quote in `\q2 “I am…`, the `{` that opens
// a word-addition — to the MARKER node's own `text` field:
//   { tag:"q2", type:"quote", text:"“" }
// We otherwise treat in-flow markers as text-less position anchors, so that
// text is invisible in display/editing and silently dropped when
// reconcileMarkers rebuilds the marker from its tag alone. Split it out into a
// plain text node right after the marker so every consumer (the segment
// renderer, the edit baseline, the marker reconcile) sees it as ordinary
// leading line text. Lossless on export — `\q2 “` round-trips identically
// whether the quote sits on the marker node or in a following text node.
// Top-level only: in aligned source, markers never nest inside a milestone.
export function liftMarkerText(verseObjects: unknown[]): unknown[] {
  if (!Array.isArray(verseObjects)) return verseObjects;
  const out: unknown[] = [];
  for (const node of verseObjects) {
    const o = node as Record<string, unknown> | null;
    if (o && isInFlowMarker(o) && typeof o["text"] === "string" && o["text"] !== "") {
      const { text, ...rest } = o;
      out.push(rest);
      out.push({ type: "text", text });
    } else {
      out.push(node);
    }
  }
  return out;
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
      // Skip empty trailing text whitespace when looking past it for the
      // marker run. Tolerate zero-width spaces (U+200B) — they crept in
      // from the editor's empty-block placeholder (&#8203;) and shouldn't
      // block marker drift just because the user saved past one.
      const txt = typeof o?.["text"] === "string" ? (o["text"] as string) : null;
      const isWhitespace = txt !== null && /^[\s​]*$/.test(txt);
      if (isWhitespace) continue;
      break;
    }
  }
  return out;
}

// Collapse editor whitespace so the diff baseline (extractEditableText)
// and the captured contenteditable text (textContent / innerText) are
// byte-comparable. Strips zero-width spaces (U+200B — empty-block caret
// placeholders the editor emits as `&#8203;`) and collapses ASCII
// whitespace AND non-breaking spaces (U+00A0 — injected as `&nbsp;` after
// toolbar-inserted marker chips, and by `innerText` block boundaries) to
// single spaces, then trims. extractEditableText and smartEditVerse share
// this so a stray trailing/embedded space can't desync the edit diff and
// nuke alignment from the edit point to the verse end.
export function normalizeEditable(s: string): string {
  return s.replace(/​/g, "").replace(/[ \t\n\r\f\v ]+/g, " ").trim();
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
        if (v["tag"] === "ts") {
          parts.push("\\ts\\* ");
        } else {
          parts.push(`\\${v["tag"]} `);
          // Surface any leading punctuation usfm-js attached to the marker
          // node (`\q2 “…` → text:"“") so the quote shows in the editor and
          // lands in the diff baseline. Mirrors liftMarkerText; harmless on
          // already-lifted trees (the marker carries no text there).
          if (typeof v["text"] === "string") parts.push(v["text"] as string);
        }
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
  return normalizeEditable(parts.join(""));
}
