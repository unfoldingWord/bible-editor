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
// Only this tab's own draining deletes are hidden (`markOwnRowDelete`): this
// tab hid those rows itself, and its #1108 rollback restores them on a
// refusal. Another tab's DELETE reaches this one as its `row.deleted`
// broadcast once it commits, and a commit heard while a load runs (from any
// tab, relayed by createRowDeleteOutcomes below, #1119) is hidden too. The
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
// a row, before the DELETE is queued, then records the queued op's id
// (recordOwnRowDeleteOp). An outcome is this tab's only when its op id is one
// this tab queued; another tab's DELETE of the same row is not (#1119 review).
// A mark is cleared when the last of this tab's DELETEs of the row is refused
// or discarded, in any tab: the row is back, and a later delete of it from
// another tab is not this tab's. Another tab's refusal, or an older op's late
// one, leaves it. A committed delete keeps its mark (the row is gone for good,
// and a load still running may need it).
type MarkTarget = Pick<RowTarget, "rowKind" | "book" | "id">;
const ownRowDeletes = new Map<string, { seq: number; target: MarkTarget; ops: Set<string> }>();
let markSeq = 0;
const ownKey = (t: MarkTarget) => `${t.rowKind}:${t.book}:${t.id}`;
export function markOwnRowDelete(rowKind: RowTarget["rowKind"], book: string, id: string): void {
  const target = { rowKind, book, id };
  const ops = ownRowDeletes.get(ownKey(target))?.ops ?? new Set<string>();
  ownRowDeletes.set(ownKey(target), { seq: ++markSeq, target, ops });
}
export function recordOwnRowDeleteOp(op: Pick<OpLike, "id" | "target">): void {
  if (op.target.kind !== "row") return;
  ownRowDeletes.get(ownKey(op.target))?.ops.add(op.id);
}
export function clearOwnRowDelete(t: MarkTarget): void {
  ownRowDeletes.delete(ownKey(t));
}
export function isOwnRowDelete(t: MarkTarget): boolean {
  return ownRowDeletes.has(ownKey(t));
}
export function isOwnRowDeleteOp(op: Pick<OpLike, "id" | "target">): boolean {
  return op.target.kind === "row" && Boolean(ownRowDeletes.get(ownKey(op.target))?.ops.has(op.id));
}
// This tab's op left the outbox without a 200: drop it, and the mark with the
// row's last one.
export function forgetOwnRowDeleteOp(op: Pick<OpLike, "id" | "target">): void {
  if (op.target.kind !== "row") return;
  const key = ownKey(op.target);
  const m = ownRowDeletes.get(key);
  if (!m?.ops.delete(op.id)) return;
  if (m.ops.size === 0) ownRowDeletes.delete(key);
}
// The rows marked from now on and still marked when the returned function is
// called: deletes clicked while a load runs.
export function trackOwnRowDeletes(): () => MarkTarget[] {
  const since = markSeq;
  return () => [...ownRowDeletes.values()].filter((m) => m.seq > since).map((m) => m.target);
}

export interface RowDeleteHooks {
  /**
   * Subscribe for the load's duration to row-DELETE outcomes, this tab's and
   * other tabs' (#1119): `abandoned` for one refused as chapter_locked or
   * discarded (the triggers of Shell's #1108 rollback), `committed` for one
   * that returned 200. Returns the unsubscribe. Without it a DELETE that left
   * the outbox during the load cannot be told committed from refused, so the
   * before-read is skipped.
   */
  watch?(on: { abandoned(op: OpLike): void; committed(op: OpLike): void }): () => void;
  /** Whether this tab made the delete (default: every delete). */
  isOwn?(target: RowTarget): boolean;
  /**
   * Start tracking own deletes clicked during the load; the returned function
   * lists them (trackOwnRowDeletes). One clicked while the after-read runs is
   * missed by that read (#1119).
   */
  trackOwnDeletes?(): () => readonly MarkTarget[];
}

// ---------- row-DELETE outcomes, across tabs (#1119) ----------
//
// The outbox drain is shared by every tab (navigator.locks), but its result
// and discard announcements fire only in the tab that drained or dropped the
// op. Tab A's own DELETE drained by tab B would then commit or be refused
// without A hearing it: a commit during A's plain refetch let the stale
// snapshot put the row back, and a refusal left A hiding a row the server
// still has, since A's #1108 rollback never ran. So each tab relays the
// row-DELETE outcomes it observes over a BroadcastChannel, and every tab
// hears them all. Only the op's identity crosses (id, target, action,
// status); the outbox itself is untouched.

