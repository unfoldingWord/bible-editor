// Write-ahead outbox: every user edit is durably queued in IndexedDB before
// it leaves the browser. A drain worker pops in order and dispatches to the
// API; on 200 the op is removed, on 409 the conflict is surfaced, on
// network/auth failures the op stays until the next drain tick. This is the
// single feature that keeps the editor safe from network blips and tab
// crashes — see docs/plan.md "Save protocol".

import { openDB, type IDBPDatabase } from "idb";
import {
  api,
  ApiError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  isChapterLockedBody,
  isReadOnly,
  onAuthRefreshed,
  type ChapterLockedBody,
  type AlignmentIntent,
  type RowKind,
  type CheckLane,
} from "./api";
import { backoffMs } from "./backoff";
import { classifyRowPatchConflict } from "./rowConflict";
import {
  MAX_ATTEMPTS_SENTINEL,
  dropGuardAllows,
  reasonForOp,
  serverRefusalReason,
  willRetryOnItsOwn,
} from "./refusalReason";
import {
  eligibleForVersionThread,
  isMaxAttemptsBlocked,
  shouldAnnounceResult,
  targetKey,
} from "./outboxTargeting.ts";
import { rebaseVersePatch } from "./verseRebase.ts";

const DB_NAME = "bible-editor-outbox";
const DB_VERSION = 1;
const STORE = "ops";

// Hard cap on retry attempts that reached a *responding* server. backoffMs()
// saturates around 30s, so 20 attempts is ~10 minutes of real-world
// wall-clock for a transient server error (5xx / 408 / 425 / 429). Beyond
// that the op is almost certainly stuck on something structural (deleted
// row, malformed payload) — keep retrying and we just churn the network and
// battery. Only those server errors consume the cap (tracked in
// `hardAttempts`); network failures and auth retries can recur indefinitely
// — an offline laptop or a signed-out session must never burn queued edits.
// At the cap the op transitions to `failed` with `lastError =
// "max_attempts_exceeded"`; the user sees it in the failed-ops drawer and
// can Retry (resets attempts) or Discard, and it auto-revives when the
// connection or session comes back (see reviveMaxAttemptsFailed).
const MAX_ATTEMPTS = 20;

// Cap on silent re-arm-and-retry after a 409 that we judged spurious — either a
// reorder-only patch (sort_order is transient last-write-wins, see api/src/rows.ts
// "transient fields like sort_order") or a content patch that doesn't genuinely
// conflict with the server's current row (see classifyRowPatchConflict). Neither
// should surface a conflict prompt. This cap stops a pathological loop if another
// writer is bumping the same row faster than we can land — beyond it, fall through
// to the normal conflict flow.
const MAX_CONFLICT_AUTOHEAL = 5;

// recoverInFlight only re-arms in_flight ops at least this stale. A live
// request can't outlast its api.ts timeout, so 2× that means "the tab that
// dispatched this is gone (crash / reload), not mid-request" — without the
// threshold, a second tab's drain would re-arm the first tab's live op and
// double-PATCH it.
const IN_FLIGHT_RECOVERY_AGE_MS = 2 * DEFAULT_REQUEST_TIMEOUT_MS;

export interface RowTarget {
  kind: "row";
  rowKind: RowKind;
  id: string;
  book: string;
}
export interface VerseTarget {
  kind: "verse";
  book: string;
  chapter: number;
  verse: number;
  bibleVersion: string;
}
export interface VerseStatusTarget {
  kind: "verse_status";
  book: string;
  chapter: number;
  verse: number;
}
export interface LaneCheckTarget {
  kind: "lane_check";
  book: string;
  chapter: number;
  verse: number;
  lane: CheckLane;
}
export type OpTarget = RowTarget | VerseTarget | VerseStatusTarget | LaneCheckTarget;

export type OpStatus = "pending" | "in_flight" | "conflict" | "failed";
export type OpAction = "patch" | "delete";

export interface OutboxOp {
  id: string;               // op uuid (separate from row id)
  target: OpTarget;
  action: OpAction;
  patch: Record<string, unknown>;
  expectedVersion: number;
  queuedAt: number;
  // Monotonic per-session counter breaking queuedAt ties (ms granularity) so
  // two enqueues in the same millisecond keep their true order — the IDB
  // index otherwise falls back to primary-key (uuid) order. Absent on
  // records persisted before this field existed; treated as 0.
  seq?: number;
  attempts: number;
  // Failures that consume the MAX_ATTEMPTS cap — genuine server errors only
  // (transient 5xx/408/425/429). Network and auth retries bump `attempts`
  // (which drives backoff) but not this. Absent = 0.
  hardAttempts?: number;
  // Wall-clock of the last pending → in_flight transition. recoverInFlight
  // uses it to distinguish a crashed tab's orphan from another tab's live
  // request.
  dispatchedAt?: number;
  status: OpStatus;
  lastError?: string;
  // The server's own explanation for a refusal, lifted from the `error` /
  // `reason` fields of a non-retryable 4xx response body. Deliberately a
  // SEPARATE field from `lastError`: that one carries control-flow sentinels
  // ("max_attempts_exceeded" is matched by reviveMaxAttemptsFailed) and must
  // stay machine-stable. This one is display-only — the failed-ops drawer
  // turns it into a plain sentence so a refused save says *why* instead of
  // looking like the app threw the edit away (issue #370).
  lastErrorReason?: string;
  conflictCurrent?: unknown;
  // Count of silent re-arms after a sort_order-only 409 (see
  // MAX_CONFLICT_AUTOHEAL). Absent = 0.
  conflictRetries?: number;
  // Set when this patch came from "switch to v{N}" in the history dialog.
  // The server stores it on the new edit_log entry + the row's column so
  // the UI can label the chip v{N} even though row.version is now N+1.
  restoredFromVersion?: number;
  // The row's values for the patched fields at the moment we enqueued (the
  // version we branched from). On a 409 this lets us tell a spurious conflict
  // (the server changed a *different* field, or already has our value) from a
  // genuine one (the server changed a field we're also editing). Only set for
  // row patches; absent for verse/status/lane ops and pre-baseline records.
  baseline?: Record<string, unknown>;
  // Exact local text-draft generation captured by this save. Used only for
  // generation-safe cleanup after a successful verse PATCH (drafts.ts).
  draftGeneration?: string;
  // Exact local ALIGNMENT-draft generation captured by this save (a separate
  // IndexedDB store — see alignmentDrafts.ts). Deliberately a distinct field
  // from draftGeneration above: the two stores have disjoint key spaces and
  // generation sequences, and only ever apply to one of text_edit/find_replace/
  // section_edit (draftGeneration) or alignment_edit (this one) saves.
  alignmentDraftGeneration?: string;
}

