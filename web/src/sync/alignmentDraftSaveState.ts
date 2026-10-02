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
