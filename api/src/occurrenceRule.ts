// The Occurrence column invariant — one pure leaf module, shared by the save
// path (rows.ts) and the export renderer (export.ts). Both used to carry their
// own byte-identical `hasOrigLang` under a "keep the two in sync" comment; they
// are unified here because the whole point of this module is that save-time and
// render-time must not disagree about what a valid Occurrence is.
//
// Why it matters: the nightly `-be-` PR only merges when
// `validate_<kind>_files.py` exits 0 (merge-be-pr.yaml gates on
// workflow_run.conclusion == 'success'), and none of the Occurrence checks pass
// a `severity` kwarg, so each defaults to "error" and fails the whole run. A
// single bad row stops its entire book+resource from publishing — silently, from
// the app's point of view. `hardRejectGuard.ts` is the last-resort export HOLD
// for rows that predate this rule; this module stops them being written at all.
//
// The three validators differ, so the rule is per-kind, not one shared test:
//
//   twl — validate_twl_files.py, OCCURRENCE_RE = ^[1-9][0-9]*$
//     `if not occurrence:` → "Occurrence column cannot be blank."
//     `elif not RE.fullmatch(...)` → "Occurrence '{v}' must be a positive
//     integer (never 0 or blank)." Unconditional: blank and 0 are both errors
//     whatever OrigWords holds (a blank OrigWords is only severity="warning").
//   tn — validate_tn_files.py, OCCURRENCE_RE = ^(?:-1|[0-9]+)$
//     `occurrence_is_allowed_blank = (occurrence == "" and _quote == "")` —
//     blank Occurrence is legal ONLY alongside a blank Quote. A quote of any
//     script, Gateway-Language included, with a blank Occurrence is an error.
//   tq — validate_tq_files.py: `if occurrence != "" and not RE.fullmatch(...)`
//     blank is always legal, so there is nothing to force.

export type OccurrenceKind = "tn" | "tq" | "twl";

// Original-language Unicode blocks: Hebrew (0590-05FF), Hebrew presentation
// forms (FB1D-FB4F), Greek and Coptic (0370-03FF), Greek Extended (1F00-1FFF).
export function hasOrigLang(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      (c >= 0x0590 && c <= 0x05ff) ||
      (c >= 0xfb1d && c <= 0xfb4f) ||
      (c >= 0x0370 && c <= 0x03ff) ||
      (c >= 0x1f00 && c <= 0x1fff)
    )
      return true;
  }
  return false;
}

// SAVE path. The occurrence a row must store, or null to leave the caller's
// value untouched. Used by both the create (POST) and patch handlers in rows.ts.
//
// The test is "is the quote non-blank", not the older "is the quote
// original-language": `hasOrigLang` alone was too narrow. `origLangOccurrence`
// below renders an OL quote's null occurrence as 1, so an OL row was already
// safe at export; a Gateway-Language quote fell through both and rendered a
// blank cell. That is prod tn JER 37:5 `bfyt` ("the Chaldeans, the ones laying
// siege", occurrence NULL), which held all of JER TN's export.
export function requiredOccurrence(
  kind: OccurrenceKind,
  quote: unknown,
  occurrence: unknown,
): number | null {
  // Anything that is not a finite integer counts as "no occurrence" and falls
  // through to the per-kind rule below. Zod already rejects NaN/"2" on the HTTP
  // path, but `typeof NaN === "number"` would otherwise sail past the null/0
  // checks and store a NaN that renders as a blank cell — the exact failure
  // this module exists to prevent.
  // A value was supplied but is not a usable integer — NaN, Infinity, 1.5, the
  // string "2", or anything >= 1e21. None of these can render legally for ANY
  // kind, so force a 1 rather than fall through to the blank rules below. That
  // distinction matters: "absent" is legal for tn (with a blank Quote) and
  // always legal for tq, so treating an ILLEGAL value as merely absent would
  // leave it in place and ship it. The bound is about rendering, not size —
  // `tsvCell` stringifies and `String(1e21) === "1e+21"`, which matches neither
  // kind's digits-only regex; `Number.isSafeInteger` is exactly the test for
  // "will stringify as plain digits".
  if (occurrence != null && !Number.isSafeInteger(occurrence)) return 1;
  // Past this point null means genuinely absent (`null` or `undefined`).
  const occ = Number.isSafeInteger(occurrence) ? (occurrence as number) : null;
  // The RAW quote cell, deliberately not trimmed: the validators compare
  // `_quote == ""`, so a whitespace-only Quote is NOT blank to them and does
  // NOT license a blank Occurrence.
  const q = typeof quote === "string" ? quote : "";

  // twl — legal iff a positive integer (^[1-9][0-9]*$). Blank, 0 and every
  // negative are errors, whatever OrigWords holds.
  if (kind === "twl") return occ != null && occ >= 1 ? null : 1;

  // tn and tq share OCCURRENCE_RE = ^(?:-1|[0-9]+)$, so -1 ("all occurrences")
  // and any non-negative integer are legal; anything below -1 never is.
  if (occ != null && occ < -1) return 1;

  if (occ == null) {
    // A blank Occurrence. tn permits it ONLY alongside a blank Quote; tq always
    // permits it. This is the clause that closes the JER 37:5 `bfyt` hole — the
    // old rule tested `hasOrigLang(quote)`, so a Gateway-Language quote slipped
    // through and rendered a blank cell.
    if (kind === "tn" && q !== "") return 1;
    // The long-standing OL clause, kept for tq: an original-language quote gets
    // >= 1 even though tq's validator would accept the blank, because the
    // quote-builder can rewrite GL text to OL words without touching occurrence.
    if (hasOrigLang(q)) return 1;
    return null;
  }

  // occ is a legal integer (-1, or >= 0). Only the pre-existing OL heal of 0
  // applies. A plain 0 on a Gateway-Language quote is valid for both kinds, so
  // it is left alone rather than healed — bumping its version would churn the
  // nightly DCS diff for no validator gain.
  if (occ === 0 && hasOrigLang(q)) return 1;
  return null;
}

// RENDER path (export.ts). Last-resort coercion at TSV-render time for rows
// stored before the save-path rule above existed. Deliberately narrower than
// `requiredOccurrence`: it only fills in an OL quote's missing occurrence and
// otherwise passes the stored value through untouched, so the render stays a
// faithful picture of D1 and `hardRejectGuard.ts` can still see — and HOLD on —
// a row that is genuinely invalid.
export function origLangOccurrence(
  quote: string | null,
  occurrence: number | null,
): number | null {
  if (quote && hasOrigLang(quote) && (occurrence == null || occurrence === 0)) return 1;
  return occurrence;
}
