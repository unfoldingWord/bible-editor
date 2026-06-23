// Unit tests for the flag/escalate lint (lint.ts).
// Run: node --experimental-strip-types --no-warnings src/lint.test.mjs

import assert from "node:assert/strict";
import usfm from "usfm-js";
import { lintTnRows, lintUsfmVerses } from "./lint.ts";

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const tn = (over) => ({ ref_raw: "1:1", id: "abcd", support_reference: null, note: null, chapter: 1, verse: 1, ...over });

t("unmatched closing bracket flagged", () => {
  const i = lintTnRows([tn({ note: "text] more" })]);
  assert.equal(i.length, 1);
  assert.equal(i[0].check, "13. Paired Square Bracket");
  assert.equal(i[0].bucket, "flag");
});
t("unmatched opening bracket flagged", () => {
  const i = lintTnRows([tn({ note: "see [13:1 here" })]);
  assert.equal(i.length, 1);
});
t("mismatched bracket sizes flagged", () => {
  const i = lintTnRows([tn({ note: "[ word ]]" })]);
  assert.equal(i.length, 1);
});
t("balanced brackets pass", () => {
  assert.equal(lintTnRows([tn({ note: "see [[rc://x]] and [13:1]" })]).length, 0);
});
t("alt-label without sentence punctuation flagged", () => {
  const i = lintTnRows([tn({ note: "express it in active form Alternate translation: x" })]);
  assert.ok(i.some((x) => x.check === "12. Alternate translation Label"));
});
t("alt-label after period NOT flagged", () => {
  assert.equal(lintTnRows([tn({ note: "active form. Alternate translation: x" })]).length, 0);
});
t("alt-label with double-space NOT flagged (auto-fixed at export)", () => {
  assert.equal(lintTnRows([tn({ note: "active form  Alternate translation: x" })]).length, 0);
});
t("malformed reference flagged", () => {
  const i = lintTnRows([tn({ ref_raw: "garbage" })]);
  assert.ok(i.some((x) => x.check === "6. Reference"));
});
t("malformed rc:// flagged", () => {
  const i = lintTnRows([tn({ support_reference: "not-a-link" })]);
  assert.ok(i.some((x) => x.check === "7. SupportReference"));
});
t("valid rc:// passes", () => {
  assert.equal(lintTnRows([tn({ support_reference: "rc://*/ta/man/translate/figs-metaphor" })]).length, 0);
});
t("issue carries ref + rowId for jump", () => {
  const i = lintTnRows([tn({ ref_raw: "5:7", id: "wxyz", note: "x]" })]);
  assert.equal(i[0].ref, "5:7");
  assert.equal(i[0].rowId, "wxyz");
});

t("review_kind set → adapted-note flag with reason as message", () => {
  const i = lintTnRows([tn({ ref_raw: "36:1-3", chapter: 36, verse: 1, id: "ab12", review_kind: "quote", review_reason: "Adapted from 2 Kings 18:13; verify Hebrew." })]);
  assert.equal(i.length, 1);
  assert.equal(i[0].check, "Adapted note — verify");
  assert.equal(i[0].bucket, "flag");
  assert.equal(i[0].ref, "36:1"); // chapter:verse, not the stale ref_raw range
  assert.equal(i[0].rowId, "ab12");
  assert.equal(i[0].message, "Adapted from 2 Kings 18:13; verify Hebrew.");
});
t("no review_kind → no adapted-note flag", () => {
  assert.equal(lintTnRows([tn({ review_kind: null })]).filter((x) => x.check === "Adapted note — verify").length, 0);
});

// Build content_json from REAL usfm-js output so the test exercises the actual
// node shape (a balanced footnote is one `{tag:"f", endTag:"f*"}` node — the
// close lives in endTag, not as `\f*` text; the original text-node tests missed
// this and let a false-positive bug through).
const verseFromUsfm = (usfmText) => {
  const j = usfm.toJSON(usfmText);
  const vos = j.chapters["1"]["1"].verseObjects;
  return { book: "1CH", chapter: 1, verse: 1, verse_end: null, bible_version: "ULT", version: 1, content_json: JSON.stringify({ verseObjects: vos }) };
};

t("balanced footnote passes (real usfm-js node, endTag set)", () => {
  assert.equal(lintUsfmVerses([verseFromUsfm("\\c 1\n\\p\n\\v 1 word \\f + \\ft a note\\f* end\n")]).length, 0);
});
t("unclosed footnote escalated (real usfm-js node, empty endTag)", () => {
  const i = lintUsfmVerses([verseFromUsfm("\\c 1\n\\p\n\\v 1 word \\f + \\ft a note end\n")]);
  assert.equal(i.length, 1);
  assert.equal(i[0].check, "6. Footnote Syntax");
  assert.equal(i[0].bucket, "escalate");
});
t("verse with \\ft/\\fr inside a balanced footnote is NOT flagged", () => {
  assert.equal(lintUsfmVerses([verseFromUsfm("\\c 1\n\\p\n\\v 1 a \\f + \\fr 1:1 \\ft note\\f* b\n")]).length, 0);
});
t("verse 0 (front) skipped", () => {
  const v = verseFromUsfm("\\c 1\n\\p\n\\v 1 word \\f + \\ft a note end\n");
  assert.equal(lintUsfmVerses([{ ...v, verse: 0 }]).length, 0);
});

console.log(`\n${passed} lint tests passed`);
