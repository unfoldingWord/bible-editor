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
//
// The same predicate protects the manual path: outbox.ts's retry() flips a
// max-attempts-failed op's status to "pending", which alone makes
// isMaxAttemptsBlocked stop applying to it. If retry() also gave it a fresh
// queuedAt (as it does for a plain fatal-refusal retry), it would sort
// behind any sibling that queued while it sat failed — that sibling would
// then drain first and, being `eligibleForVersionThread`, get threaded
// straight into this now-pending op, which would land cleanly on top of it.
// retry() avoids this by leaving queuedAt/seq untouched for that class of
// op, so plain FIFO order (not the `blocked` set) keeps it draining first,
// exactly as if it had never failed.

import { willRetryOnItsOwn } from "./refusalReason.ts";
import type { OpTarget, OutboxOp, OutboxResult } from "./outbox.ts";

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

// Whether drainPass should notify onOutboxResult listeners for this outcome.
// The persist block (the IndexedDB delete/put that finalizes the op) can
// itself throw; when it does, the catch re-arms the op as `pending` for the
// next pass, but drainPass used to call listeners with the original result
// regardless. For a `locked` result several listeners (Shell's pipeline
// toast, and drafts.ts's verse-base pin release) treat the result as a
// terminal exit — released state, dismissed UI — for an op that is in fact
// still queued and will retry (issue #570). `ok` still announces even on a
// persist failure: the server DID apply the change, so cache-updating
// listeners (useChapter/useBook/Shell) should adopt it regardless of
// whether the local delete of the now-redundant outbox entry succeeded.
export function shouldAnnounceResult(kind: OutboxResult["kind"], persisted: boolean): boolean {
  if (persisted) return true;
  return kind !== "locked";
}

/** The subset of an OutboxOp the drain's pick needs to read. */
export type PickOp = Pick<OutboxOp, "target" | "status" | "lastError" | "queuedAt" | "seq">;

// The drain's queue order: queuedAt, then seq as the same-millisecond
// tiebreak (listAll sorts by exactly this).
export function drainOrder(a: PickOp, b: PickOp): number {
  return a.queuedAt - b.queuedAt || (a.seq ?? 0) - (b.seq ?? 0);
}

// A verse op that has not settled yet: still queued (including one parked in
// retry backoff, which stays `pending`), on the wire, awaiting the user's
// conflict merge, or failed-but-will-revive. A fatally refused op is settled —
// nothing will ever re-send it.
function verseOpUnsettled(o: PickOp): boolean {
  return (
    o.status === "pending" ||
    o.status === "in_flight" ||
    o.status === "conflict" ||
    isMaxAttemptsBlocked(o)
  );
}

// Whether a verse save can reopen (delete) this lane's check server-side.
// Mirrors api/src/laneReopen.ts lanesToReopenOnVerseEdit: every verse save
// reopens 'text'; a ULT save also reopens 'tw' when a word changed (which the
// client cannot tell in advance, so any ULT op counts). tn/tq are never
// reopened by a verse save.
function verseSaveCanReopen(verse: OpTarget, lc: OpTarget): boolean {
  if (verse.kind !== "verse" || lc.kind !== "lane_check") return false;
  if (lc.lane === "text") return true;
  return lc.lane === "tw" && verse.bibleVersion === "ULT";
}

// #931: a verse PATCH reopens (deletes) some of the verse's lane checks
// server-side (api/src/verses.ts → reopenLaneChecks). A lane check and a verse
// op have different targetKeys, so per-target FIFO alone let a check queued
// right behind a verse save dispatch first whenever that save was parked
// (retry, 409, max-attempts) — and the late save then wiped the check. So a
// lane check waits (stays pending) while a verse op for the same
// book+chapter+verse that can reopen its lane (verseSaveCanReopen), queued
// EARLIER than it, is unsettled. Verse ops queued after the check don't hold
// it: an edit made after checking still reopens. A tn/tq check is never held,
// so a stuck verse save cannot freeze an unrelated checkbox.
export function laneCheckHeld(lc: PickOp, ops: PickOp[]): boolean {
  if (lc.target.kind !== "lane_check") return false;
  return ops.some(
    (o) =>
      o.target.kind === "verse" &&
      sameVerse(o.target, lc.target) &&
      verseSaveCanReopen(o.target, lc.target) &&
      drainOrder(o, lc) < 0 &&
      verseOpUnsettled(o),
  );
}

// Which op drainPass dispatches next, given this iteration's snapshot (sorted
// in drain order) and the targets this pass has already parked. A target with
// a conflicted or max-attempts-failed op is blocked (see isMaxAttemptsBlocked);
// a lane check behind an unsettled verse save is held (laneCheckHeld).
export function pickNextOp<T extends PickOp>(ops: T[], pinnedBlocked: ReadonlySet<string>): T | undefined {
  const blocked = new Set(pinnedBlocked);
  for (const o of ops) {
    if (o.status === "conflict" || isMaxAttemptsBlocked(o)) blocked.add(targetKey(o.target));
  }
  return ops.find(
    (o) => o.status === "pending" && !blocked.has(targetKey(o.target)) && !laneCheckHeld(o, ops),
  );
}

function sameVerse(a: OpTarget, b: OpTarget): boolean {
  return (
    a.kind !== "row" &&
    b.kind !== "row" &&
    a.book === b.book &&
    a.chapter === b.chapter &&
    a.verse === b.verse
  );
}

// resolveConflict re-arms a conflicted verse op (and its pending siblings) at
// the BACK of the queue. A lane check for the same verse that was queued
// behind it would then sort ahead of it and escape laneCheckHeld — and the
// re-armed verse PATCH, landing second, would reopen (delete) the check
// (#931). These are the pending lane checks resolveConflict must move to the
// back too, so they keep their place behind the verse save — only the lanes
// that save can reopen, the same rule laneCheckHeld uses.
export function laneChecksToKeepBehind<T extends PickOp>(conflicted: PickOp, all: T[]): T[] {
  if (conflicted.target.kind !== "verse") return [];
  return all
    .filter(
      (o) =>
        o.target.kind === "lane_check" &&
        o.status === "pending" &&
        sameVerse(o.target, conflicted.target) &&
        verseSaveCanReopen(conflicted.target, o.target) &&
        drainOrder(conflicted, o) < 0,
    )
    .sort(drainOrder);
}
