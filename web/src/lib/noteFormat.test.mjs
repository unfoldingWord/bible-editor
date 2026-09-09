// Regression suite for the note-body formatting toolbar operations.
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/noteFormat.test.mjs
//
// Pins the Word-style list behaviour on intro notes: numbered/bulleted list
// toggle, indent/outdent by one four-space level, list continuation on Enter,
// and normalisation of the outline (relative nesting written at four spaces
// per level, sequential numbering that keeps each list's start number).
// The 2-space top-level convention in existing ISA intros made children
// render as run-on text (issue #753); MAT/ROM intros start outlines at the
// chapter's position in the book outline (`2. Jesus' Sermon…`), so start
// numbers are data and must survive.

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
function unchanged(text, msg) {
  eq(normalizeLists(text), text, msg);
}

// ── normalizeLists: numbering ──
{
  eq(
    normalizeLists("1. a\n1. b\n    1. c\n    1. d\n1. e"),
    "1. a\n2. b\n    1. c\n    2. d\n3. e",
    "nested levels count independently; parent resumes after nested block",
  );
  eq(normalizeLists("1. a\n\n1. b"), "1. a\n\n2. b", "blank line between items keeps the count (loose list)");
  unchanged("1. a\nprose\n1. b", "unindented prose ends the list; the next list starts fresh");
  eq(normalizeLists("3. a\n7. b"), "3. a\n4. b", "a list keeps its start number; later items count on from it");
  unchanged("1. a\n2. b\n\nA paragraph between.\n\n3. c\n4. d", "a list resuming after prose keeps its start number (CommonMark renders 3)");
  unchanged(
    "## Outline\n\n2. Jesus’ Sermon on the Mount ([5:1–7:28](../05/01.md))\n    1. The Beatitudes\n3. Healings",
    "MAT-style intro outline starting at the chapter's book-outline position is left alone",
  );
  unchanged("This is prose.\n5. is the verse where it happens.\nMore prose.", "a prose line that merely begins with `5. ` is left alone");
  unchanged("* x\n* y", "bullets untouched");
  unchanged("para\n\n    code block", "non-list indented lines are left alone");
  unchanged("# Heading\n\ntext\n\n> quote", "headings and quotes untouched");
  unchanged("```\n3. literal\n9. literal\n  1. literal\n```\n\n1. a\n2. b", "fenced code is literal: list-shaped lines inside ``` are not renumbered or re-indented (Codex review)");
  unchanged("~~~\n    1. literal\n~~~", "tilde fences are fences too");
  unchanged("````\n```\n3. literal\n9. literal\n```\n````\n", "a 4-backtick fence is not closed by a 3-backtick line inside it (Codex verify)");
  unchanged("```\n3. literal\n~~~\n9. literal\n```", "a tilde line does not close a backtick fence");
  eq(normalizeLists("```js\n3. x\n```\n1. a\n1. b"), "```js\n3. x\n```\n1. a\n2. b", "an opener with an info string still opens a fence; content after the real close normalises");
  eq(normalizeLists("1. a\n```\ncode\n```\n1. b"), "1. a\n```\ncode\n```\n1. b", "a fence closes the list; the next list starts fresh with its own number");
}

