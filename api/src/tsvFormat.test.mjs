// Unit tests for the export TSV normalizers (tsvFormat.ts).
// Run: node --experimental-strip-types --no-warnings src/tsvFormat.test.mjs

import assert from "node:assert/strict";
import {
  trimTrailingLiteralN,
  stripSpaceBeforeLiteralN,
  dropWhitespaceOnlyLines,
  educateQuotes,
  normalizeAltLabel,
  normalizeNoteText,
  parseRefOrderKey,
  sortRowsByReference,
} from "./tsvFormat.ts";

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// ── trailing literal \n (Check 10) ──
t("trims a trailing literal \\n", () => assert.equal(trimTrailingLiteralN("# Intro\\n\\n"), "# Intro"));
t("trims trailing whitespace too", () => assert.equal(trimTrailingLiteralN("text  "), "text"));
t("keeps interior \\n", () => assert.equal(trimTrailingLiteralN("a\\nb"), "a\\nb"));
t("no-op when clean", () => assert.equal(trimTrailingLiteralN("clean note."), "clean note."));

// ── space before a literal \n (maintainer cleanup, pattern A) ──
t("space before \\n removed", () => assert.equal(stripSpaceBeforeLiteralN("end. \\n\\nnext"), "end.\\n\\nnext"));
t("multiple spaces before \\n removed", () => assert.equal(stripSpaceBeforeLiteralN("end.   \\n\\nnext"), "end.\\n\\nnext"));
t("tab before \\n removed", () => assert.equal(stripSpaceBeforeLiteralN("end.\t\\n\\nnext"), "end.\\n\\nnext"));
// KEY SAFETY TEST — a space AFTER a literal \n (markdown list indentation) must
// survive untouched: 3,410 legitimate occurrences on en_tn master vs. 39 for
// the before-\n case above. Stripping this would be a serious regression.
t("space AFTER \\n is PRESERVED (single space)", () =>
  assert.equal(stripSpaceBeforeLiteralN("intro\\n list item"), "intro\\n list item"));
t("space AFTER \\n is PRESERVED (two-space markdown list indent)", () =>
  assert.equal(stripSpaceBeforeLiteralN("intro\\n\\n  1. First\\n  2. Second"), "intro\\n\\n  1. First\\n  2. Second"));
t("no-op when clean", () => assert.equal(stripSpaceBeforeLiteralN("clean note."), "clean note."));
t("idempotent", () => {
  const s = "end.   \\n\\nnext";
  assert.equal(stripSpaceBeforeLiteralN(stripSpaceBeforeLiteralN(s)), stripSpaceBeforeLiteralN(s));
});

// ── whitespace-only line between two literal \n (maintainer cleanup, pattern D) ──
t("whitespace-only line collapsed", () => assert.equal(dropWhitespaceOnlyLines("a\\n   \\nb"), "a\\n\\nb"));
t("tab-only line collapsed", () => assert.equal(dropWhitespaceOnlyLines("a\\n\t\\nb"), "a\\n\\nb"));
t("leaves already-adjacent \\n\\n alone", () => assert.equal(dropWhitespaceOnlyLines("a\\n\\nb"), "a\\n\\nb"));
t("no-op when clean", () => assert.equal(dropWhitespaceOnlyLines("clean note."), "clean note."));
t("idempotent", () => {
  const s = "a\\n   \\nb";
  assert.equal(dropWhitespaceOnlyLines(dropWhitespaceOnlyLines(s)), dropWhitespaceOnlyLines(s));
});

// ── straight quotes (Check 15) ──
t("apostrophe between letters → ’", () => assert.equal(educateQuotes("a person's heart"), "a person’s heart"));
t("quoted phrase → curly pair", () => assert.equal(educateQuotes('mean "will die."'), "mean “will die.”"));
t("leaves existing curly quotes", () => assert.equal(educateQuotes("“already” curly"), "“already” curly"));
t("no-op when no straight quotes", () => assert.equal(educateQuotes("no quotes here"), "no quotes here"));
// The two-char literal \n escape (TSV line-break convention) is an OPENING
// context: a quote right after it starts a new line. Regression — this used
// to curl the wrong way (closing ”/’) because the context class only looked
// one character back and saw the "n".
t("double quote after a literal \\n escape OPENS", () =>
  assert.equal(educateQuotes('He said:\\n"Go to the land."'), "He said:\\n“Go to the land.”"));
