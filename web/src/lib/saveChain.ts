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
// verse. `alreadyDone` skips the mark only when nothing was saved: a verse
// save reopens the Text lane server-side (api/src/verses.ts reopenLaneChecks),
// so after any save the mark must be written again.
export function runSaveDoneAndNext(opts: {
  steps: SaveStep[];
  alreadyDone: boolean;
  markDone: () => void;
  advance: () => void;
}): void {
  const saved = opts.steps.some((s) => s.dirty);
  runSaveChain(opts.steps, () => {
    if (saved || !opts.alreadyDone) opts.markDone();
    opts.advance();
  });
}
