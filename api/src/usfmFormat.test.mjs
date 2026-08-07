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

t("mid-line \\q2 (no preceding newline, no following \\v) breaks onto its own line", () => {
  // Real usfm-js shape from HOS 13:15: a poetry marker glued directly after a
  // \zaln-e/\w* run with no \v anywhere nearby to trigger splitAtVerses.
  const ls = lines(
    `${HDR}\\q1 \\v 15 \\w Even\\w*\n\\q2 \\w text\\w*\\zaln-e\\*\\w wealth\\w*\\zaln-e\\*,\\q2\\zaln-s |x-strong="H1931"\\*\\w and\\w*\n`,
  );
  const q2Idx = ls.findIndex((l) => l.startsWith("\\q2 \\zaln-s"));
  assert.ok(q2Idx > 0, "second \\q2 starts its own line, with a space before \\zaln-s");
  assert.ok(ls[q2Idx - 1].endsWith(","), "preceding line keeps its own content, ending at the comma");
});

t("mid-line poetry marker between two verses on one raw line stays attached to its \\v", () => {
  // Two short verses glued onto one usfm-js line, each with a distinct poetry
  // level. splitMidlinePoetryMarkers must split BEFORE splitAtVerses runs so
  // \q2 still attaches to \v 2 instead of being force-isolated or left glued
  // onto the end of \v 1's line.
  const ls = lines(`${HDR}\\q1 \\v 1 \\w a\\w* \\q2 \\v 2 \\w b\\w*\n`);
  assert.ok(ls.some((l) => /^\\q1 \\v 1 /.test(l)), "\\q1 stays attached to \\v 1");
  assert.ok(ls.some((l) => /^\\q2 \\v 2 /.test(l)), "\\q2 stays attached to \\v 2");
});

t("clean input passes through unchanged (no-op)", () => {
  const clean = `${HDR}\\ts\\*\n\\c 1\n\\p\n\\q1 \\v 1 \\w a\\w*\n\n\\b\n\\q1 \\v 2 \\w b\\w*\n`;
  assert.equal(norm(clean), clean);
});

// ── DCS Check 7: consecutive paragraph-marker collapse ─────────────────────
// The chapter-front `\p` pile-up (EZK 8/11): a stray extra `\p` accumulated at
// the chapter front one per nightly export and only DCS-side validation caught
// it. normalizeUsfmFormatting collapses consecutive identical paragraph-family
// markers so we stop emitting it (and heal what master already carries on the
// next clean export).
const pCount = (s) => norm(s).split("\n").filter((l) => l.trim() === "\\p").length;

t("stacked \\p at chapter front collapses to a single \\p", () => {
  const out = norm(`${HDR}\\c 11\n\\p\n\n\\p\n\n\\p\n\\v 1 \\w a\\w*\n`);
  assert.match(out, /\\c 11\n\\p\n\\v 1 /);
  assert.equal((out.match(/^\\p$/gm) || []).length, 1, "only one \\p remains");
});

t("two consecutive \\p at chapter front collapse to one (EZK signature)", () => {
  assert.equal(pCount(`${HDR}\\c 8\n\\p\n\\p\n\\v 1 \\w a\\w*\n`), 1);
});

t("three consecutive \\p collapse to one", () => {
  assert.equal(pCount(`${HDR}\\c 11\n\\p\n\\p\n\\p\n\\v 1 \\w a\\w*\n`), 1);
});

t("\\p separated only by a blank line still collapses", () => {
  assert.equal(pCount(`${HDR}\\c 1\n\\p\n\n\\p\n\\v 1 \\w a\\w*\n`), 1);
});

t("the collapse is idempotent (re-normalizing a collapsed front is a no-op)", () => {
  const once = norm(`${HDR}\\c 11\n\\p\n\n\\p\n\n\\p\n\\v 1 \\w a\\w*\n`);
  assert.equal(norm(once), once);
  assert.equal((once.match(/^\\p$/gm) || []).length, 1);
});

