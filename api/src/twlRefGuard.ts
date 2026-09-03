// Shared validation for the TWL branch of PATCH /api/rows/:kind/:id
// (rows.ts) — extracted into its own leaf module (no other imports) so a
// unit test can exercise the exact production fragment without pulling in
// the full Hono route's dependency graph, mirroring chapterZeroGuard.ts.
// See issue #724.
//
// TWL is a word-LINK table: unlike tn/tq (which legitimately span a verse
// range in ref_raw, e.g. "12:11-12" for a merged note), a translationWords
// link always points at exactly one word occurrence in exactly one verse. A
// PATCH that retargets ref_raw to a range, an empty string, or another
// chapter has no valid single-verse reading, and previously nothing on the
// TWL PATCH path rejected it — refParts silently took the range's leading
// verse (or 0 for garbage), leaving the stored chapter/verse columns (which
// drive grouping/canonical order/export) diverging from what ref_raw itself
// says. Chapter 0 is separately (and unconditionally) rejected for twl by
// chapterZeroGuard.ts's isValidChapterZeroRef, so this guard doesn't special-
// case it beyond requiring a positive chapter.
const TWL_REF_RE = /^(\d+):(\d+)$/;

// `currentChapter` is the row's real, unchangeable chapter (twl PATCH is
// same-chapter only — see rows.ts's ref_raw re-derivation comment). A
// ref_raw naming a different chapter is exactly the torn-row shape this
// guard exists to close off, so it's rejected here rather than silently
// passed through.
export function isValidTwlRefRaw(refRaw: string, currentChapter: number): boolean {
  const m = TWL_REF_RE.exec(refRaw);
  if (!m) return false;
  const chapter = parseInt(m[1], 10);
  const verse = parseInt(m[2], 10);
  return chapter === currentChapter && chapter > 0 && verse > 0;
}
