// Tests for web/src/sync/rowEditBaseline.ts (#1115): a translation question
// or word link whose save the server refused (409 chapter_locked) or the user
// discarded from the sync drawer must stay on screen as unsaved, the way a
// translation note does. The row's unsaved state is judged against a baseline
// pinned to the server version, never against the cached row, which carries
// the refused text optimistically at an unchanged version.

import assert from "node:assert/strict";
import { classifyRowPatchConflict } from "./rowConflict.ts";
import {
  activeSaveBasis,
  baselineFromDraft,
  conflictingFields,
  nextSaveBasis,
  rebaseRowBaseline,
  isKeptRowEditOp,
  queuedKeptEditIds,
  resyncLocalFields,
  rowFieldDiff,
  saveGateClosed,
} from "./rowEditBaseline.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

// The row as the server confirmed it at v3.
const server = { question: "Who spoke?", response: "The LORD." };
let base = rebaseRowBaseline(null, server, 3);
check(base.version === 3 && base.fields.question === "Who spoke?", "a first baseline is the row as loaded");

// The user types and clicks Save: Shell applies the patch to the cached row at
// the SAME version (the optimistic apply) before the PATCH is answered.
const typed = { question: "Who spoke here?", response: "The LORD." };
const optimisticRow = { ...server, question: typed.question };
base = rebaseRowBaseline(base, optimisticRow, 3);
check(base.fields.question === "Who spoke?", "an optimistic same-version apply does not move the baseline");
check(
  Object.keys(rowFieldDiff(typed, base.fields)).length === 1 &&
    rowFieldDiff(typed, base.fields).question === "Who spoke here?",
  "so the typing still reads as unsaved until the server confirms it",
);
check(
  Object.keys(rowFieldDiff(typed, optimisticRow)).length === 0,
  "(the old rule, diffing against the cached row, called it saved)",
);

// The PATCH is refused and dropped: nothing bumps the version, so it stays
// unsaved. A 200 bumps the version and rebases onto the saved text.
const saved = rebaseRowBaseline(base, optimisticRow, 4);
check(saved.version === 4 && saved.fields.question === "Who spoke here?", "a 200 (new version) rebases the baseline");
check(Object.keys(rowFieldDiff(typed, saved.fields)).length === 0, "and the row is clean once saved");

// Remount over the polluted cache (verse switched and back, no refetch): the
// draft carries the baseline it was diffed against.
const draft = { patch: { question: "Who spoke here?" }, baseline: server };
const restored = baselineFromDraft(draft, 3, 3);
check(restored?.fields.question === "Who spoke?" && restored.version === 3, "a draft at the row's version restores its baseline");
check(baselineFromDraft(draft, 3, 4) === null, "a draft from an older version does not (the row moved; it is the baseline)");
check(baselineFromDraft({ patch: { question: "x" } }, 3, 3) === null, "a draft without a baseline (older build) falls back to the row");
check(baselineFromDraft(undefined, undefined, 3) === null, "no draft, no baseline");
check(baselineFromDraft({ baseline: null }, 3, 3) === null, "a malformed baseline is ignored");

// Resync from the cached row, field by field (review item 1 on #1115): a field
// holding unsaved typing keeps it, whatever moved; every other field takes the
// row's value. The kept question below was refused during an AI run; the run's
// apply (or another tab's save) then bumps the row with new text.
{
  const prevBase = { question: "Who spoke?", response: "The LORD." };
  const local = { question: "Who spoke here?", response: "The LORD." };
  const bumped = { question: "Who spoke (AI)?", response: "Yahweh." };
  const next = resyncLocalFields(local, prevBase, bumped);
  check(next.question === "Who spoke here?", "a new version never wipes a field's kept typing");
  check(next.response === "Yahweh.", "a clean field takes the new version's value");
  // The new baseline is the bumped row, so the kept field still reads unsaved.
  check(rowFieldDiff(next, bumped).question === "Who spoke here?", "and the kept field still reads as unsaved against it");
  // A same-version change (a find/replace applied to the cache) reaches a clean field.
  const replaced = resyncLocalFields(prevBase, prevBase, { ...prevBase, response: "Yahweh of hosts." });
  check(replaced.response === "Yahweh of hosts.", "a same-version change reaches a clean field");
  // Our own save landing: the row now holds exactly what we typed.
  const landed = resyncLocalFields(local, prevBase, local);
  check(landed.question === "Who spoke here?" && rowFieldDiff(landed, local).question === undefined, "our own save landing leaves the row clean");
}

