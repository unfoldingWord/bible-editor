import assert from "node:assert/strict";
import { createDraftWriteCoalescer } from "./draftWriteCoalescer.ts";

// A manual clock: timers fire only when the test advances time.
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

function harness(interval = 2000) {
  const clock = fakeClock();
  const puts = [];
  const coalescer = createDraftWriteCoalescer(async (key, value) => { puts.push([key, value]); }, interval, clock);
  return { clock, puts, coalescer };
}

// #901 success check: 20 fast keystrokes (50 ms apart) cause at most 3 puts,
// and the last one written is the latest text.
{
  const { clock, puts, coalescer } = harness();
  for (let i = 1; i <= 20; i++) {
    coalescer.write("verse:a", `text ${i}`);
    clock.advance(50);
  }
  clock.advance(5000);
  await turn();
  assert.ok(puts.length <= 3, `expected <= 3 puts, got ${puts.length}`);
  assert.deepEqual(puts.at(-1), ["verse:a", "text 20"]);
}

// Normal-speed typing (5 keys a second) also stays within 3 puts for 20 keys.
{
  const { clock, puts, coalescer } = harness();
  for (let i = 1; i <= 20; i++) {
    coalescer.write("k", i);
    clock.advance(200);
  }
  clock.advance(5000);
  assert.ok(puts.length <= 3, `expected <= 3 puts, got ${puts.length}`);
  assert.deepEqual(puts.at(-1), ["k", 20]);
}

// The first keystroke writes at once (the chip and crash backup appear
// immediately); later keystrokes wait for the interval.
{
  const { clock, puts, coalescer } = harness();
  coalescer.write("k", 1);
  assert.deepEqual(puts, [["k", 1]]);
  coalescer.write("k", 2);
  coalescer.write("k", 3);
  assert.equal(puts.length, 1);
  clock.advance(1999);
  assert.equal(puts.length, 1);
  clock.advance(1);
  assert.deepEqual(puts, [["k", 1], ["k", 3]]);
  // A quiet interval closes the window: the next keystroke is immediate again.
  clock.advance(2000);
  coalescer.write("k", 4);
  assert.deepEqual(puts.at(-1), ["k", 4]);
}

// flush writes the queued value now and resolves after it is persisted.
{
  const clock = fakeClock();
  const puts = [];
  let finish;
  const coalescer = createDraftWriteCoalescer(
    (key, value) => { puts.push([key, value]); return value === 2 ? new Promise((r) => { finish = r; }) : Promise.resolve(); },
    2000,
    clock,
  );
  coalescer.write("k", 1);
  coalescer.write("k", 2);
  let flushed = false;
  const done = coalescer.flush("k").then(() => { flushed = true; });
  assert.deepEqual(puts, [["k", 1], ["k", 2]]);
  await turn();
  assert.equal(flushed, false, "flush must wait for the write to persist");
  finish();
  await done;
  assert.equal(flushed, true);
  // Nothing queued any more: the timer firing writes nothing new.
  clock.advance(5000);
  assert.equal(puts.length, 2);
}

// flush with nothing queued resolves; flushAll writes every key's latest.
{
  const { puts, coalescer } = harness();
  await coalescer.flush("none");
  coalescer.write("a", 1);
  coalescer.write("a", 2);
  coalescer.write("b", 1);
  coalescer.write("b", 2);
  await coalescer.flushAll();
  assert.deepEqual(puts, [["a", 1], ["b", 1], ["a", 2], ["b", 2]]);
}

// #901 review A1: flushAll must call persist synchronously (inside the
// pagehide/beforeunload handler), not after an await.
{
  const { puts, coalescer } = harness();
  coalescer.write("a", 1);
  coalescer.write("a", 2);
  coalescer.write("b", 1);
  coalescer.write("b", 2);
  void coalescer.flushAll();
  assert.deepEqual(puts, [["a", 1], ["b", 1], ["a", 2], ["b", 2]]);
}

// #901 review C2: a flush (before a save, or before a save's clear) closes the
// window, so the next keystroke writes at once instead of up to 2 s later.
{
  const { puts, coalescer } = harness();
  coalescer.write("k", 1);
  coalescer.write("k", 2);
  void coalescer.flush("k");
  assert.equal(puts.length, 2);
  coalescer.write("k", 3);
  assert.deepEqual(puts.at(-1), ["k", 3], "first keystroke after a flush writes immediately");
  // A flush with nothing queued also closes an open window.
  void coalescer.flush("k");
  coalescer.write("k", 4);
  assert.deepEqual(puts.at(-1), ["k", 4]);
}

// cancel drops the queued value (the draft was cleared): it must never land
// after the clear and resurrect the draft.
{
  const { clock, puts, coalescer } = harness();
  coalescer.write("k", 1);
  coalescer.write("k", 2);
  coalescer.cancel("k");
  clock.advance(5000);
  await coalescer.flush("k");
  assert.deepEqual(puts, [["k", 1]]);
  // After a cancel the next keystroke writes at once.
  coalescer.write("k", 3);
  assert.deepEqual(puts.at(-1), ["k", 3]);
}

// A failed write is reported, not thrown out of a timer, and flush still resolves.
{
  const clock = fakeClock();
  const warn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    const coalescer = createDraftWriteCoalescer(async () => { throw new Error("quota"); }, 2000, clock);
    coalescer.write("k", 1);
    coalescer.write("k", 2);
    await coalescer.flush("k");
    assert.equal(warned, 2);
  } finally {
    console.warn = warn;
  }
}

console.log("draftWriteCoalescer: all tests passed");