type Subscriber = (ops: OutboxOp[]) => void;

let dbp: Promise<IDBPDatabase> | null = null;
function db() {
  if (!dbp) {
    dbp = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("queuedAt", "queuedAt");
          store.createIndex("status", "status");
        }
      },
    });
  }
  return dbp;
}

const subscribers = new Set<Subscriber>();

async function listAll(): Promise<OutboxOp[]> {
  const tx = (await db()).transaction(STORE, "readonly");
  const all = (await tx.store.index("queuedAt").getAll()) as OutboxOp[];
  // The index orders queuedAt ties by primary key (random uuid) — re-sort
  // with seq as tiebreak so same-millisecond enqueues drain in true order.
  all.sort((a, b) => a.queuedAt - b.queuedAt || (a.seq ?? 0) - (b.seq ?? 0));
  return all;
}

// Coalesce notify() calls onto a single microtask. drainPass calls notify()
// twice per drained op (after the in_flight flip, after the result persists),
// and each call does a full-store read + sort. Batching collapses a burst of
// calls in the same tick into one read+broadcast; subscribers only care about
// the latest snapshot anyway.
let notifyScheduled = false;
// Set when a notify() arrives while a read+dispatch is already in flight. The
// flag stays raised across the whole read+dispatch (not reset before the await
// resolves), so a swallowed notify in that window doesn't strand the UI on a
// stale snapshot — we loop and re-read.
let notifyPendingRerun = false;
async function notify() {
  if (subscribers.size === 0) return;
  if (notifyScheduled) {
    // A read+dispatch is in flight. Its listAll() may have already resolved,
    // so the snapshot it broadcasts could predate the state this call reflects.
    // Request a re-run instead of dropping the notification.
    notifyPendingRerun = true;
    return;
  }
  notifyScheduled = true;
  await Promise.resolve();
  // Keep the flag raised across the full read+dispatch so concurrent notify()
  // calls coalesce into notifyPendingRerun rather than slipping through.
  do {
    notifyPendingRerun = false;
    if (subscribers.size === 0) break;
    const all = await listAll();
    for (const s of subscribers) s(all);
    // If a notify() arrived while listAll()/dispatch ran, re-read so the last
    // snapshot the UI settles on reflects the latest committed state.
  } while (notifyPendingRerun);
  notifyScheduled = false;
}

function uid() {
  // crypto.randomUUID is universally available in modern browsers / workers.
  return crypto.randomUUID();
}

// See OutboxOp.seq. Per-session is enough: across reloads queuedAt itself
// can't tie (a reload takes well over a millisecond).
let seqCounter = 0;
function nextSeq(): number {
  return ++seqCounter;
}

// In read-only mode (viewer role), enqueue methods short-circuit before
// touching IndexedDB so a viewer who types in a note never produces a
// "failed" chip downstream. Local React state still reflects the typing —
// the read-only banner above the Shell explains why nothing persists.
function noopOp(target: OpTarget, action: OpAction, patch: Record<string, unknown>): OutboxOp {
  return {
    id: "readonly-noop",
    target,
    action,
    patch,
    expectedVersion: 0,
    queuedAt: Date.now(),
    attempts: 0,
    status: "pending",
  };
}

// targetKey / isMaxAttemptsBlocked / eligibleForVersionThread live in
// outboxTargeting.ts, not here — that module has no dependency on api.ts (its
// ApiError class uses a TS parameter-property constructor Node's strip-types
// loader can't erase), so it can be `import()`ed directly by a plain Node
// regression test. See outboxTargeting.test.mjs for the issue #487 coverage.

