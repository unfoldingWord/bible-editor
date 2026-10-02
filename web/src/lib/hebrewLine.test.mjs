// Tests for hebrewLine.ts (#899). Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/hebrewLine.test.mjs

import { hebrewLineSx, hebrewWordClass, sourceWordOf, wordOccurrence } from "./hebrewLine.ts";
import { roleLineSx, wordHighlightStyles } from "./highlightStyles.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const none = { find: false, activeFind: false, note: false, prev: false, next: false };
const cls = (m) => hebrewWordClass({ ...none, ...m });

// Precedence: Find > note > reorder stoplight.
assert(cls({}) === "be-hw", "plain word: base class only");
assert(cls({ note: true }) === "be-hw be-hw-hl", "note word: yellow");
assert(cls({ find: true, note: true, prev: true, next: true }) === "be-hw be-hw-f", "find hit drops note fill and both stoplight lines");
assert(cls({ activeFind: true, find: true, note: true }) === "be-hw be-hw-fa", "active find beats plain find");
assert(cls({ activeFind: true }) === "be-hw be-hw-fa", "active find alone");
assert(cls({ note: true, prev: true }) === "be-hw be-hw-hl be-hw-prev", "note fill + previous-note underline combine");
assert(cls({ prev: true, next: true }) === "be-hw be-hw-prev be-hw-next", "previous and next underlines combine");
assert(cls({ next: true }) === "be-hw be-hw-next", "next-note underline alone");

// The line stylesheet paints each class with the same styles the old per-word
// sx used, in both themes.
for (const mode of ["light", "dark"]) {
  const sx = hebrewLineSx(mode);
  const hl = wordHighlightStyles(mode);
  assert(eq(sx["& .be-hw"], { cursor: "help" }), `${mode}: words keep the help cursor`);
  assert(eq(sx["& .be-hw-hl"], hl.hl), `${mode}: note fill matches wordHighlightStyles.hl`);
  assert(eq(sx["& .be-hw-f"], hl.find), `${mode}: find matches wordHighlightStyles.find`);
  assert(eq(sx["& .be-hw-fa"], hl.findActive), `${mode}: active find matches wordHighlightStyles.findActive`);
  assert(eq(sx["& .be-hw-prev"], roleLineSx(mode, true, false)), `${mode}: previous-note line matches roleLineSx`);
  assert(eq(sx["& .be-hw-next"], roleLineSx(mode, false, true)), `${mode}: next-note line matches roleLineSx`);
  // prev and next must paint different properties, or a word in both would
  // lose one line now that they are separate classes.
  const p = Object.keys(sx["& .be-hw-prev"]);
  const n = Object.keys(sx["& .be-hw-next"]);
  assert(!p.some((k) => n.includes(k)), `${mode}: prev and next lines use different CSS properties`);
  // The note fill and the stoplight lines combine on one word, so they must
  // not share a property either (rule order would silently pick one).
  const h = Object.keys(sx["& .be-hw-hl"]);
  assert(![...p, ...n].some((k) => h.includes(k)), `${mode}: note fill and stoplight lines use different CSS properties`);
  // Classes are only combined as listed above; a Find class never combines.
  const classes = Object.keys(sx);
  assert(classes.length === 6, `${mode}: one rule per class`);
}
assert(hebrewLineSx("light")["& .be-hw-hl"].backgroundColor !== hebrewLineSx("dark")["& .be-hw-hl"].backgroundColor, "light and dark fills differ");

// sourceWordOf / wordOccurrence: the hover box's view of a usfm-js \w node.
const w = { type: "word", tag: "w", text: "בְּ⁠יַד", strong: "b:H3027", lemma: "יָד", morph: "He,R:Ncfsc", occurrence: "2", occurrences: "3" };
assert(
  eq(sourceWordOf(w), { id: "", strong: "b:H3027", lemma: "יָד", morph: "He,R:Ncfsc", occurrence: "2", occurrences: "3", content: "בְּ⁠יַד" }),
  "sourceWordOf copies the \\w attributes",
);
assert(wordOccurrence(w) === 2, "occurrence parsed");
assert(wordOccurrence({ text: "x" }) === 1, "missing occurrence → 1");
assert(wordOccurrence({ occurrence: "junk" }) === 1, "bad occurrence → 1");
assert(eq(sourceWordOf({ text: "x" }), { id: "", strong: "", lemma: "", morph: "", occurrence: "1", occurrences: "1", content: "x" }), "missing attributes default like before");

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall hebrewLine tests passed");
