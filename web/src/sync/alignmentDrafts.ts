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
import { onOutboxResult, type OutboxOp } from "./outbox";
import {
  alignmentDraftKey,
  alignmentDraftKeyForOp,
  isAlignerPanelSaveOp,
  isAlignmentSaveOp,
  refusalMayReplaceDraft,
  refusedOpOrder,
  type AlignmentDraftRow,
  type RefusedOpOrder,
} from "./alignmentDraftSaveState";

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
  // Set only on a draft restoreRefused wrote: the refused op it came from
  // (#1071). The panel's own persist writes leave it off.
  refusedFrom?: RefusedOpOrder;
  // The row the draft was made on (#1074). Hydration restores it only onto
  // that same row; see alignmentDraftFitsRow. Absent on older records.
  row?: AlignmentDraftRow;
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

// The panel's draft key. Defined in alignmentDraftSaveState.ts (no IndexedDB
// there, so it is unit-testable) and re-exported for existing callers.
export { alignmentDraftKey };

// #1071: a refused aligner save, once this module knows whether anything kept
// its drags: a crash draft holds them (written here, or one already there),
// or an open panel put its pre-save baseline back (noteRefusalKeptInPanel).
// Shell words its toast on this, so it never says "kept" when nothing was.
// `heldInDraft`: a crash draft at the key holds the drags. False with `kept`
// true means only the open panel's memory holds them (#1073: Shell must not
// then reset that panel by rolling the cache back).
type RefusalListener = (op: OutboxOp, kept: boolean, heldInDraft: boolean) => void;
const refusalListeners = new Set<RefusalListener>();
export function onAlignerSaveRefused(fn: RefusalListener): () => void {
  refusalListeners.add(fn);
  return () => refusalListeners.delete(fn);
}
const keptInPanel = new Set<string>();
// Called by AlignmentPanel from inside the same outbox-result dispatch, so it
// lands before the draft write below resolves.
export function noteRefusalKeptInPanel(generation: string): void {
  keptInPanel.add(generation);
}

// #1077: the newest aligner save per draft key that this tab saw commit, so
// an open panel never re-reads an older refused save's draft over it.
const committedAlignerSaves = new Map<string, RefusedOpOrder>();
export function newestCommittedAlignerSave(key: string): RefusedOpOrder | undefined {
  return committedAlignerSaves.get(key);
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
  async set(key: string, content: unknown, expectedVersion: number, row: AlignmentDraftRow): Promise<string> {
    const generation = mintAlignmentDraftGeneration();
    if (isReadOnly()) return generation;
    const rec: AlignmentDraftRecord = {
      key,
      content,
      expectedVersion,
      updatedAt: Date.now(),
      generation,
      row,
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

  // #1071: put a refused save's content back as the crash draft, when
  // refusalMayReplaceDraft allows it (no draft, or one an earlier refusal
  // wrote). The commit's own clear of the pre-save draft cannot land after
  // this: its readwrite transaction on this store was created before the op
  // was even dispatched, and IndexedDB runs overlapping readwrite
  // transactions in creation order.
  async restoreRefused(
    key: string,
    content: unknown,
    expectedVersion: number,
    from: RefusedOpOrder,
    row: AlignmentDraftRow | undefined,
  ): Promise<boolean> {
    if (isReadOnly()) return false;
    const idb = await db();
    const tx = idb.transaction(STORE, "readwrite");
    const existing = (await tx.store.get(key)) as AlignmentDraftRecord | undefined;
    const write = refusalMayReplaceDraft(existing, from);
    if (write) {
      const rec: AlignmentDraftRecord = {
        key,
        content,
        expectedVersion,
        updatedAt: Date.now(),
        generation: mintAlignmentDraftGeneration(),
        refusedFrom: from,
        ...(row ? { row } : {}),
      };
      await tx.store.put(rec);
    }
    await tx.done;
    // True whenever a draft at `key` now holds these drags: the one just
    // written, or one refusalMayReplaceDraft kept because it already holds
    // them (dragging after Save, or a later save's refusal).
    return write || existing !== undefined;
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
//
// A save the server refused as chapter_locked (an AI run the tab had not
// polled yet, #1071) is deleted from the outbox, and the panel already
// cleared its crash draft when it committed. Put the saved alignment back as
// the draft so the drags come back when the verse's aligner reopens. Runs
// here rather than in the panel because the gate's Save usually navigates
// away, unmounting it, before the refusal arrives. Only the aligner's own
// saves: a refused verse-history restore is not aligner work.
onOutboxResult((op, result) => {
  if (result.kind !== "ok" && result.kind !== "locked") return;
  if (!isAlignmentSaveOp(op)) return;
  // The panel's own key, not the row's verse_start (a range row opened on an
  // inner verse, #1071).
  const key = alignmentDraftKeyForOp(op);
  if (result.kind === "locked") {
    if (isAlignerPanelSaveOp(op)) {
      const generation = op.alignmentDraftGeneration as string;
      const settle = (heldInDraft: boolean) => {
        const kept = keptInPanel.delete(generation) || heldInDraft;
        for (const l of refusalListeners) l(op, kept, heldInDraft);
      };
      alignmentDrafts
        .restoreRefused(key, op.patch.content, op.expectedVersion, refusedOpOrder(op), op.alignmentDraftRow)
        .then(settle, () => settle(false));
    }
    return;
  }
  if (isAlignerPanelSaveOp(op)) {
    const order = refusedOpOrder(op);
    const prev = committedAlignerSaves.get(key);
    if (!prev || order.queuedAt > prev.queuedAt || (order.queuedAt === prev.queuedAt && order.seq > prev.seq)) {
      committedAlignerSaves.set(key, order);
    }
  }
  if (op.alignmentDraftGeneration) {
    void alignmentDrafts.clearGeneration(key, op.alignmentDraftGeneration);
  } else {
    void alignmentDrafts.clear(key);
  }
});
