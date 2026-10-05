// #1108: a tq/twl row DELETE hides the row from the chapter cache before the
// outbox sends it. When the server refuses it (409 chapter_locked, which drops
// the op) or the user discards the op, no 200 ever follows, so the row stayed
// hidden although the server still has it, until some later refetch happened
// to bring it back. Shell re-reads the chapter and puts the server's row back;
// this decides whether and where.
//
// Only DELETEs: a refused tn PATCH is already shown as unsaved by NoteCard
// (its baseline is pinned to the server version) and kept in its draft, and
// putting the server's text back into the cached row would make an idle card
// re-sync to it and clear that draft.
//
// Pure (no React, no IndexedDB) so the decision is unit-tested in
// refusedRowRollback.test.mjs.

export type RowDeleteRollback<R> =
  // Nothing to put back: another DELETE of the row is still draining (its own
  // result settles the cache), the server no longer has the row (deleted
  // elsewhere, or it is not in the chapter on screen), or the cache already
  // has it again.
  | { kind: "skip" }
  // Re-insert the server's row, after `afterId` (the nearest row before it in
  // the server's order that the cache still holds), or at the end.
  | { kind: "restore"; row: R; afterId?: string };

export function planRefusedRowDeleteRollback<R extends { id: string }>(args: {
  id: string;
  // The server's rows of the op's kind for the chapter on screen.
  serverRows: readonly R[] | undefined;
  // The cache's rows of that kind now, or undefined if it holds no copy.
  cachedRows: readonly R[] | undefined;
  // Whether the outbox still holds another pending or in-flight DELETE of it.
  stillQueuedForTarget: boolean;
}): RowDeleteRollback<R> {
  const { id, serverRows, cachedRows, stillQueuedForTarget } = args;
  if (stillQueuedForTarget || !serverRows || !cachedRows) return { kind: "skip" };
  if (cachedRows.some((r) => r.id === id)) return { kind: "skip" };
  const idx = serverRows.findIndex((r) => r.id === id);
  if (idx < 0) return { kind: "skip" };
  const present = new Set(cachedRows.map((r) => r.id));
  let afterId: string | undefined;
  for (let i = idx - 1; i >= 0; i--) {
    if (present.has(serverRows[i].id)) {
      afterId = serverRows[i].id;
      break;
    }
  }
  return { kind: "restore", row: serverRows[idx], afterId };
}
