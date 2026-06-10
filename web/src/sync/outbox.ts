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
  type RowKind,
} from "./api";
import { backoffMs } from "./backoff";

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

// sort_order is a transient, last-write-wins field (see api/src/rows.ts —
// "transient fields like sort_order"). A version mismatch on a reorder-only
// patch should never surface a conflict prompt; we silently re-arm against the
// server's current version and retry. This cap stops a pathological loop if
// another writer is bumping the same row faster than we can land — beyond it,
// fall through to the normal conflict flow.
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
export type OpTarget = RowTarget | VerseTarget | VerseStatusTarget;

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
  conflictCurrent?: unknown;
  // Count of silent re-arms after a sort_order-only 409 (see
  // MAX_CONFLICT_AUTOHEAL). Absent = 0.
  conflictRetries?: number;
  // Set when this patch came from "switch to v{N}" in the history dialog.
  // The server stores it on the new edit_log entry + the row's column so
  // the UI can label the chip v{N} even though row.version is now N+1.
  restoredFromVersion?: number;
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
async function notify() {
  if (subscribers.size === 0) return;
  if (notifyScheduled) return;
  notifyScheduled = true;
  await Promise.resolve();
  notifyScheduled = false;
  if (subscribers.size === 0) return;
  const all = await listAll();
  for (const s of subscribers) s(all);
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

// Two ops belong to the same target iff they touch the same row/verse. A
// conflict on one of them must not block ops to *other* targets — but it
// must keep blocking siblings, since the user's expectedVersion is stale
// for them too.
function targetKey(t: OpTarget): string {
  if (t.kind === "row") return `row:${t.rowKind}:${t.book}:${t.id}`;
  if (t.kind === "verse_status") return `vstatus:${t.book}:${t.chapter}:${t.verse}`;
  return `verse:${t.book}:${t.chapter}:${t.verse}:${t.bibleVersion}`;
}

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
    opts: { restoredFromVersion?: number; book: string },
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
    patch: { content: unknown; plain_text?: string | null },
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

  // Re-arm a conflicted op against the freshly-observed server version. Also
  // resets every op for the same target so a single user resolution doesn't
  // cascade-conflict the queue (otherwise N edits to one row produce N
  // prompts for what was logically one upstream change).
  async resolveConflict(opId: string, newExpectedVersion: number) {
    const idb = await db();
    const op = (await idb.get(STORE, opId)) as OutboxOp | undefined;
    if (!op) return;
    const key = targetKey(op.target);
    const all = (await idb.getAll(STORE)) as OutboxOp[];
    const tx = idb.transaction(STORE, "readwrite");
    for (const o of all) {
      if (targetKey(o.target) !== key) continue;
      if (o.status === "conflict" || o.status === "pending") {
        o.expectedVersion = newExpectedVersion;
        o.status = "pending";
        o.conflictCurrent = undefined;
        await tx.store.put(o);
      }
    }
    await tx.done;
    void notify();
    void drain();
  },

  async drop(opId: string) {
    await (await db()).delete(STORE, opId);
    void notify();
    void drain();
  },

  // User-driven recovery for a `failed` op (typically one that hit
  // max_attempts_exceeded against a transient back-end issue that has since
  // cleared). Resets the attempt counter so it gets a full retry budget,
  // not just one more shot before re-failing.
  async retry(opId: string) {
    const idb = await db();
    const op = (await idb.get(STORE, opId)) as OutboxOp | undefined;
    if (!op) return;
    op.status = "pending";
    op.attempts = 0;
    op.hardAttempts = 0;
    op.lastError = undefined;
    await idb.put(STORE, op);
    void notify();
    void drain();
  },

  async list(): Promise<OutboxOp[]> {
    return listAll();
  },
};

// ---------- drain ----------

let draining = false;
let drainTimer: ReturnType<typeof setTimeout> | null = null;

