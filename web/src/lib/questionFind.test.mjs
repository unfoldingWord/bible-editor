// Tests for the TQ find/replace helpers: what is searched (question and
// response only), per-field occurrence numbering, literal replacement, and the
// empty-field guard.

import assert from "node:assert/strict";
import {
  collectQuestionMatches,
  replaceAllLiteral,
  applyQuestionMatch,
  wouldEmptyField,
  questionOverrideKey,
  buildFindRegex,
  nthMatchRange,
} from "./questionFind.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  passed += 1;
};

const row = (over) => ({
  id: "ab12",
  book: "ZEC",
  chapter: 1,
  verse: 2,
  ref_raw: "1:2 the",
  tags: "the",
  quote: "the",
  occurrence: 1,
  question: null,
  response: null,
  sort_order: 0,
  version: 1,
  restored_from_version: null,
  updated_by: null,
  updated_at: 0,
  deleted_at: null,
  ...over,
});
const re = /the/gi;

// Only question + response are searched; ref_raw / quote / tags / id are not.
{
  const ms = collectQuestionMatches([row({ question: "Why the wrath?", response: "No match" })], re);
  check(ms.length === 1, "one hit: question only");
  check(ms[0].field === "question" && ms[0].start === 4 && ms[0].end === 7, "positions");
  check(ms[0].chapter === 1 && ms[0].verse === 2 && ms[0].rowId === "ab12", "location fields");
  check(collectQuestionMatches([row({ question: "x", response: "y" })], re).length === 0, "structural fields never match");
}

// Occurrence is per field and left-to-right.
{
  const ms = collectQuestionMatches([row({ question: "the the", response: "then the" })], re);
  check(ms.length === 4, "four hits");
  check(ms.map((m) => `${m.field}${m.occurrence}`).join() === "question0,question1,response0,response1", "per-field occurrence");
}

// Deleted rows skipped; null regex yields nothing; overrides win.
{
  check(collectQuestionMatches([row({ question: "the", deleted_at: 5 })], re).length === 0, "deleted skipped");
  check(collectQuestionMatches([row({ question: "the" })], null).length === 0, "null regex");
  const ov = new Map([[questionOverrideKey("ab12", "question"), "gone"]]);
  check(collectQuestionMatches([row({ question: "the" })], re, ov).length === 0, "override hides stale match");
}

// Zero-width patterns terminate.
{
  const ms = collectQuestionMatches([row({ question: "ab" })], /x*/g);
  check(ms.length === 3, "zero-width matches terminate");
}

// Literal replacement: no $ expansion.
{
  const r = replaceAllLiteral("a the b the", /the/i, "$1&");
  check(r.text === "a $1& b $1&" && r.count === 2, "literal, all occurrences");
  check(applyQuestionMatch("a the b", { start: 2, end: 5, matchText: "the" }, "$&") === "a $& b", "single literal");
  check(applyQuestionMatch("a the b", { start: 2, end: 99, matchText: "the" }, "x") === null, "drift rejected");
  check(applyQuestionMatch("a xyz b", { start: 2, end: 5, matchText: "the" }, "x") === null, "stale offsets rejected");
  check(applyQuestionMatch("a the b", { start: 2, end: 5, matchText: "the" }, "the") === null, "no-op rejected");
}

// Empty guard.
{
  check(wouldEmptyField("the", "") === true, "blanking flagged");
  check(wouldEmptyField("the", " ") === true, "whitespace-only flagged");
  check(wouldEmptyField("", "") === false, "already empty not flagged");
  check(wouldEmptyField("the x", "x") === false, "normal edit ok");
}

// Highlight helpers.
{
  const r = buildFindRegex({ find: "a.b", regex: false, caseSensitive: false });
  check(r.test("xA.By") && !new RegExp(r.source, r.flags).test("axb"), "literal escape, case-insensitive");
  check(buildFindRegex({ find: "(", regex: true, caseSensitive: false }) === null, "invalid regex -> null");
  check(buildFindRegex({ find: "", regex: false, caseSensitive: false }) === null, "empty -> null");
  const g = buildFindRegex({ find: "the", regex: false, caseSensitive: true });
  const rng = nthMatchRange("the then The the", g, 2);
  check(rng && rng.start === 13 && rng.end === 16, "nth match range, case-sensitive");
  check(nthMatchRange("the", g, 1) === null, "missing occurrence -> null");
}

console.log(`questionFind: ${passed} checks passed`);
