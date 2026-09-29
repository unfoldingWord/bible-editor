// Tests for chapterStale.ts — the "last copy, locked" rule for a chapter
// change (#892). Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/chapterStale.test.mjs

import { isStaleChapter, updateIfCurrent } from "./chapterStale.ts";

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

const payload = (book, chapter, extra = {}) => ({ book, chapter, tn: [], tq: [], twl: [], ...extra });

// ── isStaleChapter ──────────────────────────────────────────────────────────
assert(isStaleChapter(null, { book: "ZEC", chapter: 2 }) === false, "no payload is not stale (it is loading)");
assert(isStaleChapter(payload("ZEC", 2), { book: "ZEC", chapter: 2 }) === false, "same chapter is fresh");
assert(isStaleChapter(payload("ZEC", 1), { book: "ZEC", chapter: 2 }) === true, "previous chapter on screen is stale");
assert(isStaleChapter(payload("ZEC", 3), { book: "ZEC", chapter: 2 }) === true, "next chapter on screen is stale");
assert(isStaleChapter(payload("ZEC", 2), { book: "HOS", chapter: 2 }) === true, "another book's chapter is stale");
// The route book comes from the hash; the API upper-cases it. A casing
// difference must not strand the view locked forever.
assert(isStaleChapter(payload("ZEC", 2), { book: "zec", chapter: 2 }) === false, "book compare ignores case");
// Chapter 0 (front matter) is a real chapter, never "missing".
assert(isStaleChapter(payload("ZEC", 0), { book: "ZEC", chapter: 0 }) === false, "chapter 0 matches chapter 0");
assert(isStaleChapter(payload("ZEC", 0), { book: "ZEC", chapter: 1 }) === true, "chapter 0 on screen for chapter 1 is stale");

// ── updateIfCurrent ─────────────────────────────────────────────────────────
// A local mutation (optimistic edit, outbox result, WS step) lands only on the
// route's own payload. Applied to the previous chapter's copy it would put
// chapter N+1's rows or verses into chapter N's data on screen.
{
  const prev = payload("ZEC", 1, { tn: [{ id: "a" }] });
  let called = 0;
  const out = updateIfCurrent(prev, { book: "ZEC", chapter: 2 }, (p) => {
    called++;
    return { ...p, tn: [] };
  });
  assert(out === prev, "stale payload is returned unchanged (same object, so setState skips the render)");
  assert(called === 0, "mutation never runs against a stale payload");
}
{
  const prev = payload("ZEC", 2, { tn: [{ id: "a" }] });
  const out = updateIfCurrent(prev, { book: "ZEC", chapter: 2 }, (p) => ({ ...p, tn: [] }));
  assert(out !== prev && out.tn.length === 0, "mutation runs against the current chapter's payload");
}
{
  let called = 0;
  const out = updateIfCurrent(null, { book: "ZEC", chapter: 2 }, (p) => {
    called++;
    return p;
  });
  assert(out === null && called === 0, "null payload stays null and the mutation never runs");
}

console.log(`chapterStale: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
