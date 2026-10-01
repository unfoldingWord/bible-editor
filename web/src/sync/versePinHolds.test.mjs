// Issue #1060: a draftless editor (the dual aligner's reading line) holds the
// verse-base pin from its first dirty keystroke until it goes clean. The hold
// must pin the base the box showed, keep every "release if idle" path off the
// pin while the edit is live, release synchronously when the line goes clean
// with nothing queued, and never release a pin something else owns (a queued
// save's outbox exit, a draft session).
//
// Run from web/:
//   node --experimental-strip-types --no-warnings src/sync/versePinHolds.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  advanceHeldVerseBase,
  holdVerseBase,
  peekPinnedVerseBase,
  pinVerseBase,
  unpinVerseBase,
  unpinVerseBaseIfIdleWith,
  unpinVerseBaseUnlessHeld,
} from "./versePin.ts";
import { noteOwnVerseOp, takeOwnVerseOp } from "./ownVerseOps.ts";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const K = "verse:ZEC:7:2:ULT";
const K2 = "verse:ZEC:7:2:UST";
const shown = { version: 3, content: "shown" };
const moved = { version: 4, content: "moved" };

function reset() {
  unpinVerseBase(K);
  unpinVerseBase(K2);
}

check("the first dirty keystroke pins the base the box showed", () => {
  reset();
  const hold = holdVerseBase(K, shown);
  assert.equal(peekPinnedVerseBase(K)?.version, 3);
  // Save time: the live base has moved, but the save gets the held pin.
  assert.equal(pinVerseBase(K, moved).version, 3);
  hold.release();
});

check("going clean with nothing queued releases the pin at once", () => {
  reset();
  const hold = holdVerseBase(K, shown);
  hold.release();
  assert.equal(peekPinnedVerseBase(K), undefined);
  // Idempotent: a second end is a no-op, even after a new pin.
  pinVerseBase(K, moved);
  hold.release();
  hold.handOff();
  assert.equal(peekPinnedVerseBase(K)?.version, 4);
});

check("a queued save takes the pin over; its outbox exit releases it", () => {
  reset();
  const hold = holdVerseBase(K, shown);
  hold.handOff();
  assert.equal(peekPinnedVerseBase(K)?.version, 3, "handOff keeps the pin for the queued op");
  unpinVerseBaseIfIdle(K);
  assert.equal(peekPinnedVerseBase(K), undefined, "the exit's idle unpin releases it");
});

function unpinVerseBaseIfIdle(key, draftSessionLive = false) {
  unpinVerseBaseIfIdleWith(key, draftSessionLive);
}

check("an outbox exit while the line is dirty again keeps the pin, and the hold then releases it", () => {
  reset();
  // Save queued (pin handed to its op), then the line is edited again before
  // that op's exit: the new hold joins the queued save's pin.
  holdVerseBase(K, shown).handOff();
  const again = holdVerseBase(K, moved);
  assert.equal(peekPinnedVerseBase(K)?.version, 3, "joins the existing pin");
  unpinVerseBaseIfIdle(K); // the earlier op lands
  assert.equal(peekPinnedVerseBase(K)?.version, 3, "the live edit keeps its pin");
  again.release(); // Undo
  assert.equal(peekPinnedVerseBase(K), undefined, "the deferred release happens on clean");
});

check("a hold that joined a pin it does not own leaves it on release", () => {
  reset();
  pinVerseBase(K, shown); // a queued save's pin, still in flight
  const hold = holdVerseBase(K, moved);
  hold.release(); // Undo before the op's exit
  assert.equal(peekPinnedVerseBase(K)?.version, 3, "the queued op's exit owns this pin");
  unpinVerseBaseIfIdle(K);
  assert.equal(peekPinnedVerseBase(K), undefined);
});

check("a deferred release handed on by a second save goes to that save's exit", () => {
  reset();
  holdVerseBase(K, shown).handOff();
  const again = holdVerseBase(K, moved);
  unpinVerseBaseIfIdle(K); // first op's exit, deferred
  again.handOff(); // second save queued
  assert.equal(peekPinnedVerseBase(K)?.version, 3, "kept for the second op");
  unpinVerseBaseIfIdle(K); // second op's exit
  assert.equal(peekPinnedVerseBase(K), undefined);
});

check("a release never pulls the pin from a draft session that shares it", () => {
  reset();
  let draftLive = true;
  const hold = holdVerseBase(K, shown, () => !draftLive);
  hold.release();
  assert.equal(peekPinnedVerseBase(K)?.version, 3, "the draft session keeps it");
  draftLive = false;
  unpinVerseBaseIfIdle(K, true);
  assert.equal(peekPinnedVerseBase(K)?.version, 3, "idle unpin respects the draft session");
  unpinVerseBaseIfIdle(K, false);
  assert.equal(peekPinnedVerseBase(K), undefined);
});

