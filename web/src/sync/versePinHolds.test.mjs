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
import {
  holdVerseBase,
  peekPinnedVerseBase,
  pinVerseBase,
  unpinVerseBase,
  unpinVerseBaseIfIdleWith,
} from "./versePin.ts";

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

console.log(`versePinHolds: ${passed} passed`);
