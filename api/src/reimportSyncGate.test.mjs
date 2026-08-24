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

import {
  shouldRecordResourceSync,
  isSystemicMergeRefusal,
  SYSTEMIC_MERGE_REFUSAL_THRESHOLD,
  isKeptOverDoor43AtScale,
  KEPT_OVER_DOOR43_ALERT_THRESHOLD,
  mergeRefusalOverrideAllowed,
  idBlockedOverrideAllowed,
} from "./reimportSyncGate.ts";

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
    conflict_skipped: 0,
    tombstone_blocked: 0,
    tombstone_reclaimed: 0,
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

// ── Issue #427, option 2: tombstone-blocked / PK-conflict drops ─────────────
// THE 1CH 23 tQ SHAPE. Six tQ rows whose ids were held by tombstones from
// 1CH 5:x never landed; (1CH, tq) was stamped `origin='reimport'` anyway, so
// the book was certified in sync while master carried six rows D1 did not.
// Nothing retries it — the next run's SHA gate sees an unchanged source_sha
// and skips the file — so the stamp is the whole difference between a
// one-night gap and a permanent silent divergence.
eq(
  shouldRecordResourceSync(counts({ tombstone_blocked: 6 })),
  false,
  "tombstone_blocked > 0 (the 1CH 23 tQ shape) → withhold the watermark",
);
eq(
  shouldRecordResourceSync(counts({ conflict_skipped: 1 })),
  false,
  "conflict_skipped > 0 (ON CONFLICT DO NOTHING wrote 0 rows) → withhold the watermark",
);
eq(
  shouldRecordResourceSync(counts({ conflict_skipped: 0, tombstone_blocked: 0 })),
  true,
  "both drop counters present and zero → stamp",
);
// The gate must not be reachable via the OTHER counters alone: a run that
// dropped rows still withholds even when every lock counter is clean, which is
// exactly the 1CH case (no locks were held that night).
eq(
  shouldRecordResourceSync(counts({ chapters_locked: 0, prune_locked: 0, tombstone_blocked: 1 })),
  false,
  "no locks at all but a blocked row → still withhold",
);
// Fail-safe presence, same rule as chapters_locked/prune_locked: a chunk result
// memoized by a Workflow instance that started before this change simply has no
// such field, and "not measured" must not read as "measured zero". Note both
// legacy fields are present here, so ONLY the new presence check can catch it.
eq(
  shouldRecordResourceSync({ chapters_locked: 0, prune_locked: 0 }),
  false,
  "legacy counts object missing conflict_skipped/tombstone_blocked → withhold (fail-safe, not zero-and-stamp)",
);
eq(
  shouldRecordResourceSync({ chapters_locked: 0, prune_locked: 0, conflict_skipped: 0 }),
  false,
  "counts object missing tombstone_blocked only → withhold (fail-safe)",
);
eq(
  shouldRecordResourceSync({ chapters_locked: 0, prune_locked: 0, tombstone_blocked: 0 }),
  false,
  "counts object missing conflict_skipped only → withhold (fail-safe)",
);
// The aggregation-laundering route (Finding 2, applied to the new fields):
// addCounts coerces an absent field to 0 to keep the running totals numeric, so
// by the time the gate sees perResource[resource] the absence is gone. The
// separate counts_incomplete taint is what survives that, and it must still
// withhold even though all four counters read present-and-zero.
eq(
  shouldRecordResourceSync(
    counts({ conflict_skipped: 0, tombstone_blocked: 0, counts_incomplete: true }),
  ),
  false,
  "aggregate laundered a legacy chunk's absent drop counters to zero → counts_incomplete still withholds",
);

// ── Issue #427, option 1: a landed reclaim does NOT withhold by itself ──────
// shouldRecordResourceSync's signature deliberately does not even mention
// tombstone_reclaimed — a landed reclaim means master's content IS now in D1,
// so there is nothing left to withhold for. Only the lost-CAS fallback (which
// still counts tombstone_blocked, exercised above) does. This is a shape test:
// the gate's decision must be identical whether or not tombstone_reclaimed is
// present, and a nonzero tombstone_reclaimed alongside a clean tombstone_blocked
// must still stamp.
eq(
  shouldRecordResourceSync(counts({ tombstone_reclaimed: 5, tombstone_blocked: 0 })),
  true,
  "a run that reclaimed 5 rows and blocked none still stamps the watermark",
);
eq(
  shouldRecordResourceSync(counts({ tombstone_reclaimed: 5, tombstone_blocked: 1 })),
  false,
  "reclaims do not offset a genuine block — a run with both still withholds",
);

console.log("\n[isSystemicMergeRefusal]");

// Below threshold: fine, don't withhold.
eq(
  isSystemicMergeRefusal(0),
  false,
  "0 refusals → not systemic",
);
eq(
  isSystemicMergeRefusal(SYSTEMIC_MERGE_REFUSAL_THRESHOLD - 1),
  false,
  "threshold - 1 refusals → not systemic",
);

// At threshold: systemic (>=, not >).
eq(
  isSystemicMergeRefusal(SYSTEMIC_MERGE_REFUSAL_THRESHOLD),
  true,
  "exactly the threshold's worth of refusals → systemic",
);

