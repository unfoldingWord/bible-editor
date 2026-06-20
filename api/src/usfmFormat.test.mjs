// Unit tests for the export USFM formatting normalizer (usfmFormat.ts).
// Run: node --experimental-strip-types --no-warnings src/usfmFormat.test.mjs
//
// These cases are the regression net for the DCS Check-8 ("USFM Formatting")
// rules. Each was distilled from a real usfm-js output shape observed in the
// `-be-` export branches (see docs/export-validation-cleanup.md). The end-to-end
// proof (the real DCS validator taking every tested book to 0 errors) lives in
// the verification scripts; this file pins the individual transforms.

import assert from "node:assert/strict";
import { normalizeUsfmFormatting } from "./usfmFormat.ts";

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}
const norm = (s) => normalizeUsfmFormatting(s);
const lines = (s) => norm(s).split("\n");

// Minimal header block (normalizer treats everything up to the first blank line
// as the header and passes it through untouched).
const HDR = "\\id 1CH\n\\usfm 3.0\n\\h x\n\n";

t("blank line added before \\b", () => {
  const out = norm(`${HDR}\\q1 \\v 1 \\w a\\w*\n\\b\n\\q1 \\v 2 \\w b\\w*\n`);
  assert.match(out, /\\w a\\w\*\n\n\\b\n/);
});

t("blank line added before \\p (not after)", () => {
  const out = norm(`${HDR}\\v 1 \\w a\\w*\n\\p\n\\v 2 \\w b\\w*\n`);
  assert.match(out, /\\w a\\w\*\n\n\\p\n\\v 2/);
});

t("blank line removed after \\c", () => {
  const out = norm(`${HDR}\\c 1\n\n\\p\n\\v 1 \\w a\\w*\n`);
  assert.match(out, /\\c 1\n\\p\n/);
});

t("malformed \\ts* repaired to \\ts\\*", () => {
  const out = norm(`${HDR}\\v 19 \\w x\\w*.\n\\ts* \\v 20 \\w y\\w*\n`);
  assert.ok(out.includes("\\ts\\*"), "should contain proper \\ts\\*");
  assert.ok(!/\\ts\*(?!\\)/.test(out.replace(/\\ts\\\*/g, "")), "no bare \\ts* remains");
});

t("\\ts\\* glued before \\v moves to its own line", () => {
  const ls = lines(`${HDR}\\v 19 \\w x\\w*.\n\\ts\\* \\v 20 \\w y\\w*\n`);
  assert.ok(ls.includes("\\ts\\*"), "\\ts\\* on its own line");
  assert.ok(ls.some((l) => /^\\v 20 /.test(l)), "\\v 20 starts its own line");
});

t("trailing \\p extracted onto its own line", () => {
  // usfm-js shape: "...word\w*. \p" then "\v 6 ..."
  const ls = lines(`${HDR}\\v 5 \\w drink\\w*.” \\p\n\\v 6 \\w then\\w*\n`);
  assert.ok(ls.includes("\\p"), "\\p isolated");
  // \p must not be followed by a blank line, and must precede \v 6
  const pIdx = ls.indexOf("\\p");
  assert.match(ls[pIdx + 1], /^\\v 6 /);
});

t("embedded \\p (…?”\\p\\w he) split into three", () => {
  const ls = lines(`${HDR}\\v 30 \\w you\\w*?”\\p\\w he\\w*\n`);
  const pIdx = ls.indexOf("\\p");
  assert.ok(pIdx > 0, "\\p isolated");
  // content before \p (a blank line is correctly inserted between them)
  assert.ok(ls.slice(0, pIdx).some((l) => /you\\w\*\?”$/.test(l)), "verse text precedes \\p");
  assert.match(ls[pIdx + 1], /^\\w he/);
});

t("mid-line \\v split so each verse starts its own line", () => {
  const ls = lines(`${HDR}\\v 28 \\w Ishmael\\w*. \\v 29 \\w These\\w*\n`);
  assert.ok(ls.some((l) => /^\\v 28 /.test(l)));
  assert.ok(ls.some((l) => /^\\v 29 /.test(l)));
  assert.ok(ls.some((l) => /Ishmael\\w\*\.$/.test(l)), "v28 tail kept");
});

t("\\q1 stays attached to its \\v", () => {
  const ls = lines(`${HDR}\\q1 \\v 1 \\w a\\w*\n`);
  assert.ok(ls.some((l) => /^\\q1 \\v 1 /.test(l)));
});

t("\\p before \\ts\\* reordered to \\ts\\* before \\p", () => {
  const ls = lines(`${HDR}\\v 14 \\w x\\w*.\n\\p \\ts\\*\n\\v 15 \\w y\\w*\n`);
  const tsIdx = ls.indexOf("\\ts\\*");
  const pIdx = ls.indexOf("\\p");
  assert.ok(tsIdx >= 0 && pIdx >= 0);
  assert.ok(tsIdx < pIdx, "\\ts\\* comes before \\p");
  assert.match(ls[pIdx + 1], /^\\v 15 /);
});

t("\\ts\\* after \\b reordered to \\b before \\ts\\*", () => {
  const ls = lines(`${HDR}\\v 4 \\w x\\w*.\n\\ts\\*\n\\b\n\\q1 \\v 5 \\w y\\w*\n`);
  const bIdx = ls.indexOf("\\b");
  const tsIdx = ls.indexOf("\\ts\\*");
  assert.ok(bIdx < tsIdx, "\\b before \\ts\\*");
});

t("idempotent", () => {
  const src = `${HDR}\\v 14 \\w x\\w*.\n\\p \\ts\\*\n\\v 15 \\w y\\w*. \\v 16 \\w z\\w*\n\\ts\\*\n\\b\n\\q1 \\v 17 \\w q\\w*\n`;
  const once = norm(src);
  assert.equal(norm(once), once);
});

t("alignment/word content is never modified (counts preserved)", () => {
  const src = `${HDR}\\ts\\* \\v 1 \\zaln-s |x-strong="H1"\\*\\w a\\w*\\zaln-e\\*. \\v 2 \\w b\\w*\\p\n`;
  const out = norm(src);
  const count = (s, re) => (s.match(re) || []).length;
  assert.equal(count(out, /\\zaln-s\b/g), count(src, /\\zaln-s\b/g));
  assert.equal(count(out, /\\zaln-e\\\*/g), count(src, /\\zaln-e\\\*/g));
  assert.equal(count(out, /\\w\s/g), count(src, /\\w\s/g));
  assert.equal(count(out, /\\v\s+\d+/g), count(src, /\\v\s+\d+/g));
});

t("clean input passes through unchanged (no-op)", () => {
  const clean = `${HDR}\\ts\\*\n\\c 1\n\\p\n\\q1 \\v 1 \\w a\\w*\n\n\\b\n\\q1 \\v 2 \\w b\\w*\n`;
  assert.equal(norm(clean), clean);
});

console.log(`\n${passed} usfmFormat tests passed`);
