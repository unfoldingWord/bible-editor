// Tests for chapterHeightKey.ts — when an off-screen book-mode chapter must be
// laid out again (#1131). Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/chapterHeightKey.test.mjs

import { chapterHeightKey } from "./chapterHeightKey.ts";

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    passed++;
  }
}

const words = (text) => text.split(" ").map((w) => ({ type: "word", tag: "w", text: w }));
const dto = (verse, text, extra = {}) => ({
  book: "ZEC",
  chapter: 2,
  verse,
  verse_end: null,
  bible_version: "ULT",
  plain_text: text,
  version: 1,
  updated_by: null,
  updated_at: 0,
  content: { verseObjects: words(text) },
  ...extra,
});
const chapter = (ult, ust) => ({ ULT: ult, UST: ust });
const ult = { 1: dto(1, "In the eighth month"), 2: dto(2, "Yahweh was very angry") };
const ust = { 1: dto(1, "In the eighth month of the year"), 2: dto(2, "Yahweh was angry") };
const base = chapterHeightKey(chapter(ult, ust), ["ULT", "UST"], [1, 2]);

// The outbox result echoing a saved verse: same text, a newer version, a
// fresh object. This is the data change that must not re-lay out the chapter.
{
  const echoed = { ...ult, 2: dto(2, "Yahweh was very angry", { version: 2, updated_at: 99 }) };
  assert(chapterHeightKey(chapter(echoed, ust), ["ULT", "UST"], [1, 2]) === base, "version-only change keeps the key");
}
// A change in a column that is not shown cannot change the height.
{
  const hidden = { ...ust, 2: dto(2, "Yahweh was extremely angry with your ancestors") };
  assert(
    chapterHeightKey(chapter(ult, hidden), ["ULT"], [1, 2]) === chapterHeightKey(chapter(ult, ust), ["ULT"], [1, 2]),
    "a hidden column's text does not count",
  );
}
// Each of these can change the height.
{
  const longer = { ...ult, 2: dto(2, "Yahweh was very angry indeed") };
  assert(chapterHeightKey(chapter(longer, ust), ["ULT", "UST"], [1, 2]) !== base, "longer text changes the key");
  const shorter = { ...ust, 1: dto(1, "In month eight") };
  assert(chapterHeightKey(chapter(ult, shorter), ["ULT", "UST"], [1, 2]) !== base, "shorter text in another column changes the key");
}
{
  // Same plain text, a poetry marker added: one more top-level node.
  const marked = { ...ult, 2: dto(2, "Yahweh was very angry", { content: { verseObjects: [{ type: "quote", tag: "q1" }, ...words("Yahweh was very angry")] } }) };
  assert(chapterHeightKey(chapter(marked, ust), ["ULT", "UST"], [1, 2]) !== base, "an added marker changes the key");
}
{
  const head = (text) => ({ ...ult, 1: dto(1, "In the eighth month", { content: { verseObjects: [{ type: "section", tag: "s1", content: text }, ...words("In the eighth month")] } }) });
  const a = chapterHeightKey(chapter(head("A call to return"), ust), ["ULT", "UST"], [1, 2]);
  const b = chapterHeightKey(chapter(head("A call to return to Yahweh"), ust), ["ULT", "UST"], [1, 2]);
  assert(a !== base, "an added heading changes the key");
  assert(a !== b, "a longer heading changes the key");
}
{
  const bridged = { ...ult, 1: dto(1, "In the eighth month", { verse_end: 2 }) };
  assert(chapterHeightKey(chapter(bridged, ust), ["ULT", "UST"], [1, 2]) !== base, "a bridge changes the key");
  const gone = { 1: ult[1] };
  assert(chapterHeightKey(chapter(gone, ust), ["ULT", "UST"], [1, 2]) !== base, "a missing cell changes the key");
}
// Review of #1131 (A1): changes that keep every length and count but can
// still rewrap or re-indent a row.
{
  const withMarker = (tag) => ({ ...ult, 2: dto(2, "Yahweh was very angry", { content: { verseObjects: [{ type: tag === "b" ? "paragraph" : "quote", tag }, ...words("Yahweh was very angry")] } }) });
  const q1 = chapterHeightKey(chapter(withMarker("q1"), ust), ["ULT", "UST"], [1, 2]);
  assert(q1 !== chapterHeightKey(chapter(withMarker("q2"), ust), ["ULT", "UST"], [1, 2]), "\\q1 -> \\q2 changes the key");
  assert(
    chapterHeightKey(chapter(withMarker("p"), ust), ["ULT", "UST"], [1, 2]) !== chapterHeightKey(chapter(withMarker("b"), ust), ["ULT", "UST"], [1, 2]),
    "\\p -> \\b changes the key",
  );
  // Same length, different words (a rewording can rewrap the line).
  const reworded = { ...ult, 2: dto(2, "Yahweh was much angry") };
  const sameLen = { ...ult, 2: dto(2, "Yahweh was VERY angry") };
  assert(chapterHeightKey(chapter(sameLen, ust), ["ULT", "UST"], [1, 2]) !== base, "same-length different text changes the key");
  assert(chapterHeightKey(chapter(reworded, ust), ["ULT", "UST"], [1, 2]) !== base, "reworded text changes the key");
  // Same heading length, different heading words.
  const head = (text) => ({ ...ult, 1: dto(1, "In the eighth month", { content: { verseObjects: [{ type: "section", tag: "s1", content: text }, ...words("In the eighth month")] } }) });
  assert(
    chapterHeightKey(chapter(head("A call to return"), ust), ["ULT", "UST"], [1, 2]) !== chapterHeightKey(chapter(head("A cell to return"), ust), ["ULT", "UST"], [1, 2]),
    "same-length heading rewording changes the key",
  );
  // The outbox reply: a fresh object, a newer version, the same content.
  const echoed = { ...withMarker("q1"), 2: { ...withMarker("q1")[2], version: 7, updated_at: 123, content: JSON.parse(JSON.stringify(withMarker("q1")[2].content)) } };
  assert(chapterHeightKey(chapter(echoed, ust), ["ULT", "UST"], [1, 2]) === q1, "version-only reply with re-parsed content keeps the key");
}
assert(chapterHeightKey(chapter(ult, ust), ["ULT", "UST"], [1]) !== base, "a removed row changes the key");
assert(chapterHeightKey(chapter(ult, ust), ["ULT", "UST", "UHB"], [1, 2]) !== base, "a toggled column changes the key");
assert(chapterHeightKey(chapter(ult, ust), ["UST", "ULT"], [1, 2]) !== base, "column order is part of the key");
// A verse whose content is not a verseObjects tree still keys on its text.
{
  const odd = { ...ult, 2: dto(2, "Yahweh was very angry", { content: null }) };
  const oddLonger = { ...ult, 2: dto(2, "Yahweh was very, very angry", { content: null }) };
  assert(
    chapterHeightKey(chapter(odd, ust), ["ULT", "UST"], [1, 2]) !== chapterHeightKey(chapter(oddLonger, ust), ["ULT", "UST"], [1, 2]),
    "null content still keys on plain text",
  );
}

console.log(`chapterHeightKey: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
