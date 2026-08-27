// Smoke test for summarizeReimport — the "Pull from Door43" result line.
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/reimportSummary.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors the other src/lib tests.
//
// Why this exists: the own_publish_converged line was added to this summary and
// shipped without anyone ever seeing it render. The wording is the whole feature
// here — it is the only place a human learns that Door43's movement was our own
// merged export rather than someone else's edit (see api/src/ownPublish.ts) — and
// "0 must not print a line" / "1 must not read as plural nonsense" are exactly the
// mistakes a display-only string makes. Extracting it from the MUI component made
// it testable at all.

import { summarizeReimport } from "./reimportSummary.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (actual !== expected) {
    console.error(`FAIL: ${msg}\n    expected ${expected}\n    got      ${actual}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}
function has(haystack, needle, msg) {
  eq(haystack.includes(needle), true, `${msg} (in: ${haystack})`);
}
function lacks(haystack, needle, msg) {
  eq(haystack.includes(needle), false, `${msg} (in: ${haystack})`);
}

// Only `totals` is read, but pass a shape the real endpoint returns.
function res(totals) {
  return {
    ok: true,
    book: "AMO",
    perResource: {},
    totals: {
      updated: 0,
      reimported_ai: 0,
      inserted: 0,
      deleted: 0,
      skipped_edited: 0,
      skipped_locked: 0,
      skipped_noop: 0,
      dcs_404: 0,
      errors: [],
      ...totals,
    },
  };
}

console.log("\n-- own_publish_converged: 0 / 1 / n --");

// 0 must print NO line at all — not "0 resource(s)". A converged count of zero is
// the overwhelmingly common case (every pull before the first export cycle
// records a render), so a stray "0 resource(s) confirmed..." would appear on
// nearly every pull and train people to ignore the whole summary.
const zero = summarizeReimport(res({ own_publish_converged: 0 }));
lacks(zero, "confirmed as holding", "0 converged -> the line is omitted entirely");
eq(zero, "Imported AMO — no changes.", "0 converged with nothing else to report -> the plain no-changes message");

// Absent (an older or cached response that predates the field) must behave like 0,
// not print "undefined".
const absent = summarizeReimport(res({}));
lacks(absent, "confirmed as holding", "field absent -> no line");
lacks(absent, "undefined", "field absent -> never renders the word undefined");

const one = summarizeReimport(res({ own_publish_converged: 1 }));
has(one, "1 resource(s) confirmed as holding our last export", "1 converged -> the line, with the count");
eq(
  one,
  "Imported AMO: 1 resource(s) confirmed as holding our last export.",
  "1 converged alone -> a complete, punctuated sentence rather than the no-changes message",
);

const many = summarizeReimport(res({ own_publish_converged: 5 }));
has(many, "5 resource(s) confirmed as holding our last export", "5 converged -> the count is the real number");

console.log("\n-- ordering and coexistence with the other counters --");

// The converged line must not swallow or reorder the counters a translator
// actually acts on; it is context, and it belongs after them.
const mixed = summarizeReimport(
  res({ updated: 3, merge_conflicts: 2, own_publish_converged: 1, dcs_404: 1 }),
);
has(mixed, "3 updated", "updated still reported alongside");
has(mixed, "2 flagged for review (merge conflict)", "merge conflicts still reported alongside");
has(mixed, "1 resource(s) not on DCS", "dcs_404 still reported alongside");
eq(
  mixed.indexOf("flagged for review") < mixed.indexOf("confirmed as holding"),
  true,
  "the actionable merge-conflict count comes BEFORE the informational converged line",
);
eq(
  mixed.indexOf("confirmed as holding") < mixed.indexOf("not on DCS"),
  true,
  "converged sits before the dcs_404 tail, matching the existing order",
);
eq(
  mixed,
  "Imported AMO: 3 updated, 2 flagged for review (merge conflict), " +
    "1 resource(s) confirmed as holding our last export, 1 resource(s) not on DCS.",
  "the whole line reads as one comma-joined sentence",
);

console.log("\n-- blocked ids (issue #427) --");

// Both counters roll into one plain-English phrase.
has(
  summarizeReimport(res({ tombstone_blocked: 6 })),
  "6 NOT imported (ID still held by a deleted row)",
  "tombstone_blocked is reported in the snackbar",
);
has(
  summarizeReimport(res({ conflict_skipped: 2 })),
  "2 NOT imported (ID still held by a deleted row)",
  "conflict_skipped is reported too",
);
has(
  summarizeReimport(res({ tombstone_blocked: 6, conflict_skipped: 2 })),
  "8 NOT imported (ID still held by a deleted row)",
  "the two counters are summed, not listed twice",
);

// This snackbar belongs to the MANUAL "Pull from Door43" action, which runs
// runReimport — a path that never touches book_resource_syncs. It must not
// claim the watermark effect that only the nightly chunked path produces.
lacks(
  summarizeReimport(res({ tombstone_blocked: 6 })),
  "out of sync",
  "does NOT assert a watermark consequence the manual reimport path cannot have",
);

// Absent (older/cached response) must read as nothing to say, not as NaN.
lacks(summarizeReimport(res({})), "NOT imported", "no blocked rows → no blocked phrase");
lacks(summarizeReimport(res({})), "NaN", "absent counters never render as NaN");

// Reference moves (issue #540 item 3). A move the APP made is an ordinary edit
// the export publishes — reporting it as flagged is exactly what used to tell a
// translator to undo her own work, so it must not appear here at all.
lacks(
  summarizeReimport(res({ ref_moved_ours: 4 })),
  "reference differs",
  "a move the app made is not reported as something to review",
);
has(
  summarizeReimport(res({ ref_moved_theirs: 3 })),
  "3 flagged for review (reference differs between here and Door43)",
  "a move Door43 made is reported",
);
// The three held cases sum: the human action is the same for all of them, and
// the per-row flag already carries the specific reason.
has(
  summarizeReimport(res({ ref_moved_theirs: 1, ref_moved_both: 2, ref_moved_unattributable: 3 })),
  "6 flagged for review (reference differs between here and Door43)",
  "theirs + both + unattributable are summed, not listed three times",
);
lacks(summarizeReimport(res({})), "reference differs", "no reference moves → no reference phrase");

console.log("\n-- adopt_no_visible_change must not inflate the merge-conflict snackbar (#633) --");

// bookReimport tallies adopt_no_visible_change into merge_adopted but NOT
// merge_conflicts. If that exclusion regresses, this snackbar is exactly how
// a translator learns "flagged for review" for a cosmetic write.
const noVisible = summarizeReimport(res({ merge_adopted: 6, merge_conflicts: 0 }));
has(noVisible, "6 adopted from master (out-of-band correction)", "adoptions still reported");
lacks(
  noVisible,
  "flagged for review (merge conflict)",
  "zero merge_conflicts → no review flag, even when adoptions landed",
);
// Sanity: a real conflict still surfaces.
has(
  summarizeReimport(res({ merge_adopted: 1, merge_conflicts: 1 })),
  "1 flagged for review (merge conflict)",
  "a real merge_conflicts count still becomes the review line",
);

console.log("\n-- reissued tombstones reclaimed (issue #427, option 1) --");

// 0 / absent must print nothing, matching every other optional counter here.
lacks(summarizeReimport(res({ tombstone_reclaimed: 0 })), "reclaimed", "0 reclaimed -> no line");
lacks(summarizeReimport(res({})), "reclaimed", "field absent -> no line");

has(
  summarizeReimport(res({ tombstone_reclaimed: 3 })),
  "3 reissued tombstone(s) reclaimed",
  "reclaimed count is reported",
);
eq(
  summarizeReimport(res({ tombstone_reclaimed: 3 })),
  "Imported AMO: 3 reissued tombstone(s) reclaimed.",
  "reclaimed alone -> a complete sentence, not the plain no-changes message",
);

// Must coexist with (and sit after) the blocked-row line — a reclaim landing
// and the lost-CAS fallback that still counts blocked are disjoint outcomes
// for different rows in the same run (see bookReimport.ts's reclaim batch), so
// a single run can legitimately report both at once.
const reclaimedAndBlocked = summarizeReimport(res({ tombstone_blocked: 2, tombstone_reclaimed: 5 }));
has(reclaimedAndBlocked, "2 NOT imported (ID still held by a deleted row)", "blocked line still present");
has(reclaimedAndBlocked, "5 reissued tombstone(s) reclaimed", "reclaimed line still present");
eq(
  reclaimedAndBlocked.indexOf("NOT imported") < reclaimedAndBlocked.indexOf("reclaimed"),
  true,
  "the actionable blocked-row count comes BEFORE the informational reclaimed line",
);

console.log("\n-- lens-suppressed verses (issue #609) --");

// The failure this guards: a pull on a chapter the last export reflowed can put
// EVERY verse in skipped_normalized and nothing anywhere else. Before this line
// existed, `parts` came back empty and the snackbar said "no changes" — asserting
// an equality nobody measured, about verses that did differ from Door43 and whose
// difference the sync declined to adopt.
const suppressed = summarizeReimport(res({ skipped_normalized: 12 }));
lacks(suppressed, "no changes", "a run that only suppressed writes never reports 'no changes'");
has(suppressed, "12 identical once exported", "…it says how many, and why they were left alone");

// …and it must stay distinguishable from the byte-equal no-op count, which is a
// different fact: those verses really were identical to Door43's.
const bothNoops = summarizeReimport(res({ skipped_noop: 4, skipped_normalized: 2 }));
has(bothNoops, "4 unchanged,", "byte-equal verses keep their own plain 'unchanged' count");
has(bothNoops, "2 identical once exported", "…and the lens-suppressed ones are reported separately");

// Absent (a Worker response predating the counter) must behave like 0.
lacks(summarizeReimport(res({})), "identical once exported", "field absent -> no line");

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
} else {
  console.log("\nAll summarizeReimport checks passed.");
}