t("two \\p separated by real content are both preserved", () => {
  const out = norm(`${HDR}\\c 3\n\\p\n\\v 1 \\w a\\w*\n\\p\n\\v 2 \\w b\\w*\n`);
  assert.equal((out.match(/^\\p$/gm) || []).length, 2, "both \\p kept — content between them");
});

t("chapter opening with poetry keeps no \\p (none is ever invented)", () => {
  const out = norm(`${HDR}\\c 5\n\\q1 \\v 1 \\w a\\w*\n`);
  assert.equal((out.match(/^\\p$/gm) || []).length, 0, "no \\p added at a poetry-opening chapter");
  assert.match(out, /\\c 5\n\\q1 \\v 1 /);
});

t("consecutive \\q1 are NOT collapsed (DCS allows repeated poetry markers)", () => {
  const ls = lines(`${HDR}\\q1\n\\q1\n\\v 1 \\w a\\w*\n`);
  assert.equal(ls.filter((l) => l.trim() === "\\q1").length, 2);
});

t("mixed \\p then \\m adjacency is left intact (validator's job, not auto-fix)", () => {
  const ls = lines(`${HDR}\\c 3\n\\p\n\\m\n\\v 1 \\w a\\w*\n`);
  assert.ok(ls.includes("\\p"), "\\p kept");
  assert.ok(ls.includes("\\m"), "\\m kept — not silently dropped");
});

// ── \ts\* section-milestone collapse ───────────────────────────────────────
// The chapter-boundary `\ts\*` pile-up (LAM): a stray extra `\ts\*` accumulated
// on the last verse of a chapter, just before `\c`, one per nightly export — the
// exact analog of the EZK front-`\p` pump, but for the translator-section chunk
// milestone (which is NOT a DCS Check-7 paragraph marker, so the paragraph pass
// leaves it alone). normalizeUsfmFormatting collapses a consecutive `\ts\*` run so
// we stop emitting the growth and heal what master carries on the next export.
const tsCount = (s) => norm(s).split("\n").filter((l) => l.trim() === "\\ts\\*").length;

t("stacked \\ts\\* at a chapter boundary collapses to one (LAM signature)", () => {
  const out = norm(`${HDR}\\c 1\n\\q1 \\v 22 \\w a\\w*.\n\\ts\\*\n\\ts\\*\n\\ts\\*\n\\ts\\*\n\\c 2\n\\q1 \\v 1 \\w b\\w*\n`);
  assert.equal(tsCount(out), 1, "only one \\ts\\* remains");
  assert.match(out, /\\ts\\\*\n\\c 2\n/, "the surviving \\ts\\* still precedes \\c 2");
});

t("two consecutive \\ts\\* collapse to one", () => {
  assert.equal(tsCount(`${HDR}\\c 1\n\\v 1 \\w a\\w*.\n\\ts\\*\n\\ts\\*\n\\c 2\n\\v 1 \\w b\\w*\n`), 1);
});

t("\\ts\\* separated only by a blank line still collapses", () => {
  assert.equal(tsCount(`${HDR}\\c 1\n\\v 1 \\w a\\w*.\n\\ts\\*\n\n\\ts\\*\n\\c 2\n\\v 1 \\w b\\w*\n`), 1);
});

t("the \\ts\\* collapse is idempotent", () => {
  const once = norm(`${HDR}\\c 1\n\\q1 \\v 22 \\w a\\w*.\n\\ts\\*\n\\ts\\*\n\\ts\\*\n\\c 2\n\\q1 \\v 1 \\w b\\w*\n`);
  assert.equal(norm(once), once);
  assert.equal(tsCount(once), 1);
});

t("two \\ts\\* separated by real content are both preserved", () => {
  const out = norm(`${HDR}\\c 1\n\\ts\\*\n\\q1 \\v 1 \\w a\\w*.\n\\ts\\*\n\\q1 \\v 2 \\w b\\w*\n`);
  assert.equal(tsCount(out), 2, "both \\ts\\* kept — a real verse separates the two sections");
});

t("a single \\ts\\* is never invented or dropped", () => {
  assert.equal(tsCount(`${HDR}\\c 1\n\\v 1 \\w a\\w*.\n\\ts\\*\n\\c 2\n\\v 1 \\w b\\w*\n`), 1);
  assert.equal(tsCount(`${HDR}\\c 1\n\\v 1 \\w a\\w*\n`), 0, "none added where there was none");
});

