// Unit tests for the hard-reject export gate (hardRejectGuard.ts).
// Run: node --experimental-strip-types --no-warnings src/hardRejectGuard.test.mjs

import assert from "node:assert/strict";
import { bracketProblems, buildHardRejectAlertMessage, hardRejectRows } from "./hardRejectGuard.ts";

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const TN_H = ["Reference", "ID", "Tags", "SupportReference", "Quote", "Occurrence", "Note"].join("\t");
const TWL_H = ["Reference", "ID", "Tags", "OrigWords", "Occurrence", "TWLink"].join("\t");
const tnTsv = (...rows) => `${TN_H}\n${rows.map((r) => r.join("\t")).join("\n")}\n`;
const twlTsv = (...rows) => `${TWL_H}\n${rows.map((r) => r.join("\t")).join("\n")}\n`;

console.log("[hardRejectRows — twl]");
t("blank Occurrence is rejected even when OrigWords is also blank (the 'add word' stub)", () => {
  // The exact render Codex proved buildTwlTsv emits for a Shell.tsx "add word"
  // stub: OrigWords, Occurrence and TWLink all empty.
  const rows = hardRejectRows("twl", twlTsv(["1:1", "abcd", "", "", "", ""]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ref, "1:1");
  assert.equal(rows[0].rowId, "abcd");
  assert.match(rows[0].reason, /Occurrence is blank/);
});
t("blank Occurrence is rejected even when OrigWords IS present", () => {
  // Live prod shape: DAN 3:5 xf8f, orig_words "fall down", occurrence NULL.
  const rows = hardRejectRows("twl", twlTsv(["3:5", "xf8f", "", "fall down", "", "rc://*/tw/dict/bible/kt/worship"]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rowId, "xf8f");
});
t("Occurrence 0 is rejected for twl (positive integer only)", () => {
  assert.equal(hardRejectRows("twl", twlTsv(["1:1", "abcd", "", "דָּבָר", "0", "rc://x"])).length, 1);
});
t("Occurrence -1 is rejected for twl", () => {
  assert.equal(hardRejectRows("twl", twlTsv(["1:1", "abcd", "", "דָּבָר", "-1", "rc://x"])).length, 1);
});
t("non-numeric Occurrence is rejected for twl", () => {
  const rows = hardRejectRows("twl", twlTsv(["1:1", "abcd", "", "דָּבָר", "1a", "rc://x"]));
  assert.equal(rows.length, 1);
  assert.match(rows[0].reason, /must be a positive integer/);
});
t("a valid twl row passes, and a blank OrigWords/TWLink alone does NOT hold the book", () => {
  // This is the whole point of the PR: OrigWords/TWLink blank are warnings, so
  // they must NOT appear here. Only the Occurrence column holds.
  assert.deepEqual(hardRejectRows("twl", twlTsv(["1:1", "abcd", "", "", "1", ""])), []);
  assert.deepEqual(hardRejectRows("twl", twlTsv(["1:1", "abcd", "", "דָּבָר", "2", "rc://x"])), []);
});

console.log("\n[hardRejectRows — tn]");
t("blank Occurrence with a non-blank Quote is rejected", () => {
  const rows = hardRejectRows("tn", tnTsv(["1:1", "abcd", "", "", "the word", "", "a note"]));
  assert.equal(rows.length, 1);
  assert.match(rows[0].reason, /Occurrence is blank but Quote is not/);
});
t("blank Occurrence with a blank Quote is ALLOWED (the validator's own exemption)", () => {
  assert.deepEqual(hardRejectRows("tn", tnTsv(["1:1", "abcd", "", "", "", "", "a note"])), []);
});
t("Occurrence 0 and -1 are both legal for tn", () => {
  assert.deepEqual(hardRejectRows("tn", tnTsv(["1:1", "abcd", "", "", "q", "0", "n"])), []);
  assert.deepEqual(hardRejectRows("tn", tnTsv(["1:1", "abcd", "", "", "q", "-1", "n"])), []);
});
t("non-numeric Occurrence is rejected for tn", () => {
  assert.equal(hardRejectRows("tn", tnTsv(["1:1", "abcd", "", "", "q", "x", "n"])).length, 1);
});
t("a blank Note alone does NOT hold the book", () => {
  // The regression this PR exists to fix: blank Note is a warning, so an
  // otherwise-valid row with an empty Note must render and ship.
  assert.deepEqual(hardRejectRows("tn", tnTsv(["1:1", "abcd", "", "", "q", "1", ""])), []);
});

console.log("\n[robustness — must never throw or over-hold]");
t("empty / header-only / whitespace renders yield nothing", () => {
  assert.deepEqual(hardRejectRows("twl", ""), []);
  assert.deepEqual(hardRejectRows("twl", `${TWL_H}\n`), []);
  assert.deepEqual(hardRejectRows("tn", `${TN_H}\n`), []);
});
t("an unrecognized header stays silent rather than guessing column indexes", () => {
  assert.deepEqual(hardRejectRows("twl", "Foo\tBar\n1:1\tabcd\n"), []);
  // Occurrence present but OrigWords missing → still silent.
  assert.deepEqual(hardRejectRows("twl", "Reference\tID\tOccurrence\n1:1\tabcd\t\n"), []);
});
t("a short row (missing trailing cells) does not throw and is judged on what's there", () => {
  const rows = hardRejectRows("twl", `${TWL_H}\n1:1\tabcd\n`);
  assert.equal(rows.length, 1); // Occurrence cell absent → blank → rejected
  assert.equal(rows[0].rowId, "abcd");
});
t("multiple offenders are all reported, in row order", () => {
  const rows = hardRejectRows(
    "twl",
    twlTsv(["1:1", "aaaa", "", "", "", ""], ["1:2", "bbbb", "", "x", "1", "rc://x"], ["2:3", "cccc", "", "y", "0", "rc://y"]),
  );
  assert.deepEqual(rows.map((r) => r.rowId), ["aaaa", "cccc"]);
});
t("whitespace-only Occurrence is rejected (it fails the digits-only regex)", () => {
  assert.equal(hardRejectRows("twl", twlTsv(["1:1", "abcd", "", "x", "   ", "rc://x"])).length, 1);
});
// The cells are compared RAW, exactly as the validators do. Trimming the Quote
// was too lax: validate_tn_files.py tests `_quote == ""` on the unmodified cell,
// so "   " is not blank to it and does not license a blank Occurrence. Confirmed
// by running the real validator on this row — it errors, so we must HOLD.
t("a whitespace-only tn Quote does NOT license a blank Occurrence", () => {
  const rows = hardRejectRows("tn", tnTsv(["1:1", "abcd", "", "", "   ", "", "a note"]));
  assert.equal(rows.length, 1);
  assert.match(rows[0].reason, /Occurrence is blank but Quote is not/);
});
t("a whitespace-only twl OrigWords is still judged only on Occurrence", () => {
  // OrigWords blankness is only a validator WARNING, so it never drives a HOLD.
  assert.deepEqual(hardRejectRows("twl", twlTsv(["1:1", "abcd", "", "   ", "1", "rc://x"])), []);
});

console.log("[hardRejectRows — tn Note brackets (validate_tn_files.py check 13, a WARNING since en_tn #7778)]");
// Issue #1149: en_tn d6fc28c11c (2026-09-28) set every check-13 error to
// severity="warning", so Door43 merges a Note with unpaired brackets. Holding the
// book for it stranded every other edit. Live prod shape (2026-10-06): JER 34:15
// mgn7, the second alternate translation never closed; Door43's validator run on
// those bytes exits 0. lint.ts still flags it in-app via bracketProblems.
const MGN7_NOTE =
  "Yahweh is stating the pronoun **you** separately, even though the verb translated as **you turned** already includes this meaning. He is doing that for emphasis. If a speaker of your language would use an explicit pronoun for the same purpose, you may want to use that construction in your translation. If not, your language may have other ways of showing the meaning here. Alternate translation: [And you, you indeed turned] or [And you indeed turned";
t("an unclosed [ in the Note does NOT hold the book (the mgn7 hold, #1149)", () => {
  assert.deepEqual(hardRejectRows("tn", tnTsv(["34:15", "mgn7", "", "rc://*/ta/man/translate/writing-pronouns", "וַ⁠תָּשֻׁ֨בוּ אַתֶּ֜ם", "1", MGN7_NOTE])), []);
});
t("a stray ] and a mismatched [[ ] do not hold the book either", () => {
  assert.deepEqual(hardRejectRows("tn", tnTsv(["1:1", "abcd", "", "", "", "", "see this] here"])), []);
  assert.deepEqual(hardRejectRows("tn", tnTsv(["1:1", "abcd", "", "", "", "", "[[x] y"])), []);
});
t("a bad Occurrence still holds the book when the Note also has a bracket problem, and only the Occurrence is named", () => {
  const rows = hardRejectRows("tn", tnTsv(["34:15", "mgn7", "", "", "q", "x", MGN7_NOTE]));
  assert.equal(rows.length, 1);
  assert.match(rows[0].reason, /Occurrence 'x'/);
});

console.log("[bracketProblems — the in-app lint flag (lint.ts)]");
t("an unclosed [ is reported with its character position", () => {
  assert.deepEqual(bracketProblems(MGN7_NOTE), ["Opening bracket '[' at character 430 has no matching closing bracket."]);
});
t("a stray ] and a mismatched [[ ] are reported", () => {
  assert.match(bracketProblems("see this] here")[0], /Closing bracket/);
  assert.match(bracketProblems("[[x] y")[0], /bracket sizes must match/);
});
t("balanced brackets, including [[rc://...]] links, pass", () => {
  assert.deepEqual(bracketProblems("Alternate translation: [a] or [b] (See: [[rc://*/ta/man/translate/figs-ellipsis]])"), []);
});

console.log("[buildHardRejectAlertMessage]");
t("names the ref, row id and the validator's reason", () => {
  const rejects = hardRejectRows("tn", tnTsv(["17:4", "ny7v", "", "", "q", "x", "a note"]));
  const msg = buildHardRejectAlertMessage("JER", "tn", rejects);
  assert.match(msg, /JER TN/);
  assert.match(msg, /17:4 \(ny7v\): Occurrence 'x' must be a non-negative integer or -1\. Fix/);
});
t("caps the sample at 6 rows and counts the rest", () => {
  const rejects = Array.from({ length: 8 }, (_, i) => ({ ref: `1:${i + 1}`, rowId: `r00${i}`, reason: "x" }));
  const msg = buildHardRejectAlertMessage("JER", "tn", rejects);
  assert.match(msg, /8 row\(s\)/);
  assert.match(msg, /\+2 more/);
  assert.doesNotMatch(msg, /r006/);
});

t("two problems on one row count as one row", () => {
  const rejects = [
    { ref: "1:1", rowId: "abcd", reason: "x" },
    { ref: "1:1", rowId: "abcd", reason: "y" },
  ];
  assert.match(buildHardRejectAlertMessage("JER", "tn", rejects), /HELD JER TN: 1 row\(s\)/);
});

console.log(`\n${passed} hardRejectGuard tests passed`);
