// Pure FIFO-ordering rules for the outbox drain: which ops share a target,
// and which of them are allowed to block their target or receive a freshly
// confirmed version. Split out of outbox.ts so these can be unit-tested
// directly (outboxTargeting.test.mjs) without needing IndexedDB or api.ts —
// api.ts's ApiError uses a TS parameter-property constructor that Node's
// `--experimental-strip-types` loader cannot erase, so outbox.ts itself can
// never be `import()`ed from a plain Node test script.
//
// See issue #487: a `failed` op that will auto-revive (max-attempts
// sentinel) did not block its target, so a younger sibling op for the same
// row/verse could land first; threadVersionToSiblings then handed the
// stale failed op the fresh version, so reviveMaxAttemptsFailed (focus /
// online / auth-refresh) re-armed it with a clean If-Match and silently
// reverted the newer, already-landed content. The two predicates below are
// the fix: block on it (isMaxAttemptsBlocked) and exclude it from silent
// version-threading (eligibleForVersionThread) so it re-arms through the
// normal 409/autoheal path instead, where classifyRowPatchConflict can tell
// a genuine conflict from a spurious one.

import { willRetryOnItsOwn } from "./refusalReason.ts";
import type { OpTarget, OutboxOp } from "./outbox.ts";

// Two ops belong to the same target iff they touch the same row/verse. A
// conflict on one of them must not block ops to *other* targets — but it
// must keep blocking siblings, since the user's expectedVersion is stale
// for them too.
export function targetKey(t: OpTarget): string {
  if (t.kind === "row") return `row:${t.rowKind}:${t.book}:${t.id}`;
  if (t.kind === "verse_status") return `vstatus:${t.book}:${t.chapter}:${t.verse}`;
  if (t.kind === "lane_check") return `lanecheck:${t.book}:${t.chapter}:${t.verse}:${t.lane}`;
  return `verse:${t.book}:${t.chapter}:${t.verse}:${t.bibleVersion}`;
}

/** The subset of an OutboxOp these predicates actually need to read. */
export type TargetingOp = Pick<OutboxOp, "status" | "lastError">;

// A `failed` op whose lastError is the max-attempts sentinel WILL auto-revive
// (reviveMaxAttemptsFailed, triggered by focus/online/authRefresh) and
// re-dispatch with its **original, possibly stale** expectedVersion. Until
// then it must block its target the same way an unresolved `conflict` does —
// otherwise a younger sibling op for the same row/verse can leapfrog it,
// land first, and then this op auto-revives on top of that newer content
// with a clean If-Match and silently reverts it (issue #487). Fatal
// (non-revivable) refusals never auto-revive, so they must NOT block — that
// would freeze the target on an op nothing will ever re-send.
export function isMaxAttemptsBlocked(o: TargetingOp): boolean {
  return o.status === "failed" && willRetryOnItsOwn(o.lastError);
}

// Which pending/failed siblings are safe to hand a freshly-confirmed version
// to in threadVersionToSiblings. A max-attempts-failed op is EXCLUDED: handing
// it the fresh version is exactly the bug in issue #487 — it lets a stale,
// already-superseded patch re-arm with a clean If-Match on revival instead of
// re-arming through the normal 409/autoheal path, where classifyRowPatchConflict
// can tell a genuine conflict from a safe one. It stays on its original
// (blocked, per isMaxAttemptsBlocked) expectedVersion until it revives and
// finds out for itself. Fatal failed ops keep being threaded as before — they
// never auto-revive, so this carve-out doesn't apply, and threading keeps a
// user-initiated Retry from failing on a version that's needlessly stale.
export function eligibleForVersionThread(o: TargetingOp): boolean {
  if (o.status === "pending") return true;
  if (o.status === "failed") return !willRetryOnItsOwn(o.lastError);
  return false;
}
