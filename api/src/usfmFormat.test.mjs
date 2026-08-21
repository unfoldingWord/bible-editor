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
  // Includes a \c and a dangling \v immediately followed by \ts\* — exactly
  // the shapes that were non-idempotent before the conservative-walk fix
  // (defects 1-3): a dangling \v next to \c/\ts\* must abort untouched on
  // every pass, not just the first.
  const src =
    `${HDR}\\c 1\n\\v 14 \\w x\\w*.\n\\p \\ts\\*\n\\v 15 \\w y\\w*. \\v 16 \\w z\\w*\n` +
    `\\ts\\*\n\\b\n\\q1 \\v 17 \\w q\\w*\n\\v 18\n\\ts\\*\n\\c 2\n\\q1 \\v 1 \\w n\\w*\n`;
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
  // Assertion reworded: joinPoetryMarkerToVerse now joins the SECOND \q1 onto
  // the following \v (its own new rule, unrelated to Check-7 collapsing), so
  // the output is `\q1` then `\q1 \v 1 …` — no bare-`\q1`-line count of 2
  // survives. What this test actually guards (DCS allows repeated poetry
  // markers, so neither is ever dropped) still holds: count surviving \q1
  // markers wherever they appear on a line, not just bare lines.
  const ls = lines(`${HDR}\\q1\n\\q1\n\\v 1 \\w a\\w*\n`);
  const q1Count = ls.filter((l) => /^\\q1\b/.test(l.trim())).length;
  assert.equal(q1Count, 2, "both \\q1 markers survive — one bare, one leading the \\v line");
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
  const out = norm(
    `${HDR}\\v 1 \\w a\\w*.\n\\ts\\*\n\\c 2\n\\q1 \\v 1 \\w b\\w*\\qs Selah\\qs\\*\n`,
  );
  assert.ok(out.includes("\\ts\\*"), "\\ts\\* remains intact");
  assert.ok(!out.includes("\\ts \\*"), "no space was inserted inside \\ts\\*'s star");
  assert.ok(out.includes("\\qs Selah\\qs\\*"), "\\qs\\* remains intact");
  assert.ok(!out.includes("\\qs \\*"), "no space was inserted inside \\qs\\*'s star");
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

// ── Defect 5: collapseDuplicateLeadingMarker narrowed ──────────────────────
// A naive "any marker family, any following content" collapse also mangled
// `\s1 \s1 Heading` -> `\s1 Heading` (deletes a heading!) and `\q1 \q1 text`
// -> `\q1 text` (deletes a legitimately blank poetry line before real text),
// and only handled exactly 2 repeats, not 3+. Narrowed to: attachable poetry
// family only, and only when a \v follows the doubled marker.

t("triple-doubled leading marker (3 repeats) collapses to one", () => {
  const ls = lines(`${HDR}\\q1 \\q1 \\q1 \\v 1 \\w a\\w*\n`);
  assert.ok(
    ls.some((l) => l.trim() === "\\q1 \\v 1 \\w a\\w*"),
    "collapses all the way down to a single \\q1 \\v 1 line",
  );
  assert.equal(ls.filter((l) => l.trim() === "\\q1").length, 0);
});

t("\\s1 \\s1 Heading is left alone (not a poetry marker, no collapse)", () => {
  const out = norm(`${HDR}\\c 1\n\\s1 \\s1 Heading\n\\p\n\\v 1 \\w a\\w*\n`);
  assert.ok(out.includes("\\s1 \\s1 Heading"), "doubled \\s1 heading left completely intact");
});