export const outbox = {
  subscribe(fn: Subscriber): () => void {
    subscribers.add(fn);
    void listAll().then(fn);
    return () => subscribers.delete(fn);
  },

  async enqueueRow(
    rowKind: RowKind,
    id: string,
    expectedVersion: number,
    patch: Record<string, unknown>,
    opts: { restoredFromVersion?: number; book: string; baseline?: Record<string, unknown> },
  ): Promise<OutboxOp> {
    if (isReadOnly()) {
      return noopOp({ kind: "row", rowKind, id, book: opts.book }, "patch", patch);
    }
    const op: OutboxOp = {
      id: uid(),
      target: { kind: "row", rowKind, id, book: opts.book },
      action: "patch",
      patch,
      expectedVersion,
      queuedAt: Date.now(),
      seq: nextSeq(),
      attempts: 0,
      status: "pending",
      ...(opts.restoredFromVersion !== undefined
        ? { restoredFromVersion: opts.restoredFromVersion }
        : {}),
      ...(opts.baseline !== undefined ? { baseline: opts.baseline } : {}),
    };
    await (await db()).put(STORE, op);
    void notify();
    void drain();
    return op;
  },

  async enqueueDeleteRow(
    rowKind: RowKind,
    id: string,
    expectedVersion: number,
    book: string,
  ): Promise<OutboxOp> {
    if (isReadOnly()) {
      return noopOp({ kind: "row", rowKind, id, book }, "delete", {});
    }
    const op: OutboxOp = {
      id: uid(),
      target: { kind: "row", rowKind, id, book },
      action: "delete",
      patch: {},
      expectedVersion,
      queuedAt: Date.now(),
      seq: nextSeq(),
      attempts: 0,
      status: "pending",
    };
    await (await db()).put(STORE, op);
    void notify();
    void drain();
    return op;
  },

  async enqueueVerse(
    book: string,
    chapter: number,
    verse: number,
    bibleVersion: string,
    expectedVersion: number,
    patch: { content: unknown; plain_text?: string | null; alignment_intent?: AlignmentIntent },
    opts: { draftGeneration?: string; alignmentDraftGeneration?: string } = {},
  ): Promise<OutboxOp> {
    if (isReadOnly()) {
      return noopOp(
        { kind: "verse", book, chapter, verse, bibleVersion },
        "patch",
        patch as Record<string, unknown>,
      );
    }
    const op: OutboxOp = {
      id: uid(),
      target: { kind: "verse", book, chapter, verse, bibleVersion },
      action: "patch",
      patch: patch as Record<string, unknown>,
      expectedVersion,
      queuedAt: Date.now(),
      seq: nextSeq(),
      attempts: 0,
      status: "pending",
      ...(opts.draftGeneration ? { draftGeneration: opts.draftGeneration } : {}),
      ...(opts.alignmentDraftGeneration ? { alignmentDraftGeneration: opts.alignmentDraftGeneration } : {}),
    };
    await (await db()).put(STORE, op);
    void notify();
    void drain();
    return op;
  },

  // verse_status (done flag) has no version field — the worker upserts on
  // primary key (book, chapter, verse) with a UPSERT-style ON CONFLICT. We
  // still want it in the outbox so an offline toggle survives a crash and
  // doesn't need the user to re-click after reconnecting. Coalesce queued
  // toggles for the same verse so a rapid click→click→click only ships the
  // last value.
  async enqueueVerseStatus(
    book: string,
    chapter: number,
    verse: number,
    done: boolean,
  ): Promise<OutboxOp> {
    if (isReadOnly()) {
      return noopOp({ kind: "verse_status", book, chapter, verse }, "patch", { done });
    }
    const idb = await db();
    const key = `vstatus:${book}:${chapter}:${verse}`;
    // Find-and-rewrite in a SINGLE readwrite transaction. The old two-step
    // (getAll in one tx, put in another) raced the drain: between the read
    // and the write, drain could flip the found op pending → in_flight and
    // delete it on 200, so our coalesced payload landed on a doomed op and
    // the toggle vanished unsent. One tx makes the check-and-rewrite atomic
    // against drain's own single-tx pending → in_flight transition.
    //
    // Coalesce only into *pending* ops. Rewriting an in_flight op's payload
    // races the drain worker regardless of tx boundaries (the request already
    // left with the old payload, and the 200 handler deletes the op). If the
    // only op for this verse is mid-flight, queue a fresh one behind it
    // (upsert route, no If-Match, so it simply lands after).
    const tx = idb.transaction(STORE, "readwrite");
    const all = (await tx.store.getAll()) as OutboxOp[];
    const pending = all.find(
      (o) => targetKey(o.target) === key && o.status === "pending",
    );
    let result: OutboxOp;
    if (pending) {
      // Coalesce: rewrite the existing op's payload rather than queue a
      // second one that would just race to overwrite the first.
      pending.patch = { done };
      pending.queuedAt = Date.now();
      pending.seq = nextSeq();
      await tx.store.put(pending);
      result = pending;
    } else {
      result = {
        id: uid(),
        target: { kind: "verse_status", book, chapter, verse },
        action: "patch",
        patch: { done },
        expectedVersion: 0,
        queuedAt: Date.now(),
        seq: nextSeq(),
        attempts: 0,
        status: "pending",
      };
      await tx.store.put(result);
    }
    await tx.done;
    void notify();
    void drain();
    return result;
  },

  // lane_check (per-resource checkoff stamp) — same upsert/coalesce shape as
  // verse_status: no version, the (user, lane) row is what's toggled, so rapid
  // click-click only ships the final state. Offline-safe like every other op.
  async enqueueLaneCheck(
    book: string,
    chapter: number,
    verse: number,
    lane: CheckLane,
    checked: boolean,
  ): Promise<OutboxOp> {
    if (isReadOnly()) {
      return noopOp({ kind: "lane_check", book, chapter, verse, lane }, "patch", { checked });
    }
    const idb = await db();
    const key = `lanecheck:${book}:${chapter}:${verse}:${lane}`;
    const tx = idb.transaction(STORE, "readwrite");
    const all = (await tx.store.getAll()) as OutboxOp[];
    const pending = all.find((o) => targetKey(o.target) === key && o.status === "pending");
    let result: OutboxOp;
    if (pending) {
      pending.patch = { checked };
      pending.queuedAt = Date.now();
      pending.seq = nextSeq();
      await tx.store.put(pending);
      result = pending;
    } else {
      result = {
        id: uid(),
        target: { kind: "lane_check", book, chapter, verse, lane },
        action: "patch",
        patch: { checked },
        expectedVersion: 0,
        queuedAt: Date.now(),
        seq: nextSeq(),
        attempts: 0,
        status: "pending",
      };
      await tx.store.put(result);
    }
    await tx.done;
    void notify();
    void drain();
    return result;
  },

  // Re-arm a conflicted op against the freshly-observed server version. Also
  // resets every op for the same target so a single user resolution doesn't
  // cascade-conflict the queue (otherwise N edits to one row produce N
  // prompts for what was logically one upstream change).
  async resolveConflict(opId: string, newExpectedVersion: number) {
    const idb = await db();
    // Read AND write inside ONE readwrite tx. The old two-step (get + getAll in
    // autocommit txs, then put in a new tx) raced the drain: between the read
    // and the write, drain could flip a sibling pending → in_flight, and the
    // stale write here would clobber that transition (re-arming a live op and
    // double-PATCHing it). Re-check status inside the tx so we only touch ops
    // still safe to reset.
    const tx = idb.transaction(STORE, "readwrite");
    const op = (await tx.store.get(opId)) as OutboxOp | undefined;
    if (!op) {
      await tx.done;
      return;
    }
    const key = targetKey(op.target);
    const resolvedAt = Date.now();
    const all = (await tx.store.getAll()) as OutboxOp[];
    // Sort siblings by original chronological order before assigning new seq
    // values — getAll() returns by primary key (random UUID), and since all
    // siblings share the same resolvedAt, seq is the drain-order tiebreaker.
    const siblings = all
      .filter((o) => targetKey(o.target) === key && (o.status === "conflict" || o.status === "pending"))
      .sort((a, b) => a.queuedAt - b.queuedAt || (a.seq ?? 0) - (b.seq ?? 0));
    // Verse ops: don't re-send the op's content verbatim onto the newer server
    // row — its content was diffed from an older baseline, so verbatim either
    // gets refused by the server's alignment guard or silently reverts the
    // concurrent change (issue #564). Rebase the op's text intent onto the
    // server's current tree (from the 409's conflictCurrent) instead.
    // rebaseVersePatch is synchronous, so calling it between the tx's IDB
    // requests is safe. `refuse_thread` (an alignment_edit across a text
    // change) deliberately re-sends verbatim HERE: this path is the user
    // explicitly clicking "resolve — my edit wins", which is last-write-wins
    // by contract; only the automatic thread path refuses.
    const serverContent =
      op.target.kind === "verse"
        ? (op.conflictCurrent as { content?: unknown } | null | undefined)?.content
        : undefined;
    for (const o of siblings) {
      if (o.target.kind === "verse" && o.action === "patch") {
        const outcome = rebaseVersePatch(o.patch, serverContent);
        if (outcome.kind === "rebased") o.patch = outcome.patch;
      }
      o.expectedVersion = newExpectedVersion;
      o.status = "pending";
      o.queuedAt = resolvedAt;
      o.seq = nextSeq();
      o.conflictCurrent = undefined;
      await tx.store.put(o);
    }
    await tx.done;
    void notify();
    void drain();
  },

  // onlyIfStatus excludes "in_flight": the unconditional in_flight guard below
  // returns first, so that value could never match — don't promise it.
  async drop(
    opId: string,
    opts?: {
      onlyIfStatus?: Exclude<OpStatus, "in_flight">;
      // Re-check refused-ness against the stored record at delete time. `failed`
      // covers two classes — a server refusal and a retry-cap timeout that
      // revives itself — and only the first is safe to discard from the
      // "discard refused" flow. See dropGuardAllows.
      onlyIfRefused?: boolean;
    },
  ) {
    // Guard against dropping an op the drain just flipped to in_flight (same
    // race the drain itself guards at the listAll → fresh re-read). A request
    // is already on the wire; deleting the record here would race the 200
    // handler's own delete and could strand or double-handle the result. Leave
    // in_flight ops alone — they resolve on their own; the user can drop them
    // once they settle. Read-and-check inside one readwrite tx so we don't
    // open a window against drain's pending → in_flight transition.
    const idb = await db();
    const tx = idb.transaction(STORE, "readwrite");
    const op = (await tx.store.get(opId)) as OutboxOp | undefined;
    if (op && op.status === "in_flight") {
      await tx.done;
      return;
    }
    // A caller acting on a snapshot (either discard dialog, the unresolvable-
    // conflict dialog) may be stale: another tab can re-arm a conflict to
    // pending, or retry a refused op so it re-parks as a will-retry one,
    // between the snapshot and the click. Deleting then destroys an edit that
    // is about to save or is expected back. dropGuardAllows re-judges the
    // freshly-read record, making the check-and-delete atomic inside this tx.
    if (op && !dropGuardAllows(op, opts)) {
      await tx.done;
      // The mismatch means this tab just observed state it may not know about
      // (cross-tab writes never reach this tab's notify) — broadcast so the
      // UI catches up, and drain in case the op is now pending.
      void notify();
      void drain();
      return;
    }
    await tx.store.delete(opId);
    await tx.done;
    // Only when a record was actually deleted (op read non-null above) — a
    // drop of an already-gone id must not announce a discard twice.
    if (op) for (const l of discardListeners) l(op);
    void notify();
    void drain();
  },

  // User-driven recovery for a `failed` op (typically one that hit
  // max_attempts_exceeded against a transient back-end issue that has since
  // cleared). Resets the attempt counter so it gets a full retry budget,
  // not just one more shot before re-failing.
  async retry(opId: string) {
    const idb = await db();
    // Read-and-check inside one readwrite tx. If the drain just flipped this op
    // to in_flight, a request is already on the wire — resetting it to pending
    // here would let a second drain re-dispatch it (double-PATCH) or clobber
    // the in-flight result. Leave in_flight ops alone; they resolve on their
    // own. pending/failed ops retry as before (failed → fresh attempt budget).
    const tx = idb.transaction(STORE, "readwrite");
    const op = (await tx.store.get(opId)) as OutboxOp | undefined;
    if (!op || op.status === "in_flight") {
      await tx.done;
      return;
    }
    // A max-attempts-blocked op (isMaxAttemptsBlocked) was holding its
    // target's place in the FIFO: nothing queued behind it while it sat
    // failed could leapfrog ahead and get threaded a version this op would
    // later land on top of. Flipping status to "pending" already forfeits
    // that protection (isMaxAttemptsBlocked only fires on `status ===
    // "failed"`), so if we also bump queuedAt/seq to "now", this op sorts
    // *behind* any sibling that queued while it was failed — that sibling
    // then drains first, threadVersionToSiblings hands its fresh version to
    // this now-pending op (eligibleForVersionThread allows any pending op),
    // and this op lands cleanly on top of it, silently reverting the newer
    // edit. Same bug as #487, reached through Retry instead of automatic
    // revival. Keeping the original queuedAt/seq preserves this op's
    // rightful place ahead of those siblings, so plain FIFO ordering (not
    // the `blocked` set) keeps it draining — and re-threading — first, the
    // same as if it had never failed. A fatal (non-blocking) failure never
    // had this protection — it's threaded continuously while failed (see
    // eligibleForVersionThread) — so it keeps getting a fresh queue
    // position, as before.
    const preserveQueuePosition = isMaxAttemptsBlocked(op);
    op.status = "pending";
    op.attempts = 0;
    op.hardAttempts = 0;
    op.lastError = undefined;
    op.lastErrorReason = undefined;
    if (!preserveQueuePosition) {
      op.queuedAt = Date.now();
      op.seq = nextSeq();
    }
    await tx.store.put(op);
    await tx.done;
    void notify();
    void drain();
  },

  async list(): Promise<OutboxOp[]> {
    return listAll();
  },
};

