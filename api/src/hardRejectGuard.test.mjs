// Unit tests for the hard-reject export gate (hardRejectGuard.ts).
// Run: node --experimental-strip-types --no-warnings src/hardRejectGuard.test.mjs

import assert from "node:assert/strict";
import { hardRejectRows } from "./hardRejectGuard.ts";

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
t("whitespace-only Occurrence counts as blank, not as a value", () => {
  assert.equal(hardRejectRows("twl", twlTsv(["1:1", "abcd", "", "x", "   ", "rc://x"])).length, 1);
});

console.log(`\n${passed} hardRejectGuard tests passed`);
