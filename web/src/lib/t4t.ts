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

function renameAdd(vos: unknown[]): unknown[] {
  return vos.map((vo) => {
    if (!vo || typeof vo !== "object") return vo;
    const o = vo as Record<string, unknown>;
    const out: Record<string, unknown> = { ...o };
    if (o["tag"] === "add") {
      out["tag"] = T4T_ADD_TAG;
      delete out["endTag"];
    }
    if (Array.isArray(o["children"])) out["children"] = renameAdd(o["children"] as unknown[]);
    return out;
  });
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
      const content = { verseObjects: renameAdd(verseObj.verseObjects ?? []) };
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
