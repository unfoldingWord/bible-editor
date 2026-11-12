// Regression for issue #1330: restoring a tn note's old quote from history
// after the quote was cleared lost its Occurrence. Clearing the quote stores
// Occurrence 0 (#1329); the restore patch carried only quote/note/support
// reference, so the server's requiredOccurrence turned 0 into 1 and a note
// that had pointed at the 2nd copy of a Hebrew word now pointed at the 1st.

import assert from "node:assert/strict";
import { snapshotOccurrence, tnRestorePatch } from "./tnRestorePatch.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ok: ${msg}`);
};

const HEB = "דְּבַר";
const saved = (over = {}) => ({ quote: "", note: "Some note.", support_reference: null, ...over });

console.log("[restore patch carries occurrence]");
{
  // The reported case: Hebrew quote at occurrence 2, quote cleared (row now
  // blank quote, occurrence 0), then the earlier version restored.
  const p = tnRestorePatch(
    { quote: HEB, note: "Some note.", support_reference: null, occurrence: 2 },
    saved(),
  );
  check(p.quote === HEB, "the old quote is restored");
  check(p.occurrence === 2, `the old occurrence is restored with it (got ${p.occurrence})`);
  check(!("note" in p), "an unchanged note is not re-sent");
}

console.log("[occurrence stays out when it should]");
{
  // Note-only restore: the quote is the same, so occurrence must not ride
  // along — it could undo an occurrence-only repair made after that version.
  const p = tnRestorePatch(
    { quote: HEB, note: "Old wording.", support_reference: null, occurrence: 1 },
    saved({ quote: HEB }),
  );
  check(p.note === "Old wording.", "the note is restored");
  check(!("occurrence" in p), "a note-only restore sends no occurrence");

  const nul = tnRestorePatch(
    { quote: HEB, note: "Some note.", support_reference: null, occurrence: null },
    saved(),
  );
  check(nul.quote === HEB && !("occurrence" in nul), "a null snapshot occurrence is not sent");

  const missing = tnRestorePatch({ quote: HEB, note: "Some note.", support_reference: null }, saved());
  check(missing.quote === HEB && !("occurrence" in missing), "a snapshot without occurrence sends none");

  const same = tnRestorePatch(
    { quote: HEB, note: "Some note.", support_reference: null, occurrence: 2 },
    saved({ quote: HEB }),
  );
  check(Object.keys(same).length === 0, "restoring the content the row already holds sends nothing");
}

console.log("[snapshotOccurrence]");
{
  check(snapshotOccurrence(2) === 2, "an integer passes through");
  check(snapshotOccurrence(0) === 0, "zero passes through");
  check(snapshotOccurrence(null) === null, "null stays null");
  check(snapshotOccurrence(undefined) === null, "a missing key reads as null");
  check(snapshotOccurrence("2") === null, "a string is not an occurrence (the PATCH schema would reject it)");
  check(snapshotOccurrence(1.5) === null, "a non-integer is not an occurrence");
}

console.log(`\n${passed} assertions passed`);
