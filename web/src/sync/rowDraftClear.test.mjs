import assert from "node:assert/strict";
import { rowDraftClearAfterOk, rowOpClearsDraft } from "./draftSaveState.ts";

// #1092: a row op's 200 clears the row's draft only when that op saved the
// draft's fields. A move (verse/ref_raw/sort_order) or a reorder carries none
// of the typed fields, so the typed text must stay in the draft store.
const draft = (patch) => ({
  key: "row:tn:ZEC:m9ri",
  payload: { patch, baseline: { quote: "", note: "old", support_reference: "" } },
  expectedVersion: 1,
  updatedAt: 1,
  generation: "g1",
  meta: { kind: "row", rowKind: "tn", id: "m9ri", book: "ZEC", chapter: 8, verse: 3 },
});
const op = (patch, action = "patch") => ({
  id: "op1",
  target: { kind: "row", rowKind: "tn", id: "m9ri", book: "ZEC" },
  action,
  patch,
  expectedVersion: 1,
  queuedAt: 1,
  attempts: 0,
  status: "in_flight",
});

assert.equal(
  rowOpClearsDraft(op({ verse: 5, ref_raw: "8:5", sort_order: 9 }), draft({ note: "old typed" })),
  false,
  "a move does not clear unsaved note typing",
);
assert.equal(
  rowOpClearsDraft(op({ sort_order: 4 }), draft({ quote: "q" })),
  false,
  "a reorder does not clear unsaved quote typing",
);
assert.equal(rowOpClearsDraft(op({ note: "old typed" }), draft({ note: "old typed" })), true, "a save clears its draft");
assert.equal(
  rowOpClearsDraft(op({ quote: "q" }), draft({ quote: "q", note: "n" })),
  true,
  "a save of any draft field clears (prior behavior)",
);
assert.equal(rowOpClearsDraft(op({}, "delete"), draft({ note: "x" })), true, "a delete still clears");
assert.equal(
  rowOpClearsDraft(op({ verse: 5 }), { ...draft({}), payload: { note: "legacy" } }),
  true,
  "a draft without a patch object keeps the old clear-on-200 behavior",
);

// The 200 handler captures the key's latest draft generation synchronously,
// then reads the store. Typing that starts after the capture (NoteCard's
// version-bump effect re-setting a still-dirty draft, or a keystroke) must
// never be deleted by that late read-then-delete.
const save = op({ note: "old typed" });
const stored = (generation, patch = { note: "old typed" }) => ({ ...draft(patch), generation });
assert.equal(rowDraftClearAfterOk(save, "g1", "g1", stored("g1")), true, "unchanged draft generation: the save clears it");
assert.equal(
  rowDraftClearAfterOk(save, "g1", "g2", stored("g1")),
  false,
  "a newer set started after the 200 (not yet committed): keep",
);
assert.equal(
  rowDraftClearAfterOk(save, "g1", "g2", stored("g2")),
  false,
  "the store already holds the newer typing: keep",
);
assert.equal(
  rowDraftClearAfterOk(save, "g1", "g1", stored("g0")),
  false,
  "the stored record is not the generation captured at the 200: keep",
);
assert.equal(rowDraftClearAfterOk(save, "g1", "g1", undefined), false, "nothing stored: nothing to delete");
assert.equal(
  rowDraftClearAfterOk(op({ verse: 5, ref_raw: "8:5" }), "g1", "g1", stored("g1")),
  false,
  "a move never clears, even with no race",
);
assert.equal(
  rowDraftClearAfterOk(save, undefined, undefined, stored("prior-session")),
  true,
  "a prior-session draft (no generation set this session) still clears on its save",
);
assert.equal(
  rowDraftClearAfterOk(save, undefined, "g1", stored("prior-session")),
  false,
  "typing started after the 200 on a prior-session draft: keep",
);

console.log("rowDraftClear: all assertions passed");
