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
// the NEXT verse). The guard is released once advance has run, or when mark or
// advance throws. `cancel` releases the guard when the chain is known to have
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
          // Released only AFTER advance, so a click landing between the mark
          // and the move (or re-entering from either) cannot start a chain on
          // the verse being left. A throw from either still releases it.
          markDone: () => {
            try {
              opts.markDone();
            } catch (e) {
              running = false;
              throw e;
            }
          },
          advance: () => {
            try {
              opts.advance();
            } finally {
              running = false;
            }
          },
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

// One pending outbox write per aligner panel (#1196 item 2, review of #1207).
// A save that starts while an earlier write is still pending waits for it to
// settle and then runs against the panel's state at that time, so two saves
// never race: an older save's late commit cannot clear a newer crash draft or
// release the save-done-next guard under a newer save.
export function createWriteLatch() {
  let pending: Promise<void> | null = null;
  return {
    hold(write: Promise<unknown>): void {
      const mine: Promise<void> = write.then(
        () => {},
        () => {},
      ).then(() => {
        if (pending === mine) pending = null;
      });
      pending = mine;
    },
    // Runs `fn` once the pending write settles and returns true; false (and
    // `fn` not run) when nothing is pending, so the caller saves now.
    after(fn: () => void): boolean {
      if (!pending) return false;
      void pending.then(fn);
      return true;
    },
  };
}
export type WriteLatch = ReturnType<typeof createWriteLatch>;

// How an aligner panel acts on its onSave answer (#986, #1196). false: nothing
// was queued, so keep the edit and its crash draft and run no afterCommit.
// void/true: queued synchronously (the single-panel aligner), commit now. A
// promise (the dual aligner, whose IndexedDB write can reject): commit only
// once it resolves true; false or a rejection means nothing was queued. The
// latch, when given, holds later saves until the promise settles.
// Returns whether the commit happened synchronously.
export function settleOnSave(
  queued: boolean | void | Promise<boolean>,
  committed: (deferred: boolean) => void,
  notQueued: () => void,
  latch?: WriteLatch,
): boolean {
  if (queued === false) {
    notQueued();
    return false;
  }
  if (queued instanceof Promise) {
    const settled = queued.then(
      (ok) => (ok ? committed(true) : notQueued()),
      () => notQueued(),
    );
    latch?.hold(settled);
    return false;
  }
  committed(false);
  return true;
}
