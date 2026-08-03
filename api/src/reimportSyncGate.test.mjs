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
// resource. A watermark must not certify data it didn't apply.

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
    skipped_noop: 0,
    skipped_dup: 0,
    resurrected: 0,
    source_attr_reconciled: 0,
    source_attr_divergent: 0,
    twl_reordered: 0,
    dcs_404: 0,
    errors: [],
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
// watermark. Only chapters_locked (the chapter-lock-skip counter) gates the
// decision.
eq(
  shouldRecordResourceSync(counts({ skipped_locked: 3, chapters_locked: 0 })),
  true,
  "skipped_locked > 0 from prune-row skips alone (chapters_locked === 0) → still stamp",
);

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
} else {
  console.log("\nAll shouldRecordResourceSync checks passed.");
}
