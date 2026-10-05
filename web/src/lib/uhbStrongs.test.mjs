// Tests for uhbStrongs.ts. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/uhbStrongs.test.mjs
//
// WHY (#898). Shell re-walked every loaded chapter's UHB whenever
// data.verses changed — every ULT/UST save and every WS verse.updated — even
// though UHB never changes. The cache is keyed on the UHB verses object's
// identity, so an unchanged UHB is walked once, and a different chapter's
// UHB (useChapter keeps the old chapter on screen while the next loads, #892)
// can never be answered from another chapter's entry.

import assert from "node:assert/strict";
import { createUhbStrongsCache } from "./uhbStrongs.ts";
import { reduceVerses } from "./verseStructure.ts";

const verse = (...strongs) => ({
  content: { verseObjects: strongs.map((strong) => ({ type: "word", tag: "w", strong })) },
});

function harness() {
  let calls = 0;
  const strongsFor = createUhbStrongsCache((objs) => {
    calls++;
    return objs.map((o) => o.strong);
  });
  return { strongsFor, calls: () => calls };
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

test("the same UHB object is walked once", () => {
  const { strongsFor, calls } = harness();
  const uhb = { 1: verse("H1", "H2"), 2: verse("H3") };
  assert.deepEqual(strongsFor(uhb), ["H1", "H2", "H3"]);
  const afterFirst = calls();
  assert.deepEqual(strongsFor(uhb), ["H1", "H2", "H3"]);
  assert.equal(calls(), afterFirst, "no collect calls on the second read");
});

test("(regression) a ULT save through reduceVerses does not re-walk UHB", () => {
  const { strongsFor, calls } = harness();
  const data = {
    verses: { UHB: { 1: verse("H1") }, ULT: { 1: { content: { verseObjects: [] }, version: 1 } } },
  };
  strongsFor(data.verses.UHB);
  const afterFirst = calls();
  const next = reduceVerses(data, "ULT", (s) => ({
    ...s,
    verses: { ...s.verses, 1: { content: { verseObjects: [] }, version: 2 } },
  }));
  assert.notEqual(next, data, "the chapter payload changed");
  assert.equal(next.verses.UHB, data.verses.UHB, "UHB kept its identity");
  strongsFor(next.verses.UHB);
  assert.equal(calls(), afterFirst);
});

test("two chapters never share an entry", () => {
  const { strongsFor } = harness();
  const ch1 = { 1: verse("H10") };
  const ch2 = { 1: verse("H20") };
  assert.deepEqual(strongsFor(ch1), ["H10"]);
  assert.deepEqual(strongsFor(ch2), ["H20"]);
  assert.deepEqual(strongsFor(ch1), ["H10"]);
});

test("a refetched UHB object is walked again", () => {
  const { strongsFor, calls } = harness();
  strongsFor({ 1: verse("H1") });
  const afterFirst = calls();
  assert.deepEqual(strongsFor({ 1: verse("H1"), 2: verse("H5") }), ["H1", "H5"]);
  assert.ok(calls() > afterFirst);
});

test("missing verses or content yield an empty list", () => {
  const { strongsFor } = harness();
  assert.deepEqual(strongsFor(undefined), []);
  assert.deepEqual(strongsFor({ 1: { content: null } }), []);
});

console.log(`\n${passed} passed`);
