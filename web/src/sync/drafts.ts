// Local draft store for unsaved edits. Every editable field (ULT/UST verse,
// TN/TQ/TWL row, note quote/body/support-ref) stashes its in-progress text
// here on every keystroke. The outbox is NOT touched until the user clicks
// Save — drafts are deliberately separate from the write-ahead queue so the
// only thing that produces a PATCH is an explicit user action.
//
// Persistence is IndexedDB so a tab close or crash doesn't lose typing.
// This is not autosave; nothing leaves the browser until the user saves.

import { openDB, type IDBPDatabase } from "idb";
import { isReadOnly, type RowKind } from "./api";
import { onOutboxResult } from "./outbox";
import { generationForSuccessfulOp } from "./draftSaveState";
import { unpinVerseBase } from "./versePin";
export { pinVerseBase, peekPinnedVerseBase } from "./versePin";

const DB_NAME = "bible-editor-drafts";
const DB_VERSION = 1;
const STORE = "drafts";

export interface VerseDraftPayload {
  content: unknown;
  plain_text?: string | null;
}

export type DraftPayload = VerseDraftPayload | Record<string, unknown>;

export interface DraftRecord {
  key: string;
  payload: DraftPayload;
  expectedVersion: number;
  updatedAt: number;
  // Opaque identity for this exact draft write. A save carries the generation
  // it captured into the outbox so its eventual 200 only clears that draft,
  // never newer typing on the same verse that arrived while the request was in
  // flight. Optional for records persisted before this field was introduced;
  // those use a stable legacy identity derived from updatedAt.
  generation?: string;
  // Denormalized so subscribers (UnsavedToasts, SyncStatusBar) can render
  // "Save Num 20:1 ULT?" without parsing the key. Verse drafts carry
  // book/chapter/verse/bibleVersion; row drafts carry kind/id/book.
  meta: DraftMeta;
}

export type DraftMeta =
  | {
      kind: "verse";
      book: string;
      chapter: number;
      verse: number;
      bibleVersion: string;
    }
  | {
      kind: "row";
      rowKind: RowKind;
      id: string;
      book: string;
      chapter: number;
      verse: number;
    };

type Subscriber = (drafts: DraftRecord[]) => void;

let dbp: Promise<IDBPDatabase> | null = null;
function db() {
  if (!dbp) {
    dbp = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: "key" });
        }
      },
    });
  }
  return dbp;
}

const subscribers = new Set<Subscriber>();

// Synchronous mirror of "a draft was written this session and not yet cleared".
// The subscription-driven signal (useUnsavedGuard's hasDrafts) only updates
// after an async listAll()+notify round-trip, which lags the set() call — a
// reload in that window (before the IndexedDB write even commits) would slip
// past the unsaved-work guard. set()/clear() keep this Set in lockstep
// synchronously so beforeunload can read a live answer. It only covers drafts
// touched THIS session; prior-session persisted drafts are covered by the async
// subscription (and survive the reload regardless, so a missed prompt there is
// not data loss).
const pendingKeys = new Set<string>();
const latestGenerationByKey = new Map<string, string>();
let generationSeq = 0;

function nextGeneration(): string {
  generationSeq += 1;
  return `${Date.now()}:${generationSeq}:${Math.random().toString(36).slice(2)}`;
}

export function hasUnsavedDrafts(): boolean {
  return pendingKeys.size > 0;
}

async function listAll(): Promise<DraftRecord[]> {
  const all = (await (await db()).getAll(STORE)) as DraftRecord[];
  all.sort((a, b) => a.updatedAt - b.updatedAt);
  return all;
}

async function notify() {
  if (subscribers.size === 0) return;
  const all = await listAll();
  for (const s of subscribers) s(all);
}

export function verseKey(
  book: string,
  chapter: number,
  verse: number,
  bibleVersion: string,
): string {
  return `verse:${book}:${chapter}:${verse}:${bibleVersion}`;
}

// Row ids are only unique per (book, id) — the same 4-char id can exist in
// two books with unrelated content — so the key must carry the book or
// cross-book drafts collide (wrong text shown/saved). Pre-book records
// ("row:{kind}:{id}") are migrated lazily in get() below.
export function rowKey(rowKind: RowKind, book: string, id: string): string {
  return `row:${rowKind}:${book}:${id}`;
}

