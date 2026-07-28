// Unit tests for shrinkGuard.ts — the truncated-fetch completeness policy.
// The regression the HAB tn incident demands: a single-row (or near-empty)
// incoming TSV must never be allowed to prune an existing multi-row book.
// Run from api/:
//   node --experimental-strip-types --no-warnings src/shrinkGuard.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import {
  isCatastrophicTsvShrink,
  shrinkOverrideAllowed,
  SHRINK_GUARD_MIN_LIVE,
  SHRINK_GUARD_RATIO,
} from "./shrinkGuard.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// --- The HAB incident itself: 252 live, a 1-row truncated body ---
assert(
  isCatastrophicTsvShrink(252, 1),
  "HAB tn: 1-row body vs 252 live → catastrophic (would have blocked the prune)",
);
assert(
  isCatastrophicTsvShrink(252, 0),
  "0-row body vs 252 live → also flagged (defense in depth; softDelete also bails on 0)",
);

// --- A genuine large book that barely changed must NOT trip the guard ---
assert(
  !isCatastrophicTsvShrink(252, 252),
  "no change (252 vs 252) → not a shrink",
);
assert(
  !isCatastrophicTsvShrink(252, 250),
  "tiny edit (250 vs 252) → not a shrink",
);
assert(
  !isCatastrophicTsvShrink(252, 200),
  "moderate trim (200 vs 252, ~79%) → not catastrophic, applies normally",
);

// --- The 50% boundary ---
assert(
  !isCatastrophicTsvShrink(100, 50),
  "exactly 50% (50 vs 100) → not flagged (strictly-less-than ratio)",
);
assert(
  isCatastrophicTsvShrink(100, 49),
  "just under 50% (49 vs 100) → flagged",
);
assert(
  isCatastrophicTsvShrink(100, 40),
  "40 vs 100 → flagged",
);

// --- Small books are exempt: the guard only protects sizeable books, so a
//     legitimate big proportional swing on a tiny book never false-positives ---
assert(
  !isCatastrophicTsvShrink(SHRINK_GUARD_MIN_LIVE - 1, 1),
  `below MIN_LIVE (${SHRINK_GUARD_MIN_LIVE - 1} live) → exempt even with a 1-row body`,
);
assert(
  !isCatastrophicTsvShrink(5, 2),
  "tiny book (2 vs 5) → exempt (no guard for books with <MIN_LIVE rows)",
);
assert(
  isCatastrophicTsvShrink(SHRINK_GUARD_MIN_LIVE, 1),
  `at MIN_LIVE (${SHRINK_GUARD_MIN_LIVE} live) → guard engages; 1-row body flagged`,
);

// --- A growing book is never a shrink ---
assert(
  !isCatastrophicTsvShrink(100, 300),
  "book grew (300 vs 100) → not a shrink",
);

// Sanity: the policy constants are the documented values.
assert(SHRINK_GUARD_MIN_LIVE === 20, "MIN_LIVE is 20");
assert(SHRINK_GUARD_RATIO === 0.5, "RATIO is 0.5");


// --- Export shrink-guard override gating (shrinkOverrideAllowed) ------------
// The 1CH tq incident (2026-07-28): 55 tq rows deleted by hand blocked the
// nightly export as shrink_55_of_426, alerting "truncated fetch" for what was a
// verified-intentional deletion. The override exists for that; these assertions
// pin the property that keeps it from reopening the twl_PSA clobber hole —
// a run that does not name exactly one book AND one resource cannot use it.

assert(
  shrinkOverrideAllowed({ allowShrink: true, book: "1CH", resource: "tq" }, 1, 1) === true,
  "1CH tq: explicit single book + resource + allowShrink → override permitted",
);

// The nightly cron: params are { validateAndMerge: true } over every book.
assert(
  shrinkOverrideAllowed({ validateAndMerge: true }, 66, 5) === false,
  "nightly cron (no book, no resource) → override refused",
);
assert(
  shrinkOverrideAllowed({ allowShrink: true }, 66, 5) === false,
  "allowShrink with NO book/resource → refused (cannot blanket-disable the guard)",
);
assert(
  shrinkOverrideAllowed({ allowShrink: true, resource: "tq" }, 66, 1) === false,
  "allowShrink + resource but no book → refused",
);
assert(
  shrinkOverrideAllowed({ allowShrink: true, book: "1CH" }, 1, 5) === false,
  "allowShrink + book but no resource → refused (would cover all 5 resources)",
);
// Defense in depth: book named but the resolved list isn't exactly one book.
// book_imports returning 0 rows means the named book isn't imported at all.
assert(
  shrinkOverrideAllowed({ allowShrink: true, book: "1CH", resource: "tq" }, 0, 1) === false,
  "named book resolves to 0 imported books → refused",
);
assert(
  shrinkOverrideAllowed({ allowShrink: true, book: "1CH", resource: "tq" }, 2, 1) === false,
  "resolved book list wider than 1 → refused",
);
// Absent / falsy allowShrink must never be coerced into a yes.
assert(
  shrinkOverrideAllowed({ book: "1CH", resource: "tq" }, 1, 1) === false,
  "no allowShrink flag → guard stays on (override is strictly opt-in)",
);
assert(
  shrinkOverrideAllowed({ allowShrink: false, book: "1CH", resource: "tq" }, 1, 1) === false,
  "allowShrink: false → guard stays on",
);

// The defect a cold review caught (2026-07-28): the gate originally checked
// params.resource for TRUTHINESS while exportWorkflow widens an unrecognized
// resource to ALL_RESOURCES. resource:"tqq" is truthy but selects five
// resources, so the override would have covered tn/tq/twl at once and could
// have shipped a genuinely truncated tn to master. Reachable via
// `wrangler workflows trigger` with raw params JSON, which bypasses the
// route's zod enum. Both counts must be the RESOLVED list lengths.
assert(
  shrinkOverrideAllowed({ allowShrink: true, book: "1CH", resource: "tqq" }, 1, 5) === false,
  "typo'd resource widened to ALL_RESOURCES (5) → refused, not handed the override",
);
assert(
  shrinkOverrideAllowed({ allowShrink: true, book: "1CH", resource: "tq" }, 1, 5) === false,
  "resolved resource count > 1 → refused regardless of a valid-looking resource string",
);
assert(
  shrinkOverrideAllowed({ allowShrink: true, book: "1CH", resource: "tq" }, 1, 0) === false,
  "no resources resolved → refused",
);

console.log("shrinkGuard: all assertions passed");
