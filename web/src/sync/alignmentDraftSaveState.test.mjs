import assert from "node:assert/strict";
import {
  alignmentDraftFitsRow,
  alignmentDraftKey,
  alignmentDraftRow,
  alignmentPanelRowKey,
  alignmentDraftKeyForOp,
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

// #1071 re-review: the PATCH is keyed by the row's verse_start, the panel's
// crash draft by the verse it was opened on. On a range row (UST 6-9, opened
// on v7) those differ, so a refused save must use the key the op carries.
assert.equal(
  alignmentDraftKeyForOp(
    op({
      target: { kind: "verse", book: "ZEC", chapter: 7, verse: 6, bibleVersion: "UST" },
      alignmentDraftKey: "ZEC:7:7:UST",
    }),
  ),
  "ZEC:7:7:UST",
  "a range-row save uses the panel's own draft key, not the row's verse_start",
);
assert.equal(
  alignmentDraftKeyForOp(op()),
  "ZEC:6:1:ULT",
  "an op without one (queued before this field) falls back to its target",
);
assert.equal(alignmentDraftKey("ZEC", 7, 7, "UST"), "ZEC:7:7:UST", "the key format is unchanged");

// #1074: a crash draft is restored only onto the row it was made on.
{
  const v7 = { version: 5, verse: 7, verse_end: null };
  const draft7 = { expectedVersion: 5, row: alignmentDraftRow(v7) };
  assert.equal(alignmentDraftFitsRow(draft7, v7, 7), true, "same version, same single-verse row: restore");
  assert.equal(alignmentDraftFitsRow(draft7, { ...v7, version: 6 }, 7), false, "the base moved on: discard");
  // The bridged 6-7 row is written at v6's version + 1, which can equal v7's.
  const bridged = { version: 5, verse: 6, verse_end: 7 };
  assert.equal(
    alignmentDraftFitsRow(draft7, bridged, 7),
    false,
    "v7's draft is never restored onto a 6-7 row whose version happens to match",
  );
  const draftBridged = { expectedVersion: 5, row: alignmentDraftRow(bridged) };
  assert.deepEqual(draftBridged.row, { verse: 6, verseEnd: 7 });
  assert.equal(alignmentDraftFitsRow(draftBridged, bridged, 7), true, "a range row opened on its inner verse: restore");
  assert.equal(
    alignmentDraftFitsRow(draftBridged, { version: 5, verse: 7, verse_end: null }, 7),
    false,
    "a draft made on 6-7 is not restored onto v7 after a split",
  );
  assert.equal(
    alignmentDraftFitsRow(draftBridged, { version: 5, verse: 6, verse_end: 8 }, 7),
    false,
    "nor onto a row that grew to 6-8",
  );
  assert.deepEqual(
    alignmentDraftRow({ verse: 7, verse_end: 7 }),
    { verse: 7, verseEnd: null },
    "verse_end equal to verse is a single verse",
  );
  // A draft written before the row was recorded.
  const legacy = { expectedVersion: 5 };
  assert.equal(alignmentDraftFitsRow(legacy, v7, 7), true, "a legacy draft on its own single-verse row: restore");
  assert.equal(alignmentDraftFitsRow(legacy, bridged, 7), false, "a legacy draft on a range row: discard");
  assert.equal(alignmentDraftFitsRow(legacy, bridged, 6), false, "even opened on the range row's start verse");
}

// #1074: the panel's row key is the same however a single verse spells its end.
assert.equal(alignmentPanelRowKey({ verse: 7, verse_end: null }), "7-7");
assert.equal(alignmentPanelRowKey({ verse: 7 }), "7-7");
assert.equal(alignmentPanelRowKey({ verse: 7, verse_end: 7 }), "7-7");
assert.equal(alignmentPanelRowKey({ verse: 6, verse_end: 7 }), "6-7", "a bridge keys differently");
assert.equal(alignmentPanelRowKey(null), "none");

console.log("alignmentDraftSaveState: 35 passed");
