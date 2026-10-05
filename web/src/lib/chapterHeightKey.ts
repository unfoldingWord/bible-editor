// A cheap signature of what can change a book-mode chapter's rendered height
// (#1131). BookView lays a chapter out in full, once, whenever this changes,
// so the browser records its real height for `content-visibility: auto`
// before skipping it again (#1120). Keying that on the chapter data's
// identity instead re-laid out an off-screen chapter for every data change,
// including an outbox result that only bumps a verse's version, and in a
// browser without scroll anchoring (Safari) a chapter above the view that is
// laid out moves the view at that moment.
//
// Per verse row and shown column: the bridge end (a bridge spans rows) and a
// 32-bit FNV-1a hash of the plain text, the tag (or type) and string `text` /
// `content` of every top-level node (paragraph and poetry markers such as \q1
// vs \q2, \p vs \b; a \qa acrostic label) and the section-heading text. Content, not lengths, so a same-length rewording
// that rewraps still changes it; a version or timestamp alone does not.

import type { VerseDto } from "../sync/api.ts";
import { splitSectionHeaders } from "./usfm.ts";

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  // Separator, so "ab"+"c" and "a"+"bc" differ.
  return Math.imul(h ^ 0x1f, FNV_PRIME);
}

export function chapterHeightKey(
  verses: Record<string, Record<number, VerseDto> | undefined>,
  enabledVersions: readonly string[],
  verseNums: readonly number[],
): string {
  let key = enabledVersions.join(",");
  for (const v of verseNums) {
    key += `|${v}`;
    for (const bv of enabledVersions) {
      const dto = verses[bv]?.[v];
      if (!dto) {
        key += ":-";
        continue;
      }
      let h = fnv(FNV_OFFSET, dto.plain_text ?? "");
      const verseObjects = (dto.content as { verseObjects?: unknown[] } | null)?.verseObjects;
      if (Array.isArray(verseObjects)) {
        for (const node of verseObjects) {
          const o = node as { tag?: unknown; type?: unknown; text?: unknown; content?: unknown } | null;
          h = fnv(h, String(o?.tag ?? o?.type ?? ""));
          // Labels the renderer draws but plain_text leaves out live here: a
          // `\qa` acrostic label (lifted to `content`), a `\d` title's text.
          // Words and alignment milestones are skipped: their text is already
          // in plain_text, and a milestone's `content` is the source word, not
          // drawn in this column (hashing them doubled the cost on PSA).
          if (o?.type === "word" || o?.type === "milestone") continue;
          h = fnv(h, typeof o?.text === "string" ? o.text : "");
          h = fnv(h, typeof o?.content === "string" ? o.content : "");
        }
        for (const s of splitSectionHeaders(verseObjects).sections) h = fnv(h, s.text);
      }
      key += `:${dto.verse_end ?? ""}.${(h >>> 0).toString(36)}`;
    }
  }
  return key;
}
