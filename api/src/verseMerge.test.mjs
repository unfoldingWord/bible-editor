// Unit tests for verseMerge.ts — the D1-vs-master verse merge attribution used
// by the nightly Door43->D1 sync. The regression the 1CH incident demands
// (2026-08-11, commit 5905373879): with an ancestor available, a human's
// out-of-band edit to master must be adoptable instead of reverted, but never
// at the cost of silently losing alignment on words neither side touched.
// Run from api/:
//   node --experimental-strip-types --no-warnings src/verseMerge.test.mjs
//
// Not a test framework; failures are counted and reported, non-zero exit.

import { computeVerseMerge, collapseWhitespaceForCompare, verseContentConverged } from "./verseMerge.ts";
import {
  classifyMasterCommit,
  compactLineage,
  masterMayHoldHumanEditForVerse,
  parseDiffHunksForPath,
  summarizeLineage,
} from "./masterLineage.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (actual !== expected) {
    console.error(`FAIL: ${msg}\n    expected ${expected}\n    got      ${actual}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const w = (text) => ({ type: "word", tag: "w", text, occurrence: "1", occurrences: "1" });
const zaln = (strong, children) => ({
  type: "milestone",
  tag: "zaln",
  strong,
  occurrence: "1",
  occurrences: "1",
  content: strong,
  children,
});
const content = (verseObjects) => JSON.stringify({ verseObjects });
const text = (s) => JSON.stringify({ verseObjects: [{ type: "text", text: s }] });

console.log("\n[the six actions]");

// 1. keep_converged: ours and theirs already identical.
{
  const same = text("hello world");
  const r = computeVerseMerge({ base: null, ours: same, theirs: same, humanEditedSinceExport: false });
  eq(r.action, "keep_converged", "ours === theirs → keep_converged");
  eq(r.adopt, false, "keep_converged: adopt false");
  eq(r.conflict, false, "keep_converged: conflict false");
  eq(r.reason, "converged", "keep_converged: reason slug");
}

// 2. keep_no_base: no ancestor recoverable.
{
  const r = computeVerseMerge({
    base: null,
    ours: text("our text"),
    theirs: text("their text"),
    humanEditedSinceExport: false,
  });
  eq(r.action, "keep_no_base", "base null → keep_no_base");
  eq(r.adopt, false, "keep_no_base: adopt false");
  eq(r.conflict, false, "keep_no_base: conflict false");
  eq(r.reason, "no_base", "keep_no_base: reason slug");
}

// 3. keep_master_unchanged: theirs === base, master never moved.
{
  const base = text("published text");
  const r = computeVerseMerge({
    base,
    ours: text("our local edit"),
    theirs: base,
    humanEditedSinceExport: false,
  });
  eq(r.action, "keep_master_unchanged", "theirs === base → keep_master_unchanged");
  eq(r.adopt, false, "keep_master_unchanged: adopt false");
  eq(r.conflict, false, "keep_master_unchanged: conflict false");
  eq(r.reason, "master_unchanged", "keep_master_unchanged: reason slug");
}

// 4. keep_alignment_refused: adopting theirs would drop a survivor's \zaln.
{
  const ours = content([zaln("H1", [w("home")])]);
  const theirs = content([w("home")]); // same word, bare — collateral loss
  const r = computeVerseMerge({ base: ours, ours, theirs, humanEditedSinceExport: false });
  eq(r.action, "keep_alignment_refused", "bare survivor → keep_alignment_refused");
  eq(r.adopt, false, "keep_alignment_refused: adopt false");
  eq(r.conflict, true, "keep_alignment_refused: conflict TRUE (needs a human)");
  eq(r.reason, "alignment_shrink", "keep_alignment_refused: reason slug");
  eq(r.alignment?.beforeAligned, 1, "alignment.beforeAligned");
  eq(r.alignment?.afterAligned, 0, "alignment.afterAligned");
  eq(JSON.stringify(r.alignment?.lostWords), JSON.stringify(["home"]), "alignment.lostWords names the word");
}

// 5. adopt: master moved, we did not (base === ours, master's word changed,
// alignment held — this is also "an adoption that does NOT shrink alignment
// is allowed through").
{
  const base = content([zaln("H1", [w("home")])]);
  const theirs = content([zaln("H1", [w("house")])]); // different word, still aligned
  const r = computeVerseMerge({ base, ours: base, theirs, humanEditedSinceExport: false });
  eq(r.action, "adopt", "base===ours, theirs re-worded without losing alignment → adopt");
  eq(r.adopt, true, "adopt: adopt true");
  eq(r.conflict, false, "adopt: conflict false");
  eq(r.reason, "master_only", "adopt: reason slug");
}

// 6. adopt_conflict: both sides moved since the ancestor.
{
  const base = text("original master text");
  const theirs = text("corrected master text");
  const oursMutated = text("our local edit text");
  const r = computeVerseMerge({ base, ours: oursMutated, theirs, humanEditedSinceExport: false });
  eq(r.action, "adopt_conflict", "both ours and theirs differ from base → adopt_conflict");
  eq(r.adopt, true, "adopt_conflict: adopt true");
  eq(r.conflict, true, "adopt_conflict: conflict true");
  eq(r.reason, "both_changed", "adopt_conflict: reason slug");
}

console.log("\n[#540 item 2: an AI-only master movement never beats a later human app edit]");

// The AMO 4:2 shape. Both sides moved, so step 6 fires — but the commit lineage
// says every commit that moved master's file since the ancestor was our own
// export or a bp-assistant push. Master's "edit" is our own pipeline's output;
// reverting the app edit to it is the bug. D1 wins, and it is still a conflict.
{
  const base = text("original master text");
  const theirs = text("the AI run's text");
  const oursMutated = text("Beth's hand fix");
  const r = computeVerseMerge({
    base,
    ours: oursMutated,
    theirs,
    humanEditedSinceExport: false,
    masterMayHoldHumanEdit: false,
  });
  eq(r.action, "keep_ai_master", "both changed + no human commit on master → keep_ai_master");
  eq(r.adopt, false, "keep_ai_master: adopt false — nothing is written, D1 stands");
  eq(r.conflict, true, "keep_ai_master: conflict true — a human still reviews it");
  eq(r.reason, "both_changed_ai_master", "keep_ai_master: reason slug");
}

// The gate is one-directional and explicit. `true` and OMITTED must both keep
// today's master-wins behavior — the flip may only ever ride on a measured
// false, because masterMayHoldHumanEdit() returns true for an incomplete walk
// and for never having looked, and neither may silently become D1-wins.
{
  const base = text("original master text");
  const theirs = text("a maintainer's correction");
  const oursMutated = text("our local edit text");
  eq(
    computeVerseMerge({ base, ours: oursMutated, theirs, humanEditedSinceExport: false, masterMayHoldHumanEdit: true })
      .action,
    "adopt_conflict",
    "masterMayHoldHumanEdit true → master still wins a both-changed conflict",
  );
  eq(
    computeVerseMerge({ base, ours: oursMutated, theirs, humanEditedSinceExport: false }).action,
    "adopt_conflict",
    "masterMayHoldHumanEdit omitted (nobody looked) → master still wins",
  );
  eq(
    computeVerseMerge({
      base,
      ours: oursMutated,
      theirs,
      humanEditedSinceExport: false,
      masterMayHoldHumanEdit: undefined,
    }).action,
    "adopt_conflict",
    "masterMayHoldHumanEdit explicitly undefined → master still wins",
  );
}

// The flip is scoped to step 6 alone. Every earlier step keeps its answer: an
// AI-authored master edit to a verse WE never touched is still adopted (that is
// how pipeline work reaches D1 at all), and a no-ancestor or master-unchanged
// verse is unaffected.
{
  const base = text("original master text");
  const theirs = text("the AI run's text");
  eq(
    computeVerseMerge({ base, ours: base, theirs, humanEditedSinceExport: false, masterMayHoldHumanEdit: false })
      .action,
    "adopt",
    "ours === base: an AI-only master edit is still adopted — nothing of ours is at stake",
  );
  eq(
    computeVerseMerge({
      base: null,
      ours: text("a"),
      theirs: text("b"),
      humanEditedSinceExport: false,
      masterMayHoldHumanEdit: false,
    }).action,
    "keep_no_base",
    "no ancestor: still keep_no_base, not keep_ai_master — attribution never ran",
  );
  eq(
    computeVerseMerge({
      base,
      ours: text("ours"),
      theirs: base,
      humanEditedSinceExport: false,
      masterMayHoldHumanEdit: false,
    }).action,
    "keep_master_unchanged",
    "master never moved: still keep_master_unchanged",
  );
}

// Step ORDER matters as much as step 6's new branch: the alignment guard sits
// above it, and it is the guard that refuses to write a verse whose alignment
// would be damaged. The AI-vs-human policy decides WHO WINS a conflict; it must
// never decide it early enough to skip that check.
{
  const base = text("original master text");
  const r = computeVerseMerge({
    base,
    ours: "{not json",
    theirs: text("the AI run's text"),
    humanEditedSinceExport: false,
    masterMayHoldHumanEdit: false,
  });
  eq(r.action, "keep_alignment_refused", "an unparseable side still refuses at step 4, ahead of the AI-vs-human branch");
  eq(r.reason, "unparseable", "…with the refusal's own reason, not the policy's");
}

console.log("\n[stableKey: key-order-only differences do not manufacture false diffs]");

// Regression: base and ours can arrive from different writers with different
// JSON key ordering. A raw string-equality check would treat this as "master
// moved" (or worse, as a real conflict) when nothing actually differs.
{
  const oursObj = { verseObjects: [{ type: "text", text: "hello", extra: { z: 1, a: 2 } }] };
  const theirsReordered = { verseObjects: [{ extra: { a: 2, z: 1 }, type: "text", text: "hello" }] };
  const r = computeVerseMerge({
    base: null,
    ours: JSON.stringify(oursObj),
    theirs: JSON.stringify(theirsReordered),
    humanEditedSinceExport: false,
  });
  eq(r.action, "keep_converged", "key-order-only difference → keep_converged, not a conflict");
  eq(r.conflict, false, "key-order-only difference → no conflict");
}

console.log("\n[unparseable inputs — fail closed, never silently equal]");

// Unparseable ours: cannot prove the adoption safe → refuse, not "master
// unchanged" or "converged".
{
  const base = text("published text");
  const theirs = text("their different text");
  const r = computeVerseMerge({ base, ours: "{not json", theirs, humanEditedSinceExport: false });
  eq(r.action, "keep_alignment_refused", "unparseable ours → keep_alignment_refused");
  eq(r.conflict, true, "unparseable ours → conflict true");
  eq(r.reason, "unparseable", "unparseable ours → reason slug");
  eq(r.alignment, undefined, "unparseable ours → alignment omitted (counts unknowable)");
}

// Unparseable theirs: same fail-closed behavior.
{
  const base = text("published text");
  const ours = text("our text");
  const r = computeVerseMerge({ base, ours, theirs: "{also not json", humanEditedSinceExport: false });
  eq(r.action, "keep_alignment_refused", "unparseable theirs → keep_alignment_refused");
  eq(r.conflict, true, "unparseable theirs → conflict true");
  eq(r.reason, "unparseable", "unparseable theirs → reason slug");
}

// Unparseable base: a null-yielding base can never equal anything (two nulls
// are NOT equal), so it must not fall into keep_master_unchanged (base
// accidentally "matching" theirs) nor plain adopt (base accidentally
// "matching" ours). It safely falls through to adopt_conflict — master's
// change still wins, but flagged for a human, never silent.
{
  const ours = text("our text");
  const theirs = text("their different text");
  const r = computeVerseMerge({ base: "{corrupt base", ours, theirs, humanEditedSinceExport: false });
  eq(r.action, "adopt_conflict", "unparseable base → adopt_conflict, not master_unchanged/adopt");
  eq(r.conflict, true, "unparseable base → conflict true (flagged, not silent)");
}

console.log("\n[1CH-shaped pairs]");

// base === ours (we published it, nobody edited since D1), master's content
// substantively differs → adopt.
{
  const base = text("original master text");
  const theirs = text("corrected master text");
  const r = computeVerseMerge({ base, ours: base, theirs, humanEditedSinceExport: false });
  eq(r.action, "adopt", "1CH shape: base===ours, master corrected → adopt");
  eq(r.conflict, false, "1CH shape adopt: conflict false");
}

// Same base/theirs, but ours has also moved away from base → adopt_conflict.
{
  const base = text("original master text");
  const theirs = text("corrected master text");
  const oursMutated = text("locally edited text");
  const r = computeVerseMerge({ base, ours: oursMutated, theirs, humanEditedSinceExport: false });
  eq(r.action, "adopt_conflict", "1CH shape: ours also moved → adopt_conflict");
  eq(r.conflict, true, "1CH shape adopt_conflict: conflict true");
}

console.log("\n[humanEditedSinceExport race belt]");

// Bytes match the base (ours === base), but a human edit_log row landed in
// the seconds-wide window between the export's D1 read and its commit.
// Byte equality alone would say "adopt cleanly"; the flag must still force
// adopt_conflict.
{
  const base = text("original master text");
  const theirs = text("corrected master text");
  const r = computeVerseMerge({ base, ours: base, theirs, humanEditedSinceExport: true });
  eq(r.action, "adopt_conflict", "humanEditedSinceExport true, ours===base → adopt_conflict (race belt)");
  eq(r.conflict, true, "race belt: conflict true");
}

console.log("\n[whitespace-only text differences do not manufacture a false adopt]");

// Regression for the FIX A defect: buildUsfm -> normalizeUsfmFormatting
// rewrites blank-line layout, and re-parsing absorbs the change into the
// verse's trailing text node (e.g. `".” "` round-trips to `".”\n\n"`). Before
// the fix, `ours == base` (both untouched D1 content) but `theirs` (master
// re-parsed) differed only by this trailing whitespace, so the merge wrongly
// concluded "master moved" and produced `adopt` — silently rewriting the
// verse and reopening its checkoff lanes for a purely cosmetic non-change.
{
  const ours = text(".” ");
  const theirs = text(".”\n\n");
  const r = computeVerseMerge({ base: ours, ours, theirs, humanEditedSinceExport: false });
  eq(r.action, "keep_converged", "trailing-newline-only difference → keep_converged, not adopt");
  eq(r.adopt, false, "whitespace-only difference must never adopt");
}

console.log("\n[occurrence/occurrences-only drift does not manufacture a false adopt]");

// Regression for the residual FIX A found on the second render→reparse pass:
// export.ts's recomputeTargetOccurrences renumbers a target `\w` node's
// occurrence/occurrences from document position every time buildUsfm runs,
// so the SAME words can carry different occurrence labels between D1's
// stored content and a fresh render+reparse of it, with no real change to
// the verse. Same words, same text, same order — only the numeric label
// differs.
{
  const ours = content([w("the"), { type: "text", text: " " }, w("the")]);
  // Same two "the" word nodes, but relabeled as if counted with one more
  // instance somewhere else in the (simulated) larger scope.
  const theirsRelabeled = JSON.stringify({
    verseObjects: [
      { type: "word", tag: "w", text: "the", occurrence: "2", occurrences: "5" },
      { type: "text", text: " " },
      { type: "word", tag: "w", text: "the", occurrence: "3", occurrences: "5" },
    ],
  });
  const r = computeVerseMerge({ base: ours, ours, theirs: theirsRelabeled, humanEditedSinceExport: false });
  eq(r.action, "keep_converged", "occurrence/occurrences-only relabeling → keep_converged, not adopt");
  eq(r.adopt, false, "occurrence-only drift must never adopt");
}

// A genuine word-count change must still be caught: adding an extra "the"
// changes the node ARRAY (an extra element), which occurrence-dropping does
// nothing to hide — this must still register as a real difference.
{
  const ours = content([w("the")]);
  const theirsExtraWord = content([w("the"), { type: "text", text: " " }, w("the")]);
  const r = computeVerseMerge({ base: ours, ours, theirs: theirsExtraWord, humanEditedSinceExport: false });
  eq(r.action, "adopt", "a genuinely added word is still a real difference → adopt, not converged");
}

console.log("\n[#627: empty nextChar / empty text nodes do not manufacture false diffs]");

// Presence half of the nextChar round-trip: normalizeForCompare collapses
// `" "` / `"\n"` to `""`, but keeping that empty key still differed from an
// absent nextChar. base:null + keep_converged is the one-bit probe that step 1
// matched (keep_no_base would mean the trees still look different).
{
  const withEmpty = JSON.stringify({
    verseObjects: [{ tag: "q1", type: "paragraph", nextChar: "" }, w("hello")],
  });
  const absent = JSON.stringify({
    verseObjects: [{ tag: "q1", type: "paragraph" }, w("hello")],
  });
  const r = computeVerseMerge({
    base: null,
    ours: withEmpty,
    theirs: absent,
    humanEditedSinceExport: false,
  });
  eq(r.action, "keep_converged", "nextChar: \"\" vs absent → keep_converged");
}
{
  const withSpace = JSON.stringify({
    verseObjects: [{ tag: "q1", type: "paragraph", nextChar: " " }, w("hello")],
  });
  const absent = JSON.stringify({
    verseObjects: [{ tag: "q1", type: "paragraph" }, w("hello")],
  });
  const r = computeVerseMerge({
    base: null,
    ours: withSpace,
    theirs: absent,
    humanEditedSinceExport: false,
  });
  eq(r.action, "keep_converged", "nextChar: \" \" vs absent → keep_converged");
}
{
  const withNewline = JSON.stringify({
    verseObjects: [{ tag: "q1", type: "paragraph", nextChar: "\n" }, w("hello")],
  });
  const absent = JSON.stringify({
    verseObjects: [{ tag: "q1", type: "paragraph" }, w("hello")],
  });
  const r = computeVerseMerge({
    base: null,
    ours: withNewline,
    theirs: absent,
    humanEditedSinceExport: false,
  });
  eq(r.action, "keep_converged", "nextChar: \"\\n\" vs absent → keep_converged");
}

// Extra empty / whitespace-only text node shifts every following index under
// a naive compare, but carries no content — strip for comparison only.
{
  const withEmptyNode = content([w("hello"), { type: "text", text: "" }, w("world")]);
  const without = content([w("hello"), w("world")]);
  const r = computeVerseMerge({
    base: null,
    ours: withEmptyNode,
    theirs: without,
    humanEditedSinceExport: false,
  });
  eq(r.action, "keep_converged", "extra empty text node → keep_converged");
}
{
  const withWsNode = content([w("hello"), { type: "text", text: " \n " }, w("world")]);
  const without = content([w("hello"), w("world")]);
  const r = computeVerseMerge({
    base: null,
    ours: withWsNode,
    theirs: without,
    humanEditedSinceExport: false,
  });
  eq(r.action, "keep_converged", "extra whitespace-only text node → keep_converged");
}

// Guard against over-collapsing: a real word change must still look different.
{
  const ours = content([w("hello"), w("world")]);
  const theirs = content([w("hello"), w("earth")]);
  const r = computeVerseMerge({
    base: null,
    ours,
    theirs,
    humanEditedSinceExport: false,
  });
  eq(r.action, "keep_no_base", "genuinely changed word still → keep_no_base (not over-collapsed)");
}

console.log("\n[collapseWhitespaceForCompare — Task 3's lane-reopen guard input]");

// bookReimport.ts's Task 3 guard (skip reopening the 'text' lane when an
// adoption didn't actually change plain_text) compares beforePlainText vs
// afterPlainText through this exact function — these cases are the direct
// evidence backing that guard, since applyVerseRows itself has no D1-mock
// test harness to exercise end-to-end.
eq(collapseWhitespaceForCompare("hello  world"), "hello world", "collapses internal whitespace runs");
eq(collapseWhitespaceForCompare("  hello world\n"), "hello world", "trims leading/trailing whitespace");
eq(collapseWhitespaceForCompare(null), "", "null -> empty string (never crashes, never a fluke non-match)");
eq(
  collapseWhitespaceForCompare("Sword, awake\n") === collapseWhitespaceForCompare("Sword, awake "),
  true,
  "a trailing-newline-vs-trailing-space plain_text pair (the FIX A shape) compares EQUAL — the reopen guard must skip",
);
eq(
  collapseWhitespaceForCompare("Sword, awake") === collapseWhitespaceForCompare("Sword awake"),
  false,
  "a genuine word-boundary change (comma removed) compares UNEQUAL — the reopen guard must still fire",
);

console.log("\n[#557: a per-verse map we could not build must not un-protect the verse]");

// Step 6's flag is now asked per verse (masterMayHoldHumanEditForVerse). The
// narrowing rides on evidence fetched from Door43 — a commit's diff, and the
// file at that commit — and every way that can fail has to land on the SAME
// answer the file-level gate gave before #557: master wins, adopt_conflict.
// Absence of evidence is not evidence that no human touched this verse.
{
  const base = text("the ancestor we last published");
  const ours = text("a translator's app edit");
  const theirs = text("what master holds now");
  const human = [
    classifyMasterCommit({ sha: "h1", message: "Fixes s5 markers", authorEmail: "rich.mahn@unfoldingword.org" }),
  ];
  const merge = (lineage) =>
    computeVerseMerge({
      base,
      ours,
      theirs,
      humanEditedSinceExport: false,
      masterMayHoldHumanEdit: masterMayHoldHumanEditForVerse(lineage, 40, 5),
    }).action;

  // (a) The diff came back unparseable — the shape a truncated or non-diff body
  // produces. parseDiffHunksForPath says so, and the caller turns that into
  // incomplete evidence.
  const unparseable = parseDiffHunksForPath("this is not a unified diff", "24-JER.usfm");
  eq(unparseable.complete, false, "an unparseable diff parses to incomplete");
  eq(
    merge(
      compactLineage(summarizeLineage(human, { humanRefs: { complete: false, refs: [], reason: unparseable.reason } })),
    ),
    "adopt_conflict",
    "an unparseable diff → adopt_conflict (the pre-#557 answer), never keep_ai_master",
  );

  // (b) The file was absent at that revision, or the fetch fell over.
  eq(
    merge(
      compactLineage(
        summarizeLineage(human, { humanRefs: { complete: false, refs: [], reason: "revision_fetch_failed" } }),
      ),
    ),
    "adopt_conflict",
    "a missing or failed revision fetch → adopt_conflict",
  );

  // (c) Nobody even tried — no evidence on the summary at all, which is also
  // what a plan staged by a Workflow instance older than #557 replays.
  eq(merge(compactLineage(summarizeLineage(human))), "adopt_conflict", "no per-verse evidence at all → adopt_conflict");
  eq(
    merge(JSON.parse(JSON.stringify({ mayHoldHumanEdit: true, hasHumanCommit: true }))),
    "adopt_conflict",
    "a summary serialized before #557 (no refs fields at all) → adopt_conflict",
  );

  // (d) The control: complete evidence placing every human hunk elsewhere is
  // the ONLY thing that flips this verse.
  eq(
    merge(compactLineage(summarizeLineage(human, { humanRefs: { complete: true, refs: ["23:5", "31:19"], reason: "" } }))),
    "keep_ai_master",
    "complete evidence placing every human hunk elsewhere → keep_ai_master",
  );
}

// ── verseContentConverged: the exported lens (issue #609) ───────────────────
//
// Review finding F3. The pristine/AI-only write guard calls this on the nightly
// hot path with content straight out of D1 and straight off Door43, so its
// unparseable-input contract is a safety property, not an edge case: "cannot
// compare" must read as "not converged", which makes the caller WRITE. If this
// ever returned true for input it could not parse, the sync would silently decline
// to adopt master on exactly the verses whose stored JSON is already broken.
console.log("\n[verseContentConverged: unparseable input is never converged]");
{
  const good = JSON.stringify({ verseObjects: [{ type: "text", text: "hi" }] });

  eq(verseContentConverged("{not json", good), false, "unparseable OURS is never converged (caller writes)");
  eq(verseContentConverged(good, "{not json"), false, "unparseable THEIRS is never converged (caller writes)");
  eq(
    verseContentConverged("{not json", "{not json"),
    false,
    "two IDENTICALLY unparseable strings are still not converged — equal garbage is not proof of equal content",
  );

  // The positive control, so the three assertions above cannot pass merely because
  // the function always returns false.
  eq(
    verseContentConverged(good, JSON.stringify({ verseObjects: [{ type: "text", text: " hi " }] })),
    true,
    "…while a genuine whitespace-only difference IS converged under the lens",
  );
  eq(
    verseContentConverged(good, JSON.stringify({ verseObjects: [{ type: "text", text: "bye" }] })),
    false,
    "…and a real word change is not",
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll verseMerge assertions passed.");