t("\\q1 \\q1 text (no \\v) is left alone — a real blank poetry line, not doubling", () => {
  // collapseDuplicateLeadingMarker must NOT touch this (no \v follows the
  // doubled marker), so splitMidlinePoetryMarkers runs its normal job on it:
  // an empty \q1 poetry line, then a second \q1 poetry line carrying the
  // text — two rendered lines, not one collapsed line.
  const ls = lines(`${HDR}\\q1 \\q1 text\n`);
  assert.ok(ls.some((l) => l.trim() === "\\q1"), "the empty leading \\q1 line is preserved");
  assert.ok(ls.some((l) => l.trim() === "\\q1 text"), "the second \\q1 line keeps its text");
  assert.equal(
    ls.filter((l) => l.trim() === "\\q1" || l.trim() === "\\q1 text").length,
    2,
    "both \\q1 lines present — nothing collapsed",
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

t("dangling \\v: different poetry markers are preserved instead of choosing a winner", () => {
  const out = norm(`${HDR}\\q1 \\v 11\n\\q2 \\w a\\w*\n`);
  assert.match(out, /\\q1 \\v 11\n\\q2 \\w a\\w\*\n/);
});

t("dangling \\v: target line has no marker, the \\v line's marker is used", () => {
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

// ── Defects 1-4: the forward walk must be conservative and bounded ────────
// Each of these was demonstrated with an executed counter-example against the
// pre-fix code: the walk merged a verse into the WRONG verse (defect 1),
// crossed a chapter boundary (defect 2), absorbed a heading/psalm-title with
// zero validator complaint (defect 3), and had no header guard so a \v in the
// header could be hoisted and could swallow the header-terminating blank
// line (defect 4).

t("defect 1: an empty verse followed by the next chapter is NOT merged into it", () => {
  const out = norm(
    `${HDR}\\c 1\n\\p\n\\v 9 t\n\\v 10\n\\c 2\n\\p\n\\v 1 next\n`,
  );
  assert.ok(
    !out.split("\n").some((l) => (l.match(/\\v\s+\d/g) || []).length > 1),
    "no output line contains two \\v markers",
  );
  assert.match(out, /\\v 10\n/, "verse 1:10 stays dangling, not merged into chapter 2");
  assert.match(out, /\\c 2\n\\p\n\\v 1 next/, "chapter 2's \\v 1 is untouched");
});

t("defect 2: a \\v at the end of a chapter followed by \\ts\\*/\\c is NOT merged", () => {
  const out = norm(`${HDR}\\c 1\n\\p\n\\v 20\n\\ts\\*\n\\c 2\n\\p\n\\v 1 t\n`);
  assert.match(out, /\\v 20\n/, "\\v 20 stays dangling, untouched");
  assert.match(out, /\\ts\\\*\n\\c 2\n\\p\n\\v 1 t/, "\\ts\\*/\\c 2/\\p stay exactly where they were");
});

t("defect 3: a \\v followed by \\s1 is NOT merged; same for \\d", () => {
  const outS1 = norm(`${HDR}\\v 5\n\\s1 A Section Heading\n\\p\n\\v 6 t\n`);
  assert.match(outS1, /\\v 5\n\\s1 A Section Heading\n/, "\\v 5 stays dangling, heading untouched");

  const outD = norm(`${HDR}\\c 1\n\\v 5\n\\d A Psalm Title\n\\v 6 t\n`);
  assert.match(outD, /\\v 5\n\\d A Psalm Title\n/, "\\v 5 stays dangling, psalm title untouched");
});

t("defect 4: a \\v in the header region is untouched, and the header-terminating blank line survives", () => {
  const src = "\\id 1CH\n\\usfm 3.0\n\\v 1\n\\h x\n\n\\c 1\n\\p\n\\v 1 \\w a\\w*\n";
  const out = norm(src);
  assert.ok(out.startsWith("\\id 1CH\n\\usfm 3.0\n\\v 1\n\\h x\n\n"), "header region, including the stray \\v, is untouched verbatim");
  assert.match(out, /\\h x\n\n\\c 1\n\\p\n/, "the header-terminating blank line survives, so \\c still gets its own blank-line treatment");
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

// ── Change 6: a lone poetry marker joins forward onto its \v ───────────────
// The DCS maintainer hand-fixes `\q1` (alone on its line) followed by
// `\v 7 …` into a single `\q1 \v 7 …` line — 620 occurrences across the ULT
// and UST books we export (302+308), vs. essentially none (1+10) in the
// books we don't. joinPoetryMarkerToVerse reproduces that shape directly, and
// runs BEFORE joinDanglingVerses so the two compose correctly (see the
// ordering test below).

t("lone \\q1 joins forward onto \\v 7", () => {
  const ls = lines(`${HDR}\\q1\n\\v 7 \\w a\\w*\n`);
  assert.ok(ls.some((l) => l.trim() === "\\q1 \\v 7 \\w a\\w*"), "joined onto one line");
  assert.ok(!ls.some((l) => l.trim() === "\\q1"), "no bare \\q1 line left behind");
});

for (const marker of ["\\q", "\\q1", "\\q2", "\\q3", "\\q4"]) {
  t(`lone ${marker} joins forward onto its \\v (whole family)`, () => {
    const ls = lines(`${HDR}${marker}\n\\v 9 \\w a\\w*\n`);
    assert.ok(
      ls.some((l) => l.trim() === `${marker} \\v 9 \\w a\\w*`),
      `${marker} joined onto the \\v line`,
    );
  });
}

for (const marker of ["\\m", "\\pi1", "\\li1", "\\mi", "\\qa", "\\qc", "\\qr", "\\qm1"]) {
  t(`lone ${marker} is NOT joined onto its \\v (only \\q/\\q1-4 join)`, () => {
    const ls = lines(`${HDR}${marker}\n\\v 9 \\w a\\w*\n`);
    assert.ok(ls.some((l) => l.trim() === marker), `${marker} stays on its own line`);
    assert.ok(ls.some((l) => l.trim() === "\\v 9 \\w a\\w*"), "\\v 9 stays on its own line");
  });
}

// Corrected 2026-08-11: an earlier version of this test asserted a JOIN here,
// reasoning that Rich's 33 lone-`\q*` lines (all in NUM) never survive
// unjoined. That reasoning was wrong — a lone `\q*` line and a joined
// `\q<n> \v N` line are mutually exclusive shapes, so those 33 lines ARE
// cases where Rich left a lone `\q*` unjoined (he also has hundreds of the
// joined form elsewhere). Separately, 0 of those 33 are followed by a blank
// before their `\v`, so there is no corpus evidence either way for the
// blank-only case. Rich asked specifically for the `\ts\*` shape below and
// said nothing about blanks, so a pure-blank run (no `\ts\*` in it) is left
// exactly as it always was: NOT joined.
t("lone \\q1 does NOT join across a blank line", () => {
  const ls = lines(`${HDR}\\q1\n\n\\v 7 \\w a\\w*\n`);
  assert.ok(ls.some((l) => l.trim() === "\\q1"), "\\q1 stays bare");
  assert.ok(ls.some((l) => l.trim() === "\\v 7 \\w a\\w*"), "\\v 7 stays on its own line");
});

// INVERTED 2026-08-11 per Rich Mahn: a lone `\q1` stranded above a `\ts\*`
// (with the `\v` after it left unjoined) was measured 9 times in current
// master (en_ust/28-HOS.usfm x4, en_ult/33-MIC.usfm x5) and 0 times in his
// hand-cleaned files. Wanted shape: the `\ts\*` line first, then the `\q1`
// joined onto the following `\v` (MIC, en_ult/33-MIC.usfm:1222).
t("lone \\q1 DOES join across \\ts\\* (\\ts\\* is emitted first, then the join)", () => {
  const ls = lines(`${HDR}\\q1\n\\ts\\*\n\\v 7 \\w a\\w*\n`);
  const tsIdx = ls.indexOf("\\ts\\*");
  assert.ok(tsIdx >= 0, "\\ts\\* survives");
  assert.equal(ls[tsIdx + 1].trim(), "\\q1 \\v 7 \\w a\\w*", "\\ts\\* precedes the joined line");
  assert.ok(!ls.some((l) => l.trim() === "\\q1"), "no bare \\q1 line left behind");
});

t("lone \\q1 does NOT join across \\b", () => {
  const ls = lines(`${HDR}\\q1\n\\b\n\\v 7 \\w a\\w*\n`);
  assert.ok(ls.some((l) => l.trim() === "\\q1"));
  assert.ok(ls.some((l) => l.trim() === "\\b"));
});

// Export formatting may reposition a marker when the target is unambiguous,
// but must preserve it when there is no lossless join available.
t("lone \\q1 before \\c 2 is preserved", () => {
  const ls = lines(`${HDR}\\q1\n\\c 2\n\\v 7 \\w a\\w*\n`);
  assert.ok(ls.some((l) => l.trim() === "\\q1"), "\\q1 survives");
  assert.ok(ls.some((l) => l.trim() === "\\c 2"), "\\c 2 is untouched");
});

t("lone \\q1 does NOT join across an \\s1 heading", () => {
  const ls = lines(`${HDR}\\q1\n\\s1 A Heading\n\\v 7 \\w a\\w*\n`);
  assert.ok(ls.some((l) => l.trim() === "\\q1"));
  assert.ok(ls.some((l) => l.trim() === "\\s1 A Heading"));
});

t("lone \\q1 does NOT join across a \\d heading", () => {
  const ls = lines(`${HDR}\\c 1\n\\q1\n\\d A Psalm Title\n\\v 7 \\w a\\w*\n`);
  assert.ok(ls.some((l) => l.trim() === "\\q1"));
  assert.ok(ls.some((l) => l.trim() === "\\d A Psalm Title"));
});

t("\\q1 / bare \\v 2 / <content> joins all the way (interaction with joinDanglingVerses)", () => {
  const out = norm(`${HDR}\\q1\n\\v 2\n\\w a\\w*\n`);
  assert.match(out, /\\q1 \\v 2 \\w a\\w\*\n/);
});

t("\\q1 / \\v 11 / \\q2 <text> preserves both poetry levels", () => {
  // joinPoetryMarkerToVerse first attaches \\q1 to the verse. The subsequent
  // dangling-verse repair must not resolve the conflict by deleting \\q2.
  const out = norm(`${HDR}\\q1\n\\v 11\n\\q2 \\w a\\w*\n`);
  assert.match(out, /\\q1 \\v 11\n\\q2 \\w a\\w\*\n/);
  assert.equal((out.match(/\\q1|\\q2/g) || []).length, 2, "neither poetry marker is deleted");
});

t("two consecutive \\q1 before a \\v: only the second joins", () => {
  const ls = lines(`${HDR}\\q1\n\\q1\n\\v 5 \\w a\\w*\n`);
  assert.ok(ls.some((l) => l.trim() === "\\q1"), "first \\q1 stays bare");
  assert.ok(ls.some((l) => l.trim() === "\\q1 \\v 5 \\w a\\w*"), "second \\q1 joins onto \\v 5");
});

t("lone \\q1 joins onto a verse bridge \\v 6-9", () => {
  const ls = lines(`${HDR}\\q1\n\\v 6-9 \\w a\\w*\n`);
  assert.ok(ls.some((l) => l.trim() === "\\q1 \\v 6-9 \\w a\\w*"));
});

// This is the Hosea 9 shape that PR 430 treated as inferred cleanup. Absence
// from another revision is not proof that deleting editor-authored USFM is safe.
t("a lone poetry marker at end of file is preserved", () => {
  const out = norm(`${HDR}\\v 1 \\w a\\w*\n\\q1`);
  assert.match(out, /\\q1\n$/, "trailing bare \\q1 survives");
});

t("lone-poetry-marker join is idempotent", () => {
  const once = norm(`${HDR}\\q1\n\\v 7 \\w a\\w*\n\\q1\n\\q1\n\\v 8 \\w b\\w*\n`);
  assert.equal(norm(once), once);
});

// Regression for issue #431. FIX D (dropping a content-less \q* stranded
// before \c/EOF) was removed by PR #435 in favor of always preserving a lone
// poetry marker — but that drop was also the ONLY thing making this specific
// shape non-idempotent: dropping the \q* made \p and \ts\* newly adjacent, a
// run reorderMarkerRuns (which runs BEFORE the drop) had already missed, so a
// second pass sorted that run and moved \ts\* across the \c 9/\c 10 boundary
// while collapsing chapter 9's \p. With FIX D gone there is nothing left to
// create that adjacency, but pin it anyway so a future pass added to this
// pipeline can't reopen the same "creates a run after reorder already ran"
// hazard unnoticed.
t("content-less \\q* before \\ts\\*/\\c stays idempotent and keeps both \\p (#431)", () => {
  const src = `\\id HAB\n\\h Habakkuk\n\n\\c 9\n\\p\n\\q1\n\\ts\\*\n\\c 10\n\\p\n\\v 1 text\n`;
  const once = norm(src);
  const twice = norm(once);
  assert.equal(twice, once, "second normalization pass must be a no-op");
  const countP = (s) => s.split("\n").filter((l) => l.trim() === "\\p").length;
  assert.equal(countP(once), 2, "both chapters' \\p markers must survive");
  const c9Idx = once.split("\n").findIndex((l) => l.trim() === "\\c 9");
  const tsIdx = once.split("\n").findIndex((l) => l.trim() === "\\ts\\*");
  assert.ok(tsIdx > c9Idx, "\\ts\\* must not move above \\c 9");
});

t("lone-poetry-marker join never produces a line with two \\v markers", () => {
  const out = norm(`${HDR}\\q1\n\\v 11\n\\q2 \\w a\\w*\n\\q1\n\\v 12 \\w b\\w*\n`);
  for (const l of out.split("\n")) {
    const vCount = (l.match(/\\v\s+\d/g) || []).length;
    assert.ok(vCount <= 1, `line has ${vCount} \\v markers: ${JSON.stringify(l)}`);
  }
});

// ── Idempotence across all five new rules together ──────────────────────────
// This matters — the function runs on every nightly export.

t("idempotent across all five new rules together", () => {
  const src =
    `${HDR}\\c 1\n` +
    `\\q2\\zaln-s |x-strong="H0001"\\*\\w A\\w*\\zaln-e\\*\n` +
    `\\q1 \\q1 \\v 1 \\w a\\w*\n` +
    `\\b\n\\v 2\n\n\\p\n\\w b\\w*\n` +
    `\n\n\n\\q1 \\v 3\n\\q1 \\w c\\w*\n` +
    // dangling \v abutting \ts\*/\c — the defect-1/2 shape — folded into the
    // same composite so idempotence is proven for it too.
    `\\v 4\n\\ts\\*\n\\c 2\n\\q1 \\v 1 \\w d\\w*`;
  const once = norm(src);
  assert.equal(norm(once), once, "second normalization pass is a no-op");
});

// ── Invariant: a merge must never produce a line with two \v markers ───────
// Runs the "no output line contains two \v" check over every non-trivial
// input used elsewhere in this file, not just the defect-1 case that
// motivated it.
const INVARIANT_INPUTS = [
  `${HDR}\\c 1\n\\p\n\\v 9 t\n\\v 10\n\\c 2\n\\p\n\\v 1 next\n`,
  `${HDR}\\c 1\n\\p\n\\v 20\n\\ts\\*\n\\c 2\n\\p\n\\v 1 t\n`,
  `${HDR}\\v 5\n\\s1 A Section Heading\n\\p\n\\v 6 t\n`,
  `${HDR}\\c 1\n\\v 5\n\\d A Psalm Title\n\\v 6 t\n`,
  "\\id 1CH\n\\usfm 3.0\n\\v 1\n\\h x\n\n\\c 1\n\\p\n\\v 1 \\w a\\w*\n",
  `${HDR}\\q1 \\v 3\n\\q1 \\w a\\w*\n`,
  `${HDR}\\q1 \\v 11\n\\q2 \\w a\\w*\n`,
  `${HDR}\\b\n\\v 10\n\\q1 \\w a\\w*\n`,
  `${HDR}\\v 11\n\n\\p\n“text”\n`,
  `${HDR}\\v 28 \\w Ishmael\\w*. \\v 29 \\w These\\w*\n`,
  `${HDR}\\q1 \\v 1 \\w a\\w* \\q2 \\v 2 \\w b\\w*\n`,
  `${HDR}\\c 1\n\\q2\\zaln-s |x-strong="H0001"\\*\\w A\\w*\\zaln-e\\*\n\\q1 \\q1 \\v 1 \\w a\\w*\n\\b\n\\v 2\n\n\\p\n\\w b\\w*\n\n\n\n\\q1 \\v 3\n\\q1 \\w c\\w*\n\\v 4\n\\ts\\*\n\\c 2\n\\q1 \\v 1 \\w d\\w*`,
  `${HDR}\\p\n\\v 1\n\n\\q1 \\v 2 \\w x\\w*\n`,
];

// A verse line normally carries its paragraph marker FIRST (`\q1 \v 2 …`), so
// the abort test for "another \v" has to be unanchored. An anchored `^\\v`
// check misses this shape entirely and the join emits `\q1 \v 1 \v 2 …` — two
// verses on one line, which validateUsfm rejects, withholding the whole book
// from export. Caught only after the earlier fix, because every other
// two-verse case in this file puts the second `\v` at the start of its line.
// `\qa` (acrostic letter) and friends live in POETRY_MARKER_ALTERNATION, so
// without an explicit abort the join peels the marker off and hoists the verse
// number INTO the heading — `\qa \v 1 Aleph` makes "Aleph" verse 1's first word,
// and no validator complains. Unreachable in today's data, guarded anyway.
for (const [marker, text] of [
  ["\\qa", "Aleph"],
  ["\\sp", "David"],
  ["\\ms1", "Book One"],
  ["\\cl", "Chapter"],
]) {
  t(`a dangling \\v never merges into a ${marker} heading`, () => {
    const out = norm(`${HDR}\\p\n\\v 1\n${marker} ${text}\n\\q1 \\w one\\w*\n`);
    assert.ok(
      !new RegExp(`\\${marker}\\s+\\\\v 1`).test(out),
      `verse hoisted into the ${marker} heading: ${JSON.stringify(out)}`,
    );
    assert.ok(out.includes(`${marker} ${text}`), `${marker} heading must be left intact`);
  });
}

t("a body opening with a 3-blank run keeps exactly one blank", () => {
  const out = norm(`${HDR}\n\n\\p\n\\v 1 \\w a\\w*\n`);
  assert.ok(!/\n\n\n/.test(out), `more than one consecutive blank survived: ${JSON.stringify(out)}`);
});

t("a dangling \\v does not merge into a MARKER-PREFIXED verse line", () => {
  const out = norm(`${HDR}\\p\n\\v 1\n\n\\q1 \\v 2 \\w x\\w*\n`);
  assert.ok(!/\\v 1 \\v 2/.test(out), `verses merged onto one line: ${JSON.stringify(out)}`);
  assert.ok(out.includes("\\v 1"), "the dangling \\v 1 must survive untouched");
  assert.ok(out.includes("\\q1 \\v 2 \\w x\\w*"), "the target verse line must be unchanged");
});

t("invariant: no output line ever contains two \\v markers", () => {
  for (const src of INVARIANT_INPUTS) {
    const out = norm(src);
    for (const l of out.split("\n")) {
      const vCount = (l.match(/\\v\s+\d/g) || []).length;
      assert.ok(vCount <= 1, `line has ${vCount} \\v markers: ${JSON.stringify(l)}`);
    }
  }
});

// ── FIX A (2026-08-11): paragraph-family markers never fuse to content ─────
// Measured: `\m` fused mid-line to a following `\zaln-s` in current master
// (en_ult/04-NUM.usfm:19540 and en_ust/04-NUM.usfm:22162, both NUM 20:1),
// while Rich Mahn's cleaned files have `\m` own-line 4/4 (joined 0 times).

t("FIX A: \\m fused mid-line with following \\zaln-s ends up own-line (NUM 20:1, en_ult/04-NUM.usfm:19540)", () => {
  const ls = lines(
    `${HDR}\\v 20 \\w x\\w*.\\m \\zaln-s |x-strong="H1"\\*\\w y\\w*\\zaln-e\\*\n`,
  );
  assert.ok(ls.some((l) => l.trim() === "\\m"), "\\m isolated onto its own line");
  assert.ok(
    !ls.some((l) => /^\\m\s+\S/.test(l.trim())),
    "\\m never carries following content on the same line",
  );
});

t("FIX A: \\m already own-line is unchanged", () => {
  const ls = lines(`${HDR}\\c 1\n\\m\n\\v 1 \\w a\\w*\n`);
  assert.ok(ls.some((l) => l.trim() === "\\m"), "\\m stays on its own line");
  assert.ok(ls.some((l) => l.trim() === "\\v 1 \\w a\\w*"), "\\v 1 stays on its own line");
});

t("FIX A: \\m is never prefixed onto a \\v line", () => {
  const ls = lines(`${HDR}\\m\n\\v 1 \\w a\\w*\n`);
  assert.ok(
    !ls.some((l) => /^\\m\s+\\v/.test(l.trim())),
    "\\m is never joined ahead of \\v (only \\q/\\q1-4 join)",
  );
  assert.ok(ls.some((l) => l.trim() === "\\v 1 \\w a\\w*"), "\\v 1 stays bare");
});

t("FIX A: \\p behaviour unchanged (still standalone, still crossable in joinDanglingVerses)", () => {
  const ls = lines(`${HDR}\\v 30 \\w you\\w*?”\\p\\w he\\w*\n`);
  const pIdx = ls.indexOf("\\p");
  assert.ok(pIdx > 0, "\\p still isolated onto its own line");
  assert.match(ls[pIdx + 1], /^\\w he/);
});

// Regression (caught in pre-merge review 2026-08-11): FIX A's own-line
// extraction of the paragraph family (isolating `\m` from `\m \w text\w*`)
// combined with an over-broad isAbortLine branch to make a bare `\m` line
// ABORT the dangling-\v join instead of being crossed like `\p`. Input
// `\v 8` / `\m \w text\w*` (usfm-js's fused shape) went from main's correct
// `\m` / `\v 8 \w text\w*` to a stranded bare `\v 8` line sitting above `\m`
// above `\w text\w*` — exactly the defect joinDanglingVerses exists to fix.
t("dangling \\v: a bare \\m between \\v and its text is crossed, not aborted (regression against main)", () => {
  const ls = lines(`${HDR}\\v 8\n\\m \\w text\\w*\n`);
  const mIdx = ls.indexOf("\\m");
  assert.ok(mIdx > 0, "\\m kept, isolated onto its own line");
  assert.ok(
    ls.slice(mIdx + 1).some((l) => l.trim() === "\\v 8 \\w text\\w*"),
    "\\v 8 crosses the bare \\m and joins its text",
  );
  assert.ok(
    !ls.some((l) => /^\\v\s+\d+\s*$/.test(l.trim())),
    "no line is left as a bare, stranded \\v",
  );
});

t("dangling \\v: crossing a bare \\m never fuses \\m onto the \\v line", () => {
  const ls = lines(`${HDR}\\v 8\n\\m \\w text\\w*\n`);
  assert.ok(
    !ls.some((l) => /^\\m\s+\\v/.test(l.trim())),
    "\\m is not prefixed onto the merged \\v line",
  );
  assert.ok(
    !ls.some((l) => /^\\v\s+\d+\s+\\m\b/.test(l.trim())),
    "\\m does not trail the \\v line either",
  );
  assert.ok(ls.some((l) => l.trim() === "\\m"), "\\m still lands on its own line");
});

// ── FIX B (2026-08-11): a lone \q* joins across a \ts\* run ────────────────
// Measured: 9 occurrences of a lone \q* stranded above \ts\* in current
// master (en_ust/28-HOS.usfm x4, en_ult/33-MIC.usfm x5) vs 0 in Rich Mahn's
// cleaned files. Wanted shape per Rich Mahn's 2026-08-11 request: \ts\* first,
// then the \q* joined onto its \v.

t("FIX B: lone \\q1 + \\ts\\* + \\v produces \\ts\\* then \\q1 \\v N (MIC, en_ult/33-MIC.usfm:1222)", () => {
  const ls = lines(`${HDR}\\v 1 \\w it\\w*\n\\q1\n\\ts\\*\n\\v 2 \\w Aaron\\w*\n`);
  const tsIdx = ls.indexOf("\\ts\\*");
  assert.ok(tsIdx >= 0, "\\ts\\* present");
  assert.equal(ls[tsIdx + 1].trim(), "\\q1 \\v 2 \\w Aaron\\w*", "\\ts\\* precedes the joined line");
  assert.ok(!ls.some((l) => l.trim() === "\\q1"), "no bare \\q1 line left behind");
});

// ── FIX C (2026-08-11): a lone \q* joins to non-\v content too ─────────────
// Measured: 32 occurrences in current master (en_ult/38-ZEC.usfm — 24x \q2,
// 8x \q1) of a lone \q* stranded above a \zaln-s/\w continuation of the same
// verse, vs 0 in Rich Mahn's cleaned files.

t("FIX C: lone \\q2 + \\zaln-s content line joins (ZEC, en_ult/38-ZEC.usfm:3508)", () => {
  const ls = lines(
    `${HDR}\\q2\n\\zaln-s |x-strong="c:H6651"\\*\\w heaped\\w*\\zaln-e\\*\n`,
  );
  assert.ok(
    ls.some((l) => l.trim() === '\\q2 \\zaln-s |x-strong="c:H6651"\\*\\w heaped\\w*\\zaln-e\\*'),
    "joined onto one line",
  );
  assert.ok(!ls.some((l) => l.trim() === "\\q2"), "no bare \\q2 line left behind");
});

// `\c 2` has its own preservation case below. The `\ts\*` case is followed
// by `\b` so this loop continues to exercise a non-joinable skipped run.
for (const [marker, content] of [
  ["\\ts\\*", "\\ts\\*\n\\b"],
  ["\\b", "\\b"],
  ["\\s1", "\\s1 A Heading"],
  ["another \\q*", "\\q2 \\w a\\w*"],
]) {
  t(`FIX C: lone \\q1 followed by ${marker} does NOT join to it`, () => {
    const ls = lines(`${HDR}\\q1\n${content}\n`);
    assert.ok(ls.some((l) => l.trim() === "\\q1"), "\\q1 stays bare");
  });
}

// ── Lossless guard: an unjoinable lone \q* is preserved ────────────────────

t("lossless: lone \\q1 followed by \\c 2 is preserved", () => {
  const ls = lines(`${HDR}\\q1\n\\c 2\n\\v 1 \\w a\\w*\n`);
  assert.ok(ls.some((l) => l.trim() === "\\q1"), "\\q1 survives");
  assert.ok(ls.some((l) => l.trim() === "\\c 2"), "\\c 2 is untouched");
});

t("lossless: lone \\q1 at end of file is preserved", () => {
  const out = norm(`${HDR}\\v 1 \\w a\\w*\n\\q1`);
  assert.match(out, /\\q1\n$/, "\\q1 survives");
});

t("lossless: preserving a \\q1 before \\c also preserves skipped \\ts\\*", () => {
  const ls = lines(`${HDR}\\q1\n\\ts\\*\n\\c 2\n\\v 1 \\w a\\w*\n`);
  assert.ok(ls.some((l) => l.trim() === "\\q1"), "\\q1 survives");
  assert.ok(ls.some((l) => l.trim() === "\\ts\\*"), "\\ts\\* survives");
  assert.ok(ls.some((l) => l.trim() === "\\c 2"), "\\c 2 is untouched");
});

t("lossless: lone \\q1 followed by \\b remains preserved", () => {
  const ls = lines(`${HDR}\\q1\n\\b\n`);
  assert.ok(ls.some((l) => l.trim() === "\\q1"), "\\q1 is left in place");
});

t("lossless: lone \\q1 followed by \\s1 remains preserved", () => {
  const ls = lines(`${HDR}\\q1\n\\s1 A Heading\n`);
  assert.ok(ls.some((l) => l.trim() === "\\q1"), "\\q1 is left in place");
});

// ── Issue #431 regression: idempotence on a content-less \q* before \ts\* ──
// across a chapter boundary. FIX D (dropping a content-less \q* before \c/
// EOF) used to make a fresh \p/\ts\* adjacency for the SECOND pass that
// reorderMarkerRuns had already run past on the first — losing a \p and
// moving \ts\* across the chapter boundary. FIX D was removed by #435 (lone
// \q* is now always preserved), which also removes the adjacency this
// exploited, but the invariant is worth pinning directly.

t("issue #431: idempotent on lone \\q1 before \\ts\\* at a chapter boundary", () => {
  const src = `${HDR}\\c 9\n\\p\n\\q1\n\\ts\\*\n\\c 10\n\\p\n\\v 1 \\w text\\w*\n`;
  const once = norm(src);
  assert.equal(norm(once), once, "second normalization pass is a no-op");
  assert.equal(pCount(once), 2, "both \\p markers survive");
});

// Issue #384: usfm-js can emit `\c` / `\p` / `\s1 Heading` (real ZEC 6 shape),
// which is legal USFM but places the heading behind the paragraph marker, so a
// naive front-matter scan looking backward from verse 1 hits the heading first
// and never sees the \p behind it. The USFM manual orders a chapter-opening
// section heading BEFORE the paragraph that introduces its first verse, so
// reorderMarkerRuns now hoists \s-family headings above \p, same as it already
// does for \ts\*/\c.
t("issue #384: \\s1 heading is hoisted above a preceding \\p", () => {
  const out = norm(`${HDR}\\c 6\n\\p\n\\s1 The vision of four chariots\n\\v 1 \\w I\\w*\n`);
  const idxS1 = out.indexOf("\\s1 The vision");
  const idxP = out.indexOf("\\p");
  assert.ok(idxS1 >= 0 && idxP >= 0 && idxS1 < idxP, "\\s1 now precedes \\p");
});

t("issue #384: \\s1 already before \\p is left in order", () => {
  const out = norm(`${HDR}\\c 6\n\\s1 A Heading\n\\p\n\\v 1 \\w a\\w*\n`);
  const idxS1 = out.indexOf("\\s1 A Heading");
  const idxP = out.indexOf("\\p");
  assert.ok(idxS1 < idxP, "already-correct order is unchanged");
});

t("issue #384: bare \\s and \\s2-\\s5 all hoist above \\p", () => {
  for (const tag of ["\\s", "\\s2", "\\s3", "\\s4", "\\s5"]) {
    const out = norm(`${HDR}\\c 6\n\\p\n${tag} Heading text\n\\v 1 \\w a\\w*\n`);
    const idxHeading = out.indexOf(`${tag} Heading text`);
    const idxP = out.indexOf("\\p");
    assert.ok(idxHeading < idxP, `${tag} precedes \\p`);
  }
});

t("issue #384: full front-matter run \\b / \\ts\\* / \\c / \\p / \\s1 sorts into canonical order", () => {
  const out = norm(`${HDR}\\b\n\\ts\\*\n\\c 6\n\\p\n\\s1 Heading\n\\v 1 \\w a\\w*\n`);
  const order = ["\\b", "\\ts\\*", "\\c 6", "\\s1 Heading", "\\p"].map((m) => out.indexOf(m));
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i - 1] < order[i], `${["\\b", "\\ts\\*", "\\c 6", "\\s1 Heading", "\\p"][i]} out of order`);
  }
});

t("issue #384: \\sp (speaker) is NOT treated as a section heading", () => {
  const out = norm(`${HDR}\\c 6\n\\p\n\\sp Paul\n\\v 1 \\w a\\w*\n`);
  const idxSp = out.indexOf("\\sp Paul");
  const idxP = out.indexOf("\\p");
  assert.ok(idxP < idxSp, "\\p is unaffected by an unrelated \\sp marker");
});

t("issue #384: fix is idempotent on the ZEC 6 shape", () => {
  const src = `${HDR}\\c 6\n\\p\n\\s1 The vision of four chariots\n\\v 1 \\w I\\w*\n`;
  const once = norm(src);
  assert.equal(norm(once), once, "second normalization pass is a no-op");
});

console.log(`\n${passed} usfmFormat tests passed`);
