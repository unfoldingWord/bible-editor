// Regression suite for the note-body formatting toolbar operations.
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/noteFormat.test.mjs
//
// Pins the Word-style list behaviour on intro notes: numbered/bulleted list
// toggle, indent/outdent by one four-space level, list continuation on Enter,
// and normalisation so raw text reads 1. 2. 3. at every nesting level with
// children indented a full four spaces (the 2-space top-level convention in
// existing ISA intros made children render as run-on text — issue #753).

import {
  continueListOnEnter,
  indentLines,
  isListLine,
  normalizeLists,
  outdentLines,
  tidyLists,
  toggleBold,
  toggleList,
} from "./noteFormat.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}
function eq(actual, expected, msg) {
  assert(actual === expected, `${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
}

// ── normalizeLists: renumbering ──
{
  eq(
    normalizeLists("1. a\n1. b\n    1. c\n    1. d\n1. e"),
    "1. a\n2. b\n    1. c\n    2. d\n3. e",
    "nested levels count independently; parent resumes after nested block",
  );
  eq(normalizeLists("1. a\n\n1. b"), "1. a\n\n2. b", "blank line between items keeps the count (loose list)");
  eq(normalizeLists("1. a\nprose\n1. b"), "1. a\nprose\n1. b", "unindented prose ends the list; count restarts");
  eq(normalizeLists("3. a\n7. b"), "1. a\n2. b", "arbitrary source numbers normalise to 1. 2.");
  eq(normalizeLists("* x\n* y"), "* x\n* y", "bullets untouched");
  eq(normalizeLists("para\n\n    code block"), "para\n\n    code block", "non-list indented lines are left alone");
}

// ── normalizeLists: indentation (issue #753) ──
{
  const isa5 =
    "  1. Seventh oracle\n    1. The Song of the Vineyard\n  2. First six woes\n    1. Woe one\n    2. Woe two\n1. Present punishments\n    1. Devouring flame";
  eq(
    normalizeLists(isa5),
    "1. Seventh oracle\n    1. The Song of the Vineyard\n2. First six woes\n    1. Woe one\n    2. Woe two\n3. Present punishments\n    1. Devouring flame",
    "ISA-style 2-space parents snap to column 0 so their 4-space children nest; the stray 0-space item joins the sequence",
  );
  eq(normalizeLists("1. a\n   1. b"), "1. a\n    1. b", "a valid 3-space child (CommonMark-nested) becomes a 4-space child, not top level");
  eq(normalizeLists("1. a\n      * b"), "1. a\n    * b", "6-space bullet snaps down to one level");
  eq(normalizeLists("1. a\n    1. b\n        1. c"), "1. a\n    1. b\n        1. c", "8 spaces under a 4-space parent is a real third level and stays");
  eq(normalizeLists("1. a\n        1. b"), "1. a\n    1. b", "an item can't skip a level: 8 spaces directly under a top-level item becomes its child");
  eq(
    normalizeLists("1. Seventh\n       1. The Song\n2. Woes"),
    "1. Seventh\n    1. The Song\n2. Woes",
    "the case from browser testing: 7 stray spaces under a top-level item become a clean 4-space child, not an orphaned grandchild",
  );
  eq(normalizeLists("        1. orphan\n1. b"), "1. orphan\n2. b", "a deeply indented first item has no parent, so it is top level");
  eq(normalizeLists("1. a\n    1. b\nprose\n        1. c"), "1. a\n    1. b\nprose\n1. c", "prose closes the outline; the next item starts a fresh top level");
  eq(normalizeLists("  1. a\n\n    1. b"), "1. a\n\n    1. b", "loose ISA-style list normalises the same way");
  eq(normalizeLists("plain text").split("\n").length, 1, "never adds lines");
}

// ── toggleList ──
{
  const r = toggleList("alpha\nbeta", 0, 10, "ordered");
  eq(r.value, "1. alpha\n2. beta", "ordered: marks every selected line, numbered in sequence");
  eq(r.selStart, 3, "ordered: selection start shifts past the new marker");
  eq(r.selEnd, 16, "ordered: selection end shifts by total inserted");

  const off = toggleList(r.value, 0, r.value.length, "ordered");
  eq(off.value, "alpha\nbeta", "ordered on already-ordered lines strips the markers");

  const b = toggleList("1. alpha\n2. beta", 0, 16, "bullet");
  eq(b.value, "* alpha\n* beta", "bullet on ordered lines converts to `*` bullets");
  const dash = toggleList("- x\n- y", 0, 8, "bullet");
  eq(dash.value, "x\ny", "existing `-` bullets count as bullets and toggle off");

  const single = toggleList("one\ntwo\nthree", 5, 5, "ordered");
  eq(single.value, "one\n1. two\nthree", "caret with no selection marks only its own line");
  eq(single.selStart, 8, "caret stays on the same character after its marker");

  const nested = toggleList("1. a\n    sub", 7, 7, "ordered");
  eq(nested.value, "1. a\n    1. sub", "indented line keeps its indent when marked");

  const afterIsa = toggleList("  1. a\n    1. b\nc", 17, 17, "ordered");
  eq(afterIsa.value, "1. a\n    1. b\n2. c", "marking a line also normalises the ISA-style lines above it and continues their count");
  eq(afterIsa.selStart, afterIsa.value.length, "caret follows its own line even when earlier lines shrank");
}

// ── indent / outdent ──
{
  const i = indentLines("1. a\n2. b", 5, 5);
  eq(i.value, "1. a\n    1. b", "indenting an ordered item nests it and restarts its number");
  eq(i.selStart, 9, "caret moves with the indented text");

  const o = outdentLines(i.value, 9, 9);
  eq(o.value, "1. a\n2. b", "outdent restores the parent-level number");

  const multi = indentLines("1. a\n2. b\n3. c", 5, 14);
  eq(multi.value, "1. a\n    1. b\n    2. c", "multi-line selection indents every line");

  eq(outdentLines("x", 0, 0).value, "x", "outdent on an unindented line is a no-op");
  eq(indentLines("a\n\nb", 0, 4).value, "    a\n\n    b", "blank lines inside the selection stay blank");
  eq(indentLines("  1. a", 6, 6).value, "1. a", "a lone item has no parent to nest under, so indenting it leaves it top level (nested-with-no-parent renders as a code block)");
  eq(indentLines("1. p\n  1. a", 10, 10).value, "1. p\n    1. a", "indenting an ISA-style 2-space item under a parent lands on a clean 4-space level");
}

// ── tidyLists ──
{
  const t = tidyLists("intro\n\n  1. a\n    1. b\n  2. c", 22, 22);
  eq(t.value, "intro\n\n1. a\n    1. b\n2. c", "tidy normalises the whole note without touching content");
  eq(t.selStart, 20, "caret stays at the same column of its line, shifted by that line's indent change");
  eq(normalizeLists(t.value), t.value, "tidy output is a fixed point");
}

// ── Enter continuation ──
{
  const r = continueListOnEnter("1. a", 4, 4);
  eq(r?.value, "1. a\n2. ", "Enter at end of an ordered item inserts the next number");
  eq(r?.selStart, 8, "caret lands after the new marker");

  const nested = continueListOnEnter("1. a\n    1. b", 13, 13);
  eq(nested?.value, "1. a\n    1. b\n    2. ", "Enter keeps the nesting indent");

  const bullet = continueListOnEnter("* a", 3, 3);
  eq(bullet?.value, "* a\n* ", "Enter on a bullet continues with a bullet");

  const empty = continueListOnEnter("1. a\n2. ", 8, 8);
  eq(empty?.value, "1. a\n", "Enter on an empty item removes the marker (exits the list)");
  eq(empty?.selStart, 5, "caret sits on the now-plain line");

  const emptyNested = continueListOnEnter("1. a\n    1. ", 12, 12);
  eq(emptyNested?.value, "1. a\n2. ", "empty nested item outdents one level and takes the parent-level number");
  eq(emptyNested?.selStart, 8, "caret after the outdented marker");
  const emptyNestedBullet = continueListOnEnter("* a\n    * ", 10, 10);
  eq(emptyNestedBullet?.value, "* a\n* ", "empty nested bullet outdents to a top-level bullet");
  const wide = continueListOnEnter("1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n7. g\n8. h\n9. i", 44, 44);
  eq(wide?.value.slice(-4), "10. ", "continuation past 9 writes a two-digit marker");
  eq(wide?.selStart, wide?.value.length, "caret sits after the two-digit marker");

  eq(continueListOnEnter("plain", 5, 5), null, "not a list line: null so default Enter applies");
  eq(continueListOnEnter("1. abc", 3, 3), null, "caret mid-item: null (no split-continuation)");
  eq(continueListOnEnter("1. a\n2. b", 0, 3), null, "range selection: null");

  const mid = continueListOnEnter("1. a\n2. b\n3. c", 9, 9);
  eq(mid?.value, "1. a\n2. b\n3. \n4. c", "Enter mid-list renumbers the items below");

  const isa = continueListOnEnter("  1. a\n    1. b", 15, 15);
  eq(isa?.value, "1. a\n    1. b\n    2. ", "Enter on an ISA-style outline normalises it and continues the nested list");
  eq(isa?.selStart, isa?.value.length, "caret is at the end of the new item despite earlier lines shrinking");
}

// ── isListLine ──
{
  assert(isListLine("1. a\nplain", 2), "ordered line detected");
  assert(isListLine("* a", 0), "bullet line detected");
  assert(!isListLine("1. a\nplain", 7), "plain line not detected");
}

// ── bold ──
{
  const on = toggleBold("say hello now", 4, 9);
  eq(on.value, "say **hello** now", "bold wraps the selection");
  eq(on.selStart, 6, "selection stays on the word (start)");
  eq(on.selEnd, 11, "selection stays on the word (end)");
  const off = toggleBold(on.value, on.selStart, on.selEnd);
  eq(off.value, "say hello now", "bold again unwraps via surrounding markers");
  const offOuter = toggleBold("say **hello** now", 4, 13);
  eq(offOuter.value, "say hello now", "selecting the markers too also unwraps");
  const caret = toggleBold("abc", 1, 1);
  eq(caret.value, "a****bc", "empty selection inserts an empty bold pair");
  eq(caret.selStart, 3, "caret between the pair");
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall noteFormat assertions passed");