export type RowDeleteOutcomeKind = "committed" | "abandoned";
export interface RowDeleteOutcome {
  kind: RowDeleteOutcomeKind;
  op: OpLike;
  /** Observed by another tab and relayed here. */
  remote: boolean;
  /** This tab queued this op (judged before an abandon clears its mark). */
  own: boolean;
}
export interface RowDeleteOutcomes {
  on(fn: (o: RowDeleteOutcome) => void): () => void;
}
interface OutcomeChannel {
  postMessage(message: unknown): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
}

const isRowDelete = (op: Pick<OpLike, "target" | "action">) => op.target.kind === "row" && op.action === "delete";

// The outbox's own announcements, adapted: a 200 commits; a chapter_locked
// refusal or a discard abandons (no 200 will follow); anything else (a
// conflict, a retry, a failure) keeps the op in the outbox and is not an
// outcome yet.
export function createRowDeleteOutcomes(deps: {
  onResult(fn: (op: OpLike, result: { kind: string }) => void): unknown;
  onDiscard(fn: (op: OpLike) => void): unknown;
  channel: OutcomeChannel | null;
  isOwn(op: OpLike): boolean;
  clearOwn(op: OpLike): void;
}): RowDeleteOutcomes {
  const listeners = new Set<(o: RowDeleteOutcome) => void>();
  const dispatch = (kind: RowDeleteOutcomeKind, op: OpLike, remote: boolean) => {
    const outcome = { kind, op, remote, own: deps.isOwn(op) };
    for (const l of [...listeners]) {
      try {
        l(outcome);
      } catch (e) {
        console.warn("pendingRowDeletes: a row-delete outcome listener failed", e);
      }
    }
    if (kind === "abandoned") deps.clearOwn(op);
  };
  const local = (kind: RowDeleteOutcomeKind, op: OpLike) => {
    if (!isRowDelete(op)) return;
    const { id, target, action, status } = op;
    try {
      deps.channel?.postMessage({ kind, op: { id, target, action, status } });
    } catch {
      /* best-effort: this tab still hears it */
    }
    dispatch(kind, op, false);
  };
  deps.onResult((op, result) => {
    if (result.kind === "ok") local("committed", op);
    else if (result.kind === "locked") local("abandoned", op);
  });
  deps.onDiscard((op) => local("abandoned", op));
  deps.channel?.addEventListener("message", (e) => {
    const m = e.data as { kind?: unknown; op?: OpLike } | null;
    if (!m || (m.kind !== "committed" && m.kind !== "abandoned")) return;
    const op = m.op;
    if (!op || typeof op.id !== "string" || !op.target || !isRowDelete(op)) return;
    const t = op.target as Partial<RowTarget>;
    if (typeof t.rowKind !== "string" || typeof t.book !== "string" || typeof t.id !== "string") return;
    dispatch(m.kind, op, true);
  });
  return {
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// The hooks useChapter's chapter loads use: every tab's row-DELETE outcomes,
// this tab's marks.
export function rowDeleteHooks(outcomes: RowDeleteOutcomes): RowDeleteHooks {
  return {
    watch: (on) => outcomes.on((o) => (o.kind === "committed" ? on.committed(o.op) : on.abandoned(o.op))),
    isOwn: isOwnRowDelete,
    trackOwnDeletes: trackOwnRowDeletes,
  };
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
    let clicked: () => readonly MarkTarget[] = () => [];
    try {
      if (hooks.trackOwnDeletes) clicked = hooks.trackOwnDeletes();
    } catch (e) {
      warn(e);
    }
    try {
      if (hooks.watch) {
        stop = hooks.watch({
          abandoned: (op) => abandoned.add(op.id),
          committed: (op) => committed.push({ ...op, status: "in_flight" }),
        });
        watching = true;
      }
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
        // Clicked during the load and not in the after-read (its read began
        // before the op was written, or the op already left): hidden unless
        // abandoned, which clears the mark. One the read saw is judged above.
        // Only a DELETE counts: a queued PATCH of the row says nothing about
        // whether its DELETE was seen.
        const seen = new Set(after.flatMap((op) => (op.target.kind === "row" && op.action === "delete" ? [ownKey(op.target)] : [])));
        const unseen: OpLike[] = clicked()
          .filter((t) => !seen.has(ownKey(t)))
          .map((t) => ({ id: `mark:${ownKey(t)}`, target: { kind: "row", ...t }, action: "delete", status: "in_flight" }));
        return hidePendingRowDeletes(payload, [...after.filter(own), ...gone.filter(own), ...committed, ...unseen]);
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