t("malformed \\ts* pile collapses too (repaired then deduped)", () => {
  // Editor emits the malformed `\ts*`; repairTsStar normalizes each to `\ts\*`
  // before the collapse, so a malformed pile heals identically to a well-formed one.
  assert.equal(tsCount(`${HDR}\\c 1\n\\v 1 \\w a\\w*.\n\\ts*\n\\ts*\n\\ts*\n\\c 2\n\\v 1 \\w b\\w*\n`), 1);
});

// ── Change 1: marker glued to the following marker gets a space ────────────
// usfm-js's own line-builder omits the space before a `w`/`k`/`zaln` tag
// (jsonToUsfm.js:244-247), e.g. `\q2\zaln-s |x-strong=...`. Verified at scale:
// 748 occurrences on en_ust master (`\q2` x461, `\q1` x287). Rich fixed the
// en_ult analog in commit 543e3ee9 (2026-08-05); our export re-broke it.

t("marker glued directly to \\zaln-s gets a space inserted", () => {
  const ls = lines(`${HDR}\\q2\\zaln-s |x-strong="H0001"\\*\\w A\\w*\\zaln-e\\*\n`);
  assert.ok(
    ls.some((l) => l.startsWith('\\q2 \\zaln-s |x-strong="H0001"')),
    "space restored between \\q2 and \\zaln-s",
  );
});

t("\\ts\\* and \\qs\\* are not corrupted by the glued-marker space fix", () => {
  const out = norm(`${HDR}\\v 1 \\w a\\w*.\n\\ts\\*\n\\c 2\n\\q1 \\v 1 \\w b\\w*\n`);
  assert.ok(out.includes("\\ts\\*"), "\\ts\\* remains intact");
  assert.ok(!out.includes("\\ts \\*"), "no space was inserted inside \\ts\\*'s star");
  assert.ok(!out.includes("\\qs \\*"), "no space would be inserted inside a \\qs\\* either");
});

// ── Change 2: doubled leading marker on one line collapses ─────────────────
// `\q1 \q1 \v 1 …` must collapse to `\q1 \v 1 …` BEFORE splitMidlinePoetry
// Markers runs, or it gets split into two lines (`\q1` alone, then
// `\q1 \v 1 …`) — worse than the original doubling.

t("doubled leading marker on one line collapses instead of splitting", () => {
  const ls = lines(`${HDR}\\q1 \\q1 \\v 1 \\w a\\w*\n`);
  assert.ok(
    ls.some((l) => l.trim() === "\\q1 \\v 1 \\w a\\w*"),
    "single \\q1 \\v 1 line, not split",
  );
  assert.equal(
    ls.filter((l) => l.trim() === "\\q1").length,
    0,
    "no standalone duplicate \\q1 line left behind",
  );
});

// ── Change 3: a dangling \v N line joins forward to its content ────────────
// The biggest rule: Rich fixed 680 of these on 2026-08-07 (659 in NUM alone);
// we currently produce 14 on en_ust master. joinDanglingVerses runs after
// reorderMarkerRuns and before collapseConsecutiveParagraphMarkers.

t("dangling \\v: duplicate marker on the target line is dropped for the \\v line's own marker", () => {
  const ls = lines(`${HDR}\\q1 \\v 3\n\\q1 \\w a\\w*\n`);
  assert.ok(ls.some((l) => l.trim() === "\\q1 \\v 3 \\w a\\w*"), "merged, no duplicate \\q1");
});

t("dangling \\v: the \\v line's own marker wins over a different marker on the target", () => {
  const ls = lines(`${HDR}\\q1 \\v 11\n\\q2 \\w a\\w*\n`);
  assert.ok(ls.some((l) => l.trim() === "\\q1 \\v 11 \\w a\\w*"));
});

t("dangling \\v: no marker on either side merges to just \\v N + text", () => {
  const ls = lines(`${HDR}\\q1 \\v 3\n“text”\n`);
  assert.ok(ls.some((l) => l.trim() === "\\q1 \\v 3 “text”"));
});

