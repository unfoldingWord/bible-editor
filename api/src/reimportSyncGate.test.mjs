// Smoke test for shouldRecordResourceSync — the reimport-sync watermark gate.
// Run from api/:
//   node --experimental-strip-types --no-warnings src/reimportSyncGate.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors reimportClassify.test.mjs.
//
// Regression under test: the nightly reimport skips any chapter held by an
// active AI pipeline lock, but used to stamp the (book, resource) sync
// watermark unconditionally — certifying a resource "in sync at master's SHA"
// even though a locked chapter's D1 rows were never actually refreshed. The
// nightly export's freshness gate trusts that watermark, so a stale locked
// chapter (e.g. EZK 40 UST, stuck at a 2026-06-10 revision while master moved
// on 2026-08-01) got rendered as current. shouldRecordResourceSync is the
// pure decision the reimport-sync step (bookReimport.ts) now gates on:
// withhold the stamp iff this run's counts show a locked chapter for that
// resource — EITHER at the chunk-apply phase (chapters_locked) or the LATER
// prune phase (prune_locked), which can see a lock the apply phase missed.
// A watermark must not certify data it didn't apply.

import { shouldRecordResourceSync } from "./reimportSyncGate.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (actual !== expected) {
    console.error(`FAIL: ${msg}\n    expected ${expected}\n    got      ${actual}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function counts(overrides = {}) {
  return {
    updated: 0,
    reimported_ai: 0,
    inserted: 0,
    deleted: 0,
    skipped_edited: 0,
    skipped_locked: 0,
    chapters_locked: 0,
    prune_locked: 0,
    skipped_noop: 0,
    skipped_dup: 0,
    resurrected: 0,
    source_attr_reconciled: 0,
    source_attr_divergent: 0,
    twl_reordered: 0,
    dcs_404: 0,
    errors: [],
    counts_incomplete: false,
    ...overrides,
  };
}

console.log("\n[shouldRecordResourceSync]");

// Ordinary run: nothing locked → stamp.
eq(
  shouldRecordResourceSync(counts()),
  true,
  "no locked chapters → stamp the watermark",
);

// THE BUG this fixes: a chapter was skipped this run because an active AI
// pipeline job held its lock → withhold the stamp (EZK 40 shape).
eq(
  shouldRecordResourceSync(counts({ chapters_locked: 1, skipped_locked: 1 })),
  false,
  "chapters_locked > 0 → withhold the watermark",
);

// THE OVERLOADING HAZARD: skipped_locked is ALSO incremented by the
// row-level prune path (softDeleteRemovedTsvRows skipping a locked row), a
// different and much less severe situation that must NOT withhold the
// watermark on its own. Only chapters_locked / prune_locked gate the decision.
eq(
  shouldRecordResourceSync(counts({ skipped_locked: 3, chapters_locked: 0, prune_locked: 0 })),
  true,
  "skipped_locked > 0 alone, both new fields zero → still stamp (the existing overloading regression)",
);

// FIX A: prune_locked alone (a lock held during the LATER prune step, missed
// by the earlier chunk-apply step) must withhold just like chapters_locked.
eq(
  shouldRecordResourceSync(counts({ prune_locked: 1, chapters_locked: 0 })),
  false,
  "prune_locked > 0 with chapters_locked === 0 → withhold the watermark",
);

// Both zero → stamp.
eq(
  shouldRecordResourceSync(counts({ chapters_locked: 0, prune_locked: 0 })),
  true,
  "both chapters_locked and prune_locked zero → stamp",
);

// Either non-zero → withhold.
eq(
  shouldRecordResourceSync(counts({ chapters_locked: 1, prune_locked: 0 })),
  false,
  "chapters_locked non-zero, prune_locked zero → withhold",
);
eq(
  shouldRecordResourceSync(counts({ chapters_locked: 0, prune_locked: 1 })),
  false,
  "chapters_locked zero, prune_locked non-zero → withhold",
);
eq(
  shouldRecordResourceSync(counts({ chapters_locked: 1, prune_locked: 1 })),
  false,
  "both non-zero → withhold",
);

// FIX F: a counts object from a Workflow instance that began BEFORE this fix
// shipped replays memoized step.do results that simply lack these two fields.
// That must be treated as fail-safe (withhold), never as "absent means zero,
// so stamp" — the malformed/legacy-object direction is always withhold.
eq(
  shouldRecordResourceSync({}),
  false,
  "counts object missing chapters_locked AND prune_locked entirely → withhold (fail-safe, not zero-and-stamp)",
);
eq(
  shouldRecordResourceSync({ chapters_locked: 0 }),
  false,
  "counts object missing prune_locked only → withhold (fail-safe)",
);
eq(
  shouldRecordResourceSync({ prune_locked: 0 }),
  false,
  "counts object missing chapters_locked only → withhold (fail-safe)",
);

// FINDING 2 regression: an AGGREGATE counts object (perResource[resource]
// after addCounts folded a legacy/replayed chunk in) can have
// chapters_locked/prune_locked PRESENT and zero — the `?? 0` coercion in
// addCounts erases the absence — while addCounts's separate
// `counts_incomplete` flag records that the aggregate is missing evidence.
// Without checking that flag here, this case stamps; it must withhold.
eq(
  shouldRecordResourceSync(counts({ chapters_locked: 0, prune_locked: 0, counts_incomplete: true })),
  false,
  "counts_incomplete true, both counters present and zero → withhold (Finding 2 regression)",
);

// The flag must not block the ordinary path when nothing is actually
// incomplete.
eq(
  shouldRecordResourceSync(counts({ chapters_locked: 0, prune_locked: 0, counts_incomplete: false })),
  true,
  "counts_incomplete false, both zero → stamp",
);

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
} else {
  console.log("\nAll shouldRecordResourceSync checks passed.");
}
