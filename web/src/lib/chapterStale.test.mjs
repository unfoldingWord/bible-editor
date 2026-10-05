// Tests for chapterStale.ts — the "last copy, locked" rule for a chapter
// change (#892). Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/chapterStale.test.mjs

import { currentRouteFetcher, isChapterLocked, isStaleChapter, trackLockedKey, trackNavigation, updateIfCurrent } from "./chapterStale.ts";

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

// ── Navigation generations: A → B → A before B lands ───────────────────────
// Coming back to A while B is still loading, the payload on screen (A's old
// copy) matches the route again, but it may carry pre-save versions: outbox
// results and WS updates for A were filtered while the route was B. It must
// stay locked until the fetch started for THIS navigation lands.
{
  const A = { book: "ZEC", chapter: 3 };
  const B = { book: "ZEC", chapter: 4 };
  let nav = trackNavigation(null, A);
  assert(nav.gen === 1, "first route is generation 1");
  const again = trackNavigation(nav, { ...A });
  assert(again === nav, "re-rendering the same route keeps the generation (same object)");
  let landedGen = nav.gen; // A's mount GET landed
  const aData = payload("ZEC", 3);
  assert(isChapterLocked(aData, A, landedGen, nav.gen) === false, "A loaded for this navigation is editable");

  nav = trackNavigation(nav, B);
  assert(nav.gen === 2, "moving to B bumps the generation");
  assert(isChapterLocked(aData, B, landedGen, nav.gen) === true, "A shown while B loads is locked");

  nav = trackNavigation(nav, A);
  assert(nav.gen === 3, "coming back to A bumps it again");
  assert(isStaleChapter(aData, A) === false, "(chapter match alone would call A fresh)");
  assert(isChapterLocked(aData, A, landedGen, nav.gen) === true, "old A copy stays locked until A's new GET lands");

  landedGen = nav.gen; // A's new GET landed
  assert(isChapterLocked(payload("ZEC", 3), A, landedGen, nav.gen) === false, "A is editable once its GET for this navigation lands");
  assert(isChapterLocked(null, A, 0, nav.gen) === false, "no payload is loading, not locked");
}

// ── A refetch closure made before a navigation targets the CURRENT route ────
// A "Refresh" toast or a post-unlock refetch created on chapter 3 and run
// after the tab moved to 4 must fetch 4. Fetching 3 would replace 4's GET in
// the shared sequencer, land 3 under route 4, and leave the view locked.
{
  const routeRef = { current: { book: "ZEC", chapter: 3 } };
  const calls = [];
  const fetchFor = currentRouteFetcher(routeRef, (book, chapter, signal) => {
    calls.push({ book, chapter, signal });
    return Promise.resolve({ book, chapter });
  });
  routeRef.current = { book: "ZEC", chapter: 4 };
  const sig = {};
  const got = await fetchFor(sig);
  assert(calls.length === 1 && calls[0].chapter === 4, "old closure fetches the current route's chapter");
  assert(calls[0].signal === sig, "the abort signal is passed through");
  assert(got.chapter === 4, "the payload is the current route's");
}

// ── comment events vs the chapter on screen ─────────────────────────────────
// useComments is keyed on the chapter on screen, which lags the route (and the
// route's ChapterRoom socket) during a chapter change. Its WS upsert drops a
// comment for any other chapter with isStaleChapter, so ZEC 5's thread cannot
// be filed into ZEC 4's list and badge ZEC 4's verse cells.
{
  const onScreen = { book: "ZEC", chapter: 4 };
  const comment = (book, chapter) => ({ id: 1, book, chapter, verse: 3, rowKind: null, rowId: null, body: "x" });
  assert(isStaleChapter(comment("ZEC", 5), onScreen) === true, "a comment from the route's new chapter is dropped");
  assert(isStaleChapter(comment("HOS", 4), onScreen) === true, "a comment from another book's same chapter is dropped");
  assert(isStaleChapter(comment("ZEC", 4), onScreen) === false, "a comment for the chapter on screen is kept");
}

// ── trackLockedKey: reload comments after an A → B → A lock ─────────────────
// Comments are keyed on the chapter on screen. A → B → A keeps A on screen the
// whole time, so the key never changes and nothing would refetch A's comments,
// although the tab's socket followed B meanwhile and missed A's events.
{
  let s = trackLockedKey(null, true, "ZEC/14"); // lock starts on A
  assert(s.lockedKey === "ZEC/14" && s.reload === false, "the lock remembers the key it started on");
  s = trackLockedKey(s.lockedKey, true, "ZEC/14"); // still locked (B window, back on A)
  assert(s.lockedKey === "ZEC/14" && s.reload === false, "no reload while locked");
  s = trackLockedKey(s.lockedKey, false, "ZEC/14"); // A's fresh payload lands
  assert(s.lockedKey === null && s.reload === true, "A → B → A reloads A's comments when A lands");
}
{
  // A → B: the key changes on landing, so the comments fetch runs by itself;
  // a reload on top would fetch B twice.
  let s = trackLockedKey(null, true, "ZEC/4");
  s = trackLockedKey(s.lockedKey, false, "ZEC/5");
  assert(s.lockedKey === null && s.reload === false, "A → B does not reload (the key change fetches)");
  // No lock at all (first load, an in-place refetch): nothing to reload.
  const t = trackLockedKey(null, false, "ZEC/5");
  assert(t.lockedKey === null && t.reload === false, "unlocked renders never reload");
}

console.log(`chapterStale: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