// ---------- drain ----------

let draining = false;
// Set when drain() is called while a drain is already active — mirrors
// notify()'s notifyPendingRerun. An enqueue whose IDB put commits after the
// running pass's final listAll() snapshot, and whose drain() call lands
// before `draining` flips false, is neither seen by that pass nor able to
// start a new one; without this flag the op sits pending until an unrelated
// trigger (focus/online/next enqueue). The active drain consumes the flag by
// re-running drainPass before it finishes.
let drainRequested = false;
let drainTimer: ReturnType<typeof setTimeout> | null = null;
// Wall-clock deadline of the pending drainTimer, 0 when none. scheduleDrain
// only replaces the timer when the new deadline is EARLIER — with a single
// shared timer, a long reschedule (young in-flight recovery, up to the 60s
// recovery age) would otherwise clobber a short due retry (~250ms backoff)
// and an op due in 250ms could wait the full recovery age.
let drainTimerAt = 0;

type Result =
  | { kind: "ok"; updated: unknown }
  | { kind: "conflict"; current: unknown }
  | { kind: "retry"; reason: string }
  // `reason` is the machine sentinel stored on op.lastError; `serverReason`
  // is the server's own explanation (body.error / body.reason), kept apart so
  // the sentinel stays stable while the drawer can show a human sentence.
  | { kind: "fatal"; reason: string; serverReason?: string }
  // Chapter is locked because an AI pipeline is mid-flight. The auto-apply
  // step will overwrite the row anyway, so retrying is pointless — the op
  // gets dropped and the listener can surface a toast.
  | { kind: "locked"; lockBody: ChapterLockedBody };

