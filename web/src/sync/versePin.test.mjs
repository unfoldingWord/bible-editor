// Regression coverage for issue #474: "A save can carry stale verse content
// with a fresh version." A WebSocket verse.updated (another tab's edit, or
// the nightly source-attr reconcile) landing mid-edit must not silently
// rebase a later save's diff baseline onto content the user's
// still-protected DOM never reflected — that let a save whose content read
// as "added back" text someone else deleted go out under a version fresh
// enough to pass If-Match, silently resurrecting the deletion.
// pinVerseBase is the guard: it freezes the diff/save baseline to what the
// edit session actually started from.
//
// Run from web/:
//   node --experimental-strip-types --no-warnings src/sync/versePin.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors src/lib/replace.test.mjs.

import { pinVerseBase, peekPinnedVerseBase, unpinVerseBase } from "./versePin.ts";
import { smartEditVerse } from "../lib/replace.ts";
import { extractEditableText } from "../lib/usfm.ts";

let failed = 0;
function check(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ─── pinVerseBase: first call wins, held until unpin ────────────────────
{
  console.log("[pinVerseBase] first call wins, later calls don't move the pin");
  const key = "verse:TST:1:1:ULT";
  unpinVerseBase(key);
  const first = pinVerseBase(key, { version: 2, content: "v2-content" });
  check(first.version === 2 && first.content === "v2-content", "first pin captures the given base");

  // A version bump lands mid-edit (WS verse.updated) — a later call with a
  // fresher base must NOT move the pin.
  const second = pinVerseBase(key, { version: 3, content: "v3-content" });
  check(second.version === 2 && second.content === "v2-content", "later pin call returns the ORIGINAL pin, not the fresher base");
  check(peekPinnedVerseBase(key)?.version === 2, "peek agrees: still pinned to v2");

  unpinVerseBase(key);
  check(peekPinnedVerseBase(key) === undefined, "unpin clears the pin");

  const third = pinVerseBase(key, { version: 3, content: "v3-content" });
  check(third.version === 3, "a new session after unpin re-pins to the current base");
  unpinVerseBase(key);
}

// ─── The actual #474 mechanism: mirrors saveVerseDraft's composition ────
// (extractEditableText(base.content) -> smartEditVerse(base.content, old,
// plain)) with and without pinning, against the HOS 11:1 shape reported in
// the issue: a leading quote as a plain text node ahead of a
// \zaln-s-wrapped word.
const w = (text) => ({ text, tag: "w", type: "word", occurrence: "1", occurrences: "1" });
const t = (text) => ({ type: "text", text });
const zaln = (strong, children) => ({
  tag: "zaln", type: "milestone", strong, lemma: "x", morph: "x",
  occurrence: "1", occurrences: "1", content: "x", children, endTag: "zaln-e\\*",
});

// What the session's DOM actually shows when the user starts typing: quote
// present, matching the server row the tab loaded.
const sessionStartContent = {
  verseObjects: [t("“"), zaln("H1234", [w("When")]), t(" Israel was a child")],
};
const sessionStartVersion = 2;

// What lands via WS mid-edit: someone else's legitimate deletion of the
// quote, landed as version 3.
const midEditServerContent = {
  verseObjects: [zaln("H1234", [w("When")]), t(" Israel was a child")],
};
const midEditServerVersion = 3;

// The user's own edit: DOM still starts with the quote (untouched — dirtyRef
// shields it from the WS update) plus one appended clause.
const userDomText = "“When Israel was a child, I loved him.";

// Mirrors saveVerseDraft's diff composition in Shell.tsx.
function saveAgainst(base) {
  const oldEditable = extractEditableText(base.content);
  const result = smartEditVerse(base.content, oldEditable, userDomText);
  return { editableSent: extractEditableText(result.content), expectedVersion: base.version };
}

{
  console.log("\n[Bug] Diffing against the LIVE (post-WS) base resurrects the deleted quote");
  const buggy = saveAgainst({ version: midEditServerVersion, content: midEditServerContent });
  check(buggy.editableSent.startsWith("“"), "unpinned save reintroduces the quote someone else deleted");
  check(buggy.expectedVersion === midEditServerVersion, "...carrying a FRESH version, so If-Match would silently pass");
}

{
  console.log("\n[Fix] Diffing against the PINNED (session-start) base does not resurrect anything");
  const key = "verse:HOS:11:1:ULT";
  unpinVerseBase(key);
  pinVerseBase(key, { version: sessionStartVersion, content: sessionStartContent });
  // WS update lands mid-edit; a naive re-derivation would use this fresher
  // base, but the pin must not move.
  pinVerseBase(key, { version: midEditServerVersion, content: midEditServerContent });
  const pinned = peekPinnedVerseBase(key);
  const fixed = saveAgainst(pinned);
  check(fixed.editableSent === userDomText, "fixed save's content is exactly what the user typed — no resurrection");
  check(
    fixed.expectedVersion === sessionStartVersion,
    "...carrying the STALE (session-start) version, so the server 409s instead of silently accepting it",
  );
  unpinVerseBase(key);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll versePin tests passed.");
