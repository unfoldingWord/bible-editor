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
// draining (hidingPendingRowDeletes says why both reads): pending (including
// retrying in backoff) or in flight, the same "still draining" rule as
// siblingStillDraining. A DELETE refused or discarded (#1108, which restores
// the row) hides nothing once it is gone, a DELETE that left the outbox before
// the GET started hides nothing, and one waiting on the user (conflict,
// failed) at the last read shows the server's row.
//
// Only this tab's own deletes are hidden (`markOwnRowDelete`). The outbox is
// shared by every tab, but a refusal or discard is announced only in the tab
// that drained or dropped the op, so hiding another tab's DELETE could leave
// this tab hiding a row it never learns was restored. Another tab's delete
// still reaches this one as its `row.deleted` broadcast once it commits. The
// mark is in memory: after a reload the tab's still-queued deletes are no
// longer hidden by a refetch (the behaviour before #1107).
//
// Pure apart from the injected outbox reads, so it is unit-tested in
// pendingRowDeletes.test.mjs (outbox.ts itself cannot be imported in Node).

import type { ChapterPayload } from "./api";
import type { OutboxOp, RowTarget } from "./outbox";
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

// This tab's own row deletes, by target. Shell marks one when the user deletes
// a row, before the DELETE is queued.
const ownRowDeletes = new Set<string>();
const ownKey = (rowKind: string, book: string, id: string) => `${rowKind}:${book}:${id}`;
export function markOwnRowDelete(rowKind: RowTarget["rowKind"], book: string, id: string): void {
  ownRowDeletes.add(ownKey(rowKind, book, id));
}
export function isOwnRowDelete(t: Pick<RowTarget, "rowKind" | "book" | "id">): boolean {
  return ownRowDeletes.has(ownKey(t.rowKind, t.book, t.id));
}

export interface RowDeleteHooks {
  /**
   * Subscribe for the load's duration to this tab's row-DELETE outcomes:
   * `abandoned` for one refused as chapter_locked or discarded (the triggers of
   * Shell's #1108 rollback), `committed` for one that returned 200. Returns the
   * unsubscribe.
   */
  watch?(on: { abandoned(op: OpLike): void; committed(op: OpLike): void }): () => void;
  /** Whether this tab made the delete (default: every delete). */
  isOwn?(target: RowTarget): boolean;
}

// Wrap a chapter loader so its payload is filtered by this tab's row DELETEs
// that were draining when the GET started, are still draining when it
// resolved, or committed while it ran.
//
// - After: a DELETE still queued or in flight once the response is here. An
//   op present at both reads is judged by its status at the after-read, so one
//   that turned into a conflict or a refusal waiting on the user shows its row.
// - Before: a DELETE draining at GET start can commit while the (larger)
//   chapter body is still downloading. Its op is then gone by the after-read,
//   but the snapshot may predate the commit, and a plain refetch replaces the
//   cache wholesale, so the `row.deleted` broadcast that arrived first would
//   be undone. A committed delete stays hidden, which is right.
// - Committed: a DELETE queued after the before-read that also commits before
//   the after-read is seen by neither read; its 200 (`watch` committed) hides
//   it.
// - Except abandoned ones: a DELETE refused as chapter_locked or discarded
//   during the window is dropped from the before-set. Shell's #1108 rollback
//   re-reads the chapter with its own GET and restores the row; if that GET
//   beat this one, hiding the row here would undo the restore. A refusal
//   announced after the after-read is safe: this payload lands a few
//   microtasks later, long before the rollback's own GET returns, and the
//   rollback then restores over it.
//
// Any failure lands the snapshot unchanged or less filtered, never a failed
// GET: a failed subscription skips the before-set (an abandoned op could not
// be told apart), a failed before-read leaves only the after-read, and a
// failed after-read or filter (a malformed persisted op) lands the snapshot
// unchanged. An outbox problem must never turn a good GET into the chapter's
// error screen.
export function hidingPendingRowDeletes<P extends Pick<ChapterPayload, "book" | "tn" | "tq" | "twl">>(
  load: ChapterLoader<P>,
  listOps: () => Promise<readonly OpLike[]>,
  hooks: RowDeleteHooks = {},
): ChapterLoader<P> {
  const warn = (e: unknown) =>
    console.warn("pendingRowDeletes: could not apply pending row deletes; showing the snapshot less filtered", e);
  return async (signal, onAttempt) => {
    const abandoned = new Set<string>();
    const committed: OpLike[] = [];
    let stop = () => {};
    let watching = false;
    try {
      if (hooks.watch) {
        stop = hooks.watch({
          abandoned: (op) => abandoned.add(op.id),
          committed: (op) => committed.push({ ...op, status: "in_flight" }),
        });
      }
      watching = true;
    } catch (e) {
      warn(e);
    }
    let before: readonly OpLike[] = [];
    if (watching) {
      try {
        before = await listOps();
      } catch (e) {
        warn(e);
      }
    }
    try {
      const payload = await load(signal, onAttempt);
      try {
        const after = await listOps();
        const own = (op: OpLike) => op.target.kind === "row" && (hooks.isOwn?.(op.target) ?? true);
        const afterIds = new Set(after.map((op) => op.id));
        const gone = before.filter((op) => !afterIds.has(op.id) && !abandoned.has(op.id));
        return hidePendingRowDeletes(payload, [...after.filter(own), ...gone.filter(own), ...committed]);
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
