// Tests for the outbox's retry holds (issue #1249).
//
// The defect: a verse save whose request kept failing on auth after a
// successful silent refresh was retried with no backoff (~6 PATCH/s on
// agentbox, measured). The refresh fires onAuthRefreshed → reviveAndDrain →
// drain(). A pass is running, so drain() only sets drainRequested, and the
// re-pass loop starts a new drainPass right after the retry branch parked the
// op. That pass's pinnedBlocked set is new and empty, so pickNextOp picked the
// op again at once and the backoff the retry branch scheduled never applied.
//
// The fix: the retry branch records a hold per target that outlives the pass
// ({ opId, until, afterRefresh }). pickNextOp treats a held target as blocked
// until the hold expires. A refresh releases only holds whose failed attempt
// did NOT already run on a refreshed session (afterRefresh false). A retry
// that failed even after a refresh gains nothing from another refresh, and
// releasing it there would let any refresh (the alerts poll's, or the retry's
// own) restart the loop.

import assert from "node:assert/strict";
import { pickNextOp, targetKey } from "./outboxTargeting.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

const verseOp = (id, v, status, queuedAt, seq, extra = {}) => ({
  id,
  target: { kind: "verse", book: "ZEC", chapter: 1, verse: v, bibleVersion: "ULT" },
  action: "patch",
  patch: {},
  expectedVersion: 3,
  queuedAt,
  seq,
  attempts: 1,
  status,
  ...extra,
});
const key = (v) => targetKey({ kind: "verse", book: "ZEC", chapter: 1, verse: v, bibleVersion: "ULT" });
const NOW = 1_000_000;

// The loop from the issue: the op came back `pending` after an auth retry
// with a 30s backoff. The next pass has an empty pinnedBlocked set.
{
  const stuck = verseOp("a", 3, "pending", 100, 1, { lastError: "csrf_mismatch" });
  const holds = new Map([[key(3), { opId: "a", until: NOW + 30_000, afterRefresh: true }]]);
  check(
    pickNextOp([stuck], new Set(), holds, NOW) === undefined,
    "FIX (#1249): a new pass does not re-pick an op inside its retry backoff",
  );
  // FIFO: a younger op on the same verse waits behind the held one.
  const younger = verseOp("b", 3, "pending", 200, 2);
  check(
    pickNextOp([stuck, younger], new Set(), holds, NOW) === undefined,
    "FIX (#1249): a younger op on the held target waits too (FIFO)",
  );
  // An op on another verse is not held up.
  const other = verseOp("c", 4, "pending", 300, 3);
  check(
    pickNextOp([stuck, younger, other], new Set(), holds, NOW) === other,
    "an op on a different target drains during the hold",
  );
  // Once the backoff has elapsed the op is picked again.
  check(
    pickNextOp([stuck, other], new Set(), holds, NOW + 30_000) === stuck,
    "the held op is picked once its backoff has elapsed",
  );
  // A hold only applies while its own op is still pending. Once the user
  // discards it (or it lands), the next edit to the verse goes straight out.
  check(
    pickNextOp([younger], new Set(), holds, NOW) === younger,
    "a hold whose op is gone does not block the next edit to the verse",
  );
  // Without holds, behaviour is unchanged.
  check(pickNextOp([stuck], new Set()) === stuck, "no holds: the pending op is picked as before");
}

// The helpers. Imported dynamically so the pick checks above report as plain
// assertion failures on a tree without the fix.
const { activeRetryHoldWakeAt, releaseRetryHoldsOnRefresh } = await import("./outboxTargeting.ts");
{
  const stuck = verseOp("a", 3, "pending", 100, 1);
  const other = verseOp("c", 4, "pending", 300, 3);
  const holds = new Map([
    [key(3), { opId: "a", until: NOW + 30_000, afterRefresh: true }],
    [key(4), { opId: "c", until: NOW + 5_000, afterRefresh: false }],
    [key(5), { opId: "gone", until: NOW + 1_000, afterRefresh: false }],
  ]);
  check(
    activeRetryHoldWakeAt([stuck, other], holds, NOW) === NOW + 5_000,
    "wake time is the earliest hold whose op is still pending",
  );
  check(
    activeRetryHoldWakeAt([stuck, other], holds, NOW + 30_000) === undefined,
    "no wake time once every hold has expired",
  );
  releaseRetryHoldsOnRefresh(holds);
  check(
    holds.has(key(3)) && !holds.has(key(4)) && !holds.has(key(5)),
    "FIX (#1249): a refresh releases only holds whose attempt did not already run on a refreshed session",
  );
  check(
    pickNextOp([stuck, other], new Set(), holds, NOW) === other,
    "after the refresh, the released op drains at once and the refresh-proof one stays held",
  );
}

console.log(`\nretryHolds: ${passed} checks passed`);
