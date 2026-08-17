// Tests for web/src/sync/outboxTargeting.ts — the FIFO-ordering rules that
// fix issue #487 ("Outbox FIFO inversion: a max-attempts-failed op can be
// auto-revived and silently overwrite a newer landed edit on the same
// target").
//
// The defect: a `failed` op did not block its target, so a younger sibling
// op for the same row/verse could leapfrog it and land first.
// threadVersionToSiblings then handed the stale failed op the fresh
// confirmed version, so when reviveMaxAttemptsFailed re-armed it (on focus /
// online / auth-refresh) the OLDER patch landed with a clean If-Match — no
// 409, no autoheal check — silently reverting the newer content. Both ops
// reported "ok"; nothing surfaced to the user.
//
// This module can't be exercised end-to-end without a browser (IndexedDB,
// window focus/online events), so these tests construct the exact op
// snapshots drainPass and threadVersionToSiblings would see at each step of
// the failure scenario from the issue, and assert the two predicates that
// fix it: isMaxAttemptsBlocked (drainPass's `blocked` set) and
// eligibleForVersionThread (threadVersionToSiblings's sibling filter).

import assert from "node:assert/strict";
import { MAX_ATTEMPTS_SENTINEL } from "./refusalReason.ts";
import {
  eligibleForVersionThread,
  isMaxAttemptsBlocked,
  targetKey,
} from "./outboxTargeting.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

const noteTarget = { kind: "row", rowKind: "tn", id: "note-1", book: "ZEC" };

// --- The issue #487 timeline, as the ops would look in the store ---
//
// 1. Edit "A" to a note exhausts MAX_ATTEMPTS during a server outage.
const op1FailedA = {
  id: "op1",
  target: noteTarget,
  action: "patch",
  patch: { note: "A" },
  expectedVersion: 5,
  queuedAt: 1000,
  attempts: 20,
  hardAttempts: 20,
  status: "failed",
  lastError: MAX_ATTEMPTS_SENTINEL,
};
// 2. The user edits the note again, to "AB" — a younger, still-pending op
//    for the SAME target queues up behind the failed one.
const op2PendingAB = {
  id: "op2",
  target: noteTarget,
  action: "patch",
  patch: { note: "AB" },
  expectedVersion: 5,
  queuedAt: 2000,
  attempts: 0,
  status: "pending",
};

// --- isMaxAttemptsBlocked: drainPass's `blocked` set ---
//
// This is the leapfrog fix itself. Before #487, only `status === "conflict"`
// blocked a target — a max-attempts-failed op did not, so op2 was free to
// drain and land while op1 sat there waiting to auto-revive. Blocking on it
// keeps the two ops in their original FIFO order: op1 must resolve (revive,
// dispatch, and either land or genuinely 409) before op2 is ever picked up.

check(
  isMaxAttemptsBlocked(op1FailedA) === true,
  "REGRESSION (#487): a max-attempts-failed op blocks its target, so a younger sibling can't leapfrog it",
);
check(
  isMaxAttemptsBlocked(op2PendingAB) === false,
  "a pending op never blocks on its own account",
);

// A fatal (non-revivable) refusal must NOT block — nothing will ever re-send
// it, so blocking on it would freeze the target forever.
const op1FatalRefusal = { ...op1FailedA, lastError: "http 400" };
check(
  isMaxAttemptsBlocked(op1FatalRefusal) === false,
  "a fatal (non-revivable) refusal does not block — it never auto-revives",
);

// A legacy record with no lastError classifies the same way
// willRetryOnItsOwn does elsewhere: undefined -> not the sentinel -> refusal,
// not a blocker.
check(
  isMaxAttemptsBlocked({ status: "failed", lastError: undefined }) === false,
  "a legacy failed record with no lastError does not block (matches willRetryOnItsOwn)",
);

// Conflict-status ops are handled by drainPass's own `status === "conflict"`
// check, not this predicate — confirm this predicate stays narrowly scoped
// to the max-attempts class so the two checks don't overlap confusingly.
check(
  isMaxAttemptsBlocked({ status: "conflict", lastError: "version_mismatch" }) === false,
  "a conflict-status op is out of scope for this predicate (drainPass ORs it in separately)",
);

// --- eligibleForVersionThread: threadVersionToSiblings's sibling filter ---
//
// Defense in depth for the same bug: even if a max-attempts-failed op's
// target were ever picked up as a sibling of a just-landed op (e.g. a stale
// snapshot, a future refactor), it must not be handed the fresh version. It
// has to stay on ITS OWN expectedVersion so that when it revives, it
// re-arms through the normal 409/autoheal path — where classifyRowPatchConflict
// can tell a genuine conflict (op2 already changed this field) from a
// spurious one — instead of silently overwriting op2's landed "AB" with its
// own stale "A".

check(
  eligibleForVersionThread(op1FailedA) === false,
  "REGRESSION (#487): a max-attempts-failed op is excluded from silent version-threading",
);
check(
  eligibleForVersionThread(op2PendingAB) === true,
  "a pending sibling is still threaded the fresh version, as before",
);

// Fatal failed ops keep the pre-#487 behaviour: they're still threaded, so a
// user-initiated Retry (which does not reset expectedVersion) doesn't fail
// on a version that's needlessly stale.
check(
  eligibleForVersionThread(op1FatalRefusal) === true,
  "a fatal (non-revivable) failed op is still threaded — only the auto-revive class is excluded",
);

// in_flight / conflict ops are never threading candidates — conflict is
// owned by the user-resolve flow (resolveConflict overwrites expectedVersion
// itself), and in_flight means a request is already on the wire.
check(
  eligibleForVersionThread({ status: "conflict", lastError: "version_mismatch" }) === false,
  "a conflict-status op is not a threading candidate",
);
check(
  eligibleForVersionThread({ status: "in_flight", lastError: undefined }) === false,
  "an in_flight op is not a threading candidate",
);

// --- End-to-end shape of the fix, replaying drainPass's own logic ---
//
// This mirrors exactly what drainPass computes over a `listAll()` snapshot,
// and what threadVersionToSiblings computes over the same store: given the
// two-op timeline above, confirm the blocked set contains op1's target (so
// op2 cannot drain ahead of it) and that threading a fresh version — as if
// op1 had somehow landed first — would skip op1's stale sibling but still
// reach a genuinely-pending one.

const ops = [op1FailedA, op2PendingAB];
const blocked = new Set();
for (const o of ops) {
  if (o.status === "conflict" || isMaxAttemptsBlocked(o)) blocked.add(targetKey(o.target));
}
check(
  blocked.has(targetKey(noteTarget)),
  "the shared target is blocked while op1 sits failed with the max-attempts sentinel",
);
const nextPending = ops.find((o) => o.status === "pending" && !blocked.has(targetKey(o.target)));
check(
  nextPending === undefined,
  "REGRESSION (#487): op2 is NOT picked up for dispatch while op1 blocks the target — no leapfrog",
);

const threadCandidates = ops.filter(
  (o) => targetKey(o.target) === targetKey(noteTarget) && eligibleForVersionThread(o),
);
check(
  threadCandidates.length === 1 && threadCandidates[0].id === "op2",
  "only the pending sibling (op2) would receive a threaded version — op1 keeps its own",
);

console.log(`\noutboxTargeting: ${passed} checks passed`);
