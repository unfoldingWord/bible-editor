// Smoke test for staleSkipRemedy — the export_stale banner's remedy text
// (issue #829). Run from api/:
//   node --experimental-strip-types --no-warnings src/syncWithholds.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors reimportSyncGate.test.mjs.
//
// Regression under test: recordStaleSkipAlert (exportWorkflow.ts) used to
// assert a single unmeasured cause — "the pre-export sync didn't catch up;
// re-run the sync" — for EVERY export_stale skip, including a deliberate
// chapters_locked withhold the reimport step already knew about and could not
// have fixed by re-running (project_alert_must_only_state_measured_cause).
// staleSkipRemedy renders the actual measured cause instead, and honestly
// says "no reason on record" rather than guessing one when nothing was
// persisted.

import { staleSkipRemedy } from "./syncWithholds.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (actual !== expected) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function withhold(overrides = {}) {
  return {
    book: "JER",
    resource: "ult",
    reason: "chapters_locked",
    count: 1,
    occurredAt: 1_700_000_000_000,
    ...overrides,
  };
}

console.log("\n[staleSkipRemedy]");

// THE ABLATION the issue's success check asks for: with no recorded reason,
// the remedy must say so honestly, never assert the old generic cause.
eq(
  staleSkipRemedy(null),
  "D1 is behind master; this run recorded no reason.",
  "no withhold row on record → honest 'no reason' text, not a guessed cause",
);

// Every reason renders distinct, cause-naming text — and none of them repeats
// the old wrong-in-general remedy ('re-run the sync').
const reasons = [
  "chapters_locked",
  "prune_locked",
  "conflict_skipped",
  "tombstone_blocked",
  "counts_incomplete",
  "structure_overlap",
  "systemic_refusal",
  "merge_record_failed",
  "apply_incomplete",
];
for (const reason of reasons) {
  const text = staleSkipRemedy(withhold({ reason, count: 3 }));
  eq(typeof text === "string" && text.length > 0, true, `${reason} → produces non-empty text`);
  eq(
    text.includes("re-run the sync for"),
    false,
    `${reason} → does not repeat the old blanket 're-run the sync' remedy`,
  );
}

// A deliberate hold (chapters_locked) must read as "will self-heal", not as
// something re-running the sync fixes — this is the exact wrong-remedy bug.
eq(
  staleSkipRemedy(withhold({ reason: "chapters_locked", count: 2 })).includes("2 chapter(s)"),
  true,
  "chapters_locked → names the measured chapter count",
);
eq(
  /pipeline job/.test(staleSkipRemedy(withhold({ reason: "chapters_locked" }))),
  true,
  "chapters_locked → names the real cause (an active pipeline job holding the chapter)",
);

// A human-actionable reason points at something to go look at, not "re-run".
eq(
  /human/.test(staleSkipRemedy(withhold({ reason: "conflict_skipped", count: 6 }))),
  true,
  "conflict_skipped → tells the operator this needs a human, not a re-run",
);
eq(
  /human/.test(staleSkipRemedy(withhold({ reason: "structure_overlap", count: 1 }))),
  true,
  "structure_overlap → tells the operator this needs a human",
);

// count: 0 (the boolean-flag reasons) must not render a stray "0 " prefix.
eq(
  staleSkipRemedy(withhold({ reason: "systemic_refusal", count: 0 })).startsWith("0 "),
  false,
  "a zero count is omitted from the rendered text, not printed as '0 '",
);

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
} else {
  console.log("\nAll staleSkipRemedy checks passed.");
}
