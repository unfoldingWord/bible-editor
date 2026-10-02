// #1073: a verse save the server refused as chapter_locked is dropped from the
// outbox, but Shell had already folded its content into the chapter (and book)
// cache optimistically. Left there, the refused content reads as saved: the
// aligner's Reset goes back to it, a reopened aligner or verse shows it, and
// the next save diffs against it. Shell re-reads the chapter after the
// refusal and puts the server's row back; this decides how, per cache.
//
// Pure (no React, no IndexedDB) so the decision is unit-tested in
// refusedVerseRollback.test.mjs.

import type { VerseDto } from "./api";
import type { OpStatus } from "./outbox";

// Whether another save of the same verse will still drain on its own and so
// settle the cache itself: pending (including retrying in backoff) or in
// flight. A conflict waiting on the user, or a failed op, is terminal until a
// person acts, so it must not hold the rollback off forever.
export function siblingStillDraining(
  ops: ReadonlyArray<{ id: string; status: OpStatus; targetKey: string }>,
  refusedId: string,
  key: string,
): boolean {
  return ops.some(
    (o) => o.id !== refusedId && o.targetKey === key && (o.status === "pending" || o.status === "in_flight"),
  );
}

export type VerseRollback =
  // Nothing to put back: another save of the verse is still queued (its own
  // result settles the cache), the cache's row changed during the GET, the
  // server no longer has the row, or the cache holds a row newer than the one
  // just fetched.
  | { kind: "skip" }
  // The server's row is at the version the cache holds (the refused save never
  // bumped it), so only a forced apply replaces the refused content.
  | { kind: "force"; row: VerseDto }
  // The server moved on while the save waited: the version-gated apply is
  // enough and cannot regress a newer row.
  | { kind: "remote"; row: VerseDto };

export function planRefusedVerseRollback(args: {
  serverRow: VerseDto | undefined;
  // The cache's row when the refusal arrived, before the chapter GET.
  cachedBefore: VerseDto | undefined;
  // The cache's row now (after the GET), or undefined if this cache has no copy.
  cachedRow: VerseDto | undefined;
  // Whether the outbox still holds another op for the same verse target.
  stillQueuedForTarget: boolean;
}): VerseRollback {
  const { serverRow, cachedBefore, cachedRow, stillQueuedForTarget } = args;
  if (stillQueuedForTarget || !serverRow || !cachedRow) return { kind: "skip" };
  // The verse changed while the GET was in flight (saved or edited again):
  // that change is newer than the refusal, so leave it.
  if (
    !cachedBefore ||
    cachedRow.version !== cachedBefore.version ||
    cachedRow.content !== cachedBefore.content
  ) {
    return { kind: "skip" };
  }
  if (serverRow.version > cachedRow.version) return { kind: "remote", row: serverRow };
  if (serverRow.version === cachedRow.version) return { kind: "force", row: serverRow };
  return { kind: "skip" };
}
