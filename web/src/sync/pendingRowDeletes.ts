// #1107: a tq/twl row DELETE hides its row before the outbox sends it. A
// chapter GET that lands before that DELETE commits still holds the row, and
// the landed payload put it back on screen; editing it then PATCHed a deleted
// id. The sequencer's replay queue (chapterFetchSequencer.ts, #974 / #989)
// only covers a delete made while a merging GET was already pending. A delete
// made with none pending (offline, then the reconnect GET races the drain) left
// no step to replay, so the row came back until the DELETE committed.
//
// So every chapter GET useChapter issues re-reads the outbox after the
// response arrives and drops the rows whose own DELETE is still draining:
// pending (including retrying in backoff) or in flight, the same "still
// draining" rule as siblingStillDraining. A DELETE that is gone (committed,
// refused, discarded) hides nothing, so #1108's restore of a refused or
// discarded delete is never undone here, and a DELETE waiting on the user
// (conflict, failed) shows the server's row, as before.
//
// Pure apart from the injected `listOps`, so it is unit-tested in
// pendingRowDeletes.test.mjs (outbox.ts itself cannot be imported in Node).

import type { ChapterPayload } from "./api";
import type { OutboxOp } from "./outbox";
import type { ChapterLoader } from "../hooks/chapterFetchSequencer";

type OpLike = Pick<OutboxOp, "target" | "action" | "status">;

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

// Wrap a chapter loader so its payload is filtered by the outbox as read
// AFTER the GET resolved: a DELETE that committed before the snapshot is not
// in it anyway, and one that commits after the read reaches the tab as its
// own `row.deleted`. An outbox read failure lands the snapshot unchanged.
export function hidingPendingRowDeletes<P extends Pick<ChapterPayload, "book" | "tn" | "tq" | "twl">>(
  load: ChapterLoader<P>,
  listOps: () => Promise<readonly OpLike[]>,
): ChapterLoader<P> {
  return async (signal, onAttempt) => {
    const payload = await load(signal, onAttempt);
    let ops: readonly OpLike[];
    try {
      ops = await listOps();
    } catch {
      return payload;
    }
    return hidePendingRowDeletes(payload, ops);
  };
}
