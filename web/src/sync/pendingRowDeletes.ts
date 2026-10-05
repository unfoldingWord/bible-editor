// #1107: a tq/twl row DELETE hides its row before the outbox sends it. A
// chapter GET that lands before that DELETE commits still holds the row, and
// the landed payload put it back on screen; editing it then PATCHed a deleted
// id. The sequencer's replay queue (chapterFetchSequencer.ts, #974 / #989)
// only covers a delete made while a merging GET was already pending. A delete
// made with none pending (offline, then the reconnect GET races the drain) left
// no step to replay, so the row came back until the DELETE committed.
//
// So every chapter GET useChapter issues reads the outbox before it starts and
// again after the response arrives, and drops the rows whose own DELETE is
// draining (hidingPendingRowDeletes says why both reads):
// pending (including retrying in backoff) or in flight, the same "still
// draining" rule as siblingStillDraining. A DELETE refused or discarded
// (#1108, which restores the row) hides nothing once it is gone, a DELETE
// that left the outbox before the GET started hides nothing, and one waiting
// on the user (conflict, failed) at both reads shows the server's row.
//
// Pure apart from the injected outbox reads, so it is unit-tested in
// pendingRowDeletes.test.mjs (outbox.ts itself cannot be imported in Node).

import type { ChapterPayload } from "./api";
import type { OutboxOp } from "./outbox";
import type { ChapterLoader } from "../hooks/chapterFetchSequencer";

type OpLike = Pick<OutboxOp, "id" | "target" | "action" | "status">;

// The payload without the rows whose DELETE is still draining for its book;
// the payload itself when there are none.
export function hidePendingRowDeletes<P extends Pick<ChapterPayload, "book" | "tn" | "tq" | "twl">>(
  payload: P,
  ops: readonly OpLike[],
): P {
  let out: P | undefined;
  for (const op of ops) {
    const t = op.target;
    if (t.kind !== "row" || op.action !== "delete" || t.book !== payload.book) continue;
    if (op.status !== "pending" && op.status !== "in_flight") continue;
    const list = (out ?? payload)[t.rowKind] as ReadonlyArray<{ id: string }>;
    if (!list.some((r) => r.id === t.id)) continue;
    out = { ...(out ?? payload), [t.rowKind]: list.filter((r) => r.id !== t.id) };
  }
  return out ?? payload;
}

// Wrap a chapter loader so its payload is filtered by the row DELETEs that
// were draining when the GET started OR are still draining when it resolved.
//
// - After: a DELETE still queued or in flight once the response is here.
// - Before: a DELETE draining at GET start can commit while the (larger)
//   chapter body is still downloading. Its op is then gone by the after-read,
//   but the snapshot may predate the commit, and a plain refetch replaces the
//   cache wholesale, so the `row.deleted` broadcast that arrived first would
//   be undone. A committed delete stays hidden, which is right.
// - Except abandoned ones: a DELETE refused as chapter_locked or discarded
//   during the window (`onAbandoned`, the same two triggers as Shell's #1108
//   rollback) is dropped from the before-set. That rollback re-reads the
//   chapter with its own GET and restores the row; if that GET beat this one,
//   hiding the row here would undo the restore. A refusal announced after the
//   after-read is safe: this payload lands a few microtasks later, long
//   before the rollback's own GET returns, and the rollback then restores
//   over it.
//
// Any failure here (an outbox read, the subscription, or a malformed persisted
// op tripping the filter) lands the snapshot unchanged: an outbox problem must
// never turn a good GET into the chapter's error screen.
export function hidingPendingRowDeletes<P extends Pick<ChapterPayload, "book" | "tn" | "tq" | "twl">>(
  load: ChapterLoader<P>,
  listOps: () => Promise<readonly OpLike[]>,
  onAbandoned?: (fn: (op: Pick<OutboxOp, "id">) => void) => () => void,
): ChapterLoader<P> {
  const warn = (e: unknown) =>
    console.warn("pendingRowDeletes: could not apply pending row deletes; showing the snapshot unchanged", e);
  return async (signal, onAttempt) => {
    const abandoned = new Set<string>();
    let stop = () => {};
    let before: readonly OpLike[] | null = null;
    try {
      stop = onAbandoned?.((op) => abandoned.add(op.id)) ?? stop;
      before = await listOps();
    } catch (e) {
      warn(e);
    }
    try {
      const payload = await load(signal, onAttempt);
      if (!before) return payload;
      try {
        const after = await listOps();
        const kept = before.filter((op) => !abandoned.has(op.id));
        return hidePendingRowDeletes(payload, [...kept, ...after]);
      } catch (e) {
        warn(e);
        return payload;
      }
    } finally {
      try {
        stop();
      } catch {
        /* nothing left to undo */
      }
    }
  };
}
