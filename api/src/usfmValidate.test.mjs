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

const HDR = "\\id EZK\n\\usfm 3.0\n\\ide UTF-8\n\\h Ezekiel\n\\toc1 Ezekiel\n\\mt1 Ezekiel\n";
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
