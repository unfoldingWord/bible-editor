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
import { onOutboxDiscard, onOutboxResult, type OutboxOp } from "./outbox";
import {
  pinReleaseForVerseExit,
  verseOpExitInfo,
  type VerseOpExit,
  type VerseOpExitInfo,
} from "./draftSaveState";
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

// Release the verse-base pin for `key` — unless a draft session has (re)started
// meanwhile. Callers decide to unpin from an ASYNC drafts.get snapshot, and a
// new session's first keystroke can land inside that window: stashVerseDraft
// pins and set() adds to pendingKeys synchronously (before its own async put),
// so checking pendingKeys at the actual unpin moment closes the race the
// snapshot leaves open. Mirrors the latestGenerationByKey guard inside
// clearGeneration, which protects the clear path from the same class of race.
export function unpinVerseBaseIfIdle(key: string): void {
  if (pendingKeys.has(key)) return;
  unpinVerseBase(key);
}
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

// ---------- verse-op terminal exits: draft clear + pin release ----------
//
// Auto-clear the draft when the outbox confirms its corresponding PATCH
// landed. Anything other than a 200 keeps the draft so the user can retry
// or hand-edit. 409 is special — the user resolves via SyncStatusBar; the
// draft survives so the next retry has the right payload.
//
// Two terminal exits that will never produce a 200 — `locked` (the drain
// deletes the op permanently) and a user discard — must still release a
// DRAFTLESS save's verse-base pin, or the leaked pin poisons every later save
// of the verse (#565). A draft, when one exists, SURVIVES those exits
// untouched: it is the only copy of the user's unsaved text.
//
// The drain is cross-tab-exclusive (navigator.locks) while the pin map
// (versePin.ts) is per-tab memory, so the tab observing an op's exit is often
// NOT the tab holding the pin. Every verse-op exit is therefore broadcast, and
// each tab runs the same release rule against the shared draft store.

// This tab's synchronous bookkeeping (pendingKeys, pin, latestGenerationByKey)
// can outlive its draft record when the record is cleared by ANOTHER tab —
// clearGeneration only releases the local trio itself when it performs the
// delete. Safe to release exactly when this tab's own latest generation is the
// one confirmed cleared: any newer local keystroke replaces
// latestGenerationByKey synchronously, so a match proves no live edit session
// depends on the pin (#474 guard preserved).
function releaseLocalBookkeeping(key: string, generation: string): void {
  if (latestGenerationByKey.get(key) !== generation) return;
  latestGenerationByKey.delete(key);
  pendingKeys.delete(key);
  unpinVerseBase(key);
}

function applyVerseExit(key: string, info: VerseOpExitInfo): void {
  void drafts.get(key).then((draft) => {
    const release = pinReleaseForVerseExit(draft, info);
    if (release.kind === "clear") {
      void drafts.clearGeneration(key, release.generation).then((cleared) => {
        // The draining tab can win the race and delete the record between our
        // get() above and this clear — clearGeneration then returns false
        // without touching this tab's bookkeeping, leaving the pin and the
        // beforeunload dirty flag leaked for a save that has in fact landed.
        if (!cleared) releaseLocalBookkeeping(key, release.generation);
      });
    } else if (release.kind === "unpin") {
      // The shared draft record can already be gone — cleared by the draining
      // tab — while this tab's bookkeeping for it lingers. When a LANDED op
      // captured exactly the generation this tab wrote last, that bookkeeping
      // describes a save that has succeeded, not live typing: release it. A
      // mismatch (or a draftless/legacy op with no generation) falls through
      // to the idle-guarded unpin and a live edit session keeps its pin.
      if (info.exit === "ok" && info.draftGeneration !== undefined) {
        releaseLocalBookkeeping(key, info.draftGeneration);
      }
      unpinVerseBaseIfIdle(key);
    }
  });
}

type VerseExitMessage = { key: string; info: VerseOpExitInfo };

const verseExitChannel =
  typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("be-verse-op-exits") : null;

verseExitChannel?.addEventListener("message", (e: MessageEvent) => {
  const data = e.data as Partial<VerseExitMessage> | null;
  if (!data || typeof data.key !== "string") return;
  const info = data.info;
  if (!info || (info.exit !== "ok" && info.exit !== "locked" && info.exit !== "discarded")) return;
  applyVerseExit(data.key, info);
});

function handleVerseExit(op: OutboxOp, exit: VerseOpExit): void {
  if (op.target.kind !== "verse") return;
  const key = verseKey(op.target.book, op.target.chapter, op.target.verse, op.target.bibleVersion);
  let info: VerseOpExitInfo;
  try {
    // For a legacy (pre-generation) ok this parses the queued content, which
    // used to run inside an async then() where a throw was isolated. This now
    // runs synchronously inside outbox listener dispatch — keep that isolation
    // so malformed content can't abort the drain pass's listener loop.
    info = verseOpExitInfo(op, exit);
  } catch {
    return; // same non-release the pre-#565 code gave this op
  }
  applyVerseExit(key, info);
  // BroadcastChannel never delivers to its own poster — the applyVerseExit
  // above is this tab's copy. Announcement is best-effort: the local release
  // has already run, and a failed post only leaves the other tabs where the
  // pre-#565 behavior left every tab.
  try {
    verseExitChannel?.postMessage({ key, info } satisfies VerseExitMessage);
  } catch {
    /* best-effort */
  }
}

onOutboxResult((op, result) => {
  if (op.target.kind === "verse") {
    if (result.kind === "ok" || result.kind === "locked") handleVerseExit(op, result.kind);
    return;
  }
  if (result.kind !== "ok") return;
  if (op.target.kind === "row") {
    void drafts.clear(rowKey(op.target.rowKind, op.target.book, op.target.id));
  }
});

// SyncStatusBar's discard flows (refused, unresolvable-conflict, discard-all)
// all funnel through outbox.drop — the other permanent deletion (#565).
onOutboxDiscard((op) => handleVerseExit(op, "discarded"));
