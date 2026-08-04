// Unit tests for the USFM structural validator (usfmValidate.ts) — the TS port
// of DCS validate_usfm_files.py Check 7 (consecutive paragraph markers) and
// Check 8 (formatting) that backs the export HOLD gate.
// Run: node --experimental-strip-types --no-warnings src/usfmValidate.test.mjs

import assert from "node:assert/strict";
import { validateUsfm, hasUsfmValidationErrors, summarizeUsfmIssues } from "./usfmValidate.ts";

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// The trailing BLANK LINE is load-bearing, not cosmetic. DCS's Check 8
// (`validate_usfm_formatting`) skips every line until the first blank one and
// never re-enters header mode, so without it Check 8 would be inert for the whole
// file and every Check-8 case below would pass vacuously. Real renders do have it:
// en_ult/en_ust master files carry a blank line at line 9 (after `\mt1`, before
// the first `\ts\*`), and our own blankLinePass preserves the header the same way.
const HDR = "\\id EZK\n\\usfm 3.0\n\\ide UTF-8\n\\h Ezekiel\n\\toc1 Ezekiel\n\\mt1 Ezekiel\n\n";
const rules = (u) => validateUsfm(u).map((i) => i.rule);

// ── Check 7: consecutive paragraph markers (the EZK front-\p pump) ──────────

t("consecutive \\p flagged (Check 7)", () => {
  const u = `${HDR}\\c 8\n\\p\n\\p\n\\v 1 word\n`;
  const found = validateUsfm(u).filter((i) => i.rule === "consecutive-paragraph-markers");
  assert.equal(found.length, 1);
  assert.equal(found[0].ref, "8", "ref carries the chapter");
});

t("three consecutive \\p → two adjacency errors", () => {
  const u = `${HDR}\\c 8\n\\p\n\\p\n\\p\n\\v 1 word\n`;
  assert.equal(
    validateUsfm(u).filter((i) => i.rule === "consecutive-paragraph-markers").length,
    2,
  );
});

t("mixed \\p then \\m flagged as consecutive (matches DCS PARAGRAPH_MARKERS set)", () => {
  const u = `${HDR}\\c 3\n\\p\n\\m\n\\v 1 word\n`;
  assert.ok(rules(u).includes("consecutive-paragraph-markers"));
});

t("\\p separated by a blank line is NOT consecutive (blank resets, per DCS)", () => {
  const u = `${HDR}\\c 1\n\\p\n\n\\p\n\\v 1 word\n`;
  assert.ok(!rules(u).includes("consecutive-paragraph-markers"));
});

t("consecutive \\q1 are NOT flagged (\\q not in DCS paragraph set)", () => {
  const u = `${HDR}\\c 1\n\\q1\n\\q1\n\\v 1 word\n`;
  assert.ok(!rules(u).includes("consecutive-paragraph-markers"));
});

t("two \\p around real content are NOT consecutive", () => {
  const u = `${HDR}\\c 1\n\\p\n\\v 1 a\n\\p\n\\v 2 b\n`;
  assert.ok(!rules(u).includes("consecutive-paragraph-markers"));
});

// ── Check 8: USFM formatting ────────────────────────────────────────────────

t("\\c not alone on its line flagged", () => {
  const u = `${HDR}\\c 1 \\p\n\\v 1 word\n`;
  assert.ok(rules(u).includes("chapter-marker-not-isolated"));
});

t("\\p not alone on its line flagged", () => {
  const u = `${HDR}\\c 1\n\\p \\v 1 word\n`;
  assert.ok(rules(u).includes("paragraph-marker-not-isolated"));
});

t("two \\v on one line flagged", () => {
  const u = `${HDR}\\c 1\n\\p\n\\v 1 a \\v 2 b\n`;
  assert.ok(rules(u).includes("multiple-verses-per-line"));
});

t("non-marker content before \\v flagged", () => {
  const u = `${HDR}\\c 1\n\\p\n leftover text \\v 1 word\n`;
  assert.ok(rules(u).includes("invalid-content-before-verse"));
});

t("\\q1 before \\v is allowed (valid poetry prefix)", () => {
  const u = `${HDR}\\c 1\n\\q1 \\v 1 word\n`;
  assert.ok(!rules(u).includes("invalid-content-before-verse"));
});

// ── Port fidelity: divergences from DCS that made us UNDER-block ────────────
// Every case below is a DCS Check-8 hard error this port used to wave through.
// Waving one through never got a book published: DCS's validate_usfm_files.py has
// no warning tier at all (unlike the tn/tq/twl validators), so the `-be-` PR check
// goes red and merge-be-pr.yaml — which merges only on
// `workflow_run.conclusion == 'success'` — never merges it. The book was withheld
// either way; the only difference was that nothing named the reason.

t("marker with LEAKED TEXT before \\v is flagged (DCS anchors on $, not a word boundary)", () => {
  // The usfm-js shape this repo already knows: an opening quote parked on a
  // marker node's `text`. A word-boundary anchor matched just the `\p` and never
  // looked at the rest, so this shipped.
  const u = `${HDR}\\c 1\n\\p “And he said\\v 5 word\n`;
  assert.ok(rules(u).includes("invalid-content-before-verse"));
});

t("\\q1 with trailing prose before \\v is flagged", () => {
  const u = `${HDR}\\c 1\n\\q1 some leaked text\\v 5 word\n`;
  assert.ok(rules(u).includes("invalid-content-before-verse"));
});

