// Regression tests for runSaveChain (see saveChain.ts) — the fix for #490:
// a chain step whose save defers behind an async confirm (e.g. the
// collateral-loss / "words will be unaligned" dialog) must gate `finish`
// until that step's afterCommit actually fires, and a Cancel anywhere in the
// chain must stop `finish` from ever running. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/saveChain.test.mjs

import assert from "node:assert/strict";
import { createSaveDoneAndNextGuard, runSaveChain, runSaveDoneAndNext } from "./saveChain.ts";

let failed = 0;
function check(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  }
}

// A clean chain (nothing dirty) finishes immediately.
{
  let finished = false;
  runSaveChain(
    [
      { dirty: false, save: () => check(false, "clean step must not save") },
      { dirty: false, save: () => check(false, "clean step must not save") },
    ],
    () => {
      finished = true;
    },
  );
  check(finished, "an all-clean chain still calls finish");
}

// Every dirty step's synchronous save runs finish once, in order.
{
  const order = [];
  runSaveChain(
    [
      {
        dirty: true,
        save: (afterCommit) => {
          order.push("a");
          afterCommit();
        },
      },
      { dirty: false, save: () => check(false, "clean step must not save") },
      {
        dirty: true,
        save: (afterCommit) => {
          order.push("b");
          afterCommit();
        },
      },
    ],
    () => order.push("finish"),
  );
  assert.deepEqual(order, ["a", "b", "finish"], "synchronous saves run in order, then finish");
}

// The reading-line-then-alignment-panel shape from Shell's resolveDualAction:
// a step that defers behind a confirm (never calling afterCommit synchronously)
// must hold up every later step AND finish — this is the exact #490 failure
// mode (close proceeding while a confirm was still pending).
{
  const order = [];
  let pendingConfirm = null;
  runSaveChain(
    [
      {
        dirty: true,
        save: (afterCommit) => {
          order.push("reading");
          // Defers behind the collateral-loss confirm, like saveVerseDraft
          // does when guardBlocksSave trips (Shell.tsx enqueueVerseSafely).
          pendingConfirm = afterCommit;
        },
      },
      {
        dirty: true,
        save: (afterCommit) => {
          order.push("alignment");
          afterCommit();
        },
      },
    ],
    () => order.push("finish"),
  );
  check(order.length === 1 && order[0] === "reading", "later steps and finish do not run while the confirm is pending");
  check(pendingConfirm !== null, "the deferred step captured its afterCommit continuation");

  // Cancel: the confirm never resolves its commit, so afterCommit is simply
  // never called — the chain must stay stalled forever (no finish, no leak
  // into the alignment step).
  check(order.length === 1, "Cancel on the confirm leaves the chain stalled — no alignment step, no finish");

  // Save anyway: the confirm's commit fires, which is what calls afterCommit.
  pendingConfirm();
  assert.deepEqual(order, ["reading", "alignment", "finish"], "confirming resumes the chain and finish still runs last");
}

// A ref that's dirty but whose imperative handle is unmounted (current ===
// null) must still resolve via its own fallback rather than hanging the
// chain forever — mirrors the `dualLeftDirty && dualLeftRef.current` guard
// callers wrap around runSaveChain.
{
  const order = [];
  const nullRef = { current: null };
  runSaveChain(
    [
      {
        dirty: true,
        save: (afterCommit) => {
          const handle = nullRef.current;
          if (handle) handle.save(afterCommit);
          else afterCommit();
        },
      },
    ],
    () => order.push("finish"),
  );
  assert.deepEqual(order, ["finish"], "a dirty step backed by a null ref still resolves via its fallback");
}

