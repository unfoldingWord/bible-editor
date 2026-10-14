// Tests for navHistory.ts. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/navHistory.test.mjs

import { createNavHistory, SETTLE_MS, MAX_ENTRIES } from "./navHistory.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const verse = (chapter, v) => ({ book: "ZEC", chapter, verse: v });
const note = (chapter, v, id) => ({ ...verse(chapter, v), kind: "tn", rowId: id });

function setup() {
  let t = 1000;
  const h = createNavHistory(() => t);
  return { h, wait: (ms) => { t += ms; } };
}

// --- a spot held for a moment is recorded when left ---
{
  const { h, wait } = setup();
  h.observe(verse(1, 1));
  wait(SETTLE_MS);
  h.observe(verse(2, 1));
  assert(h.entries().length === 1 && h.entries()[0].chapter === 1, "settled spot is recorded on leaving");
}

// --- passing through quickly records nothing ---
{
  const { h, wait } = setup();
  h.observe(verse(1, 1));
  wait(SETTLE_MS);
  h.observe(verse(1, 2)); // pushes 1:1
  wait(300);
  h.observe(verse(1, 3)); // scrolled past 1:2
  wait(300);
  h.observe(verse(1, 4)); // scrolled past 1:3
  assert(h.entries().length === 1, "scrolled-past verses are not recorded");
  assert(h.entries()[0].verse === 1, "only the spot that was held is kept");
}

// --- the note counts as part of the spot ---
{
  const { h, wait } = setup();
  h.observe(note(3, 4, "n1"));
  wait(SETTLE_MS * 4);
  h.observe(verse(3, 4));
  assert(h.entries()[0].rowId === "n1", "leaving a note for its own verse still records the note");
}

// --- opening a note in the same verse does not record the bare verse ---
{
  const { h, wait } = setup();
  h.observe(verse(5, 4));
  wait(SETTLE_MS);
  h.observe(note(5, 4, "n1"));
  assert(h.entries().length === 0, "verse -> note in the same verse adds no entry");
  wait(SETTLE_MS);
  h.observe(verse(8, 1));
  assert(h.entries().length === 1 && h.entries()[0].rowId === "n1", "leaving the note records the note");
}

// --- back pops and does not record the departure ---
{
  const { h, wait } = setup();
  h.observe(verse(1, 1));
  wait(SETTLE_MS);
  h.observe(verse(2, 1)); // [1:1]
  wait(SETTLE_MS);
  h.observe(verse(3, 1)); // [1:1, 2:1]
  const back = h.takeBack();
  assert(back.chapter === 2, "back returns the newest entry");
  h.observe(verse(3, 1)); // transient while the chapter loads
  h.observe(verse(2, 1));
  assert(h.entries().length === 1 && h.entries()[0].chapter === 1, "back does not push the spot it left");
  wait(SETTLE_MS);
  const again = h.takeBack();
  assert(again.chapter === 1, "second back walks further back");
  assert(h.entries().length === 0, "stack empties");
  assert(h.takeBack() === undefined, "back on an empty stack is a no-op");
}

// --- menu pick drops everything newer ---
{
  const { h, wait } = setup();
  for (const ch of [1, 2, 3, 4]) {
    h.observe(verse(ch, 1));
    wait(SETTLE_MS);
  }
  // entries: 1,2,3 ; current 4
  const picked = h.takeBack(1);
  assert(picked.chapter === 2, "picking an entry returns it");
  assert(h.entries().length === 1 && h.entries()[0].chapter === 1, "newer entries are dropped");
}

// --- arriving at the newest entry by hand retires it ---
{
  const { h, wait } = setup();
  h.observe(verse(1, 1));
  wait(SETTLE_MS);
  h.observe(verse(2, 1)); // [1:1]
  h.observe(verse(1, 1)); // walked back manually (2:1 held < settle, not recorded)
  assert(h.entries().length === 0, "Back does not offer the place you are already at");
}

// --- same spot twice does not duplicate ---
{
  const { h, wait } = setup();
  h.observe(verse(1, 1));
  wait(SETTLE_MS);
  h.observe(verse(2, 1));
  wait(SETTLE_MS);
  h.observe(verse(1, 1)); // records 2:1, retires 1:1 -> [2:1]
  wait(SETTLE_MS);
  h.observe(verse(2, 1)); // records 1:1, retires 2:1 -> [1:1]
  assert(h.entries().length === 1 && h.entries()[0].chapter === 1, "bouncing between two spots keeps one entry");
}

// --- re-observing the current spot is a no-op (and keeps the hint fresh) ---
{
  const { h, wait } = setup();
  h.observe({ ...note(1, 1, "n"), hint: "old" });
  h.observe({ ...note(1, 1, "n"), hint: "new" });
  wait(SETTLE_MS);
  h.observe(verse(2, 1));
  assert(h.entries().length === 1 && h.entries()[0].hint === "new", "hint refreshes without re-recording");
}

// --- cap ---
{
  const { h, wait } = setup();
  for (let i = 1; i <= MAX_ENTRIES + 10; i++) {
    h.observe(verse(i, 1));
    wait(SETTLE_MS);
  }
  assert(h.entries().length === MAX_ENTRIES, "history is capped");
  assert(h.entries()[0].chapter === 10, "oldest entries fall off first");
}

// --- subscribers hear about changes ---
{
  const { h, wait } = setup();
  let n = 0;
  const off = h.subscribe(() => n++);
  h.observe(verse(1, 1));
  wait(SETTLE_MS);
  h.observe(verse(2, 1));
  assert(n === 1, "subscriber notified when an entry is added");
  off();
  h.takeBack();
  assert(n === 1, "unsubscribed listener is not called");
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all passed");
