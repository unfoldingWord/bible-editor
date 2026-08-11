// A row at chapter 0 (the book-level intro) is legal ONLY as ref_raw
// "front:intro", and only for tn (see importParsers.ts refParts and
// REFERENCE_RE in lint.ts — chapter 0 is not a real chapter with verses, so
// "0:1", "0:intro", "0:front" etc. have no valid rendering). The "Add note"
// create path used to derive ref_raw as `${chapter}:${activeVerse}` with a
// special case only for activeVerse === 0 (web/src/components/Shell.tsx
// onNoteCreate), so viewing the chapter-0 pseudo-chapter with a nonzero
// active verse minted an illegal "0:N" reference. DCS's validator only warns
// on a malformed Reference (see lint.ts), so the row silently published —
// this is exactly the shape of the ISA ee2w row (STATE.md). Reject it at
// create/patch time rather than trust every future caller to derive ref_raw
// correctly.
//
// tq and twl differ from tn: a production census (2026-08-11) found ZERO
// chapter-0 rows for either kind (tn has 37 legitimate "front:intro" rows
// plus the one illegal "0:1"). Translation questions and word-links don't
// apply to book-intro front matter, so there is no established legal
// chapter-0 shape for tq/twl to allow — the guard forbids chapter 0 entirely
// for those two kinds rather than inventing a "front:intro" convention that
// has never actually been used.
export function isValidChapterZeroRef(
  kind: "tn" | "tq" | "twl",
  chapter: number,
  ref_raw: string,
): boolean {
  if (chapter !== 0) return true;
  return kind === "tn" && ref_raw === "front:intro";
}
