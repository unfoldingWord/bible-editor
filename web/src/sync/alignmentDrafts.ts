// Crash-safe persistence of in-progress ALIGNMENT work.
//
// Verse TEXT edits are stashed to `bible-editor-drafts` (drafts.ts) on every
// keystroke, so they survive a tab close or browser crash. Alignment DRAGS
// had no such tier — they lived only in AlignmentPanel's React state until an
// explicit Save enqueued them, so a crash/reload before saving lost them with
// no trace (see the JER 32 loss; memory `project_verse_edit_loss_unload_no_guard`).
//
// This is that missing tier: a dedicated IndexedDB store the AlignmentPanel
// writes to on each drag (debounced) and reads back when the aligner reopens.
// It is DELIBERATELY separate from the shared `drafts` store — that store's
// subscribers (UnsavedToasts, SyncStatusBar, ScriptureColumn/DocColumn/BookView
// hydration) expect `{ plainText }` verse drafts and an alignment payload there
// would collide with them. Writes come only from AlignmentPanel; reads only on
// aligner mount. Nothing here ever produces a PATCH — the outbox is untouched.

import { openDB, type IDBPDatabase } from "idb";
import { isReadOnly } from "./api";
import { onOutboxResult, type VerseTarget } from "./outbox";
import { isAlignmentSaveOp } from "./alignmentDraftSaveState";

const DB_NAME = "bible-editor-alignment-drafts";
const DB_VERSION = 1;
const STORE = "drafts";

export interface AlignmentDraftRecord {
  key: string;
  // The serialized alignment tree, shaped exactly like a verse's stored
  // content (`{ verseObjects }`) so hydration re-parses it through the same
  // parseAlignment path a fresh load uses.
  content: unknown;
  // The verse version this draft branched from. On hydration we only restore
  // when this still matches the current base version — otherwise the base
  // changed under the draft (a save from another tab, a reimport) and the
  // draft is stale and must be discarded, not applied over newer content.
  expectedVersion: number;
  updatedAt: number;
  // Opaque identity for this exact draft write, mirroring drafts.ts's
  // `generation`. AlignmentPanel captures the generation of the draft a save
  // represents and threads it through the outbox op (as
  // `alignmentDraftGeneration`); the onOutboxResult listener below then only
  // deletes that exact generation, so a draft written by CONTINUED dragging
  // AFTER Save (a different, newer generation) survives a landed op's cleanup
  // instead of being wiped for the ~400ms until its own persist cycle re-runs
  // (#508). Absent on records persisted before this field existed.
  generation?: string;
}

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

// Same key shape the outbox uses for a verse target, so the onOutboxResult
// listener below can clear the matching draft off a landed save.
export function alignmentDraftKey(
  book: string,
  chapter: number,
  verse: number,
  bibleVersion: string,
): string {
  return `${book}:${chapter}:${verse}:${bibleVersion}`;
}

let generationSeq = 0;
// Exported so a caller can mint an op's provenance identity WITHOUT writing a
// draft — see AlignmentPanel's commit(), which needs every alignment save to
// carry a real, unique generation even when its own 400ms persist debounce
// never got to write one (a save committed within 400ms of the first drag).
// Without this, that save's op would carry alignmentDraftGeneration=undefined,
// and the onOutboxResult listener's legacy fallback (unconditional clear)
// could then wipe a draft written by dragging that continued AFTER Save,
// exactly the failure #508 exists to prevent.
export function mintAlignmentDraftGeneration(): string {
  generationSeq += 1;
  return `${Date.now()}:${generationSeq}:${Math.random().toString(36).slice(2)}`;
}

export const alignmentDrafts = {
  // Returns the generation minted for this write (even in read-only mode,
  // where nothing is actually persisted) so callers that want generation-safe
  // cleanup later (AlignmentPanel's save path) always have a value to carry.
  async set(key: string, content: unknown, expectedVersion: number): Promise<string> {
    const generation = mintAlignmentDraftGeneration();
    if (isReadOnly()) return generation;
    const rec: AlignmentDraftRecord = {
      key,
      content,
      expectedVersion,
      updatedAt: Date.now(),
      generation,
    };
    await (await db()).put(STORE, rec);
    return generation;
  },

  async get(key: string): Promise<AlignmentDraftRecord | undefined> {
    return (await (await db()).get(STORE, key)) as AlignmentDraftRecord | undefined;
  },

  async clear(key: string): Promise<void> {
    await (await db()).delete(STORE, key);
  },

  // Delete only if the record currently at `key` still carries `generation` —
  // the read + conditional delete share one transaction so another committed
  // write cannot slip between them. A record with no `generation` (pre-#508)
  // or a mismatched one (a newer draft has since been written) is left alone.
  async clearGeneration(key: string, generation: string): Promise<boolean> {
    const idb = await db();
    const tx = idb.transaction(STORE, "readwrite");
    const rec = (await tx.store.get(key)) as AlignmentDraftRecord | undefined;
    if (!rec || rec.generation !== generation) {
      await tx.done;
      return false;
    }
    await tx.store.delete(key);
    await tx.done;
    return true;
  },

  // Mirrors drafts.ts's shape; `updatedAt` + `list` are the seam a future
  // "you have unsaved alignment from an earlier session" recovery surface would
  // hang on (the way UnsavedToasts/SyncStatusBar consume drafts.ts). No caller
  // yet — kept intentionally, not accidental cruft.
  async list(): Promise<AlignmentDraftRecord[]> {
    return (await (await db()).getAll(STORE)) as AlignmentDraftRecord[];
  },
};

// Belt-and-suspenders: when an alignment save's PATCH lands (200), the drag
// state it captured is now durable server-side, so drop the crash-draft that
// was protecting it. AlignmentPanel also clears optimistically in its
// save-commit closure; both are idempotent. Generation-gated (falling back to
// an unconditional clear only for a legacy op enqueued before generation
// tracking existed) so a draft written by dragging that continued AFTER Save
// — a newer generation this op never captured — survives (#508).
onOutboxResult((op, result) => {
  if (result.kind !== "ok") return;
  if (!isAlignmentSaveOp(op)) return;
  const target = op.target as VerseTarget;
  const key = alignmentDraftKey(target.book, target.chapter, target.verse, target.bibleVersion);
  if (op.alignmentDraftGeneration) {
    void alignmentDrafts.clearGeneration(key, op.alignmentDraftGeneration);
  } else {
    void alignmentDrafts.clear(key);
  }
});
