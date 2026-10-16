// Tests for web/src/sync/rowEditBaseline.ts (#1115): a translation question
// or word link whose save the server refused (409 chapter_locked) or the user
// discarded from the sync drawer must stay on screen as unsaved, the way a
// translation note does. The row's unsaved state is judged against a baseline
// pinned to the server version, never against the cached row, which carries
// the refused text optimistically at an unchanged version.

import assert from "node:assert/strict";
import {
  baselineFromDraft,
  rebaseRowBaseline,
  isKeptRowEditOp,
  rowFieldDiff,
  shouldSyncFromRow,
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

// Resync from the cached row: a new version always wins (today's rule); a
// same-version change (a find/replace applied optimistically, a merging
// refetch carrying the server's text) only reaches a row with no unsaved typing.
check(shouldSyncFromRow({ versionMoved: true, dirty: true }), "a new server version resyncs even dirty fields");
check(shouldSyncFromRow({ versionMoved: false, dirty: false }), "a same-version change reaches a clean row");
check(!shouldSyncFromRow({ versionMoved: false, dirty: true }), "a same-version change never overwrites kept typing");

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
