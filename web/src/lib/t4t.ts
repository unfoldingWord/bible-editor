// Read-only English T4T (Translation for Translators) scripture.
//
// T4T never lives in D1 (see api/src/t4t.ts for why). The client fetches the
// raw book USFM and parses it here into the same per-verse VerseDto shape the
// chapter API returns, so rows / columns / book modes can render it next to
// ULT/UST. It is display-only: never editable, never queued to the outbox,
// never aligned, never highlighted, never a find/replace target, never
// exported.
import usfm from "usfm-js";
import { extractPlainText } from "./usfm.ts";
import type { VerseDto } from "../sync/api";

export const T4T_VERSION = "T4T";

// usfm-js parses `\add text\add*` as {tag:"add", text, endTag:"add*"}, which
// the shared renderer does not draw. The parser renames it to this private
// tag (no real USFM marker uses it), and highlight.ts renders only this tag as
// italic. Renaming keeps that render branch from ever touching ULT/UST.
export const T4T_ADD_TAG = "t4t-add";

// Other character styles T4T uses (`\bd`, `\sc`) are not drawn by the shared
// renderer either; their text is kept as plain text.
const PLAIN_CHAR_TAGS = new Set(["bd", "sc", "it", "em", "bdit", "no", "nd"]);

// Normalize usfm-js output for display. Measured over all 66 T4T books: besides
// `\add`, `\bd` and `\sc` lose their text in the renderer, and an unnumbered
// `\li` is parsed as a character marker that swallows everything after it as
// nested `children` (GEN 46:8-25 nests 20 deep). The tree is flattened: each
// node is emitted without its children, then its children follow as siblings.
function normalize(vos: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const vo of vos) {
    if (!vo || typeof vo !== "object") {
      out.push(vo);
      continue;
    }
    const o = vo as Record<string, unknown>;
    const tag = typeof o["tag"] === "string" ? (o["tag"] as string) : null;
    const text = typeof o["text"] === "string" ? (o["text"] as string) : null;
    const children = Array.isArray(o["children"]) ? (o["children"] as unknown[]) : null;
    if (tag === "add" || tag === "add*") {
      if (text) out.push({ tag: T4T_ADD_TAG, text });
    } else if (tag && PLAIN_CHAR_TAGS.has(tag)) {
      if (text) out.push({ type: "text", text });
    } else if (tag === "li") {
      out.push({ tag: "li1", content: text ?? "" });
    } else if (children) {
      const rest: Record<string, unknown> = { ...o };
      delete rest["children"];
      out.push(rest);
    } else {
      out.push(o);
    }
    if (children) out.push(...normalize(children));
  }
  return out;
}

// Parse a whole T4T book into chapter → verse-start → VerseDto. Bridges
// (`\v 3-4`) become verse 3 with verse_end 4; a chapter's `front` becomes
// verse 0, matching scripts/import-book.mjs.
export function parseT4tBook(book: string, text: string): Map<number, Record<number, VerseDto>> {
  const json = (usfm as { toJSON: (s: string) => { chapters?: Record<string, Record<string, { verseObjects?: unknown[] }>> } }).toJSON(text);
  const out = new Map<number, Record<number, VerseDto>>();
  for (const [chKey, chapterObj] of Object.entries(json.chapters ?? {})) {
    const chapter = parseInt(chKey, 10);
    if (!Number.isFinite(chapter)) continue;
    const verses: Record<number, VerseDto> = {};
    for (const [vKey, verseObj] of Object.entries(chapterObj)) {
      let verse: number;
      let verseEnd: number | null = null;
      if (vKey === "front") {
        verse = 0;
      } else {
        const m = vKey.match(/^(\d+)(?:-(\d+))?$/);
        if (!m) continue;
        verse = parseInt(m[1], 10);
        if (m[2]) {
          const end = parseInt(m[2], 10);
          if (end > verse) verseEnd = end;
        }
      }
      const content = { verseObjects: normalize(verseObj.verseObjects ?? []) };
      verses[verse] = {
        book,
        chapter,
        verse,
        verse_end: verseEnd,
        bible_version: T4T_VERSION,
        plain_text: extractPlainText(content),
        version: 0,
        updated_by: null,
        updated_at: 0,
        content,
      };
    }
    out.set(chapter, verses);
  }
  return out;
}

// T4T figure-of-speech tags: square brackets holding only uppercase letters,
// commas and spaces, e.g. `[RHQ]`, `[MTY, IDI]`. Brackets with any other
// content (lowercase words, digits) are real text and are kept.
const FIGURE_TAG_RE = /\s*\[[A-Z][A-Z, ]*\]/g;

// Plain text to seed a UST verse from a parsed T4T verse ("Copy T4T to UST").
// Each `\add X\add*` (italic implied words) becomes `{X}`, the UST convention;
// figure tags are dropped; doubled spaces and spaces before closing punctuation
// are collapsed. `◄a/b►` alternates are kept as-is. A bridge's content is the
// whole bridge, so a bridged T4T row copies all of it.
export function t4tToUstPlain(content: unknown): string {
  const vos = (content as { verseObjects?: unknown[] } | null)?.verseObjects ?? [];
  const mapped = vos.map((vo) => {
    const o = vo as Record<string, unknown> | null;
    if (o && o["tag"] === T4T_ADD_TAG && typeof o["text"] === "string") {
      return { type: "text", text: `{${(o["text"] as string).trim()}}` };
    }
    return vo;
  });
  return extractPlainText({ verseObjects: mapped })
    .replace(FIGURE_TAG_RE, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?’”)\]])/g, "$1")
    .trim();
}
