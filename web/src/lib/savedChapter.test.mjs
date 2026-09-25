// Regression suite for issue #936 part 2: which chapter a confirmed outbox
// save touched, so the note-link preview can drop its cached server copy of
// that chapter. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/savedChapter.test.mjs
//
// In book view a find/replace can save a note into a chapter that isn't open.
// The preview's 60 s cache of that chapter then showed the pre-save text; a
// confirmed save (200) from this client must invalidate it. Anything not yet
// confirmed (conflict, retry, fatal) must not: the preview shows saved text only.

import { savedChapter } from "./savedChapter.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const rowOp = { target: { kind: "row", rowKind: "tn", id: "b1wi", book: "ZEC" } };
const verseOp = { target: { kind: "verse", book: "ZEC", chapter: 7, verse: 2, bibleVersion: "ULT" } };
const ok = (updated) => ({ kind: "ok", updated });

assert(
  eq(savedChapter(rowOp, ok({ id: "b1wi", book: "ZEC", chapter: 7, note: "x" })), { book: "ZEC", chapter: 7 }),
  "a confirmed note save names the row's chapter (row targets carry no chapter)",
);
assert(eq(savedChapter(verseOp, ok({})), { book: "ZEC", chapter: 7 }), "a confirmed verse save names its chapter");
assert(savedChapter(rowOp, { kind: "conflict", current: {} }) === null, "a conflict is not a save");
assert(savedChapter(rowOp, { kind: "retry", reason: "network" }) === null, "a retry is not a save");
assert(savedChapter(rowOp, { kind: "fatal", reason: "x" }) === null, "a fatal error is not a save");
assert(savedChapter(rowOp, ok(null)) === null, "a row save with no returned row names nothing");
assert(savedChapter(rowOp, ok({ id: "b1wi", book: "ZEC" })) === null, "a returned row without a chapter names nothing");

if (failed > 0) {
  console.error(`\n${failed} savedChapter test(s) failed`);
  process.exit(1);
}
console.log("\nsavedChapter: all tests passed");
