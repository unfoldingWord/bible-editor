// Regression tests for runSaveChain (see saveChain.ts) — the fix for #490:
// a chain step whose save defers behind an async confirm (e.g. the
// collateral-loss / "words will be unaligned" dialog) must gate `finish`
// until that step's afterCommit actually fires, and a Cancel anywhere in the
// chain must stop `finish` from ever running. Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/saveChain.test.mjs

import assert from "node:assert/strict";
import { runSaveChain } from "./saveChain.ts";

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

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll saveChain smoke checks passed.");