type Result =
  | { kind: "ok"; updated: unknown }
  | { kind: "conflict"; current: unknown }
  | { kind: "retry"; reason: string }
  | { kind: "fatal"; reason: string }
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
      // retry rather than failing it permanently. read_only 403s carry no
      // `error` body and fall through to fatal, as they must (they'd loop).
      if (
        e.status === 403 &&
        (e.body as { error?: string } | undefined)?.error === "csrf_mismatch"
      ) {
        return { kind: "retry", reason: "csrf_mismatch" };
      }
      // 403, 404, 422, 428 etc. are non-retryable client errors — sending
      // the same payload again won't change the outcome.
      return { kind: "fatal", reason: `http ${e.status}` };
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
// resolveConflict overwrites expectedVersion anyway) and anything without a
// numeric version in the response (verse_status upserts, row deletes).
async function threadVersionToSiblings(done: OutboxOp, updated: unknown) {
  const version = (updated as { version?: unknown } | null | undefined)?.version;
  if (typeof version !== "number") return;
  const key = targetKey(done.target);
  const idb = await db();
  const all = (await idb.getAll(STORE)) as OutboxOp[];
  const siblings = all.filter(
    (o) =>
      targetKey(o.target) === key &&
      (o.status === "pending" || o.status === "failed") &&
      o.expectedVersion !== version,
  );
  if (siblings.length === 0) return;
  const tx = idb.transaction(STORE, "readwrite");
  for (const o of siblings) {
    o.expectedVersion = version;
    await tx.store.put(o);
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
  // Targets with an unresolved conflict are skipped for *this* pass but
  // we keep draining other targets so a single hot row doesn't freeze
  // the entire queue.
  const blocked = new Set<string>();
  while (true) {
    // Offline — nothing can leave the machine, so dispatching would only
    // burn attempts against guaranteed failures. Park the queue (mirrors
    // the offline wait in fetchWithRetry.ts); the `online` listener below
    // re-drains the moment connectivity returns.
    if (typeof navigator !== "undefined" && navigator.onLine === false) break;
    const ops = await listAll();
    // Mark any target with a still-conflicted op as blocked, so we don't
    // pick up sibling pending ops with stale expectedVersion either.
    for (const o of ops) {
      if (o.status === "conflict") blocked.add(targetKey(o.target));
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

    // Persist the new status *before* notifying listeners. If a put() or
    // delete() throws, the catch below resets the op to pending so it
    // doesn't strand at in_flight.
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
        if (
          next.target.kind === "row" &&
          next.action === "patch" &&
          isSortOrderOnlyPatch(next.patch) &&
          typeof serverVersion === "number" &&
          (next.conflictRetries ?? 0) < MAX_CONFLICT_AUTOHEAL
        ) {
          // Reorder-only mismatch — re-arm against the server's version and
          // retry silently rather than surfacing a conflict. Don't block the
          // target: it stays drainable so this pass picks it straight back up.
          next.status = "pending";
          next.expectedVersion = serverVersion;
          next.conflictRetries = (next.conflictRetries ?? 0) + 1;
          next.conflictCurrent = undefined;
          next.lastError = "sort_order_autoheal";
          await (await db()).put(STORE, next);
        } else {
          next.status = "conflict";
          next.conflictCurrent = result.current;
          next.lastError = "version_mismatch";
          await (await db()).put(STORE, next);
          blocked.add(targetKey(next.target));
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
          next.lastError = "max_attempts_exceeded";
          await (await db()).put(STORE, next);
        } else {
          next.status = "pending";
          next.lastError = result.reason;
          await (await db()).put(STORE, next);
          scheduleDrain(backoffMs(next.attempts));
          blocked.add(targetKey(next.target));
        }
      } else {
        next.status = "failed";
        next.lastError = result.reason;
        await (await db()).put(STORE, next);
      }
    } catch (persistErr) {
      // Best-effort recovery — if IndexedDB itself failed, the op may be
      // half-written. Force pending so the next drain pass tries again.
      try {
        next.status = "pending";
        next.lastError = `persist_failed: ${String(persistErr)}`;
        await (await db()).put(STORE, next);
      } catch {
        /* nothing we can do; will be picked up by recoverInFlight on reload */
      }
    }

    for (const l of resultListeners) l(next, result);
    void notify();
  }
}

export async function drain() {
  if (draining) return;
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
          return true;
        },
      );
      if (!acquired) scheduleDrain(3000);
    } else {
      // No Web Locks (very old browser) — fall back to single-tab behavior.
      await drainPass();
    }
  } finally {
    draining = false;
    void notify();
  }
}

function scheduleDrain(ms: number) {
  if (drainTimer) clearTimeout(drainTimer);
  drainTimer = setTimeout(() => {
    drainTimer = null;
    void drain();
  }, ms);
}

// Ops that exhausted MAX_ATTEMPTS get a fresh retry budget when the world
// genuinely changes — connectivity returns or the session is refreshed.
// Without this, ~10 minutes of bad luck would park edits as `failed`
// forever (drain only picks up `pending`), one discard click from gone.
async function reviveMaxAttemptsFailed() {
  const idb = await db();
  // Only `failed` ops are candidates — query the status index rather than
  // scanning the whole store.
  const failedOps = (await idb
    .transaction(STORE, "readonly")
    .store.index("status")
    .getAll("failed")) as OutboxOp[];
  const revivable = failedOps.filter(
    (o) => o.lastError === "max_attempts_exceeded",
  );
  if (revivable.length === 0) return;
  const tx = idb.transaction(STORE, "readwrite");
  for (const o of revivable) {
    o.status = "pending";
    o.attempts = 0;
    o.hardAttempts = 0;
    o.lastError = undefined;
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
  window.addEventListener("focus", () => void drain());
  // A successful silent refresh means auth-stalled ops can move again.
  onAuthRefreshed(() => void reviveAndDrain());
  void drain();
}