export const drafts = {
  subscribe(fn: Subscriber): () => void {
    subscribers.add(fn);
    void listAll().then(fn);
    return () => subscribers.delete(fn);
  },

  async set(
    key: string,
    payload: DraftPayload,
    expectedVersion: number,
    meta: DraftMeta,
  ): Promise<void> {
    if (isReadOnly()) return;
    // Mark dirty synchronously — before the async put — so the unload guard
    // sees it during the commit window (see pendingKeys).
    pendingKeys.add(key);
    const generation = nextGeneration();
    latestGenerationByKey.set(key, generation);
    const rec: DraftRecord = {
      key,
      payload,
      expectedVersion,
      updatedAt: Date.now(),
      generation,
      meta,
    };
    await (await db()).put(STORE, rec);
    void notify();
  },

  async get(key: string): Promise<DraftRecord | undefined> {
    const idb = await db();
    const rec = (await idb.get(STORE, key)) as DraftRecord | undefined;
    if (rec) return rec;
    // One-time tolerance for the pre-book row key format ("row:{kind}:{id}").
    // On a miss, check whether a legacy record exists whose meta says it
    // belongs to this book; if so, migrate it under the new key. A legacy
    // record for the *other* book in a collision stays put until that book's
    // card claims it.
    const m = /^row:([^:]+):([^:]+):(.+)$/.exec(key);
    if (!m) return undefined;
    const [, rowKind, book, id] = m;
    const legacyKey = `row:${rowKind}:${id}`;
    const legacy = (await idb.get(STORE, legacyKey)) as DraftRecord | undefined;
    if (!legacy || legacy.meta.kind !== "row" || legacy.meta.book !== book) {
      return undefined;
    }
    const migrated: DraftRecord = { ...legacy, key };
    pendingKeys.delete(legacyKey);
    pendingKeys.add(key);
    await idb.put(STORE, migrated);
    await idb.delete(STORE, legacyKey);
    void notify();
    return migrated;
  },

  async clear(key: string): Promise<void> {
    pendingKeys.delete(key);
    latestGenerationByKey.delete(key);
    unpinVerseBase(key);
    await (await db()).delete(STORE, key);
    void notify();
  },

  // Delete only the exact draft generation that produced a successful save.
  // The read + conditional delete share one transaction so another committed
  // write cannot slip between them. latestGenerationByKey also covers a newer
  // set() that has started synchronously but has not committed to IndexedDB yet.
  async clearGeneration(key: string, generation: string): Promise<boolean> {
    const idb = await db();
    const tx = idb.transaction(STORE, "readwrite");
    const rec = (await tx.store.get(key)) as DraftRecord | undefined;
    const currentGeneration = rec?.generation ?? (rec ? `legacy:${rec.updatedAt}` : undefined);
    if (!rec || currentGeneration !== generation) {
      await tx.done;
      return false;
    }
    await tx.store.delete(key);
    await tx.done;
    if (latestGenerationByKey.get(key) === generation) {
      latestGenerationByKey.delete(key);
      pendingKeys.delete(key);
      unpinVerseBase(key);
    }
    void notify();
    return true;
  },

  async list(): Promise<DraftRecord[]> {
    return listAll();
  },
};

// Emotion/sx fragment for the orange "you have unsaved typing here" border.
// Targets any descendant marked `data-dirty="true"` that isn't currently
// focused — quiet while typing, loud once you click away. The inset
// box-shadow draws inside the existing border so layout doesn't shift.
// Use the literal warning color (Kindle / #E59D33) so this object stays
// theme-agnostic and can spread into any sx block.
export function draftDirtyBorderSx() {
  return {
    "& [data-dirty='true']:not(:focus)": {
      boxShadow: "inset 0 0 0 2px #E59D33",
    },
  } as const;
}

// Auto-clear the draft when the outbox confirms its corresponding PATCH
// landed. Anything other than a 200 keeps the draft so the user can retry
// or hand-edit. 409 is special — the user resolves via SyncStatusBar; the
// draft survives so the next retry has the right payload.
onOutboxResult((op, result) => {
  if (result.kind !== "ok") return;
  if (op.target.kind === "verse") {
    const key = verseKey(op.target.book, op.target.chapter, op.target.verse, op.target.bibleVersion);
    void drafts.get(key).then((draft) => {
      const generation = generationForSuccessfulOp(draft, op);
      if (generation) void drafts.clearGeneration(key, generation);
    });
  } else if (op.target.kind === "row") {
    void drafts.clear(rowKey(op.target.rowKind, op.target.book, op.target.id));
  }
});
