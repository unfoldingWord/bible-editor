// #1108: a tq/twl row DELETE hides the row from the chapter cache before the
// outbox sends it. When the server refuses it (409 chapter_locked, which drops
// the op) or the user discards the op, no 200 ever follows, so the row stayed
// hidden although the server still has it, until some later refetch happened
// to bring it back. Shell re-reads the chapter and puts the server's row back;
// this decides whether and where.
//
// tn PATCHes are left alone: a refused one is already shown as unsaved by
// NoteCard (its baseline is pinned to the server version) and kept in its
// draft, and putting the server's text back into the cached row would make an
// idle card re-sync to it and clear that draft. tq/twl PATCHes do get their
// fields put back (#1115, planRefusedRowPatchRollback below): their rows
// compare against a pin (rowEditPin.ts) and keep their typing when the cache
// changes under it, and a cache left holding refused text would show it as
// saved after a remount.
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

// #1115: a refused or discarded tq/twl PATCH left its optimistic text in the
// cached row. Put the server's values of the patched fields back, unless
// another PATCH of the row is still draining (its own result settles the
// cache), either copy of the row is missing, or the cached row's version
// changed since the re-read started (`versionAtStart`: a newer save or a
// server push landed meanwhile and already settled it). The optimistic
// restored_from_version mark of a history restore goes back too, and so do the
// server's version and updated_at when the server has moved on, so the next
// Save does not 409 for nothing. Null means nothing to do.
export function planRefusedRowPatchRollback(args: {
  patch: Record<string, unknown>;
  serverRow: Record<string, unknown> | undefined;
  cachedRow: Record<string, unknown> | undefined;
  stillQueuedForTarget: boolean;
  versionAtStart?: unknown;
}): Record<string, unknown> | null {
  const { patch, serverRow, cachedRow, stillQueuedForTarget, versionAtStart } = args;
  if (stillQueuedForTarget || !serverRow || !cachedRow) return null;
  if (versionAtStart !== undefined && cachedRow.version !== versionAtStart) return null;
  const out: Record<string, unknown> = {};
  for (const k of [...Object.keys(patch), "restored_from_version", "version", "updated_at"]) {
    if (k in serverRow && cachedRow[k] !== serverRow[k]) out[k] = serverRow[k];
  }
  return Object.keys(out).length > 0 ? out : null;
}
