import assert from "node:assert/strict";
import {
  generationForSavedPlain,
  generationForSuccessfulOp,
  pinReleaseAfterVerseOk,
  pinReleaseForVerseExit,
  verseDraftHasActiveSave,
  verseOpExitInfo,
} from "./draftSaveState.ts";
import { pinVerseBase, unpinVerseBase, peekPinnedVerseBase } from "./versePin.ts";

const draft = {
  key: "verse:MIC:5:0:ULT",
  payload: { plainText: "\\q1" },
  expectedVersion: 0,
  updatedAt: 1,
  generation: "g-intro",
  meta: { kind: "verse", book: "MIC", chapter: 5, verse: 0, bibleVersion: "ULT" },
};

function op(status, overrides = {}) {
  return {
    id: `op-${status}`,
    target: { kind: "verse", book: "MIC", chapter: 5, verse: 0, bibleVersion: "ULT", ...overrides },
    action: "patch",
    patch: {},
    expectedVersion: 0,
    queuedAt: 1,
    attempts: 0,
    status,
    draftGeneration: "g-intro",
  };
}

assert.equal(verseDraftHasActiveSave(draft, [op("pending")]), true, "pending intro save suppresses reminder");
assert.equal(verseDraftHasActiveSave(draft, [op("in_flight")]), true, "in-flight intro save suppresses reminder");
assert.equal(verseDraftHasActiveSave(draft, [op("conflict")]), false, "conflicted save remains recoverable");
assert.equal(verseDraftHasActiveSave(draft, [op("failed")]), false, "failed save remains recoverable");
assert.equal(verseDraftHasActiveSave(draft, [op("pending", { verse: 1 })]), false, "verse 1 save does not hide intro draft");
assert.equal(verseDraftHasActiveSave(draft, [op("pending", { bibleVersion: "UST" })]), false, "other version does not hide intro draft");
assert.equal(
  verseDraftHasActiveSave(draft, [{ ...op("pending"), draftGeneration: "g-older" }]),
  false,
  "older in-flight save does not hide newer typing",
);
const legacyOp = {
  ...op("pending"),
  queuedAt: 2,
  draftGeneration: undefined,
  patch: { content: { verseObjects: [{ type: "quote", tag: "q1" }] } },
};
assert.equal(verseDraftHasActiveSave(draft, [legacyOp]), true, "pre-upgrade pending save suppresses its old draft");
assert.equal(
  verseDraftHasActiveSave({ ...draft, payload: { plainText: "\\q1\u00a0\n\u200b" } }, [legacyOp]),
  true,
  "pre-upgrade save matches raw editor whitespace after normalization",
);
assert.equal(
  verseDraftHasActiveSave({ ...draft, payload: { plainText: "\\q1 changed" } }, [legacyOp]),
  false,
  "pre-upgrade save does not hide newer text",
);
const unrelatedLegacyOp = {
  ...legacyOp,
  patch: { content: { verseObjects: [{ type: "word", tag: "w", text: "unrelated" }] } },
};
assert.equal(
  verseDraftHasActiveSave(draft, [unrelatedLegacyOp]),
  false,
  "unrelated legacy verse operation does not hide the text draft",
);

assert.equal(generationForSavedPlain(draft, "\\q1"), "g-intro", "matching payload carries its generation");
assert.equal(generationForSavedPlain(draft, "\\q1 changed"), undefined, "newer text is not cleared by older save");
assert.equal(
  generationForSavedPlain({ ...draft, generation: undefined }, "\\q1"),
  "legacy:1",
  "legacy draft gets a stable cleanup identity",
);
assert.equal(generationForSuccessfulOp(draft, legacyOp), "g-intro", "pre-upgrade success clears the draft it captured");
assert.equal(
  generationForSuccessfulOp({ ...draft, payload: { plainText: "\\q1 changed" } }, legacyOp),
  undefined,
  "pre-upgrade success preserves newer typing",
);
assert.equal(
  generationForSuccessfulOp(draft, unrelatedLegacyOp),
  undefined,
  "unrelated legacy verse success preserves the text draft",
);

