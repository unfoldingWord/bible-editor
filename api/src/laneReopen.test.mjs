// Smoke test for lanesToReopenOnVerseEdit — the pure decision behind which
// verse_lane_checks lanes a content save reopens. Run from api/:
//   node --experimental-strip-types --no-warnings src/laneReopen.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors sortOrder.test.mjs.
//
// Regression: a tiny ULT edit (a comma after "Gilgal", a moved `{…}` brace)
// used to reopen the 'tw' (Words) lane and clear the Board checkoff even though
// no word changed. It must now reopen only 'text' for such edits (HOS 12:11 /
// HOS 8 report from Beth Oakes).

import { lanesToReopenOnVerseEdit, lanesForAdoption } from "./laneReopen.ts";

let failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${msg}\n    expected ${e}\n    got      ${a}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

console.log("\n[lanesToReopenOnVerseEdit]");

// ULT punctuation-only edit (comma / brace / whitespace): word sequence
// unchanged → Words stays checked, only Text reopens.
eq(
  lanesToReopenOnVerseEdit("ULT", true),
  ["text"],
  "ULT comma/brace edit (wordSequenceUnchanged) reopens only 'text'",
);

// ULT real word edit: a word changed → Words reopens too ("trickles down").
eq(
  lanesToReopenOnVerseEdit("ULT", false),
  ["text", "tw"],
  "ULT word edit (wordSequence changed) reopens 'text' and 'tw'",
);

// UST edits never touch the Words lane, regardless of word changes.
eq(
  lanesToReopenOnVerseEdit("UST", false),
  ["text"],
  "UST word edit reopens only 'text'",
);
eq(
  lanesToReopenOnVerseEdit("UST", true),
  ["text"],
  "UST punctuation edit reopens only 'text'",
);

console.log("\n[lanesForAdoption]");

// FIX 4 regression, reviewer's exact probe: D1 stores "and"/"the" as two
// separate \w nodes with a bare whitespace text node between them; master's
// adopted content fuses them into one \w node covering "and the". Plain
// text is identical ("and the") on both sides, but the \w TOKENIZATION
// differs (2 word nodes vs 1) — a glue/de-glue shape, not a real word edit.
{
  const w = (text) => JSON.stringify({ type: "word", tag: "w", text, occurrence: "1", occurrences: "1" });
  const t = (text) => JSON.stringify({ type: "text", text });
  const beforeContentJson = `{"verseObjects":[${w("and")},${t(" ")},${w("the")}]}`;
  const afterContentJson = `{"verseObjects":[${w("and the")}]}`;
  const beforePlainText = "and the";
  const afterPlainText = "and the";

  eq(
    lanesForAdoption("ULT", beforePlainText, afterPlainText, beforeContentJson, afterContentJson),
    ["tw"],
    "de-glue-shaped adoption (identical plain text, changed \\w tokenization) reopens 'tw' but not 'text'",
  );

  // Contrast case: plain text AND word sequence both genuinely unchanged
  // (identical content_json) — neither lane should reopen.
  eq(
    lanesForAdoption("ULT", beforePlainText, beforePlainText, beforeContentJson, beforeContentJson),
    [],
    "genuinely unchanged-text adoption (identical content_json) reopens neither lane",
  );

  // UST never touches 'tw', even for the same de-glue shape.
  eq(
    lanesForAdoption("UST", beforePlainText, afterPlainText, beforeContentJson, afterContentJson),
    [],
    "UST de-glue-shaped adoption reopens neither lane ('tw' never applies to UST, and plain text is unchanged)",
  );

  // A genuine word-boundary change (different plain text, different word
  // sequence) reopens both lanes on ULT.
  const changedContentJson = `{"verseObjects":[${w("and the")},${t(" ")},${w("dog")}]}`;
  eq(
    lanesForAdoption("ULT", beforePlainText, "and the dog", beforeContentJson, changedContentJson),
    ["text", "tw"],
    "genuine word-boundary change reopens both 'text' and 'tw' on ULT",
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll laneReopen assertions passed.");
