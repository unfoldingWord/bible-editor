import assert from "node:assert/strict";
import {
  isAlignerPanelSaveOp,
  isAlignmentSaveOp,
  refusalMayReplaceDraft,
  refusedSaveStillCurrent,
} from "./alignmentDraftSaveState.ts";

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

// #1071: only the aligner panel's own saves (they always carry a draft
// generation) get the refusal handling; a verse-history restore does not.
assert.equal(
  isAlignerPanelSaveOp(op({ alignmentDraftGeneration: "g1" })),
  true,
  "an aligner save with a draft generation is an aligner panel save",
);
assert.equal(
  isAlignerPanelSaveOp(op()),
  false,
  "a history restore (alignment_edit, no draft generation) is NOT an aligner panel save",
);
assert.equal(
  isAlignerPanelSaveOp(
    op({ alignmentDraftGeneration: "g1", patch: { content: {}, alignment_intent: "text_edit" } }),
  ),
  false,
  "a text_edit is never an aligner panel save",
);

// #1071: which crash draft a refused save may replace.
assert.equal(refusalMayReplaceDraft(undefined, { queuedAt: 5, seq: 1 }), true, "no draft: restore");
assert.equal(
  refusalMayReplaceDraft({}, { queuedAt: 5, seq: 1 }),
  false,
  "a draft from dragging after the save already holds its drags: keep it",
);
assert.equal(
  refusalMayReplaceDraft({ refusedFrom: { queuedAt: 5, seq: 1 } }, { queuedAt: 9, seq: 2 }),
  true,
  "a later save's refusal replaces the draft an earlier save's refusal wrote",
);
assert.equal(
  refusalMayReplaceDraft({ refusedFrom: { queuedAt: 5, seq: 1 } }, { queuedAt: 5, seq: 2 }),
  true,
  "same millisecond: the higher seq is the later save",
);
assert.equal(
  refusalMayReplaceDraft({ refusedFrom: { queuedAt: 9, seq: 2 } }, { queuedAt: 5, seq: 1 }),
  false,
  "an earlier save's refusal never replaces a later save's draft",
);

// #1071 review F2: a refused save may only put the panel's old baseline back
// while the verse is still what the save was built on (its own optimistic
// content, or the content it saved over, at the same version). A foreign
// change that arrived while the op waited in backoff must win.
const base = { verseObjects: [{ type: "text", text: "base" }] };
const saved = { verseObjects: [{ type: "text", text: "saved" }] };
const foreign = { verseObjects: [{ type: "text", text: "foreign" }] };
const pending = { version: 3, savedContent: saved, baseContent: base };
assert.equal(
  refusedSaveStillCurrent(pending, { version: 3, content: saved }),
  true,
  "the optimistic copy of the save is still showing: restore",
);
assert.equal(
  refusedSaveStillCurrent(pending, { version: 3, content: JSON.parse(JSON.stringify(base)) }),
  true,
  "the content the save was built on is still showing: restore",
);
assert.equal(
  refusedSaveStillCurrent(pending, { version: 4, content: foreign }),
  false,
  "a foreign change landed (new version and content): do not restore",
);
assert.equal(
  refusedSaveStillCurrent(pending, { version: 4, content: saved }),
  false,
  "a newer version, even with the same bytes, is not the save's base: do not restore",
);
assert.equal(refusedSaveStillCurrent(pending, null), false, "no verse: do not restore");

console.log("alignmentDraftSaveState: 16 passed");