// Above threshold: systemic.
eq(
  isSystemicMergeRefusal(SYSTEMIC_MERGE_REFUSAL_THRESHOLD + 1),
  true,
  "threshold + 1 refusals → systemic",
);

// Default threshold is 5, per the fix spec.
eq(SYSTEMIC_MERGE_REFUSAL_THRESHOLD, 5, "default threshold is 5");

// A custom threshold is honored.
eq(isSystemicMergeRefusal(2, 3), false, "custom threshold: below it → not systemic");
eq(isSystemicMergeRefusal(3, 3), true, "custom threshold: at it → systemic");

console.log("\n[interaction: chapters_locked/prune_locked gate vs merge-refusal gate]");

// The two gates are independent and consulted together at the call site
// (bookReimport.ts's `reimport-sync-${book}` step): EITHER firing must
// withhold, regardless of the other.
eq(
  !shouldRecordResourceSync(counts()) || isSystemicMergeRefusal(0),
  false,
  "no lock held, no refusals → the combined decision does NOT withhold",
);
eq(
  !shouldRecordResourceSync(counts({ chapters_locked: 1 })) || isSystemicMergeRefusal(0),
  true,
  "existing lock-held gate fires even with zero refusals → withhold",
);
eq(
  !shouldRecordResourceSync(counts()) || isSystemicMergeRefusal(SYSTEMIC_MERGE_REFUSAL_THRESHOLD),
  true,
  "no lock held, but refusals are systemic → withhold",
);
eq(
  !shouldRecordResourceSync(counts({ chapters_locked: 1 })) || isSystemicMergeRefusal(SYSTEMIC_MERGE_REFUSAL_THRESHOLD),
  true,
  "both gates firing at once → still withhold (not double-negated into a stamp)",
);

console.log("\n[FIX H: isSystemicMergeRefusal override]");

// The override, when true, forces the gate open regardless of count.
eq(
  isSystemicMergeRefusal(SYSTEMIC_MERGE_REFUSAL_THRESHOLD + 10, undefined, true),
  false,
  "override true → never systemic, even far past threshold",
);
eq(
  isSystemicMergeRefusal(0, undefined, true),
  false,
  "override true with zero refusals → still not systemic (no-op override)",
);
// Absent/false override must never be coerced into a bypass.
eq(
  isSystemicMergeRefusal(SYSTEMIC_MERGE_REFUSAL_THRESHOLD),
  true,
  "no override arg at all → gate still fires at threshold",
);
eq(
  isSystemicMergeRefusal(SYSTEMIC_MERGE_REFUSAL_THRESHOLD, undefined, false),
  true,
  "override explicitly false → gate still fires at threshold",
);
// A custom threshold and an override compose (override wins).
eq(
  isSystemicMergeRefusal(3, 3, true),
  false,
  "override wins over a custom threshold too",
);

console.log("\n[FIX H: mergeRefusalOverrideAllowed]");

eq(
  mergeRefusalOverrideAllowed({ allowMergeRefusal: true, book: "1CH", resource: "ult" }, 1, 1, "ult"),
  true,
  "1CH ult: explicit single book + resource + allowMergeRefusal → override permitted",
);
eq(
  mergeRefusalOverrideAllowed({ allowMergeRefusal: true }, 66, 5, "ult"),
  false,
  "allowMergeRefusal with NO book/resource → refused (cannot blanket-disable the gate)",
);
eq(
  mergeRefusalOverrideAllowed({ allowMergeRefusal: true, resource: "ult" }, 66, 1, "ult"),
  false,
  "allowMergeRefusal + resource but no book → refused",
);
eq(
  mergeRefusalOverrideAllowed({ allowMergeRefusal: true, book: "1CH" }, 1, 5, "ult"),
  false,
  "allowMergeRefusal + book but no resource → refused (would cover every resource)",
);
eq(
  mergeRefusalOverrideAllowed({ allowMergeRefusal: true, book: "1CH", resource: "ult" }, 1, 1, "ust"),
  false,
  "override for a DIFFERENT resource than the one being checked → refused, never leaks across resources",
);
eq(
  mergeRefusalOverrideAllowed({ allowMergeRefusal: true, book: "1CH", resource: "ult" }, 2, 1, "ult"),
  false,
  "resolved book count > 1 → refused (widened resource/book must fail safe)",
);
eq(
  mergeRefusalOverrideAllowed({ book: "1CH", resource: "ult" }, 1, 1, "ult"),
  false,
  "no allowMergeRefusal flag → refused (override is strictly opt-in)",
);
eq(
  mergeRefusalOverrideAllowed({ allowMergeRefusal: false, book: "1CH", resource: "ult" }, 1, 1, "ult"),
  false,
  "allowMergeRefusal: false → refused",
);

console.log("\n[issue #473 option A: idBlockedOverride on shouldRecordResourceSync]");

