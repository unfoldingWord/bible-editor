// A cheap signature of what can change a book-mode chapter's rendered height
// (#1131). BookView lays a chapter out in full, once, whenever this changes,
// so the browser records its real height for `content-visibility: auto`
// before skipping it again (#1120). Keying that on the chapter data's
// identity instead re-laid out an off-screen chapter for every data change,
// including an outbox result that only bumps a verse's version, and in a
// browser without scroll anchoring (Safari) a chapter above the view that is
// laid out moves the view at that moment.
//
// Per verse row and shown column: the bridge end (a bridge spans rows), the
// plain-text length, the top-level node count (paragraph and poetry markers,
// words) and the section-heading text. A same-length edit that rewraps a line
// is not caught; the chapter then keeps its old height until it is next on
// screen, as before #1120.

import type { VerseDto } from "../sync/api.ts";
import { splitSectionHeaders } from "./usfm.ts";

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
      const verseObjects = (dto.content as { verseObjects?: unknown[] } | null)?.verseObjects;
      let nodes = 0;
      let headings = "";
      if (Array.isArray(verseObjects)) {
        nodes = verseObjects.length;
        for (const s of splitSectionHeaders(verseObjects).sections) headings += `${s.tag}.${s.text.length};`;
      }
      key += `:${dto.verse_end ?? ""}.${dto.plain_text?.length ?? 0}.${nodes}.${headings}`;
    }
  }
  return key;
}
