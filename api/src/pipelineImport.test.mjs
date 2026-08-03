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

import {
  mayClaimImport,
  IMPORT_CLAIM_STALE_SECONDS,
  tnSweepScope,
  shouldTouchClaim,
  CLAIM_TOUCH_INTERVAL_SECONDS,
} from "./pipelineImportClaim.ts";

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

// --- The stale window is a lease bound for CRASH RECOVERY, not a promise that
//     it exceeds any real apply. DAN 11's apply ran ~12 minutes — longer than
//     IMPORT_CLAIM_STALE_SECONDS (600s) — so a long-but-alive apply is only
//     protected because it heartbeats its claim (see shouldTouchClaim below),
//     not because the window is bigger than any apply could be. ---
assert(
  IMPORT_CLAIM_STALE_SECONDS > 0,
  `stale window (${IMPORT_CLAIM_STALE_SECONDS}s) is a positive lease bound for crash recovery`,
);

// ── tnSweepScope: the DAN 11 regression ──────────────────────────────────
// A resumed apply only re-selects UNRESOLVED proposals. Scoping the TN delete
// sweep to those proposals' (chapter, verse) pairs (rather than to every verse
// the job ever proposed for) means a verse the FIRST pass already applied and
// resolved must NOT reappear in the sweep scope for the resumed pass.
{
  // DAN 11 tn, en_tn, 2026-08-03: first pass proposed/applied verses 1-31 (and
  // more), died before resolving verses 32-45; the resumed pass's unresolved
  // proposals are ONLY verses 32-45. The regression: a job-wide scope would
  // include 1-31 and delete the first pass's already-applied notes.
  const resumedUnresolved = [];
  for (let v = 32; v <= 45; v++) resumedUnresolved.push({ chapter: 11, verse: v });
  const scope = tnSweepScope(resumedUnresolved);
  const verses = new Set(scope.map((p) => `${p.chapter}/${p.verse}`));
  assert(
    scope.length === 14,
    "DAN 11 regression: resumed-pass scope has exactly the 14 unresolved verses",
  );
  for (let v = 1; v <= 31; v++) {
    assert(
      !verses.has(`11/${v}`),
      `DAN 11 regression: ch11 v${v} (first pass's already-applied verse) absent from resumed scope`,
    );
  }
  assert(verses.has("11/32") && verses.has("11/45"), "DAN 11 regression: unresolved verses present");
}

// --- dedupes multiple proposals sharing one verse ---
assert(
  tnSweepScope([
    { chapter: 3, verse: 5 },
    { chapter: 3, verse: 5 },
    { chapter: 3, verse: 5 },
  ]).length === 1,
  "tnSweepScope dedupes multiple proposals for the same verse",
);

// --- keeps (chapter, verse) pairs distinct across chapters ---
{
  const scope = tnSweepScope([{ chapter: 2, verse: 1 }]);
  assert(
    scope.length === 1 && scope[0].chapter === 2 && scope[0].verse === 1,
    "tnSweepScope: a proposal for ch2 v1 does not also put ch1 v1 in scope",
  );
}

// --- empty input → empty scope ---
assert(tnSweepScope([]).length === 0, "tnSweepScope([]) → empty scope");

// ── shouldTouchClaim: heartbeat rate limit ──────────────────────────────
assert(
  !shouldTouchClaim(NOW, NOW + CLAIM_TOUCH_INTERVAL_SECONDS - 1),
  "shouldTouchClaim: below the interval → false",
);
assert(
  shouldTouchClaim(NOW, NOW + CLAIM_TOUCH_INTERVAL_SECONDS),
  "shouldTouchClaim: exactly at the interval → true",
);
assert(
  shouldTouchClaim(NOW, NOW + CLAIM_TOUCH_INTERVAL_SECONDS + 1),
  "shouldTouchClaim: after the interval → true",
);
{
  // A long apply (DAN 11: ~12 minutes) gets its claim refreshed repeatedly,
  // not just once, as long as the caller re-checks each time it last touched.
  let lastTouchedAt = NOW;
  let touches = 0;
  for (let elapsed = 0; elapsed <= 12 * 60; elapsed += 5) {
    const now = NOW + elapsed;
    if (shouldTouchClaim(lastTouchedAt, now)) {
      touches += 1;
      lastTouchedAt = now;
    }
  }
  assert(
    touches >= 10,
    `shouldTouchClaim: a 12-minute apply refreshes its claim repeatedly (${touches} touches)`,
  );
}

console.log("pipelineImport (claim guard): all assertions passed");