// The override, when true, forces ONLY the conflict_skipped/tombstone_blocked
// half open — a tombstone_blocked-only run now stamps.
eq(
  shouldRecordResourceSync(counts({ tombstone_blocked: 6 }), true),
  true,
  "idBlockedOverride true → a tombstone_blocked-only run now stamps",
);
eq(
  shouldRecordResourceSync(counts({ conflict_skipped: 3 }), true),
  true,
  "idBlockedOverride true → a conflict_skipped-only run now stamps",
);
// The override must NOT touch chapters_locked/prune_locked — those are a
// different withhold reason (a lock held mid-run), not the id-collision this
// override exists to bypass.
eq(
  shouldRecordResourceSync(counts({ chapters_locked: 1, tombstone_blocked: 6 }), true),
  false,
  "idBlockedOverride true, but chapters_locked also nonzero → still withholds (override is scoped)",
);
eq(
  shouldRecordResourceSync(counts({ prune_locked: 1, conflict_skipped: 3 }), true),
  false,
  "idBlockedOverride true, but prune_locked also nonzero → still withholds (override is scoped)",
);
// Absent/false override must never be coerced into a bypass.
eq(
  shouldRecordResourceSync(counts({ tombstone_blocked: 6 })),
  false,
  "no override arg at all → gate still withholds on tombstone_blocked",
);
eq(
  shouldRecordResourceSync(counts({ tombstone_blocked: 6 }), false),
  false,
  "override explicitly false → gate still withholds",
);
// Fail-safe presence still applies even with the override set — a legacy/
// malformed counts object must still withhold regardless of the override.
eq(
  shouldRecordResourceSync({}, true),
  false,
  "idBlockedOverride true but counts object missing everything → still withholds (fail-safe)",
);
// A no-op override (nothing was actually blocked) changes nothing.
eq(
  shouldRecordResourceSync(counts(), true),
  true,
  "idBlockedOverride true with a clean run → still stamps (no-op override)",
);

console.log("\n[issue #473 option A: idBlockedOverrideAllowed]");

eq(
  idBlockedOverrideAllowed({ allowIdBlocked: true, book: "1CH", resource: "tq" }, 1, 1, "tq"),
  true,
  "1CH tq: explicit single book + resource + allowIdBlocked → override permitted",
);
eq(
  idBlockedOverrideAllowed({ allowIdBlocked: true }, 66, 5, "tq"),
  false,
  "allowIdBlocked with NO book/resource → refused (cannot blanket-disable the gate)",
);
eq(
  idBlockedOverrideAllowed({ allowIdBlocked: true, resource: "tq" }, 66, 1, "tq"),
  false,
  "allowIdBlocked + resource but no book → refused",
);
eq(
  idBlockedOverrideAllowed({ allowIdBlocked: true, book: "1CH" }, 1, 5, "tq"),
  false,
  "allowIdBlocked + book but no resource → refused (would cover every resource)",
);
eq(
  idBlockedOverrideAllowed({ allowIdBlocked: true, book: "1CH", resource: "tq" }, 1, 1, "twl"),
  false,
  "override for a DIFFERENT resource than the one being checked → refused, never leaks across resources",
);
eq(
  idBlockedOverrideAllowed({ allowIdBlocked: true, book: "1CH", resource: "tq" }, 2, 1, "tq"),
  false,
  "resolved book count > 1 → refused (widened resource/book must fail safe)",
);
eq(
  idBlockedOverrideAllowed({ book: "1CH", resource: "tq" }, 1, 1, "tq"),
  false,
  "no allowIdBlocked flag → refused (override is strictly opt-in)",
);
eq(
  idBlockedOverrideAllowed({ allowIdBlocked: false, book: "1CH", resource: "tq" }, 1, 1, "tq"),
  false,
  "allowIdBlocked: false → refused",
);

console.log("\n[isKeptOverDoor43AtScale]");

// The contrast with its sibling is the whole point: this one ALERTS and never
// withholds, so nothing here may end up wired into shouldRecordResourceSync.
eq(isKeptOverDoor43AtScale(0), false, "0 kept-over-Door43 rows → no alarm");
eq(
  isKeptOverDoor43AtScale(KEPT_OVER_DOOR43_ALERT_THRESHOLD - 1),
  false,
  "threshold - 1 → still the policy working normally",
);
eq(
  isKeptOverDoor43AtScale(KEPT_OVER_DOOR43_ALERT_THRESHOLD),
  true,
  "exactly the threshold → alarm (>=, not >), matching its sibling's boundary",
);
eq(isKeptOverDoor43AtScale(500), true, "far above the threshold → alarm");
eq(isKeptOverDoor43AtScale(3, 2), true, "an explicit threshold is honoured");
// And the property the alarm exists to preserve: keeping the app's version, at
// any scale, must never withhold the watermark — freezing the export would
// strand the very app edits the decision protected.
eq(
  shouldRecordResourceSync({
    chapters_locked: 0,
    prune_locked: 0,
    conflict_skipped: 0,
    tombstone_blocked: 0,
    merge_kept_ai: 999,
  }),
  true,
  "999 kept-over-Door43 rows still stamp the watermark — this outcome never withholds",
);

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
} else {
  console.log("\nAll shouldRecordResourceSync / isSystemicMergeRefusal checks passed.");
}