// ── normalizeLists: nesting (issue #753) ──
{
  const isa5 =
    "  1. Seventh oracle\n    1. The Song of the Vineyard\n  2. First six woes\n    1. Woe one\n    2. Woe two\n1. Present punishments\n    1. Devouring flame";
  eq(
    normalizeLists(isa5),
    "1. Seventh oracle\n    1. The Song of the Vineyard\n2. First six woes\n    1. Woe one\n    2. Woe two\n3. Present punishments\n    1. Devouring flame",
    "ISA-style 2-space parents snap to column 0 so their 4-space children nest; the shallower `1.` is still the same list and counts as 3",
  );
  unchanged("1. a\n    1. b\n        1. c\n2. d", "the 0/4/8 convention (ZEC, MAT, ROM, LEV on Door43) is a fixed point");
  eq(normalizeLists("1. a\n   1. b"), "1. a\n    1. b", "a valid 3-space child becomes a 4-space child");
  eq(normalizeLists("1. a\n      * b"), "1. a\n    * b", "a 6-space bullet directly under a top-level item is one level deep");
  eq(
    normalizeLists("1. Seventh\n       1. The Song\n2. Woes"),
    "1. Seventh\n    1. The Song\n2. Woes",
    "the case from browser testing: 7 stray spaces under a top-level item become a clean child, not an orphaned grandchild",
  );
  eq(normalizeLists("1. a\n        1. b"), "1. a\n    1. b", "an item can't skip a level: 8 spaces directly under a top-level item is its child");
  eq(normalizeLists("- a\n  - b\n    - c\n- d"), "- a\n    - b\n        - c\n- d", "2-space nested bullets keep their nesting, rewritten at 4 spaces per level");
  unchanged("    1. all\n    2. indented\n        1. child", "an outline written entirely at 4+ spaces with no list open is an indented code block in Markdown and is left alone (Codex verify)");
  unchanged("para\n\n    1. literal\n    2. literal\n\n    still code", "indented code block after prose: untouched, blank lines inside it do not end it");
  eq(normalizeLists("para\n\n    1. literal\n\nafter\n1. a\n1. b"), "para\n\n    1. literal\n\nafter\n1. a\n2. b", "a list after an indented code block still normalises; the code block does not");
  eq(normalizeLists("1. a\n\n    1. b\n    1. c"), "1. a\n\n    1. b\n    2. c", "4-space lines while a list is open are nested items, not code (CommonMark reads them the same way)");
  unchanged("        1. orphan\n1. b", "an 8-space line with no list open is an indented code block, so it and the list after it are left alone");
  eq(normalizeLists("  1. orphan\n1. b"), "1. orphan\n2. b", "a shallower (0–3 space) line after the first item rebases the top level and continues its count");
  unchanged("1. a\n    1. b\nprose\n        1. c", "prose closes the outline; an 8-space line after it is code, not a list");
  eq(normalizeLists("1. a\n    1. b\nprose\n  1. c"), "1. a\n    1. b\nprose\n1. c", "prose closes the outline; the next (0–3 space) item starts a fresh top level");
  eq(normalizeLists("  1. a\n\n    1. b"), "1. a\n\n    1. b", "loose ISA-style list normalises the same way");
  eq(normalizeLists("plain text").split("\n").length, 1, "never adds lines");
  const twice = normalizeLists(normalizeLists(isa5));
  eq(twice, normalizeLists(isa5), "normalisation is idempotent");
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

  const withNl = toggleList("a\nb\nc", 0, 4, "bullet");
  eq(withNl.value, "* a\n* b\nc", "a selection ending just after a newline does not mark the next line");
  eq(withNl.selEnd, 8, "…but the selection still ends after that newline");
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
  eq(indentLines("  1. a", 6, 6).value, "1. a", "a lone item has no parent to nest under: it is not indented (which would make it a code block), only normalised");
  eq(indentLines("1. a", 4, 4).value, "1. a", "…and on an already-clean lone item the whole action is a no-op, so Tab falls through to the browser");
  eq(indentLines("intro\n\n1. a\n2. b", 8, 8).value, "intro\n\n1. a\n2. b", "the first item of a list after prose is also a no-op");
  eq(indentLines("1. a\n\n2. b", 8, 8).value, "1. a\n\n    1. b", "a blank line between items does not hide the parent");
  eq(indentLines("1. a\nplain", 7, 7).value, "1. a\n    plain", "a non-list line still indents (continuation text under an item)");
  eq(indentLines("1. p\n  1. a", 10, 10).value, "1. p\n    1. a", "indenting an ISA-style 2-space item under a parent lands on a clean 4-space level");
  eq(indentLines("3. a\n4. b", 5, 5).value, "3. a\n    1. b", "indenting under a list that starts at 3 keeps the parent's start and restarts the child at 1");
}

// ── tidyLists ──
{
  const t = tidyLists("intro\n\n  1. a\n    1. b\n  2. c", 22, 22);
  eq(t.value, "intro\n\n1. a\n    1. b\n2. c", "tidy normalises the whole note without touching content");
  eq(t.selStart, 20, "caret stays at the same column of its line, shifted by that line's indent change");
  eq(normalizeLists(t.value), t.value, "tidy output is a fixed point");
  const clean = "2. Sermon\n    1. Beatitudes\n3. Healings";
  eq(tidyLists(clean, 0, 0).value, clean, "tidy on a clean MAT-style outline changes nothing (so the button never appears for it)");
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

  const started = continueListOnEnter("3. a", 4, 4);
  eq(started?.value, "3. a\n4. ", "Enter continues from the list's own start number");

  const empty = continueListOnEnter("1. a\n2. ", 8, 8);
  eq(empty?.value, "1. a\n", "Enter on an empty item removes the marker (exits the list)");
  eq(empty?.selStart, 5, "caret sits on the now-plain line");

  const emptyNested = continueListOnEnter("1. a\n    1. ", 12, 12);
  eq(emptyNested?.value, "1. a\n2. ", "empty nested item outdents one level and takes the parent-level number");
  eq(emptyNested?.selStart, 8, "caret after the outdented marker");
  const emptyNestedBullet = continueListOnEnter("* a\n    * ", 10, 10);
  eq(emptyNestedBullet?.value, "* a\n* ", "empty nested bullet outdents to a top-level bullet");
  const mixed = continueListOnEnter("1. a\n  1. b\n    1. ", 19, 19);
  eq(mixed?.value, "1. a\n    1. b\n    2. ", "legacy mixed-indent outline: Enter on the empty third-level item outdents one LEVEL (to a sibling of b), not four raw spaces to the top (Codex review)");
  eq(mixed?.selStart, mixed?.value.length, "caret after the outdented marker");
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
  const two = toggleBold("**one** and **two**", 0, 19);
  eq(two.value, "****one** and **two****", "a selection spanning two bold spans is wrapped, not stripped of its outer markers (Codex review)");
  const twoInside = toggleBold("x **one** and **two** y", 4, 19);
  eq(twoInside.value, "x ****one** and **two**** y", "surrounding markers around a multi-span selection do not count as one bold span");
  const ws = toggleBold("say hello now", 3, 10);
  eq(ws.value, "say **hello** now", "edge whitespace in the selection stays outside the markers (`** hello **` is not emphasis)");
  eq(ws.selStart, 6, "selection tightens to the word (start)");
  eq(ws.selEnd, 11, "selection tightens to the word (end)");
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall noteFormat assertions passed");
