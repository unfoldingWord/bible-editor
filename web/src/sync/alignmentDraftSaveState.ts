import type { OutboxOp } from "./outbox.ts";
import { sameVerseContent } from "../lib/alignmentDelta.ts";

// Pure predicate factored out of alignmentDrafts.ts's onOutboxResult listener
// so it's unit-testable without an IndexedDB harness — mirrors draftSaveState.ts's
// role for drafts.ts (that module's own CRUD isn't unit tested for the same
// reason).
//
// True only for a save that could plausibly have written to the alignment
// crash-draft store. Gating on the target kind alone (as that listener used
// to) also caught ordinary text_edit/find_replace/section_edit verse saves,
// which could wipe an unrelated in-progress alignment crash-draft on the SAME
// verse the moment an unrelated save landed (#508).
export function isAlignmentSaveOp(op: Pick<OutboxOp, "target" | "patch">): boolean {
  return op.target.kind === "verse" && op.patch.alignment_intent === "alignment_edit";
}

// The crash-draft key the aligner panel uses (alignmentDrafts.ts re-exports
// it): the verse the panel was opened on, which on a range row can sit inside
// the row rather than at its verse_start.
export function alignmentDraftKey(
  book: string,
  chapter: number,
  verse: number,
  bibleVersion: string,
): string {
  return `${book}:${chapter}:${verse}:${bibleVersion}`;
}

// #1071: the crash-draft key for an aligner save op. The op's target is keyed
// by the row's verse_start (the PATCH needs it), so the panel's own key rides
// along on the op; an op queued before that field existed falls back to its
// target, which is right for every single-verse row.
export function alignmentDraftKeyForOp(
  op: Pick<OutboxOp, "target" | "alignmentDraftKey">,
): string {
  if (op.alignmentDraftKey) return op.alignmentDraftKey;
  const t = op.target as { book: string; chapter: number; verse: number; bibleVersion: string };
  return alignmentDraftKey(t.book, t.chapter, t.verse, t.bibleVersion);
}

// #1071: an alignment save the aligner panel itself queued. Its commit always
// mints an alignmentDraftGeneration; the verse-history restore also sends
// alignment_intent "alignment_edit" but carries none, and a refused restore
// must not be written into the aligner's crash draft or announced as kept.
export function isAlignerPanelSaveOp(
  op: Pick<OutboxOp, "target" | "patch" | "alignmentDraftGeneration">,
): boolean {
  return isAlignmentSaveOp(op) && typeof op.alignmentDraftGeneration === "string";
}

// Which refused op wrote a crash draft (#1071), as the outbox orders ops.
export interface RefusedOpOrder {
  queuedAt: number;
  seq: number;
}

export function refusedOpOrder(op: Pick<OutboxOp, "queuedAt" | "seq">): RefusedOpOrder {
  return { queuedAt: op.queuedAt, seq: op.seq ?? 0 };
}

// #1071: may a refused save's content replace the crash draft now at its key?
// - No draft: yes.
// - A draft an earlier refusal wrote (it carries `refusedFrom`): only when
//   this op was queued after that one. Two saves of one verse can be queued
//   together (offline, backoff); the later one holds every drag the earlier
//   one does, plus the ones made between them.
// - Any other draft came from dragging after the panel committed, on top of
//   the saved state, so it already holds these drags: keep it.
export function refusalMayReplaceDraft(
  existing: { refusedFrom?: RefusedOpOrder } | undefined,
  op: RefusedOpOrder,
): boolean {
  if (!existing) return true;
  const prev = existing.refusedFrom;
  if (!prev) return false;
  return op.queuedAt > prev.queuedAt || (op.queuedAt === prev.queuedAt && op.seq > prev.seq);
}

