import assert from "node:assert/strict";
import { NO_ROW_DRAFT, rowDraftClearAfterOk, rowOpClearsDraft } from "./draftSaveState.ts";

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
// The sequence measured live: the Save captured g10, the user typed on (g21),
// and NoteCard re-set the still-dirty draft (g22) when the 200 bumped the
// version, before the 200 handler ran.
assert.equal(
  rowDraftClearAfterOk(save, "g10", "g22", stored("g22")),
  false,
  "typing after the Save, re-set before the 200 handler: keep",
);

// The cases above are ops without a draftGeneration field: legacy ops already
// queued in users' IndexedDB, which keep the read-at-200 fallback. New ops
// always carry the field: the generation they saved, or NO_ROW_DRAFT.
const genOp = (draftGeneration, patch = { note: "old typed" }, queuedAt = 100) => ({
  ...op(patch),
  draftGeneration,
  queuedAt,
});
const rec = (generation, updatedAt, patch = { note: "old typed" }) => ({
  ...draft(patch),
  generation,
  updatedAt,
});

// Review A1: the op drains in a tab that never set this draft (the user
// reloaded after Save, or another tab holds the drain lock), so there is no
// live generation. The stored record is the one the save captured: clear it.
assert.equal(
  rowDraftClearAfterOk(genOp("g1"), undefined, undefined, rec("g1", 50)),
  true,
  "fresh tab, stored draft is the saved generation: clear",
);
assert.equal(
  rowDraftClearAfterOk(genOp("g1"), undefined, undefined, rec("g2", 150)),
  false,
  "fresh tab, stored draft is newer typing from the saving tab: keep",
);
assert.equal(rowDraftClearAfterOk(genOp("g1"), "g1", "g1", rec("g1", 50)), true, "same tab, no newer typing: clear");
assert.equal(
  rowDraftClearAfterOk(genOp("g1"), "g2", "g2", rec("g2", 150)),
  false,
  "same tab, newer typing already stored: keep",
);
assert.equal(
  rowDraftClearAfterOk(genOp("g1"), "g1", "g2", rec("g1", 50)),
  false,
  "same tab, a newer set started but has not committed: keep",
);
assert.equal(
  rowDraftClearAfterOk(genOp("g1", { verse: 5 }), "g1", "g1", rec("g1", 50)),
  false,
  "a move with a generation still never clears",
);

// Review A2: an op queued when no draft existed (the AI suggestion path, or a
// save with no draft this session) carries NO_ROW_DRAFT. A draft written after
// it was queued is typing it did not carry: keep. A draft older than the op
// (a prior session's, never re-set here) is what the save stored: clear.
assert.equal(
  rowDraftClearAfterOk(genOp(NO_ROW_DRAFT), "g5", "g5", rec("g5", 150)),
  false,
  "no draft at enqueue, typing arrived in flight: keep",
);
assert.equal(
  rowDraftClearAfterOk(genOp(NO_ROW_DRAFT), undefined, undefined, rec("old", 50)),
  true,
  "no draft at enqueue, prior-session draft older than the op: clear",
);
assert.equal(
  rowDraftClearAfterOk(genOp(NO_ROW_DRAFT), undefined, "g6", rec("old", 50)),
  false,
  "no draft at enqueue, a newer set has started: keep",
);
assert.equal(
  rowDraftClearAfterOk(genOp(NO_ROW_DRAFT), undefined, undefined, undefined),
  false,
  "no draft at enqueue, nothing stored: nothing to delete",
);

// #1100 case 1: only the tab holding the drain lock runs the 200 handler, and
// its in-memory generation is its own. Tab B drains tab A's save of A's newer
// draft while B still holds an older generation of its own for that note. The
// store holds A's saved generation, written after B's last set() began, so
// B's typing is already superseded there: clear. A B generation that started
// at or after the stored write is live typing: keep. Generations are
// "<Date.now()>:<seq>:<random>" (drafts.ts nextGeneration).
assert.equal(
  rowDraftClearAfterOk(genOp("200:1:a"), "100:4:b", "100:4:b", rec("200:1:a", 200)),
  true,
  "other tab drains the saved draft while holding an older own generation: clear",
);
assert.equal(
  rowDraftClearAfterOk(genOp("200:1:a"), "100:4:b", "300:5:b", rec("200:1:a", 200)),
  false,
  "other tab started newer typing after the stored write: keep",
);
assert.equal(
  rowDraftClearAfterOk(genOp("200:1:a"), "200:5:b", "200:5:b", rec("200:1:a", 200)),
  false,
  "other tab's set() in the same millisecond as the stored write: keep",
);
assert.equal(
  rowDraftClearAfterOk(genOp("200:1:a"), "g0", "g0", rec("200:1:a", 200)),
  false,
  "an own generation without a readable start time: keep",
);
assert.equal(
  rowDraftClearAfterOk(genOp("200:1:a"), "100:4:b", "100:4:b", rec("300:2:a", 300)),
  false,
  "older own generation, but the store holds newer unsaved typing: keep",
);

// #1100 case 2: a 409 resolve or a fatal-failure retry moves the op's queuedAt
// to "now". A NO_ROW_DRAFT op must still compare against its ORIGINAL enqueue
// time (firstQueuedAt), or it deletes another tab's typing written between
// that enqueue and the requeue. Legacy ops without the field keep queuedAt.
const requeued = (firstQueuedAt) => ({
  ...genOp(NO_ROW_DRAFT, { note: "old typed" }, 500),
  ...(firstQueuedAt === undefined ? {} : { firstQueuedAt }),
});
assert.equal(
  rowDraftClearAfterOk(requeued(100), undefined, undefined, rec("200:1:a", 300)),
  false,
  "requeued draftless op, typing written after the original enqueue: keep",
);
assert.equal(
  rowDraftClearAfterOk(requeued(100), undefined, undefined, rec("old", 50)),
  true,
  "requeued draftless op, draft older than the original enqueue: clear",
);
assert.equal(
  rowDraftClearAfterOk(requeued(undefined), undefined, undefined, rec("old", 300)),
  true,
  "legacy op without firstQueuedAt keeps comparing against queuedAt",
);

console.log("rowDraftClear: all assertions passed");
