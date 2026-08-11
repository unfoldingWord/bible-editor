// Unit tests for verseMerge.ts — the D1-vs-master verse merge attribution used
// by the nightly Door43->D1 sync. The regression the 1CH incident demands
// (2026-08-11, commit 5905373879): with an ancestor available, a human's
// out-of-band edit to master must be adoptable instead of reverted, but never
// at the cost of silently losing alignment on words neither side touched.
// Run from api/:
//   node --experimental-strip-types --no-warnings src/verseMerge.test.mjs
//
// Not a test framework; failures are counted and reported, non-zero exit.

import { computeVerseMerge } from "./verseMerge.ts";

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

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll verseMerge assertions passed.");
