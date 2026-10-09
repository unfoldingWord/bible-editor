// #1174: a note MOVE (a tn PATCH carrying `verse`) refused as chapter_locked
// is rolled back on screen by Shell's rollBackRefusedTnMove (#1165), but the
// outbox announces the refusal only in the tab that drained the op. The drain
// is shared by every tab, so when another tab drained it, the tab that made the
// move kept showing the note at the refused verse until its next refetch.
//
// So each tab relays the refused moves it drains over a BroadcastChannel, and
// a tab hears a relayed one only when it queued that op itself (markOwn, by op
// id). The draining tab never hears its own post (BroadcastChannel does not
// deliver to the sender) and rolls back through its local result listener, so
// no tab rolls back twice and a tab that did not make the move does nothing.
//
// Pure apart from the injected outbox listener and channel, so it is
// unit-tested in refusedTnMoves.test.mjs (outbox.ts cannot be imported in Node).

import type { OutboxOp, RowTarget } from "./outbox";

export type RefusedTnMove = Pick<OutboxOp, "id" | "target" | "action" | "patch">;

interface RelayChannel {
  postMessage(message: unknown): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  removeEventListener?(type: "message", fn: (e: { data: unknown }) => void): void;
}

export interface RefusedTnMoveRelay {
  /** This tab queued the op (a tn move PATCH). */
  markOwn(opId: string): void;
  /** This tab's move, refused in another tab. Returns the unsubscribe. */
  on(fn: (op: RefusedTnMove) => void): () => void;
  close(): void;
}

// How many of this tab's move op ids are remembered. A move is a click, so
// this is far more than are ever in flight at once.
const MAX_OWN = 200;

const isTnMove = (op: Pick<OutboxOp, "target" | "action" | "patch">) =>
  op.target?.kind === "row" &&
  (op.target as RowTarget).rowKind === "tn" &&
  op.action === "patch" &&
  typeof op.patch?.verse === "number";

// Queue one of this tab's moves under `opId`, marked as this tab's BEFORE the
// put starts: once the op is in IndexedDB another tab's drain can send it and
// relay its refusal before the put resolves here (#1174 review), so marking
// from the resolved op would miss that relay. A synchronous throw from
// `enqueue` becomes a rejection, like the put's own failure.
export function enqueueOwnTnMove<T>(
  relay: Pick<RefusedTnMoveRelay, "markOwn">,
  opId: string,
  enqueue: (opId: string) => Promise<T>,
): Promise<T> {
  relay.markOwn(opId);
  try {
    return enqueue(opId);
  } catch (e) {
    return Promise.reject(e);
  }
}

export function createRefusedTnMoveRelay(deps: {
  onResult(fn: (op: RefusedTnMove, result: { kind: string }) => void): unknown;
  channel: RelayChannel | null;
}): RefusedTnMoveRelay {
  const own = new Set<string>();
  const listeners = new Set<(op: RefusedTnMove) => void>();
  const unsub = deps.onResult((op, result) => {
    if (!isTnMove(op)) return;
    // Only ok and locked take the op out of the outbox. A retry, conflict or
    // fatal result leaves it queued (pending, conflict, failed), so any tab
    // may still drain it and relay a refusal: keep the mark for that.
    if (result.kind !== "ok" && result.kind !== "locked") return;
    // Settled here: a later relay of it from elsewhere is not news.
    own.delete(op.id);
    if (result.kind !== "locked") return;
    const { id, target, action } = op;
    try {
      deps.channel?.postMessage({ op: { id, target, action, patch: { verse: op.patch.verse, ref_raw: op.patch.ref_raw } } });
    } catch {
      /* best-effort: the next refetch catches up */
    }
  });
  const onMessage = (e: { data: unknown }) => {
    const op = (e.data as { op?: RefusedTnMove } | null)?.op;
    if (!op || typeof op.id !== "string" || !isTnMove(op)) return;
    const t = op.target as Partial<RowTarget>;
    if (typeof t.id !== "string" || typeof t.book !== "string") return;
    if (!own.delete(op.id)) return;
    for (const l of [...listeners]) {
      try {
        l(op);
      } catch (err) {
        console.warn("refusedTnMoves: a refused-move listener failed", err);
      }
    }
  };
  deps.channel?.addEventListener("message", onMessage);
  return {
    markOwn(opId) {
      own.add(opId);
      if (own.size > MAX_OWN) own.delete(own.values().next().value as string);
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      if (typeof unsub === "function") unsub();
      deps.channel?.removeEventListener?.("message", onMessage);
    },
  };
}
