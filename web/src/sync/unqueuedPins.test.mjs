// Regression coverage for issue #1050: a reading-line save that queued nothing
// (refused under a book lock, or its unalign confirm cancelled) keeps the
// verse-base pin while its edit is still on screen, so saving that edit after
// the verse moved 409s instead of overwriting the change. With no outbox exit
// to release it, the tracker must release it exactly when the edit goes away,
// synchronously (an async release let a save started in the gap reuse the old
// pin), and never for a save that was queued (the outbox exit owns that one).
//
// Run from web/:
//   node --experimental-strip-types --no-warnings src/sync/unqueuedPins.test.mjs

import { createUnqueuedPinTracker } from "./unqueuedPins.ts";

let failed = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}`);
  }
}

function setup() {
  const unpinned = [];
  const tracker = createUnqueuedPinTracker((key) => unpinned.push(key));
  return { tracker, unpinned };
}

const K = "verse:ZEC:7:2:ULT";

{
  // Refused while the edit is still on screen: keep the pin, then release it
  // synchronously when the line drops the edit.
  const { tracker, unpinned } = setup();
  tracker.started(K);
  tracker.abandoned(K, () => true);
  check("kept edit keeps the pin", unpinned.length === 0 && tracker.holds(K));
  tracker.dropped(K);
  check("dropping the edit releases the pin at once", unpinned.length === 1 && unpinned[0] === K);
  check("and forgets the key", !tracker.holds(K));
  tracker.dropped(K);
  check("a second drop releases nothing more", unpinned.length === 1);
}

{
  // The line went clean while the save was in flight (Undo during the draft
  // lookup), then the save was refused: nothing would ever release a record,
  // so release now instead of recording.
  const { tracker, unpinned } = setup();
  tracker.started(K);
  tracker.abandoned(K, () => false);
  check("abandoned with no edit left releases now", unpinned.length === 1 && !tracker.holds(K));
}

{
  // A caller that cannot say whether the edit is still shown (a scripture
  // cell, whose draft keeps the session's pin anyway) records the key.
  const { tracker, unpinned } = setup();
  tracker.abandoned(K);
  check("no stillEditing probe: record, do not release", unpinned.length === 0 && tracker.holds(K));
}

{
  // A drop for a save that was queued, or for a key never recorded, must not
  // release: the outbox exit owns a queued save's pin.
  const { tracker, unpinned } = setup();
  tracker.dropped(K);
  check("drop of an unrecorded key releases nothing", unpinned.length === 0);
  tracker.started(K);
  tracker.abandoned(K, () => true);
  tracker.queued(K);
  tracker.dropped(K);
  check("a later queued save hands the pin to the outbox", unpinned.length === 0 && !tracker.holds(K));
}

{
  // A new save attempt clears an earlier record before deciding again, so a
  // drop while it is in flight does not pull the pin out from under it.
  const { tracker, unpinned } = setup();
  tracker.abandoned(K, () => true);
  tracker.started(K);
  tracker.dropped(K);
  check("drop during a new attempt releases nothing", unpinned.length === 0);
  tracker.abandoned(K, () => true);
  check("the attempt's own refusal records again", tracker.holds(K));
}

{
  // Keys are independent.
  const { tracker, unpinned } = setup();
  const K2 = "verse:ZEC:7:2:UST";
  tracker.abandoned(K, () => true);
  tracker.abandoned(K2, () => true);
  tracker.dropped(K2);
  check("dropping one side releases only that key", unpinned.length === 1 && unpinned[0] === K2 && tracker.holds(K));
}

if (failed) {
  console.error(`unqueuedPins: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("unqueuedPins: all checks passed.");
