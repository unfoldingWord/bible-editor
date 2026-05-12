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
export type OpTarget = RowTarget | VerseTarget;

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

  async resolveConflict(opId: string, newExpectedVersion: number) {
    const op = (await (await db()).get(STORE, opId)) as OutboxOp | undefined;
    if (!op) return;
    op.expectedVersion = newExpectedVersion;
    op.status = "pending";
    op.conflictCurrent = undefined;
    await (await db()).put(STORE, op);
    void notify();
    void drain();
  },

  async drop(opId: string) {
    await (await db()).delete(STORE, opId);
    void notify();
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
        );
      }
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
      if (e.status === 401 || e.status === 403) {
        return { kind: "retry", reason: `auth ${e.status}` };
      }
      if (e.status >= 500) {
        return { kind: "retry", reason: `server ${e.status}` };
      }
      return { kind: "fatal", reason: `http ${e.status}` };
    }
    return { kind: "retry", reason: "network" };
  }
}

export async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (true) {
      const ops = await listAll();
      const next = ops.find((o) => o.status === "pending");
      if (!next) break;
      next.status = "in_flight";
      next.attempts += 1;
      await (await db()).put(STORE, next);
      void notify();

      const result = await dispatch(next);
      for (const l of resultListeners) l(next, result);

      if (result.kind === "ok") {
        await (await db()).delete(STORE, next.id);
      } else if (result.kind === "conflict") {
        next.status = "conflict";
        next.conflictCurrent = result.current;
        next.lastError = "version_mismatch";
        await (await db()).put(STORE, next);
        // Don't continue draining past a conflict — wait for the UI to resolve it.
        void notify();
        break;
      } else if (result.kind === "retry") {
        next.status = "pending";
        next.lastError = result.reason;
        await (await db()).put(STORE, next);
        scheduleDrain(backoffMs(next.attempts));
        void notify();
        break;
      } else {
        next.status = "failed";
        next.lastError = result.reason;
        await (await db()).put(STORE, next);
        void notify();
      }
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

// Drain on focus / online so a sleeping tab catches up on wake.
if (typeof window !== "undefined") {
  window.addEventListener("online", () => void drain());
  window.addEventListener("focus", () => void drain());
}
