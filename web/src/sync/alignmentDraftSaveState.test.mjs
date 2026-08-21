import assert from "node:assert/strict";
import { isAlignmentSaveOp } from "./alignmentDraftSaveState.ts";

function op(overrides = {}) {
  return {
    id: "op-1",
    target: { kind: "verse", book: "ZEC", chapter: 6, verse: 1, bibleVersion: "ULT" },
    action: "patch",
    patch: { content: {}, alignment_intent: "alignment_edit" },
    expectedVersion: 0,
    queuedAt: 1,
    attempts: 0,
    status: "pending",
    ...overrides,
  };
}

assert.equal(isAlignmentSaveOp(op()), true, "an alignment_edit verse save is an alignment save op");
assert.equal(
  isAlignmentSaveOp(op({ patch: { content: {}, alignment_intent: "text_edit" } })),
  false,
  "a text_edit verse save is NOT an alignment save op — must not touch the alignment crash-draft",
);
assert.equal(
  isAlignmentSaveOp(op({ patch: { content: {}, alignment_intent: "find_replace" } })),
  false,
  "a find_replace verse save is NOT an alignment save op",
);
assert.equal(
  isAlignmentSaveOp(op({ patch: { content: {}, alignment_intent: "section_edit" } })),
  false,
  "a section_edit verse save is NOT an alignment save op",
);
assert.equal(
  isAlignmentSaveOp(op({ patch: {} })),
  false,
  "a verse save with no alignment_intent at all is NOT an alignment save op",
);
assert.equal(
  isAlignmentSaveOp(op({ target: { kind: "row", rowKind: "tn", id: "abcd", book: "ZEC" } })),
  false,
  "a non-verse target is never an alignment save op",
);

console.log("alignmentDraftSaveState: 6 passed");