export type { Result as OutboxResult };

type ResultListener = (op: OutboxOp, result: Result) => void;
const resultListeners = new Set<ResultListener>();
export function onOutboxResult(fn: ResultListener): () => void {
  resultListeners.add(fn);
  return () => resultListeners.delete(fn);
}

// Fires when drop() permanently deletes an op (every SyncStatusBar discard
// flow funnels through drop). A discard is a terminal exit no 200 will ever
// follow, so anything keyed to the op's eventual landing — the verse-base
// pin a draftless save left behind (#565) — must release here instead.
type DiscardListener = (op: OutboxOp) => void;
const discardListeners = new Set<DiscardListener>();
export function onOutboxDiscard(fn: DiscardListener): () => void {
  discardListeners.add(fn);
  return () => discardListeners.delete(fn);
}

function unexpectedAlignmentLossReason(body: unknown): string | null {
  const error = (body as { error?: unknown } | null)?.error;
  if (error !== "unexpected_alignment_loss") return null;
  const losses = (body as { delta?: { unexpectedLosses?: unknown[] } } | null)
    ?.delta?.unexpectedLosses;
  const sample = Array.isArray(losses)
    ? losses
        .slice(0, 3)
        .map((loss) => (loss as { text?: unknown } | null)?.text)
        .filter((text): text is string => typeof text === "string" && text.length > 0)
        .join(", ")
    : "";
  return `unexpected_alignment_loss${sample ? `: ${sample}` : ""}`;
}

async function dispatch(op: OutboxOp): Promise<Result> {
  try {
    let updated: unknown;
    if (op.target.kind === "row") {
      if (op.action === "delete") {
        updated = await api.deleteRow(
          op.target.rowKind,
          op.target.id,
          op.expectedVersion,
          op.target.book,
        );
      } else {
        updated = await api.patchRow(
          op.target.rowKind,
          op.target.id,
          op.expectedVersion,
          op.patch,
          {
            ...(op.restoredFromVersion !== undefined ? { restoredFromVersion: op.restoredFromVersion } : {}),
            book: op.target.book,
          },
        );
      }
    } else if (op.target.kind === "verse_status") {
      updated = await api.setVerseDone(
        op.target.book,
        op.target.chapter,
        op.target.verse,
        Boolean((op.patch as { done?: boolean }).done),
      );
    } else if (op.target.kind === "lane_check") {
      updated = await api.setLaneCheck(
        op.target.book,
        op.target.chapter,
        op.target.verse,
        op.target.lane,
        Boolean((op.patch as { checked?: boolean }).checked),
      );
    } else {
      updated = await api.patchVerse(
        op.target.book,
        op.target.chapter,
        op.target.verse,
        op.target.bibleVersion,
        op.expectedVersion,
        op.patch as { content: unknown; plain_text?: string | null },
      );
    }
    return { kind: "ok", updated };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 409) {
        if (isChapterLockedBody(e.body)) {
          return { kind: "locked", lockBody: e.body };
        }
        const alignmentLoss = unexpectedAlignmentLossReason(e.body);
        if (alignmentLoss) {
          // Also carry it as the display reason so every refusal reaches the
          // drawer through the same field, not just the plain-4xx ones.
          return { kind: "fatal", reason: alignmentLoss, serverReason: alignmentLoss };
        }
        const body = e.body as { current?: unknown } | undefined;
        return { kind: "conflict", current: body?.current };
      }
      if (e.status === 401) {
        // Token missing/expired. Don't burn retries against a wall — pause
        // and let an outer reauth refresh the token. The op stays pending.
        return { kind: "retry", reason: `auth ${e.status}` };
      }
      // Transient HTTP signals: rate-limit, timeout, too-early. 5xx is the
      // server saying "try again". 503 / 504 explicitly.
      if (
        e.status === 408 ||
        e.status === 425 ||
        e.status === 429 ||
        e.status >= 500
      ) {
        return { kind: "retry", reason: `transient ${e.status}` };
      }
      // A csrf_mismatch 403 is recoverable: the be_csrf cookie expired but the
      // session is still valid. api.ts already refreshes-and-retries inline; if
      // one still reaches here (refresh raced/failed), keep the op pending and
      // retry rather than failing it permanently. The other 403s
      // (source_text_is_read_only, forbidden/not_an_editor) fall through to
      // fatal, as they must — retrying them would just loop.
      if (
        e.status === 403 &&
        (e.body as { error?: string } | undefined)?.error === "csrf_mismatch"
      ) {
        return { kind: "retry", reason: "csrf_mismatch" };
      }
      // 403, 404, 422, 428 etc. are non-retryable client errors — sending
      // the same payload again won't change the outcome. Carry the server's
      // own explanation alongside the status so the drawer can tell the user
      // *why* the save was refused instead of just "http 400" (issue #370).
      const serverReason = serverRefusalReason(e.body);
      return {
        kind: "fatal",
        reason: `http ${e.status}`,
        ...(serverReason !== undefined ? { serverReason } : {}),
      };
    }
    return { kind: "retry", reason: "network" };
  }
}

