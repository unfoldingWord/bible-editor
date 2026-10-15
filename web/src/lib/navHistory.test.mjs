// Tests for navHistory.ts. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/navHistory.test.mjs

import { createNavHistory, prune, SETTLE_MS, MAX_ENTRIES, MAX_PER_CHAPTER } from "./navHistory.ts";

const KEY = "bible-editor.navHistory.v2";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function fakeStorage(initial) {
  const m = new Map(initial ? [[KEY, initial]] : []);
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

const verse = (chapter, v) => ({ book: "ZEC", chapter, verse: v });
const note = (chapter, v, id) => ({ ...verse(chapter, v), kind: "tn", rowId: id });
const label = (s) => `${s.chapter}:${s.verse}${s.rowId ? "n" : ""}`;
const list = (h) => h.view().entries.map(label).join(" ");

function setup(storage) {
  let t = 1000;
  const h = createNavHistory(() => t, storage);
  return {
    h,
    wait: (ms = SETTLE_MS) => { t += ms; },
    // Visit a spot and stay long enough for it to count.
    visit(spot) { h.observe(spot); t += SETTLE_MS; },
  };
}

// --- a spot held for a moment is recorded when left ---
{
  const { h, visit } = setup();
  visit(verse(1, 1));
  h.observe(verse(2, 1));
  assert(list(h) === "1:1" && h.view().here === 1, "settled spot is recorded on leaving, marker at the end");
}

// --- passing through quickly records nothing ---
{
  const { h, visit, wait } = setup();
  visit(verse(1, 1));
  h.observe(verse(2, 2)); // records 1:1
  wait(300);
  h.observe(verse(2, 3));
  wait(300);
  h.observe(verse(2, 4));
  assert(list(h) === "1:1", "scrolled-past verses are not recorded");
}

// --- the note counts as part of the spot ---
{
  const { h, visit } = setup();
  visit(note(3, 4, "n1"));
  h.observe(verse(3, 4));
  assert(h.view().entries[0].rowId === "n1", "leaving a note for its own verse still records the note");
}

// --- opening a note in the same verse does not record the bare verse ---
{
  const { h, visit } = setup();
  visit(verse(5, 4));
  h.observe(note(5, 4, "n1"));
  assert(list(h) === "", "verse -> note in the same verse adds no entry");
}

// --- going back keeps the entries ahead, and moves the marker ---
{
  const { h, visit } = setup();
  for (const ch of [1, 2, 3, 4, 5]) visit(verse(ch, 1));
  // list: 1 2 3 4, current 5
  const back = h.takeAt(1); // back to chapter 2
  assert(back.chapter === 2, "takeAt returns the target");
  assert(list(h) === "1:1 3:1 4:1 5:1", "entries ahead are kept and the spot we left joins them");
  assert(h.view().here === 1, "marker sits where the target was");
  h.observe(verse(5, 1)); // transitional: chapter changing
  h.observe(verse(2, 1)); // arrived
  assert(list(h) === "1:1 3:1 4:1 5:1" && h.view().here === 1, "arrival does not disturb the list");
}

// --- forward goes the other way ---
{
  const { h, visit } = setup();
  for (const ch of [1, 2, 3, 4]) visit(verse(ch, 1));
  h.takeAt(0); // back to 1; list 2 3 4, here 0
  h.observe(verse(1, 1));
  assert(list(h) === "2:1 3:1 4:1" && h.view().here === 0, "all of it is ahead after going to the oldest");
  const fwd = h.takeAt(h.view().here); // one step forward
  assert(fwd.chapter === 2, "forward goes to the nearest entry ahead");
  assert(list(h) === "1:1 3:1 4:1" && h.view().here === 1, "the spot we left is now behind the marker");
}

// --- a spot reached by a jump is recorded even if left quickly ---
{
  const { h, visit, wait } = setup();
  for (const ch of [1, 2, 3]) visit(verse(ch, 1));
  h.takeAt(0); // to chapter 1
  h.observe(verse(1, 1));
  wait(200);
  h.observe(verse(1, 9)); // moved on after 200ms
  assert(h.view().entries.some((e) => e.chapter === 1 && e.verse === 1), "the landing spot is kept");
}

// --- moving on by hand resets the marker to the newest end ---
{
  const { h, visit } = setup();
  for (const ch of [1, 2, 3, 4]) visit(verse(ch, 1));
  h.takeAt(0);
  h.observe(verse(1, 1));
  visit(verse(1, 1));
  h.observe(verse(9, 1)); // wanders off by hand from the middle
  assert(h.view().here === h.view().entries.length, "marker returns to the end");
  assert(list(h) === "2:1 3:1 4:1 1:1", "what was ahead stays as recent places, newest last");
}

// --- bad index ---
{
  const { h } = setup();
  assert(h.takeAt(0) === undefined, "takeAt on an empty list is a no-op");
}

// --- same-chapter cap prefers big jumps ---
{
  const spots = [1, 15, 16, 17].map((v) => verse(5, v));
  const out = prune(spots, spots.length);
  const verses = out.entries.map((e) => e.verse).join(",");
  assert(out.entries.length === MAX_PER_CHAPTER, "a chapter keeps at most three");
  assert(verses === "1,15,17", `keeps the newest and the farthest apart, not 15,16,17 (got ${verses})`);
}
{
  const spots = [3, 4, 5, 6].map((v) => verse(5, v));
  const out = prune(spots, spots.length);
  assert(out.entries.map((e) => e.verse).join(",") === "3,5,6", "with no big jump it still drops one and keeps the newest");
}
{
  const spots = [verse(5, 1), verse(6, 1), verse(5, 9), verse(6, 9), verse(5, 17), verse(5, 18), verse(5, 19)];
  const out = prune(spots, spots.length);
  assert(out.entries.filter((e) => e.chapter === 5).length === 3, "cap is per chapter");
  assert(out.entries.filter((e) => e.chapter === 6).length === 2, "other chapters are untouched");
}

// --- overall cap, marker follows ---
{
  const spots = Array.from({ length: 14 }, (_, i) => verse(i + 1, 1));
  const out = prune(spots, 6);
  assert(out.entries.length === MAX_ENTRIES, "list is capped at ten");
  assert(out.entries[0].chapter === 5, "oldest entries fall off first");
  assert(out.here === 2, "marker stays in the same gap after trimming");
}

// --- re-observing the current spot keeps the hint fresh ---
{
  const { h, visit } = setup();
  h.observe({ ...note(1, 1, "n"), hint: "old" });
  h.observe({ ...note(1, 1, "n"), hint: "new" });
  visit({ ...note(1, 1, "n"), hint: "new" });
  h.observe(verse(2, 1));
  assert(h.view().entries.length === 1 && h.view().entries[0].hint === "new", "hint refreshes without re-recording");
}

// --- the view is a stable object until something changes ---
{
  const { h, visit } = setup();
  visit(verse(1, 1));
  const a = h.view();
  h.observe(verse(1, 1));
  assert(h.view() === a, "same view when nothing changed");
  h.observe(verse(2, 1));
  assert(h.view() !== a, "new view after a change");
}

// --- subscribers hear about changes ---
{
  const { h, visit } = setup();
  let n = 0;
  const off = h.subscribe(() => n++);
  visit(verse(1, 1));
  h.observe(verse(2, 1));
  assert(n === 1, "subscriber notified when an entry is added");
  off();
  h.takeAt(0);
  assert(n === 1, "unsubscribed listener is not called");
}

// --- survives a reload, marker included ---
{
  const storage = fakeStorage();
  const a = setup(storage);
  for (const ch of [1, 2, 3, 4]) a.visit(verse(ch, 1));
  a.h.takeAt(1); // back to 2; list 1 3 4(?) etc.
  const before = list(a.h);
  const b = setup(storage); // the page reloaded
  assert(list(b.h) === before, "entries are restored after a reload");
  assert(b.h.view().here === a.h.view().here, "the marker is restored too");
}

// --- bad or missing storage never breaks the history ---
{
  assert(createNavHistory(Date.now, fakeStorage("not json")).view().entries.length === 0, "corrupt storage is ignored");
  assert(createNavHistory(Date.now, fakeStorage('{"entries":[{"book":1},{"book":"ZEC","chapter":1,"verse":2}],"here":9}')).view().entries.length === 1, "malformed entries are dropped");
  const bad = createNavHistory(Date.now, fakeStorage('{"entries":[{"book":"ZEC","chapter":-1,"verse":1},{"book":"XYZW","chapter":1,"verse":1}],"here":0}'));
  assert(bad.view().entries.length === 0, "out-of-range entries are dropped");
  const clamped = createNavHistory(Date.now, fakeStorage('{"entries":[{"book":"ZEC","chapter":1,"verse":2}],"here":99}'));
  assert(clamped.view().here === 1, "marker is clamped into range");
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const { h, visit } = setup(throwing);
  visit(verse(1, 1));
  h.observe(verse(2, 1));
  assert(h.view().entries.length === 1, "throwing storage does not break recording");
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