t("dangling \\v: target's own marker moves above the verse when the \\v line has none", () => {
  const ls = lines(`${HDR}\\b\n\\v 10\n\\q1 \\w a\\w*\n`);
  assert.ok(ls.some((l) => l.trim() === "\\b"), "\\b kept on its own line");
  assert.ok(
    ls.some((l) => l.trim() === "\\q1 \\v 10 \\w a\\w*"),
    "\\q1 moved above the verse number",
  );
});

t("dangling \\v: neither side has a marker", () => {
  const ls = lines(`${HDR}\\v 3\n“text”\n`);
  assert.ok(ls.some((l) => l.trim() === "\\v 3 “text”"));
});

t("dangling \\v: blank lines before the target are deleted", () => {
  const out = norm(`${HDR}\\v 2 \n\n\n“text”\n`);
  assert.equal(out, `${HDR}\\v 2 “text”\n`, "pending blanks before the target are gone, not just skipped over");
});

t("dangling \\v: a marker-only line (\\p) between \\v and its text is kept on its own line", () => {
  const ls = lines(`${HDR}\\v 11\n\n\\p\n“text”\n`);
  const pIdx = ls.indexOf("\\p");
  assert.ok(pIdx > 0, "\\p kept on its own line");
  assert.ok(
    ls.slice(pIdx + 1).some((l) => l.trim() === "\\v 11 “text”"),
    "\\v 11 joined to its text after \\p",
  );
});

// ── Change 4: runs of 2+ blank lines collapse to one ────────────────────────

t("a run of consecutive blank lines collapses to exactly one", () => {
  const out = norm(`${HDR}\\v 1 \\w a\\w*.\n\n\n\n\\p\n\\v 2 \\w b\\w*\n`);
  assert.ok(!/\n\n\n/.test(out), "no run of 2+ blank lines remains");
  assert.match(out, /\\w a\\w\*\.\n\n\\p\n/);
});

// ── Change 5: exactly one trailing newline, always ──────────────────────────

t("output always ends with exactly one trailing newline, even with no input newline", () => {
  const out = norm(`${HDR}\\v 1 \\w a\\w*`);
  assert.ok(out.endsWith("\n") && !out.endsWith("\n\n"), "exactly one trailing newline");
});

t("output collapses multiple trailing input newlines to exactly one", () => {
  const out = norm(`${HDR}\\v 1 \\w a\\w*\n\n\n`);
  assert.ok(out.endsWith("\n") && !out.endsWith("\n\n"), "exactly one trailing newline");
});

// ── Regression guards: pre-existing logic left unchanged by this pass ──────

t("regression guard: \\ts\\* after \\b still reorders to \\b before \\ts\\*", () => {
  const ls = lines(`${HDR}\\v 4 \\w x\\w*.\n\\ts\\*\n\\b\n\\q1 \\v 5 \\w y\\w*\n`);
  const bIdx = ls.indexOf("\\b");
  const tsIdx = ls.indexOf("\\ts\\*");
  assert.ok(bIdx < tsIdx, "\\b still comes before \\ts\\*");
});

t("regression guard: consecutive \\p still collapses to one", () => {
  const out = norm(`${HDR}\\c 8\n\\p\n\\p\n\\v 1 \\w a\\w*\n`);
  assert.equal((out.match(/^\\p$/gm) || []).length, 1, "still collapses to a single \\p");
});

// ── Idempotence across all five new rules together ──────────────────────────
// This matters — the function runs on every nightly export.

t("idempotent across all five new rules together", () => {
  const src =
    `${HDR}\\q2\\zaln-s |x-strong="H0001"\\*\\w A\\w*\\zaln-e\\*\n` +
    `\\q1 \\q1 \\v 1 \\w a\\w*\n` +
    `\\b\n\\v 2\n\n\\p\n\\w b\\w*\n` +
    `\n\n\n\\q1 \\v 3\n\\q1 \\w c\\w*`;
  const once = norm(src);
  assert.equal(norm(once), once, "second normalization pass is a no-op");
});

console.log(`\n${passed} usfmFormat tests passed`);