// Re-arm anything stuck mid-flight from a previous tab crash / hot reload.
// Without this, the drain filter (status === "pending") would skip ops that
// were transitioned to "in_flight" but never resolved. Age-gated on
// dispatchedAt so we never re-arm another live tab's in-flight request
// (the request can't outlast its timeout; see IN_FLIGHT_RECOVERY_AGE_MS).
// Records without dispatchedAt predate the field — recover them as before.
//
// Returns the soonest wall-clock at which a *young* (skipped) in-flight op
// becomes recovery-eligible, or undefined if there were none. drainPass uses
// it to self-schedule the next pass: without it, a save → reload within the
// recovery age leaves the op in_flight with no pending work and nothing arms
// a timer, so the edit stalls until an unrelated trigger (focus/online/new
// enqueue) fires after the age elapses.
async function recoverInFlight(): Promise<number | undefined> {
  const idb = await db();
  // Query the status index instead of scanning the whole store — only
  // in_flight ops are candidates here.
  const inFlight = (await idb
    .transaction(STORE, "readonly")
    .store.index("status")
    .getAll("in_flight")) as OutboxOp[];
  const now = Date.now();
  const stuck: OutboxOp[] = [];
  let soonestYoungEligibility: number | undefined;
  for (const o of inFlight) {
    if (o.dispatchedAt === undefined || now - o.dispatchedAt > IN_FLIGHT_RECOVERY_AGE_MS) {
      stuck.push(o);
    } else {
      // Skipped (another live tab may own it) — track when it would become
      // eligible so the caller can re-check then.
      const eligibleAt = o.dispatchedAt + IN_FLIGHT_RECOVERY_AGE_MS;
      if (soonestYoungEligibility === undefined || eligibleAt < soonestYoungEligibility) {
        soonestYoungEligibility = eligibleAt;
      }
    }
  }
  if (stuck.length === 0) return soonestYoungEligibility;
  const tx = idb.transaction(STORE, "readwrite");
  for (const o of stuck) {
    o.status = "pending";
    o.lastError = "recovered_from_in_flight";
    await tx.store.put(o);
  }
  await tx.done;
  return soonestYoungEligibility;
}

// A 200 means the server's version for this target just advanced; sibling
// ops queued behind the completed one still carry the old expectedVersion
// and would self-409 in a guaranteed cascade (offline double-save, AI-draft
// apply). Thread the confirmed version into them — with several siblings
// queued, each landing re-threads the rest. Skips `conflict` ops (those are
// owned by the user-resolve flow: drain won't pick them up, and
// resolveConflict overwrites expectedVersion anyway), max-attempts-failed ops
// (see eligibleForVersionThread — issue #487), and anything without a numeric
// version in the response (verse_status upserts, row deletes).
async function threadVersionToSiblings(done: OutboxOp, updated: unknown) {
  const version = (updated as { version?: unknown } | null | undefined)?.version;
  if (typeof version !== "number") return;
  const key = targetKey(done.target);
  const idb = await db();
  // Read AND write inside ONE readwrite tx. The old two-step (getAll in an
  // autocommit tx, then put in a new tx) raced the drain: between the read and
  // the write, drain could flip a sibling pending → in_flight, and re-threading
  // its version here would clobber that live op. Re-check status inside the tx
  // so we only thread ops still pending/failed (never an in_flight one).
  const tx = idb.transaction(STORE, "readwrite");
  const all = (await tx.store.getAll()) as OutboxOp[];
  // Verse ops: the sibling's content was diffed from a baseline that predates
  // the row the 200 just confirmed. Threading only the version would land that
  // stale content with a clean If-Match — refused by the server's alignment
  // guard, or worse, silently reverting the concurrent change (issue #564).
  // Rebase the sibling's text intent onto the confirmed row's content (the 200
  // body) instead. rebaseVersePatch is synchronous, so calling it between the
  // tx's IDB requests is safe. `refuse_thread` (an alignment_edit whose
  // baseline text no longer matches the server's) skips the sibling entirely:
  // it keeps its stale expectedVersion, 409s on dispatch, and surfaces the
  // conflict prompt for the user to decide — the conservative option, since
  // alignment_edit is guard-exempt and a verbatim auto-thread would silently
  // revert the text change.
  const serverContent =
    done.target.kind === "verse"
      ? (updated as { content?: unknown } | null | undefined)?.content
      : undefined;
  for (const o of all) {
    if (
      targetKey(o.target) === key &&
      eligibleForVersionThread(o) &&
      o.expectedVersion !== version
    ) {
      if (o.target.kind === "verse" && o.action === "patch") {
        const outcome = rebaseVersePatch(o.patch, serverContent);
        if (outcome.kind === "refuse_thread") continue;
        if (outcome.kind === "rebased") o.patch = outcome.patch;
      }
      o.expectedVersion = version;
      await tx.store.put(o);
    }
  }
  await tx.done;
}

// A reorder enqueues a patch whose only field is sort_order. Such patches are
// last-write-wins and must never raise a user-facing conflict — they auto-heal
// against the server's current version instead.
function isSortOrderOnlyPatch(patch: Record<string, unknown>): boolean {
  const keys = Object.keys(patch);
  return keys.length === 1 && keys[0] === "sort_order";
}

