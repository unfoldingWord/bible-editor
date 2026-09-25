// Chains a sequence of "maybe-deferred" saves so a caller can run a single
// continuation only once EVERY dirty step has actually committed — never
// while an async confirm (e.g. the collateral-loss / unalign dialog) from an
// earlier step is still pending, and never at all if the user cancels one.
//
// Each step's `save` mirrors the imperative handles it wraps
// (AlignmentPanelHandle.save / ReadingLineHandle.save): it takes an
// `afterCommit` callback and is responsible for invoking it once — and only
// once — the underlying save has actually landed. That happens synchronously
// for a plain save, or later if it defers behind a confirm; a step whose
// confirm the user cancels correctly never calls `afterCommit`, which stalls
// the whole chain (`finish` never runs). That stall IS the fix for #490: a
// hand-rolled chain that ran `finish` right after firing off a save whose
// commit could still be pending would close/unmount while a "Words will be
// unaligned" (or equivalent) confirm was still open, discarding the edit if
// the user then hit Cancel.
export interface SaveStep {
  dirty: boolean;
  save: (afterCommit: () => void) => void;
}

export function runSaveChain(steps: SaveStep[], finish: () => void): void {
  const run = (i: number): void => {
    if (i >= steps.length) {
      finish();
      return;
    }
    const step = steps[i];
    if (!step.dirty) {
      run(i + 1);
      return;
    }
    step.save(() => run(i + 1));
  };
  run(0);
}

// The dual aligner's "save, mark done, next verse" button (#931): run the
// same dirty-side save chain as the unsaved-changes gate's Save, and only once
// every side has committed mark the verse done and advance. A cancelled
// confirm stalls the chain, so nothing is marked and the aligner stays on this
// verse. The mark is always written, even for a verse already shown done:
// setting a check is idempotent, local state can be stale while a verse PATCH
// is still queued (the server's reopen will clear the check), and the outbox
// holds the check behind any earlier verse save for the same verse
// (outboxTargeting.ts laneCheckHeld), so it always lands last.
export function runSaveDoneAndNext(opts: {
  steps: SaveStep[];
  markDone: () => void;
  advance: () => void;
}): void {
  runSaveChain(opts.steps, () => {
    opts.markDone();
    opts.advance();
  });
}

// In-flight guard for the button: a second click while a chain is still
// running (waiting on a draft read or a confirm) is ignored, so it cannot
// start a second save-and-mark (which, once the first had advanced, would mark
// the NEXT verse). `cancel` releases the guard when the chain is known to have
// stalled for good — the user cancelled the unalign confirm — so the button
// works again. The caller passes the verse to mark in its own closures, so the
// mark always targets the verse the click started on.
export function createSaveDoneAndNextGuard() {
  let running = false;
  return {
    get running() {
      return running;
    },
    run(opts: { steps: SaveStep[]; markDone: () => void; advance: () => void }): boolean {
      if (running) return false;
      running = true;
      try {
        runSaveDoneAndNext({
          steps: opts.steps,
          markDone: () => {
            running = false;
            opts.markDone();
          },
          advance: opts.advance,
        });
      } catch (e) {
        running = false;
        throw e;
      }
      return true;
    },
    cancel() {
      running = false;
    },
  };
}