t("\\b before \\v is flagged — `b` is NOT in DCS's _VERSE_PREFIX_RE", () => {
  const u = `${HDR}\\c 1\n\\b\\v 5 word\n`;
  assert.ok(rules(u).includes("invalid-content-before-verse"));
});

t("bare allowed markers before \\v still pass (\\p, \\q, \\li2, \\nb, \\qd)", () => {
  for (const m of ["\\p", "\\q", "\\q1", "\\li2", "\\nb", "\\qd", "\\pc", "\\cls", "\\mi"]) {
    const u = `${HDR}\\c 1\n${m} \\v 5 word\n`;
    assert.ok(
      !rules(u).includes("invalid-content-before-verse"),
      `${m} should be an allowed verse prefix`,
    );
  }
});

t("\\qt-s before \\v is flagged (not in DCS's alternation)", () => {
  const u = `${HDR}\\c 1\n\\qt-s\\v 5 word\n`;
  assert.ok(rules(u).includes("invalid-content-before-verse"));
});

t("\\ts\\* fused onto a content line is flagged (the LAM \\ts\\* pump shape)", () => {
  const u = `${HDR}\\c 1\n\\ts\\* \\v 5 word\n`;
  assert.ok(rules(u).includes("ts-marker-not-isolated"));
});

t("\\ts\\* alone on its line is fine", () => {
  const u = `${HDR}\\ts\\*\n\\c 1\n\\p\n\\v 1 word\n`;
  assert.ok(!rules(u).includes("ts-marker-not-isolated"));
});

t("\\b fused onto a content line is flagged", () => {
  const u = `${HDR}\\c 1\n\\b \\v 5 word\n`;
  assert.ok(rules(u).includes("b-marker-not-isolated"));
});

t("\\b alone on its line is fine", () => {
  const u = `${HDR}\\c 1\n\\b\n\\p\n\\v 1 word\n`;
  assert.ok(!rules(u).includes("b-marker-not-isolated"));
});

t("\\b immediately after \\ts\\* is flagged (ordering rule)", () => {
  const u = `${HDR}\\c 1\n\\ts\\*\n\\b\n\\p\n\\v 1 word\n`;
  assert.ok(rules(u).includes("b-marker-after-ts"));
});

t("\\b after \\ts\\* with a blank line between is NOT flagged (DCS clears prev_non_blank)", () => {
  // Bug-for-bug fidelity: DCS reassigns prev_non_blank on EVERY line including
  // blanks, and our blankLinePass inserts exactly such a blank line, so the
  // ordering rule must not fire here.
  const u = `${HDR}\\c 1\n\\ts\\*\n\n\\b\n\\p\n\\v 1 word\n`;
  assert.ok(!rules(u).includes("b-marker-after-ts"));
});

t("\\b before \\ts\\* is the correct order and is NOT flagged", () => {
  const u = `${HDR}\\c 1\n\\b\n\\ts\\*\n\\p\n\\v 1 word\n`;
  assert.ok(!rules(u).includes("b-marker-after-ts"));
});

// ── Port fidelity: the one divergence that made us OVER-block ───────────────

t("Check 8 does NOT run on header lines (DCS skips to the first blank line)", () => {
  // A header line that would trip a Check-8 rule in the body must be exempt, or
  // we withhold a book DCS would have merged. Measured as latent today (0 issues
  // across 34 real en_ult/en_ust master files) — this pins the behaviour anyway.
  const u = "\\id EZK\n\\p not alone but in the header\n\\mt1 Ezekiel\n\n\\c 1\n\\p\n\\v 1 word\n";
  assert.ok(!rules(u).includes("paragraph-marker-not-isolated"));
});

t("Check 7 DOES run on header lines (separate DCS function, no header skip)", () => {
  // Check 7 lives in validate_usfm_content, which has no header skip at all, so
  // the skip added for Check 8 must not swallow it.
  const u = "\\id EZK\n\\p\n\\p\n\\mt1 Ezekiel\n\n\\c 1\n\\v 1 word\n";
  assert.ok(rules(u).includes("consecutive-paragraph-markers"));
});

t("header mode does not re-enter after the first blank line", () => {
  // DCS never sets in_header back to True, so a later blank line must not
  // re-exempt the rest of the file.
  const u = `${HDR}\\c 1\n\\p\n\\v 1 word\n\n\\p trailing text\n`;
  assert.ok(rules(u).includes("paragraph-marker-not-isolated"));
});

// ── Clean input passes clean ────────────────────────────────────────────────

t("well-formed chapter has no issues", () => {
  const u = `${HDR}\\c 1\n\\p\n\\v 1 In the beginning\n\\p\n\\v 2 and so on\n\\q1 \\v 3 poetry\n`;
  assert.deepEqual(validateUsfm(u), []);
  assert.equal(hasUsfmValidationErrors(u), false);
});

t("summarizeUsfmIssues gives a compact reason string", () => {
  const u = `${HDR}\\c 8\n\\p\n\\p\n\\v 1 word\n`;
  const s = summarizeUsfmIssues(validateUsfm(u));
  assert.match(s, /consecutive-paragraph-markers×1/);
  assert.match(s, /first: line/);
});

console.log(`\n${passed} usfmValidate tests passed`);
