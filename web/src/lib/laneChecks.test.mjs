// Tests for laneChecks.ts attribution wording — the "who checked it" tooltip on
// the chapter board, verse rail, and resource panels. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/laneChecks.test.mjs

import { indexCheckerNames, laneAttribution } from "./laneChecks.ts";

let failed = 0;
let passed = 0;
function eq(actual, expected, msg) {
  if (actual !== expected) {
    console.error(`FAIL: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
    failed++;
  } else {
    passed++;
  }
}

const ME = 1;
const names = indexCheckerNames([
  { verse: 1, lane: "tn", checked_by: 2, checked_by_name: "bwright" },
  { verse: 2, lane: "tn", checked_by: 3, checked_by_name: "jsmith" },
  { verse: 3, lane: "tn", checked_by: 4, checked_by_name: null },
  { verse: 4, lane: "tn", checked_by: 5 },
]);
eq(names.size, 2, "index keeps only rows that carry a name");

// With names.
eq(laneAttribution([ME], ME, names), "you", "me only");
eq(laneAttribution([2], ME, names), "bwright", "one named other");
eq(laneAttribution([ME, 2, 3], ME, names), "you + bwright, jsmith", "me + two named");
eq(laneAttribution([2, 3], ME, names), "bwright, jsmith", "two named, not me");
eq(laneAttribution([2, 4], ME, names), "bwright, 1 other", "named + unknown");
eq(laneAttribution([ME, 2, 4, 5], ME, names), "you + bwright, 2 others", "me + named + unknowns");
eq(laneAttribution([], ME, names), "open", "empty");
eq(laneAttribution(undefined, ME, names), "open", "undefined");

// Unknown names fall back to the old count wording.
eq(laneAttribution([4], ME, names), "someone else", "one unknown other");
eq(laneAttribution([4, 5], ME, names), "2 people", "two unknown others");
eq(laneAttribution([ME, 4], ME, names), "you + 1 other", "me + one unknown");
eq(laneAttribution([ME, 4, 5], ME, names), "you + 2 others", "me + two unknown");

// No name map at all (old call shape) keeps the old wording.
eq(laneAttribution([2], ME), "someone else", "no map: one other");
eq(laneAttribution([ME, 2, 3], ME), "you + 2 others", "no map: me + two");
eq(laneAttribution([2, 3, 4], null, names), "bwright, jsmith, 1 other", "signed-out viewer");

console.log(`laneChecks: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
