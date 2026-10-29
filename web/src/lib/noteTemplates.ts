// Quick-fill templates for the two most common TN shapes. Placeholder
// convention:
//   - Bare ALL-CAPS tokens (NOTE, REF) are double-click-selectable so the
//     editor can replace them in one shot.
//   - Bracketed [ALT] matches the canonical TSV form for the alternate-
//     translation slot — double-clicking ALT selects just the inner word,
//     leaving the brackets in place (which is how the corpus is written).
// Wording matches docs/samples/en_tn_tn_ZEC.tsv (TCM); SH is the current team template.

export const TCM =
  "This could mean: (1) NOTE Alternate translation: [ALT] (2) NOTE Alternate translation: [ALT]";

export const SH =
  "See how you translated the same/similar expression \u201cSIMILAR_EXPRESSION\u201d in [1:1](../01/01.md).";