// #1071: when an aligner save is refused, may the panel put back the baseline
// it had before that save? Only while the verse still shows what the save was
// built on: the same version, with either the save's own optimistic content
// or the content it saved over. A foreign change that landed while the op
// waited in backoff (another tab, a reimport, an AI apply) must win; putting
// the old baseline back over it would let the next save revert it.
export function refusedSaveStillCurrent(
  pending: { version: number; savedContent: unknown; baseContent: unknown },
  verse: { version: number; content: unknown } | null | undefined,
): boolean {
  if (!verse || verse.version !== pending.version) return false;
  return (
    sameVerseContent(verse.content, pending.savedContent) ||
    sameVerseContent(verse.content, pending.baseContent)
  );
}

// #1074: the row a crash draft was made on — its start verse and bridge end
// (null for a single verse). A bridge or split by another editor moves the
// panel's verse onto a different row while its draft key stays the same.
export interface AlignmentDraftRow {
  verse: number;
  verseEnd: number | null;
}

export function alignmentDraftRow(row: { verse: number; verse_end?: number | null }): AlignmentDraftRow {
  const end = row.verse_end ?? null;
  return { verse: row.verse, verseEnd: end === row.verse ? null : end };
}

// #1074: the row part of an aligner panel's React key, so a bridge or split
// under the panel remounts it. A single verse keys the same whether its
// verse_end is null, missing or equal to its start.
export function alignmentPanelRowKey(row: { verse: number; verse_end?: number | null } | null | undefined): string {
  if (!row) return "none";
  const r = alignmentDraftRow(row);
  return `${r.verse}-${r.verseEnd ?? r.verse}`;
}

// #1074: may the panel open on verse `verseNum` restore this crash draft onto
// the row it now resolves to? Only onto the version the draft branched from
// AND the same row. The version alone is not enough: a bridged row's version
// (its start verse's + 1) can equal the version of the verse whose draft it
// would replace, and restoring v7's draft onto a 6-7 row would let Save
// delete verse 6. A draft written before the row was recorded is trusted only
// on the single-verse row of its own verse.
export function alignmentDraftFitsRow(
  draft: { expectedVersion: number; row?: AlignmentDraftRow },
  current: { version: number; verse: number; verse_end?: number | null },
  verseNum: number,
): boolean {
  if (draft.expectedVersion !== current.version) return false;
  const row = alignmentDraftRow(current);
  if (!draft.row) return row.verse === verseNum && row.verseEnd === null;
  return draft.row.verse === row.verse && (draft.row.verseEnd ?? null) === row.verseEnd;
}

function opIsAfter(a: RefusedOpOrder, b: RefusedOpOrder): boolean {
  return a.queuedAt > b.queuedAt || (a.queuedAt === b.queuedAt && a.seq > b.seq);
}

// #1077: an aligner panel already open on the verse read its crash draft once,
// when it mounted or last fully reset. A refusal that lands later (Saved at
// the gate and reopened before the 409; or A saved, then B refused, after A's
// row reset the panel and dropped its record of B) writes the draft after
// that read, so the open panel would not show the drags until reopened. May
// it re-read the draft now? Only when nothing newer can be overwritten:
// - the panel is clean (no drags of its own since its last reset or save);
// - it has no pending save of its own (that save's result decides instead);
// - the draft at the key is this refusal's (another refusal or a persist
//   write may have replaced it);
// - no other aligner save for the key, still queued or already committed,
//   is newer than the refused one. Two saves queued for one verse with the
//   older refused after the newer committed: the newer holds the drags the
//   translator last saved, so the older one's content must not come back.
// The caller still checks the draft fits the row the panel shows
// (alignmentDraftFitsRow).
export function refusedDraftMayRehydrate(args: {
  panelClean: boolean;
  panelHasPendingSave: boolean;
  refused: RefusedOpOrder;
  draftFrom: RefusedOpOrder | undefined;
  otherSaves: ReadonlyArray<RefusedOpOrder>;
}): boolean {
  const { panelClean, panelHasPendingSave, refused, draftFrom, otherSaves } = args;
  if (!panelClean || panelHasPendingSave || !draftFrom) return false;
  if (draftFrom.queuedAt !== refused.queuedAt || draftFrom.seq !== refused.seq) return false;
  return !otherSaves.some((o) => opIsAfter(o, refused));
}
