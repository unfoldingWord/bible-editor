// Unit tests for the export TSV normalizers (tsvFormat.ts).
// Run: node --experimental-strip-types --no-warnings src/tsvFormat.test.mjs

import assert from "node:assert/strict";
import {
  trimTrailingLiteralN,
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

// ── straight quotes (Check 15) ──
t("apostrophe between letters → ’", () => assert.equal(educateQuotes("a person's heart"), "a person’s heart"));
t("quoted phrase → curly pair", () => assert.equal(educateQuotes('mean "will die."'), "mean “will die.”"));
t("leaves existing curly quotes", () => assert.equal(educateQuotes("“already” curly"), "“already” curly"));
t("no-op when no straight quotes", () => assert.equal(educateQuotes("no quotes here"), "no quotes here"));

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
