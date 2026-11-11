// Verse text saves curl straight quotes (#1273) without unaligning anything.
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/curlyVerse.test.mjs
//
// Each case runs the same steps as Shell.tsx saveVerseDraft: adoptBaseQuotes on
// the typed text, smartEditVerse, then curlifyVerseContent on the result.

import { smartEditVerse } from "./replace.ts";
import { extractEditableText, extractPlainText, normalizeEditable } from "./usfm.ts";
import { analyzeAlignmentDelta, guardBlocksSave } from "./alignmentDelta.ts";
import { adoptBaseQuotes, curlifyVerseContent } from "./curlyVerse.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const w = (text) => ({ text, tag: "w", type: "word", occurrence: "1", occurrences: "1" });
const t = (text) => ({ type: "text", text });
const q = (tag) => ({ type: "quote", tag });
const zaln = (strong, children) => ({
  tag: "zaln", type: "milestone", strong, lemma: "x", morph: "x",
  occurrence: "1", occurrences: "1", content: "x", children, endTag: "zaln-e\\*",
});

// "text@STRONG" per \w word in document order ("@-" when unaligned).
function alignedWords(content) {
  const out = [];
  const walk = (nodes, strongs) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "word" && n.tag === "w") out.push(`${n.text}@${strongs.join(">") || "-"}`);
      if (Array.isArray(n.children)) walk(n.children, n.tag === "zaln" ? [...strongs, n.strong] : strongs);
    }
  };
  walk(content.verseObjects, []);
  return out;
}

// The save path, as Shell.tsx saveVerseDraft runs it. Returns null on a no-op.
function saveEdit(base, typedPlain) {
  const oldEditable = extractEditableText(base);
  const typed = adoptBaseQuotes(oldEditable, normalizeEditable(typedPlain));
  if (typed === oldEditable) return null;
  const result = smartEditVerse(base, oldEditable, typed, { capturedFromDom: true });
  const content = curlifyVerseContent(result.content);
  return { content, plain: extractPlainText(content), delta: analyzeAlignmentDelta(base, content) };
}