// pinReleaseAfterVerseOk — the #563 pin-leak rule. A landed verse save must
// release the diff-baseline pin exactly once: via clearGeneration when a
// matching draft exists, via an explicit unpin when the save was draftless
// (the dual-aligner reading line never stashes keystrokes), and never when a
// draft it can't be tied to exists — that draft is newer typing whose baseline
// the pin protects (#474).
assert.deepEqual(
  pinReleaseAfterVerseOk(draft, op("pending")),
  { kind: "clear", generation: "g-intro" },
  "matching draft: release rides the generation clear",
);
assert.deepEqual(
  pinReleaseAfterVerseOk(undefined, op("pending")),
  { kind: "unpin" },
  "draftless save (reading line): pin released explicitly, or it leaks for the session",
);
assert.deepEqual(
  pinReleaseAfterVerseOk({ ...draft, generation: "g-newer" }, op("pending")),
  { kind: "keep" },
  "newer typing raced ahead: its draft still needs the pin — keep it",
);
assert.deepEqual(
  pinReleaseAfterVerseOk(draft, unrelatedLegacyOp),
  { kind: "keep" },
  "unrelated legacy op landing does not release a pin a live draft depends on",
);
assert.deepEqual(
  pinReleaseAfterVerseOk(draft, legacyOp),
  { kind: "clear", generation: "g-intro" },
  "pre-generation op still clears via reconstructed editable text (exit-info plumbing parity)",
);

// verseOpExitInfo — the wire-safe description of a verse op's terminal exit.
// It must carry everything the release rule needs, because the receiving tab
// never sees the op: the drain is cross-tab-exclusive while the pin map is
// per-tab memory (#565).
assert.deepEqual(
  verseOpExitInfo(op("pending"), "ok"),
  { exit: "ok", draftGeneration: "g-intro" },
  "generation ops announce their draft generation",
);
assert.deepEqual(
  verseOpExitInfo(legacyOp, "locked"),
  { exit: "locked", editableText: "\\q1" },
  "pre-generation ops announce their reconstructed editable text instead",
);

// pinReleaseForVerseExit, non-ok exits — `locked` deletes the op permanently
// (chapter mid-AI-pipeline) and a discard deletes it from SyncStatusBar; no
// 200 will ever follow either, so a DRAFTLESS pin must release here or the
// verse is poisoned for the session. A draft, when one exists, is the only
// copy of the user's unsaved text: it must SURVIVE these exits, so the rule
// never clears and keeps the pin protecting its baseline.
assert.deepEqual(
  pinReleaseForVerseExit(undefined, verseOpExitInfo(op("pending"), "locked")),
  { kind: "unpin" },
  "locked exit of a draftless save releases the pin",
);
assert.deepEqual(
  pinReleaseForVerseExit(draft, verseOpExitInfo(op("pending"), "locked")),
  { kind: "keep" },
  "locked exit never clears a draft — even the one this op captured",
);
assert.deepEqual(
  pinReleaseForVerseExit(undefined, verseOpExitInfo(op("pending"), "discarded")),
  { kind: "unpin" },
  "discarding a draftless refused op releases the pin its cleanup used to leak",
);
assert.deepEqual(
  pinReleaseForVerseExit({ ...draft, generation: "g-newer" }, verseOpExitInfo(op("pending"), "discarded")),
  { kind: "keep" },
  "discard with newer typing present keeps both the draft and its pin",
);

// Success check (a), unit-shaped: tab A's draftless save pinned a baseline,
// but the drain — and the ok result — ran in tab B. Tab B broadcasts the exit
// info; tab A applies the same rule against its own (draftless) draft state,
// unpins, and the follow-up save session pins the FRESH base instead of
// diffing against the stale one.
const pinKey = "verse:MIC:5:0:ULT";
pinVerseBase(pinKey, { version: 3, content: "stale" });
{
  const announced = verseOpExitInfo(op("pending"), "ok"); // built in "tab B"
  const release = pinReleaseForVerseExit(undefined, announced); // applied in "tab A"
  assert.deepEqual(release, { kind: "unpin" }, "cross-tab ok announcement releases in the receiving tab");
  unpinVerseBase(pinKey);
}
assert.equal(peekPinnedVerseBase(pinKey), undefined, "pin map is empty after the cross-tab release");
assert.equal(
  pinVerseBase(pinKey, { version: 7, content: "fresh" }).version,
  7,
  "tab A's next save session pins the fresh base, not the leaked one",
);
unpinVerseBase(pinKey);

// Success check (b), unit-shaped: a reading-line save against a
// pipeline-locked chapter — the op is deleted permanently, the exit is
// `locked`, and the draftless pin must release; the save after the lock
// clears then pins the current version and lands without a conflict prompt.
pinVerseBase(pinKey, { version: 3, content: "pre-lock" });
{
  const release = pinReleaseForVerseExit(undefined, verseOpExitInfo(op("pending"), "locked"));
  assert.deepEqual(release, { kind: "unpin" }, "locked-exit deletion releases the draftless pin");
  unpinVerseBase(pinKey);
}
assert.equal(
  pinVerseBase(pinKey, { version: 9, content: "post-lock" }).version,
  9,
  "save after the lock clears pins the fresh version — no stale-baseline 409",
);
unpinVerseBase(pinKey);

console.log("draftSaveState: 33 passed");
