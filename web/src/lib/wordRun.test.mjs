// Pins the edit engine's shared word pattern (wordRun.ts, #1301). replace.ts,
// alignmentReassembly.ts and curlyVerse.ts all tokenize with this one regex,
// so a change here changes word boundaries for editing, reassembly and quote
// reconciliation at once. The expected source and tokens below were captured
// from the three former copies, which were identical, before they were merged.
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/wordRun.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors src/lib/replace.test.mjs.

import { WORD_CHAR, WORD_RUN_RE } from "./wordRun.ts";

let failed = 0;
let ran = 0;
function eq(actual, expected, msg) {
  ran++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failed++;
    console.error(`FAIL: ${msg}\n  expected ${e}\n  actual   ${a}`);
  }
}

eq(WORD_CHAR, "[\\p{L}\\p{M}\\p{N}\\u200d\\u2060]", "WORD_CHAR class string");
eq(
  WORD_RUN_RE.source,
  "[\\p{L}\\p{M}\\p{N}\\u200d\\u2060]+(?:[-'’][\\p{L}\\p{M}\\p{N}\\u200d\\u2060]+|(?<=\\p{N}),\\p{N}+)*",
  "WORD_RUN_RE source",
);
eq(WORD_RUN_RE.flags, "gu", "WORD_RUN_RE flags");

const tok = (s) => [...s.matchAll(WORD_RUN_RE)].map((m) => [m.index, m[0]]);

eq(tok("Yahweh’s house"), [[0, "Yahweh’s"], [9, "house"]], "curly apostrophe binds a possessive");
eq(tok("don't stop"), [[0, "don't"], [6, "stop"]], "straight apostrophe binds a contraction");
eq(tok("1,000 men"), [[0, "1,000"], [6, "men"]], "grouping comma between digits binds");
eq(tok("a, b"), [[0, "a"], [3, "b"]], "comma not between digits separates");
eq(tok("well-known"), [[0, "well-known"]], "hyphen binds");
eq(tok("‘quoted’ word"), [[1, "quoted"], [9, "word"]], "opening quote and trailing ’ stay outside the word");
eq(
  tok("עַל־כֵּן"),
  [[0, "עַל"], [4, "כֵּן"]],
  "Hebrew maqaf (U+05BE) separates two words",
);
eq(tok("x‍y z⁠w"), [[0, "x‍y"], [4, "z⁠w"]], "ZWJ and word-joiner stay inside a word");
eq(tok("30 cubits; 300,000."), [[0, "30"], [3, "cubits"], [11, "300,000"]], "numbers are words");

// The regex is global and shared across modules: matchAll and String#match
// must leave lastIndex at 0 so the next caller starts from the beginning.
"one two".match(WORD_RUN_RE);
eq(WORD_RUN_RE.lastIndex, 0, "lastIndex stays 0 after String#match");
eq(tok("one two"), [[0, "one"], [4, "two"]], "matchAll after match starts at 0");
eq(WORD_RUN_RE.lastIndex, 0, "lastIndex stays 0 after matchAll");

if (failed) {
  console.error(`\n${failed} of ${ran} checks failed`);
  process.exit(1);
}
console.log(`wordRun.test: ${ran} checks passed`);