check("holds are per editor: the pin stays until the last one ends", () => {
  reset();
  const a = holdVerseBase(K, shown);
  const b = holdVerseBase(K, moved);
  a.release();
  assert.equal(peekPinnedVerseBase(K)?.version, 3, "b still holds it");
  a.release(); // a's second end must not end b's hold
  assert.equal(peekPinnedVerseBase(K)?.version, 3);
  b.release();
  assert.equal(peekPinnedVerseBase(K), undefined);
});

check("keys are independent", () => {
  reset();
  const a = holdVerseBase(K, shown);
  const b = holdVerseBase(K2, moved);
  b.release();
  assert.equal(peekPinnedVerseBase(K2), undefined);
  assert.equal(peekPinnedVerseBase(K)?.version, 3);
  unpinVerseBaseIfIdle(K2);
  a.release();
  assert.equal(peekPinnedVerseBase(K), undefined);
});

check("with no hold, the idle unpin behaves as before", () => {
  reset();
  pinVerseBase(K, shown);
  unpinVerseBaseIfIdle(K, true);
  assert.equal(peekPinnedVerseBase(K)?.version, 3, "a draft session keeps it");
  unpinVerseBaseIfIdle(K, false);
  assert.equal(peekPinnedVerseBase(K), undefined);
});

// ---- review round 1 ----

check("a draft session ending (clear / clearGeneration) keeps a pin a live hold joined, until the hold ends clean", () => {
  reset();
  pinVerseBase(K, shown); // the draft session's (or a queued draft-backed save's) pin
  const hold = holdVerseBase(K, moved); // the reading line joins it
  unpinVerseBaseUnlessHeld(K); // drafts.clear / clearGeneration / releaseLocalBookkeeping
  assert.equal(peekPinnedVerseBase(K)?.version, 3, "the dirty line keeps its base");
  hold.release();
  assert.equal(peekPinnedVerseBase(K), undefined, "released when the line goes clean");
});

check("with no hold, a draft session ending unpins as before", () => {
  reset();
  pinVerseBase(K, shown);
  unpinVerseBaseUnlessHeld(K);
  assert.equal(peekPinnedVerseBase(K), undefined);
});

check("drafts.ts never unpins directly: every unpin path goes through a hold-aware release", () => {
  const src = readFileSync(new URL("./drafts.ts", import.meta.url), "utf8");
  assert.equal(/\bunpinVerseBase\s*\(/.test(src), false, "direct unpinVerseBase( call in drafts.ts");
});

check("this tab's own save landing moves a live hold's pin forward to the landed row", () => {
  reset();
  const hold = holdVerseBase(K, shown); // v3
  advanceHeldVerseBase(K, 3, { version: 4, content: "aligned" });
  assert.deepEqual(peekPinnedVerseBase(K), { version: 4, content: "aligned" });
  // A second own save, threaded onto v4, lands as v5.
  advanceHeldVerseBase(K, 4, { version: 5, content: "aligned+text" });
  assert.equal(peekPinnedVerseBase(K)?.version, 5);
  hold.release();
  assert.equal(peekPinnedVerseBase(K), undefined);
});

check("an own save made against a different base does not move the pin (another change came between)", () => {
  reset();
  const hold = holdVerseBase(K, shown); // v3
  advanceHeldVerseBase(K, 4, { version: 5, content: "x" }); // based on a v4 the line never showed
  assert.equal(peekPinnedVerseBase(K)?.version, 3);
  hold.release();
});

check("with no live hold, a landed save does not move a pin", () => {
  reset();
  pinVerseBase(K, shown);
  advanceHeldVerseBase(K, 3, { version: 4, content: "x" });
  assert.equal(peekPinnedVerseBase(K)?.version, 3);
  // A hold on another key does not count.
  const other = holdVerseBase(K2, moved);
  advanceHeldVerseBase(K, 3, { version: 4, content: "x" });
  assert.equal(peekPinnedVerseBase(K)?.version, 3);
  other.release();
  unpinVerseBase(K);
});

check("only ops this tab queued count as own; each is claimed once", () => {
  noteOwnVerseOp("op-a");
  assert.equal(takeOwnVerseOp("op-b"), false, "another tab's op");
  assert.equal(takeOwnVerseOp(undefined), false);
  assert.equal(takeOwnVerseOp("op-a"), true);
  assert.equal(takeOwnVerseOp("op-a"), false, "forgotten after its exit");
});

console.log(`versePinHolds: ${passed} passed`);