t("single quote after a literal \\n escape OPENS", () =>
  assert.equal(educateQuotes("He said:\\n'Go to the land.'"), "He said:\\n‘Go to the land.’"));
t("a word merely ending in n is still a CLOSING context", () =>
  assert.equal(educateQuotes('the "land in" question'), "the “land in” question"));

// ── Alternate translation label (Check 12, auto-fixable subset) ──
t("Alternative → Alternate", () => assert.equal(normalizeAltLabel("X. Alternative translation: Y"), "X. Alternate translation: Y"));
t("capital Translation → lowercase", () => assert.equal(normalizeAltLabel("X. Alternate Translation: Y"), "X. Alternate translation: Y"));
t("collapse inter-word spaces", () => assert.equal(normalizeAltLabel("X. Alternate  translation: Y"), "X. Alternate translation: Y"));
t("collapse 2+ spaces before label", () => assert.equal(normalizeAltLabel("end.  Alternate translation: Y"), "end. Alternate translation: Y"));
t("no-op without label", () => assert.equal(normalizeAltLabel("just a note"), "just a note"));

// ── compose ──
t("normalizeNoteText null passthrough", () => assert.equal(normalizeNoteText(null), null));
t("normalizeNoteText composes all three", () =>
  assert.equal(normalizeNoteText(`a person's note.  Alternative translation: "x"\\n`), "a person’s note. Alternate translation: “x”"));
t("normalizeNoteText collapses an interior double space (pattern C)", () =>
  assert.equal(normalizeNoteText("has  been established"), "has been established"));
t("normalizeNoteText strips space before \\n (pattern A)", () =>
  assert.equal(
    normalizeNoteText("to obey and honor Yahweh. \\n\\n### How should this be applied?"),
    "to obey and honor Yahweh.\\n\\n### How should this be applied?",
  ));
t("normalizeNoteText collapses a whitespace-only line (pattern D)", () =>
  assert.equal(normalizeNoteText("First para.\\n   \\nSecond para."), "First para.\\n\\nSecond para."));
t("normalizeNoteText no-op on already-clean text", () => {
  const clean = "This is a clean note with no whitespace issues.";
  assert.equal(normalizeNoteText(clean), clean);
});
t("normalizeNoteText is idempotent", () => {
  const s = "has  been established. \\n\\n   \\nAlternative translation: \"x\"\\n";
  const once = normalizeNoteText(s);
  assert.equal(normalizeNoteText(once), once);
});
t("normalizeNoteText preserves a real markdown list round-trip", () => {
  const note = "Some intro text.\\n\\n1. First\\n  2. Second";
  assert.equal(normalizeNoteText(note), note);
});

// ── reference order (Check 11) ──
t("range sorts before its single-verse start", () => {
  const range = parseRefOrderKey("1:5-15");
  const single = parseRefOrderKey("1:5");
  // compare element-wise: range key < single key
  let cmp = 0;
  for (let i = 0; i < range.length && cmp === 0; i++) cmp = range[i] - single[i];
  assert.ok(cmp < 0, "range should sort before single");
});
t("intro before verse 1", () => {
  const intro = parseRefOrderKey("1:intro");
  const v1 = parseRefOrderKey("1:1");
  assert.ok(intro[1] < v1[1]);
});
t("malformed ref → null", () => assert.equal(parseRefOrderKey("garbage"), null));

t("sortRowsByReference reorders range before single, stable otherwise", () => {
  const rows = [
    { ref_raw: "1:5", chapter: 1, verse: 5, id: "a" },
    { ref_raw: "1:5-15", chapter: 1, verse: 5, id: "b" },
    { ref_raw: "1:6", chapter: 1, verse: 6, id: "c" },
    { ref_raw: "1:6", chapter: 1, verse: 6, id: "d" },
  ];
  const out = sortRowsByReference(rows).map((r) => r.id);
  assert.deepEqual(out, ["b", "a", "c", "d"]); // range first; 1:6 pair keeps c-before-d
});

console.log(`\n${passed} tsvFormat tests passed`);