async function drainPass() {
  const youngInFlightEligibleAt = await recoverInFlight();
  // Targets this pass has itself just parked as conflict/retry-backoff
  // (below) — must stay blocked for the rest of the pass regardless of what
  // a later snapshot shows, since the backoff hasn't elapsed yet. This is
  // distinct from the per-iteration recompute below: unlike a live status
  // check, nothing will flip these back to pending mid-pass, so pinning is
  // correct here and doesn't reintroduce issue #515.
  const pinnedBlocked = new Set<string>();
  while (true) {
    // Offline — nothing can leave the machine, so dispatching would only
    // burn attempts against guaranteed failures. Park the queue (mirrors
    // the offline wait in fetchWithRetry.ts); the `online` listener below
    // re-drains the moment connectivity returns.
    if (typeof navigator !== "undefined" && navigator.onLine === false) break;
    const ops = await listAll();
    // Mark any target with a still-conflicted op as blocked, so we don't
    // pick up sibling pending ops with stale expectedVersion either. A
    // max-attempts-failed op blocks the same way (isMaxAttemptsBlocked —
    // issue #487): it WILL auto-revive with a stale expectedVersion, so a
    // younger pending sibling must not be allowed to land ahead of it and
    // then get silently reverted when the older op re-arms. Fatal
    // (non-revivable) failed ops are excluded from this — nothing will ever
    // re-send them, so blocking on them would freeze the target forever.
    //
    // Recomputed fresh from this iteration's snapshot every time (seeded
    // from pinnedBlocked, not accumulated into it) — issue #515: if
    // retry() or reviveMaxAttemptsFailed() flips a blocking op back to
    // pending while this pass is running, their own drain() call is a
    // no-op (a pass is already active), so this loop is the only thing
    // that will ever notice. A blocked set that only ever grew would keep
    // treating that target as blocked for the rest of the pass even after
    // its live status no longer justifies it, stranding the revived op
    // until some unrelated trigger fires.
    const blocked = new Set(pinnedBlocked);
    for (const o of ops) {
      if (o.status === "conflict" || isMaxAttemptsBlocked(o)) blocked.add(targetKey(o.target));
    }
    let next = ops.find(
      (o) => o.status === "pending" && !blocked.has(targetKey(o.target)),
    );
    if (!next) {
      // No pending work, but recoverInFlight skipped a young in-flight op
      // (its dispatching tab may have crashed/reloaded). Nothing else will
      // re-check it — the retry-backoff and online/focus triggers only fire
      // on other events — so schedule a pass for when it becomes recovery-
      // eligible, plus a small margin to clear the age threshold. This keeps
      // the retry chain self-continuing instead of stalling for the full age.
      if (youngInFlightEligibleAt !== undefined) {
        scheduleDrain(Math.max(0, youngInFlightEligibleAt - Date.now()) + 250);
      }
      break;
    }
    // Re-read the record fresh inside the same readwrite tx that flips it
    // in_flight, rather than trusting the snapshot listAll() handed us. A
    // verse-status coalesce (enqueueVerseStatus) may have rewritten this op's
    // payload after listAll() read it; dispatching the stale `next` would
    // ship the pre-coalesce value and the toggle would be lost. Re-reading
    // here picks up the coalesced payload; if the op vanished or is no longer
    // pending (another path claimed it), skip and re-loop.
    const tx = (await db()).transaction(STORE, "readwrite");
    const fresh = (await tx.store.get(next.id)) as OutboxOp | undefined;
    if (!fresh || fresh.status !== "pending") {
      await tx.done;
      continue;
    }
    fresh.status = "in_flight";
    fresh.attempts += 1;
    fresh.dispatchedAt = Date.now();
    await tx.store.put(fresh);
    await tx.done;
    next = fresh;
    void notify();

    let result: Result;
    try {
      result = await dispatch(next);
    } catch (err) {
      result = { kind: "retry", reason: `dispatch_threw: ${String(err)}` };
    }

    // Display-only server explanation for a refusal. Set on every result so a
    // reason from an earlier attempt can't linger on an op that has since
    // failed for a different cause (or is merely retrying).
    next.lastErrorReason = reasonForOp(result);

    // Persist the new status *before* notifying listeners. If a put() or
    // delete() throws, the catch below resets the op to pending so it
    // doesn't strand at in_flight. `persisted` records which of those two
    // happened, so the listener dispatch below can tell a genuine terminal
    // exit from one that got walked back (issue #570).
    let persisted = true;
    try {
      if (result.kind === "ok") {
        await (await db()).delete(STORE, next.id);
        // Best-effort only, and outside the persist-recovery catch's reach:
        // a threading failure must not resurrect the just-completed op.
        try {
          await threadVersionToSiblings(next, result.updated);
        } catch {
          /* siblings keep their stale version and resolve via the 409 flow */
        }
      } else if (result.kind === "locked") {
        // The chapter is mid-pipeline; the auto-apply will overwrite this
        // row anyway. Drop the op and let the listener surface a toast.
        await (await db()).delete(STORE, next.id);
      } else if (result.kind === "conflict") {
        const serverVersion = (result.current as { version?: unknown } | null | undefined)
          ?.version;
        // Two classes of 409 auto-heal against the server's version instead of
        // prompting: (1) a reorder-only patch (sort_order is last-write-wins,
        // positional metadata), and (2) a content patch whose change doesn't
        // genuinely conflict with the server's current row — the version
        // advanced for an unrelated reason (another field/tab, a bit-toggle, a
        // reimport) or our edit already landed. Only true conflicts (the server
        // changed a field we're also editing, to a different value) prompt.
        const sortOrderOnly =
          next.target.kind === "row" &&
          next.action === "patch" &&
          isSortOrderOnlyPatch(next.patch);
        const nonConflictingContent =
          next.target.kind === "row" &&
          next.action === "patch" &&
          !sortOrderOnly &&
          classifyRowPatchConflict(
            next.patch,
            next.baseline,
            result.current as Record<string, unknown>,
          ) === "auto_heal";
        if (
          (sortOrderOnly || nonConflictingContent) &&
          typeof serverVersion === "number" &&
          (next.conflictRetries ?? 0) < MAX_CONFLICT_AUTOHEAL
        ) {
          // Spurious mismatch — re-arm against the server's version and retry
          // silently rather than surfacing a conflict. Don't block the target:
          // it stays drainable so this pass picks it straight back up. On retry
          // the PATCH only rewrites our own fields, so an unrelated concurrent
          // change on the same row is preserved (field-level merge).
          next.status = "pending";
          next.expectedVersion = serverVersion;
          next.conflictRetries = (next.conflictRetries ?? 0) + 1;
          next.conflictCurrent = undefined;
          next.lastError = sortOrderOnly ? "sort_order_autoheal" : "nonconflict_autoheal";
          await (await db()).put(STORE, next);
        } else {
          next.status = "conflict";
          next.conflictCurrent = result.current;
          next.lastError = "version_mismatch";
          await (await db()).put(STORE, next);
          pinnedBlocked.add(targetKey(next.target));
        }
      } else if (result.kind === "retry") {
        // Only genuine server errors (`transient NNN`) consume the
        // MAX_ATTEMPTS cap. Network failures (`network`, `dispatch_threw`)
        // and auth retries (`auth 401`) recur for as long as the laptop is
        // offline or the session is dead — parking those as `failed` would
        // strand real edits behind a no-confirm discard button.
        const capEligible = result.reason.startsWith("transient");
        if (capEligible) next.hardAttempts = (next.hardAttempts ?? 0) + 1;
        if (capEligible && (next.hardAttempts ?? 0) >= MAX_ATTEMPTS) {
          // Out of retries — promote to `failed` so the UI can surface
          // it. `attempts` carries the count so the drawer can show how
          // long we tried before giving up.
          next.status = "failed";
          next.lastError = MAX_ATTEMPTS_SENTINEL;
          await (await db()).put(STORE, next);
        } else {
          next.status = "pending";
          next.lastError = result.reason;
          await (await db()).put(STORE, next);
          scheduleDrain(backoffMs(next.attempts));
          pinnedBlocked.add(targetKey(next.target));
        }
      } else {
        next.status = "failed";
        next.lastError = result.reason;
        await (await db()).put(STORE, next);
      }
    } catch (persistErr) {
      persisted = false;
      // Best-effort recovery — if IndexedDB itself failed, the op may be
      // half-written. Force pending so the next drain pass tries again.
      try {
        next.status = "pending";
        next.lastError = `persist_failed: ${String(persistErr)}`;
        // The refusal reason belongs to the result we failed to persist — this
        // op is going back on the queue, so it must not carry an explanation
        // for an outcome that was never recorded.
        next.lastErrorReason = undefined;
        await (await db()).put(STORE, next);
      } catch {
        /* nothing we can do; will be picked up by recoverInFlight on reload */
      }
    }

    if (shouldAnnounceResult(result.kind, persisted)) {
      for (const l of resultListeners) l(next, result);
    }
    void notify();
  }
}

