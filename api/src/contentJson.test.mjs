// Tests for contentJson.ts. Run from api/:
//   node --experimental-strip-types --no-warnings src/contentJson.test.mjs
//
// Covers the verse-PATCH emptiness gate: an empty verseObjects tree is legal
// for the chapter-front pseudo-verse (verse 0) and nowhere else. Not a test
// framework; failures exit non-zero.

import { refusesEmptyVerseObjects, parseVerseContentJson, CorruptContentJsonError } from "./contentJson.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const HEADING = [{ tag: "s1", type: "section", content: "A heading\n" }];
const TEXT = [{ type: "text", text: "hello " }];

// --- verse 0 may be emptied (issue #366) ---
// A chapter-leading `\s1` lives on the verse-0 pseudo-row. When it is that
// row's only node, deleting it leaves an empty tree; refusing that is exactly
// what made the heading undeletable.
assert(refusesEmptyVerseObjects(0, []) === false, `verse 0 may be emptied`);

// --- real verses may not be emptied ---
// An empty tree would blank the verse text with no way to type it back.
for (const v of [1, 2, 7, 176]) {
  assert(refusesEmptyVerseObjects(v, []) === true, `verse ${v} may not be emptied`);
}

// --- non-empty trees are never refused by this gate, at any verse ---
assert(refusesEmptyVerseObjects(0, HEADING) === false, `verse 0 with a heading passes`);
assert(refusesEmptyVerseObjects(1, TEXT) === false, `verse 1 with text passes`);

// --- a non-numeric route param must not unlock emptiness ---
// verses.ts derives the verse via parseInt, so a junk param yields NaN.
// NaN !== 0, so the gate stays closed rather than opening by accident.
assert(refusesEmptyVerseObjects(Number.NaN, []) === true, `NaN verse may not be emptied`);

// --- parseVerseContentJson wraps malformed JSON ---
{
  const row = {
    book: "MIC",
    chapter: 2,
    verse: 0,
    verse_end: null,
    bible_version: "UST",
    version: 1,
    content_json: "{not json",
  };
  let threw = null;
  try {
    parseVerseContentJson(row);
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof CorruptContentJsonError, `malformed content_json throws CorruptContentJsonError`);
  assert(threw.context.book === "MIC" && threw.context.verse === 0, `error carries row context`);
}

// --- an empty tree round-trips as valid content ---
assert(
  JSON.stringify(
    parseVerseContentJson({
      book: "MIC",
      chapter: 2,
      verse: 0,
      verse_end: null,
      bible_version: "UST",
      version: 2,
      content_json: '{"verseObjects":[]}',
    }),
  ) === '{"verseObjects":[]}',
  `empty verseObjects parses as valid stored content`,
);

console.log("contentJson: all assertions passed");
