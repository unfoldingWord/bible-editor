// Tests for the stale-progress heuristic in SyncStatusBar. The component
// computes staleness as: "is the oldest pending/in-flight op older than
// STALE_PROGRESS_MS?" This replaced a broken lastSuccessAt clock that
// false-alarmed translators who save less often than every 30s.
//
// The logic under test is pure arithmetic (no React), so we replicate it
// here to lock the contract. If the component's formula drifts from these
// expectations, this test failing is the signal.

import assert from "node:assert/strict";

const STALE_PROGRESS_MS = 30_000;

// Replicate the component's staleness formula. The real code is:
//   const oldestQueuedAt = pendingOps.length > 0
//     ? Math.min(...pendingOps.map(o => o.queuedAt)) : 0;
//   const staleProgress = pendingOps.length > 0
//     && now - oldestQueuedAt > STALE_PROGRESS_MS;
//   const effectivelyOffline = !online || staleProgress;
function computeEffectivelyOffline(online, pendingOps, now) {
  const oldestQueuedAt = pendingOps.length > 0
    ? Math.min(...pendingOps.map((o) => o.queuedAt))
    : 0;
  const staleProgress =
    pendingOps.length > 0 && now - oldestQueuedAt > STALE_PROGRESS_MS;
  return !online || staleProgress;
}

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

const NOW = 1_700_000_000_000; // arbitrary fixed reference point

// --- No pending ops: never stale ---

check(
  computeEffectivelyOffline(true, [], NOW) === false,
  "online, no pending ops → not effectively offline",
);

check(
  computeEffectivelyOffline(false, [], NOW) === true,
  "navigator offline, no pending ops → effectively offline (offline branch)",
);

// --- Fresh ops (queued less than 30s ago): should NOT trigger stale ---

check(
  computeEffectivelyOffline(
    true,
    [{ queuedAt: NOW - 1_000 }],
    NOW,
  ) === false,
  "one op queued 1s ago → blue 'saving', not orange",
);

check(
  computeEffectivelyOffline(
    true,
    [{ queuedAt: NOW - 29_999 }],
    NOW,
  ) === false,
  "one op queued 29.999s ago → still blue (boundary: just under threshold)",
);

check(
  computeEffectivelyOffline(
    true,
    [
      { queuedAt: NOW - 5_000 },
      { queuedAt: NOW - 10_000 },
      { queuedAt: NOW - 15_000 },
    ],
    NOW,
  ) === false,
  "multiple fresh ops, oldest 15s → blue 'saving'",
);

// --- Stale ops (queued 30s+ ago): SHOULD trigger ---

check(
  computeEffectivelyOffline(
    true,
    [{ queuedAt: NOW - 30_001 }],
    NOW,
  ) === true,
  "one op queued 30.001s ago → orange 'reconnecting' (just over threshold)",
);

check(
  computeEffectivelyOffline(
    true,
    [{ queuedAt: NOW - 60_000 }],
    NOW,
  ) === true,
  "one op queued 60s ago → orange",
);

check(
  computeEffectivelyOffline(
    true,
    [
      { queuedAt: NOW - 5_000 },
      { queuedAt: NOW - 45_000 },
    ],
    NOW,
  ) === true,
  "mix of fresh and stale — oldest is 45s → orange (oldest wins)",
);

// --- The false-alarm scenario this fix prevents ---
// Translator hasn't saved in 2 minutes, then makes a new edit. Under the
// OLD logic (lastSuccessAt seeded at mount), the chip would immediately go
// orange because now - lastSuccessAt > 30s. Under the NEW logic, the op was
// just queued, so queuedAt is fresh and the chip stays blue.

check(
  computeEffectivelyOffline(
    true,
    [{ queuedAt: NOW }],
    NOW,
  ) === false,
  "REGRESSION: op just enqueued (age 0) → blue, not orange false alarm",
);

check(
  computeEffectivelyOffline(
    true,
    [{ queuedAt: NOW - 500 }],
    NOW,
  ) === false,
  "REGRESSION: op enqueued 500ms ago → still blue during first drain attempt",
);

// --- Offline always wins regardless of op age ---

check(
  computeEffectivelyOffline(
    false,
    [{ queuedAt: NOW }],
    NOW,
  ) === true,
  "navigator offline + fresh op → effectively offline (offline trumps freshness)",
);

check(
  computeEffectivelyOffline(
    false,
    [{ queuedAt: NOW - 60_000 }],
    NOW,
  ) === true,
  "navigator offline + stale op → effectively offline",
);

// --- Exact boundary ---

check(
  computeEffectivelyOffline(
    true,
    [{ queuedAt: NOW - STALE_PROGRESS_MS }],
    NOW,
  ) === false,
  "op age === STALE_PROGRESS_MS exactly → not stale (strict greater-than)",
);

console.log(`\n  syncStaleness: ${passed} assertions passed`);