export async function drain() {
  if (draining) {
    // A pass is active. Request a re-run instead of dropping the wakeup —
    // the running pass's final listAll() may already have resolved, so the
    // op that prompted this call could be invisible to it.
    drainRequested = true;
    return;
  }
  draining = true;
  try {
    // Cross-tab mutual exclusion. Two tabs share one IndexedDB store; both
    // draining at once double-PATCHes the same ops. ifAvailable means we
    // never queue behind the other tab — if it holds the lock it's already
    // doing our work; check back shortly in case it closes mid-queue.
    if (typeof navigator !== "undefined" && navigator.locks) {
      const acquired = await navigator.locks.request(
        "be-outbox-drain",
        { ifAvailable: true },
        async (lock) => {
          if (!lock) return false;
          await drainPass();
          // Consume queued wakeups while the lock is still held, so the
          // re-pass keeps the cross-tab exclusion drainPass relies on.
          while (drainRequested) {
            drainRequested = false;
            await drainPass();
          }
          return true;
        },
      );
      if (!acquired) scheduleDrain(3000);
    } else {
      // No Web Locks (very old browser) — fall back to single-tab behavior.
      await drainPass();
      while (drainRequested) {
        drainRequested = false;
        await drainPass();
      }
    }
  } finally {
    draining = false;
    void notify();
    // A wakeup can still land in the awaits between the re-pass loop above
    // and this line (lock release, promise resolution). `draining` is false
    // again now, so a fresh drain() re-acquires the lock and handles it.
    if (drainRequested) {
      drainRequested = false;
      void drain();
    }
  }
}

function scheduleDrain(ms: number) {
  const at = Date.now() + ms;
  if (drainTimer) {
    // Keep the pending timer when it fires no later than the new request —
    // clearing it unconditionally let a longer reschedule silently push out
    // an already-due retry (see drainTimerAt).
    if (at >= drainTimerAt) return;
    clearTimeout(drainTimer);
  }
  drainTimerAt = at;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    drainTimerAt = 0;
    void drain();
  }, ms);
}

// Ops that exhausted MAX_ATTEMPTS get a fresh retry budget when the world
// genuinely changes — connectivity returns or the session is refreshed.
// Without this, ~10 minutes of bad luck would park edits as `failed`
// forever (drain only picks up `pending`), one discard click from gone.
async function reviveMaxAttemptsFailed() {
  const idb = await db();
  // Read AND write inside ONE readwrite tx (same shape as resolveConflict).
  // The old two-step (index read in a readonly tx, puts in a new tx) raced
  // drop(): a user's Discard could delete the record in the gap, and the put
  // here would RE-CREATE it as pending — a user-discarded edit saving to the
  // server. Re-check status + the revivable predicate on the freshly-read
  // records inside the tx so we only revive ops still parked as failed.
  const tx = idb.transaction(STORE, "readwrite");
  // Only `failed` ops are candidates — query the status index rather than
  // scanning the whole store.
  const failedOps = (await tx.store.index("status").getAll("failed")) as OutboxOp[];
  // Same predicate the failed-ops panel uses to label an op "still trying" —
  // imported, not re-tested, so the label can never outlive the behaviour.
  const revivable = failedOps.filter(
    (o) => o.status === "failed" && willRetryOnItsOwn(o.lastError),
  );
  if (revivable.length === 0) {
    await tx.done;
    return;
  }
  for (const o of revivable) {
    o.status = "pending";
    o.attempts = 0;
    o.hardAttempts = 0;
    o.lastError = undefined;
    o.lastErrorReason = undefined;
    await tx.store.put(o);
  }
  await tx.done;
  void notify();
}

async function reviveAndDrain() {
  await reviveMaxAttemptsFailed();
  await drain();
}

// Drain on focus / online so a sleeping tab catches up on wake. Also kick
// off an initial drain (which runs recoverInFlight first) so any ops left
// stranded by a previous tab crash get re-armed at startup.
if (typeof window !== "undefined") {
  window.addEventListener("online", () => void reviveAndDrain());
  // Focus revives too, not just drains. A run of 5xx can exhaust the retry
  // cap while the laptop never goes offline and the session never refreshes —
  // and `online` / onAuthRefreshed were the only two revival triggers, so
  // those ops sat as `failed` forever with nothing left to retry them. The
  // failed-ops panel tells the user they "keep trying on their own", which
  // has to be true: coming back to the tab is the moment to re-check.
  window.addEventListener("focus", () => void reviveAndDrain());
  // A successful silent refresh means auth-stalled ops can move again.
  onAuthRefreshed(() => void reviveAndDrain());
  void drain();
}