// #931 "save, mark done, next verse": mark-done and advance run only after
// every dirty side has committed, in that order; a cancelled confirm leaves
// the verse unmarked and the aligner where it is.
{
  const order = [];
  let pendingConfirm = null;
  runSaveDoneAndNext({
    steps: [
      { dirty: true, save: (afterCommit) => { order.push("ult"); pendingConfirm = afterCommit; } },
      { dirty: true, save: (afterCommit) => { order.push("ust"); afterCommit(); } },
    ],
    markDone: () => order.push("done"),
    advance: () => order.push("next"),
  });
  assert.deepEqual(order, ["ult"], "nothing is marked or advanced while a confirm is pending (Cancel = stays here)");
  pendingConfirm();
  assert.deepEqual(order, ["ult", "ust", "done", "next"], "both saves land, then mark done, then advance");
}
// The mark is always written, clean verse or not — no "already done" skip
// (local state can be stale while a verse PATCH is queued; the outbox orders
// the check after it).
{
  const order = [];
  runSaveDoneAndNext({
    steps: [{ dirty: false, save: () => check(false, "clean step must not save") }],
    markDone: () => order.push("done"),
    advance: () => order.push("next"),
  });
  assert.deepEqual(order, ["done", "next"], "a clean verse is still marked done, then advanced");
  const order2 = [];
  runSaveDoneAndNext({
    steps: [{ dirty: true, save: (afterCommit) => { order2.push("ult"); afterCommit(); } }],
    markDone: () => order2.push("done"),
    advance: () => order2.push("next"),
  });
  assert.deepEqual(order2, ["ult", "done", "next"], "a saved verse is marked after its save");
}
// In-flight guard: a second click while the chain is running is ignored, and
// the mark targets the verse the FIRST click started on.
{
  const guard = createSaveDoneAndNextGuard();
  const marked = [];
  let active = 7;
  let pendingCommit = null;
  const heldDuring = [];
  const click = () => {
    const verse = active; // captured at click time, as Shell does
    return guard.run({
      steps: [{ dirty: true, save: (afterCommit) => { pendingCommit = afterCommit; } }],
      markDone: () => { heldDuring.push(["mark", guard.running]); marked.push(verse); },
      advance: () => { heldDuring.push(["advance", guard.running]); active = verse + 1; },
    });
  };
  assert.equal(click(), true, "first click starts the chain");
  assert.equal(guard.running, true, "guard is held while the save is pending");
  assert.equal(click(), false, "a second click during the chain is ignored");
  pendingCommit();
  assert.deepEqual(
    heldDuring,
    [["mark", true], ["advance", true]],
    "the guard stays held through markDone AND advance (released only after advance)",
  );
  assert.deepEqual(marked, [7], "only the starting verse is marked");
  assert.equal(active, 8, "advanced once");
  assert.equal(guard.running, false, "guard released when the chain finishes");
  // Cancelled confirm: the chain stalls for good; cancel() frees the button.
  pendingCommit = null;
  assert.equal(click(), true, "a new click on verse 8 starts a chain");
  guard.cancel();
  assert.equal(guard.running, false, "cancel() releases a stalled chain");
  assert.deepEqual(marked, [7], "the cancelled chain marked nothing");
  // A throwing step does not wedge the guard.
  const g2 = createSaveDoneAndNextGuard();
  assert.throws(() => g2.run({ steps: [{ dirty: true, save: () => { throw new Error("boom"); } }], markDone() {}, advance() {} }));
  assert.equal(g2.running, false, "a throwing save releases the guard");
  // A click from inside advance (e.g. a re-render firing the handler) is ignored.
  const g3 = createSaveDoneAndNextGuard();
  let reentered = null;
  g3.run({
    steps: [],
    markDone() {},
    advance() { reentered = g3.run({ steps: [], markDone() {}, advance() {} }); },
  });
  assert.equal(reentered, false, "a click during advance is ignored");
  assert.equal(g3.running, false, "guard released after advance");
  // A throwing advance or markDone (after an async commit) does not wedge it.
  for (const which of ["markDone", "advance"]) {
    const g4 = createSaveDoneAndNextGuard();
    let commit = null;
    g4.run({
      steps: [{ dirty: true, save: (afterCommit) => { commit = afterCommit; } }],
      markDone: () => { if (which === "markDone") throw new Error("boom"); },
      advance: () => { if (which === "advance") throw new Error("boom"); },
    });
    assert.throws(() => commit());
    assert.equal(g4.running, false, `a throwing ${which} releases the guard`);
  }
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll saveChain smoke checks passed.");