const STRAIGHT = /['"]/;

// Every node's own .text, in document order.
function allText(content) {
  let out = "";
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      if (typeof n.text === "string") out += n.text;
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(content.verseObjects);
  return out;
}

console.log("untouched aligned word with a straight apostrophe stays aligned and comes back curled");
{
  const base = {
    verseObjects: [
      zaln("H1", [w("the")]), t(" "), zaln("H2", [w("baby's")]), t(" "), zaln("H3", [w("toy")]), t("."),
    ],
  };
  const baseJson = JSON.stringify(base);
  const r = saveEdit(base, "the baby's toy fell.");
  assert(r.plain === "the baby’s toy fell.", `plain curled (got ${JSON.stringify(r.plain)})`);
  const words = alignedWords(r.content);
  assert(words.includes("baby’s@H2"), `baby’s still aligned to H2 (got ${words.join(" ")})`);
  assert(words.includes("the@H1") && words.includes("toy@H3"), "neighbours still aligned");
  assert(words.includes("fell@-"), "new word is unaligned");
  assert(!guardBlocksSave(r.delta, "text_edit"), "save guard does not block");
  assert(JSON.stringify(base) === baseJson, "base content is not mutated");
}

console.log("straight apostrophe in its own text node inside a milestone (Yahweh ' s, the D1 shape)");
{
  const base = {
    verseObjects: [
      zaln("H3068", [w("Yahweh"), t("'"), w("s")]), t(" "), zaln("H1004", [w("temple")]), t("."),
    ],
  };
  const baseJson = JSON.stringify(base);
  const r = saveEdit(base, "Yahweh's temple stood.");
  assert(r.plain === "Yahweh’s temple stood.", `plain curled (got ${JSON.stringify(r.plain)})`);
  const ms = r.content.verseObjects.find((n) => n.strong === "H3068");
  assert(
    JSON.stringify(ms?.children) === JSON.stringify([w("Yahweh"), t("’"), w("s")]),
    `H3068 keeps Yahweh / ’ / s (got ${JSON.stringify(ms?.children)})`,
  );
  assert(alignedWords(r.content).includes("temple@H1004"), "temple still aligned");
  assert(!guardBlocksSave(r.delta, "text_edit"), "save guard does not block");
  assert(JSON.stringify(base) === baseJson, "base content is not mutated");
}

console.log("multi-character insert of 's is saved curly");
{
  const base = {
    verseObjects: [zaln("H1", [w("the")]), t(" "), zaln("H2", [w("baby")]), t(" "), zaln("H3", [w("toy")]), t(".")],
  };
  const r = saveEdit(base, "the baby's toy.");
  assert(r.plain === "the baby’s toy.", `plain curled (got ${JSON.stringify(r.plain)})`);
  assert(!STRAIGHT.test(allText(r.content)), `no straight quote anywhere in the tree (got ${JSON.stringify(allText(r.content))})`);
  const words = alignedWords(r.content);
  assert(words.includes("the@H1") && words.includes("toy@H3"), `untouched words still aligned (got ${words.join(" ")})`);
}

console.log("opening quotes at verse start curl as opening");
{
  const mk = () => ({ verseObjects: [zaln("H1", [w("Turn")]), t(" "), zaln("H2", [w("back")]), t(".")] });
  const r1 = saveEdit(mk(), "\"Turn back.\"");
  assert(r1.plain === "“Turn back.”", `double quotes (got ${JSON.stringify(r1.plain)})`);
  const r2 = saveEdit(mk(), "'Turn back.'");
  assert(r2.plain === "‘Turn back.’", `single quotes (got ${JSON.stringify(r2.plain)})`);
  const words = alignedWords(r1.content);
  assert(words.join(" ") === "Turn@H1 back@H2", `alignment kept (got ${words.join(" ")})`);
}

console.log("quote right after a mid-verse \\q1 marker curls as opening");
{
  const base = {
    verseObjects: [
      zaln("H1", [w("He")]), t(" "), zaln("H2", [w("said")]), t(","), q("q1"),
      zaln("H3", [w("Turn")]), t(" "), zaln("H4", [w("back")]), t("."),
    ],
  };
  const typed = extractEditableText(base).replace("Turn", "\"Turn").replace("back.", "back.\"");
  const r = saveEdit(base, typed);
  assert(r.plain === "He said, “Turn back.”", `opening after marker (got ${JSON.stringify(r.plain)})`);
  assert(alignedWords(r.content).join(" ") === "He@H1 said@H2 Turn@H3 back@H4", "alignment kept");
}

console.log("a ' typed (or still shown) where the saved verse has ’, plus an edit elsewhere, unaligns nothing");
{
  const mk = () => ({
    verseObjects: [
      zaln("H1", [w("the")]), t(" "), zaln("H2", [w("baby’s")]), t(" "), zaln("H3", [w("toy")]), t(" "),
      zaln("H4", [w("is")]), t(" "), zaln("H5", [w("red")]), t("."),
    ],
  });
  const r = saveEdit(mk(), "the baby's toy is very red.");
  assert(r.plain === "the baby’s toy is very red.", `plain (got ${JSON.stringify(r.plain)})`);
  const words = alignedWords(r.content);
  assert(
    words.join(" ") === "the@H1 baby’s@H2 toy@H3 is@H4 very@- red@H5",
    `every old word keeps its alignment (got ${words.join(" ")})`,
  );
  assert(!guardBlocksSave(r.delta, "text_edit"), "save guard does not block");
  assert(saveEdit(mk(), "the baby's toy is red.") === null, "a ' vs ’ difference alone is a no-op save");
  const r2 = saveEdit(mk(), "the baby‘s toy is red.");
  assert(r2 !== null && r2.plain === "the baby‘s toy is red.", "a deliberate ’ → ‘ change is still saved");
}

console.log("curlifyVerseContent leaves curled content alone");
{
  const content = { verseObjects: [zaln("H1", [w("baby’s")]), t(" “ok”")] };
  assert(curlifyVerseContent(content) === content, "same reference when nothing to curl");
  const ms = { verseObjects: [{ ...zaln("H1", [w("x")]), content: "a'b" }] };
  assert(curlifyVerseContent(ms) === ms, "zaln source attributes are never curled");
}

console.log("adoptBaseQuotes");
{
  assert(adoptBaseQuotes("a ’b’ c", "a 'b' c") === "a ’b’ c", "unchanged straight → base curly");
  assert(adoptBaseQuotes("a ’b’ c", "a 'b' c d") === "a ’b’ c d", "lead reconciled, append kept");
  assert(adoptBaseQuotes("a b", "a 'b' c") === "a 'b' c", "new quotes kept as typed");
  assert(adoptBaseQuotes("x “y” z", "x \"y\" z") === "x “y” z", "double quotes too");
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall curlyVerse tests passed");
