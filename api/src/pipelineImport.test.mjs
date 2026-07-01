// Unit tests for the pipeline import single-applier claim (pipelineImport.ts).
// The regression the ISA 48 incident demands: two pollers (the */5 cron and a
// translator's open tab polling GET /api/pipelines/:jobId) must never both run
// the destructive delete/insert apply for one job — their chapter-scoped TN
// deletes interleaved and wiped/doubled the chapter (2026-06-30). The
// production guard is one atomic CAS UPDATE; mayClaimImport is its predicate,
// tested here so the concurrency rule can't silently regress.
// Run from api/:
//   node --experimental-strip-types --no-warnings src/pipelineImport.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { mayClaimImport, IMPORT_CLAIM_STALE_SECONDS } from "./pipelineImportClaim.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const NOW = 1_000_000;

// --- Unclaimed slot: the first poller may take it ---
assert(mayClaimImport(null, NOW), "unclaimed (NULL) → may claim");

// --- The race: once a poller claims, a concurrent racer must NOT re-claim ---
// Model the atomic CAS: poller A wins and stamps import_claimed_at = NOW.
// Poller B, which read the same pre-apply state, now re-evaluates against the
// stamped value and must be refused.
const afterA = NOW; // A's claim timestamp
assert(
  !mayClaimImport(afterA, NOW),
  "fresh claim by a concurrent poller → refused (no interleaving second apply)",
);
assert(
  !mayClaimImport(afterA, NOW + 1),
  "claim 1s old → still refused",
);
assert(
  !mayClaimImport(afterA, NOW + IMPORT_CLAIM_STALE_SECONDS),
  "claim exactly at the stale window → still held (strictly-less-than)",
);

// --- Crash recovery: a claim left dangling by a hard Worker death (no JS
//     throw to release it) becomes reclaimable once older than the window ---
assert(
  mayClaimImport(afterA, NOW + IMPORT_CLAIM_STALE_SECONDS + 1),
  "claim older than the stale window → reclaimable (crash recovery)",
);

// --- Release path: a failed apply sets import_claimed_at back to NULL, so the
//     one-retry poll can immediately re-import ---
assert(
  mayClaimImport(null, NOW + 5),
  "released claim (NULL) → immediately reclaimable for the retry",
);

// --- The stale window must comfortably exceed a real apply (~1 min) so a
//     still-running apply is never reclaimed out from under itself ---
assert(
  IMPORT_CLAIM_STALE_SECONDS >= 300,
  `stale window (${IMPORT_CLAIM_STALE_SECONDS}s) is well beyond a real apply`,
);

console.log("pipelineImport (claim guard): all assertions passed");
