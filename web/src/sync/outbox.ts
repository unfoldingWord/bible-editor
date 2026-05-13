// Write-ahead outbox: every user edit is durably queued in IndexedDB before
// it leaves the browser. A drain worker pops in order and dispatches to the
// API; on 200 the op is removed, on 409 the conflict is surfaced, on
// network/auth failures the op stays until the next drain tick. This is the
// single feature that keeps the editor safe from network blips and tab
// crashes — see docs/plan.md "Save protocol".

import { openDB, type IDBPDatabase } from "idb";
import { api, ApiError, type RowKind } from "./api";

const DB_NAME = "bible-editor-outbox";
const DB_VERSION = 1;
const STORE = "ops";

export interface RowTarget {
  kind: "row";
  rowKind: RowKind;
  id: string;
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
  attempts: number;
  status: OpStatus;
  lastError?: string;
  conflictCurrent?: unknown;
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
  return (await tx.store.index("queuedAt").getAll()) as OutboxOp[];
}

async function notify() {
  if (subscribers.size === 0) return;
  const all = await listAll();
  for (const s of subscribers) s(all);
}

function uid() {
  // crypto.randomUUID is universally available in modern browsers / workers.
  return crypto.randomUUID();
}

// Two ops belong to the same target iff they touch the same row/verse. A
// conflict on one of them must not block ops to *other* targets — but it
// must keep blocking siblings, since the user's expectedVersion is stale
// for them too.
function targetKey(t: OpTarget): string {
  if (t.kind === "row") return `row:${t.rowKind}:${t.id}`;
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
    opts?: { restoredFromVersion?: number },
  ): Promise<OutboxOp> {
    const op: OutboxOp = {
      id: uid(),
      target: { kind: "row", rowKind, id },
      action: "patch",
      patch,
      expectedVersion,
      queuedAt: Date.now(),
      attempts: 0,
      status: "pending",
      ...(opts?.restoredFromVersion !== undefined
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
  ): Promise<OutboxOp> {
    const op: OutboxOp = {
      id: uid(),
      target: { kind: "row", rowKind, id },
      action: "delete",
      patch: {},
      expectedVersion,
      queuedAt: Date.now(),
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
    const op: OutboxOp = {
      id: uid(),
      target: { kind: "verse", book, chapter, verse, bibleVersion },
      action: "patch",
      patch: patch as Record<string, unknown>,
      expectedVersion,
      queuedAt: Date.now(),
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
    const idb = await db();
    const key = `vstatus:${book}:${chapter}:${verse}`;
    const all = (await idb.getAll(STORE)) as OutboxOp[];
    const pending = all.find(
      (o) => targetKey(o.target) === key && (o.status === "pending" || o.status === "in_flight"),
    );
    if (pending) {
      // Coalesce: rewrite the existing op's payload rather than queue a
      // second one that would just race to overwrite the first.
      pending.patch = { done };
      pending.queuedAt = Date.now();
      await idb.put(STORE, pending);
      void notify();
      void drain();
      return pending;
    }
    const op: OutboxOp = {
      id: uid(),
      target: { kind: "verse_status", book, chapter, verse },
      action: "patch",
      patch: { done },
      expectedVersion: 0,
      queuedAt: Date.now(),
      attempts: 0,
      status: "pending",
    };
    await idb.put(STORE, op);
    void notify();
    void drain();
    return op;
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
  | { kind: "fatal"; reason: string };

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
        );
      } else {
        updated = await api.patchRow(
          op.target.rowKind,
          op.target.id,
          op.expectedVersion,
          op.patch,
          op.restoredFromVersion !== undefined
            ? { restoredFromVersion: op.restoredFromVersion }
            : undefined,
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
      // 403, 404, 422, 428 etc. are non-retryable client errors — sending
      // the same payload again won't change the outcome.
      return { kind: "fatal", reason: `http ${e.status}` };
    }
    return { kind: "retry", reason: "network" };
  }
}

// Re-arm anything stuck mid-flight from a previous tab crash / hot reload.
// Without this, the drain filter (status === "pending") would skip ops that
// were transitioned to "in_flight" but never resolved.
async function recoverInFlight() {
  const idb = await db();
  const all = (await idb.getAll(STORE)) as OutboxOp[];
  const stuck = all.filter((o) => o.status === "in_flight");
  if (stuck.length === 0) return;
  const tx = idb.transaction(STORE, "readwrite");
  for (const o of stuck) {
    o.status = "pending";
    o.lastError = "recovered_from_in_flight";
    await tx.store.put(o);
  }
  await tx.done;
}

export async function drain() {
  if (draining) return;
  draining = true;
  try {
    await recoverInFlight();
    // Targets with an unresolved conflict are skipped for *this* pass but
    // we keep draining other targets so a single hot row doesn't freeze
    // the entire queue.
    const blocked = new Set<string>();
    while (true) {
      const ops = await listAll();
      // Mark any target with a still-conflicted op as blocked, so we don't
      // pick up sibling pending ops with stale expectedVersion either.
      for (const o of ops) {
        if (o.status === "conflict") blocked.add(targetKey(o.target));
      }
      const next = ops.find(
        (o) => o.status === "pending" && !blocked.has(targetKey(o.target)),
      );
      if (!next) break;
      next.status = "in_flight";
      next.attempts += 1;
      await (await db()).put(STORE, next);
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
        } else if (result.kind === "conflict") {
          next.status = "conflict";
          next.conflictCurrent = result.current;
          next.lastError = "version_mismatch";
          await (await db()).put(STORE, next);
          blocked.add(targetKey(next.target));
        } else if (result.kind === "retry") {
          next.status = "pending";
          next.lastError = result.reason;
          await (await db()).put(STORE, next);
          scheduleDrain(backoffMs(next.attempts));
          blocked.add(targetKey(next.target));
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
  } finally {
    draining = false;
    void notify();
  }
}

function backoffMs(attempts: number) {
  // Exponential up to 30s.
  return Math.min(30_000, 250 * 2 ** Math.max(0, attempts - 1));
}

function scheduleDrain(ms: number) {
  if (drainTimer) clearTimeout(drainTimer);
  drainTimer = setTimeout(() => {
    drainTimer = null;
    void drain();
  }, ms);
}

// Drain on focus / online so a sleeping tab catches up on wake. Also kick
// off an initial drain (which runs recoverInFlight first) so any ops left
// stranded by a previous tab crash get re-armed at startup.
if (typeof window !== "undefined") {
  window.addEventListener("online", () => void drain());
  window.addEventListener("focus", () => void drain());
  void drain();
}