// Lost update (review round 2): A's refused question is kept; B then saves the
// SAME field, so the version moves and A's baseline rebases to B's text. A
// plain save would send If-Match at B's version and overwrite B silently. The
// field is a conflict: A's next save must be based on the version A typed
// against, so the server answers 409 and the outbox's conflict path runs.
{
  const prevBase = { question: "Who spoke?", response: "The LORD." };
  const local = { question: "A: who spoke here?", response: "The LORD." };
  const bByQuestion = { question: "B: who spoke there?", response: "The LORD." };
  const bByResponse = { question: "Who spoke?", response: "B: Yahweh." };
  check(JSON.stringify(conflictingFields(local, prevBase, bByQuestion)) === '["question"]', "a dirty field the server also changed is a conflict");
  check(conflictingFields(local, prevBase, bByResponse).length === 0, "a change to another field is not");
  check(conflictingFields(local, prevBase, { ...bByQuestion, question: local.question }).length === 0, "the server landing exactly our text is not");
  check(conflictingFields(prevBase, prevBase, bByQuestion).length === 0, "a clean field the server changed is not");

  const basis = nextSaveBasis(null, { local, prevBase, prevVersion: 3, row: bByQuestion });
  check(basis?.version === 3 && basis.fields.question === "Who spoke?", "the save is based on the version A typed against");
  check(nextSaveBasis(null, { local, prevBase, prevVersion: 3, row: bByResponse }) === null, "no basis when nothing conflicts");
  const later = nextSaveBasis(basis, { local, prevBase: bByQuestion, prevVersion: 4, row: { ...bByQuestion, response: "C" } });
  check(later === basis, "a later bump keeps the earlier basis");
  check(activeSaveBasis(basis, local, bByQuestion) === basis, "active while the conflicting field is still dirty");
  check(activeSaveBasis(basis, { ...local, question: bByQuestion.question }, bByQuestion) === null, "inactive once A's field matches the server again");

  // End to end through the outbox's 409 classifier: the save's baseline is
  // what the op compares the server row against.
  const patch = { question: local.question };
  check(
    classifyRowPatchConflict(patch, { question: bByQuestion.question }, { ...bByQuestion, version: 4 }) === "auto_heal",
    "(without a basis, the rebased baseline lets the 409 auto-heal: B's text would be overwritten)",
  );
  check(
    classifyRowPatchConflict(patch, { question: basis.fields.question }, { ...bByQuestion, version: 4 }) === "conflict",
    "with the basis, the 409 is a real conflict and reaches the user",
  );
}

// The save gate (review item 2): Save and Undo are off while a save of the
// row's edited fields is queued, in flight or in conflict, and from the click
// until the outbox's next snapshot (which holds the new op). It never sticks:
// a refusal or discard removes the op, and the next snapshot reopens it.
{
  const op = (rowKind, id, patch, action = "patch", kind = "row") => ({ target: { kind, rowKind, id, book: "ZEC" }, action, patch });
  const ops = [
    op("tq", "A", { question: "x" }),
    op("tq", "B", { sort_order: 2 }),
    op("twl", "C", { orig_words: "w" }),
    op("tq", "D", {}, "delete"),
    op("tq", "E", { response: "r" }),
  ];
  check(JSON.stringify(queuedKeptEditIds(ops, "tq")) === '["A","E"]', "queued question edits: only edit-field PATCHes of that kind");
  check(JSON.stringify(queuedKeptEditIds(ops, "twl")) === '["C"]', "queued word-link edits likewise");
  check(saveGateClosed({ queued: true, clickedAtSeq: null, seq: 5 }), "closed while a save is queued");
  check(saveGateClosed({ queued: false, clickedAtSeq: 5, seq: 5 }), "closed from the click until the next snapshot");
  check(!saveGateClosed({ queued: false, clickedAtSeq: 5, seq: 6 }), "open once a later snapshot shows nothing queued (landed, refused or discarded)");
  check(!saveGateClosed({ queued: false, clickedAtSeq: null, seq: 6 }), "open with nothing queued");
}

// Diff semantics: only changed fields, null/undefined distinct from "".
check(
  JSON.stringify(rowFieldDiff({ a: "1", b: null }, { a: "1", b: null })) === "{}",
  "identical fields produce no diff",
);
check(rowFieldDiff({ a: null }, { a: "x" }).a === null, "a cleared field is part of the diff");

// The refusal toast says "kept" only for an edit the row keeps on screen.
const rowOp = (rowKind, patch, action = "patch") => ({ target: { kind: "row", rowKind, id: "x", book: "ZEC" }, action, patch });
check(isKeptRowEditOp(rowOp("tq", { question: "q" })), "a refused question edit is kept");
check(isKeptRowEditOp(rowOp("twl", { tw_link: "rc://*/tw/dict/bible/kt/god" })), "a refused word-link edit is kept");
check(!isKeptRowEditOp(rowOp("twl", { sort_order: 3 })), "a word-link reorder is not");
check(!isKeptRowEditOp(rowOp("twl", { verse: 2, ref_raw: "1:2", sort_order: 1 })), "a word-link verse move is not");
check(!isKeptRowEditOp(rowOp("tn", { note: "n" })), "a note edit is not (its wording is unchanged here)");
check(!isKeptRowEditOp(rowOp("tq", {}, "delete")), "a delete is not");
check(!isKeptRowEditOp({ target: { kind: "verse" }, action: "patch", patch: { content: [] } }), "a verse op is not");

console.log(`rowEditBaseline: ${passed} checks passed`);
