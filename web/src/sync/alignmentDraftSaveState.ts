import type { OutboxOp } from "./outbox.ts";

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
