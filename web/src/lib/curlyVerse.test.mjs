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

// #1278: the engine moves an opening quote out of the preceding word's \zaln
// milestone (hoistOpeningPunctuation, #777), but only a curly one. A straight
// quote reaches the engine as typed and is curled afterwards, so it has to end
// up in the same place a typed curly quote would: glued to the word after it,
// as top-level text, never as trailing text inside the previous milestone.
function strandedOpener(nodes) {
  for (const n of nodes ?? []) {
    if (!n || n.type !== "milestone" || n.tag !== "zaln" || !Array.isArray(n.children)) continue;
    const flat = [];
    const flatten = (kids) => {
      for (const k of kids) {
        if (!k || typeof k !== "object") continue;
        if (k.type === "word" && k.tag === "w") flat.push(null);
        else if (k.type === "text") flat.push(k.text ?? "");
        else if (Array.isArray(k.children)) flatten(k.children);
      }
    };
    flatten(n.children);
    const trailing = flat.slice(flat.lastIndexOf(null) + 1).join("");
    if (/[“‘"']/.test(trailing)) return `${n.strong} ends with ${JSON.stringify(trailing)}`;
    const inner = strandedOpener(n.children);
    if (inner) return inner;
  }
  return null;
}

console.log("pasted straight opening quote lands where a typed curly one would (#1278)");
{
  // H1 holds its comma inside the milestone (the JER 31:18 shape, #777).
  const commaInside = () => ({
    verseObjects: [
      zaln("H1", [w("say"), t(",")]), t(" "), zaln("H2", [w("The")]), t(" "), zaln("H3", [w("one")]), t("."),
    ],
  });
  const commaOutside = () => ({
    verseObjects: [
      zaln("H1", [w("say")]), t(", "), zaln("H2", [w("The")]), t(" "), zaln("H3", [w("one")]), t("."),
    ],
  });
  const cases = [
    ["\"The pasted over The, comma inside H1", commaInside, "say, \"The one.", "say, “The one.", "say@H1 The@H2 one@H3"],
    ["'The pasted over The, comma inside H1", commaInside, "say, 'The one.", "say, ‘The one.", "say@H1 The@H2 one@H3"],
    ["\"The pasted over The, comma outside H1", commaOutside, "say, \"The one.", "say, “The one.", "say@H1 The@H2 one@H3"],
    [" \"Go inserted after say, (the issue's shape)", commaInside, "say, \"Go The one.", "say, “Go The one.", "say@H1 Go@- The@H2 one@H3"],
    [" \"Go inserted after say (no comma)", () => ({
      verseObjects: [zaln("H1", [w("He")]), t(" "), zaln("H2", [w("said")]), t(" "), zaln("H3", [w("Turn")]), t(".")],
    }), "He said \"Go Turn.", "He said “Go Turn.", "He@H1 said@H2 Go@- Turn@H3"],
  ];
  for (const [label, mk, straight, curly, words] of cases) {
    const r = saveEdit(mk(), straight);
    const rc = saveEdit(mk(), curly);
    assert(r.plain === curly, `${label}: plain curled (got ${JSON.stringify(r.plain)})`);
    const stranded = strandedOpener(r.content.verseObjects);
    assert(stranded === null, `${label}: no opener left inside a milestone (${stranded})`);
    assert(
      JSON.stringify(r.content) === JSON.stringify(rc.content),
      `${label}: same tree as typing the curly quote (got ${JSON.stringify(r.content.verseObjects)}, want ${JSON.stringify(rc.content.verseObjects)})`,
    );
    assert(alignedWords(r.content).join(" ") === words, `${label}: alignment kept (got ${alignedWords(r.content).join(" ")})`);
    assert(!guardBlocksSave(r.delta, "text_edit"), `${label}: save guard does not block`);
  }
}

console.log("a straight opener is never moved across a \\q1 marker (#1278)");
{
  // Hand-built: the opener is stranded in H1 with a line-break marker after
  // it. The hoist's rule is never to move text across a line break, so the
  // curled “ stays in H1 (left for a hand fix, as for a typed curly quote).
  const content = {
    verseObjects: [zaln("H1", [w("say"), t(", \"")]), q("q1"), zaln("H2", [w("The")]), t(".")],
  };
  const out = curlifyVerseContent(content);
  assert(
    JSON.stringify(out.verseObjects) ===
      JSON.stringify([zaln("H1", [w("say"), t(", “")]), q("q1"), zaln("H2", [w("The")]), t(".")]),
    `“ curled in place, not moved past \\q1 (got ${JSON.stringify(out.verseObjects)})`,
  );
}

console.log("curlifyVerseContent hoists a curled opener stranded in a milestone (#1278)");
{
  // usfm-js keeps the newline between milestones as its own text node; the
  // opener steps over it so it stays glued to the next \zaln-s (#777).
  const content = {
    verseObjects: [zaln("H1", [w("say"), t(", \"")]), t("\n"), zaln("H2", [w("The")]), t(".")],
  };
  const out = curlifyVerseContent(content);
  assert(
    JSON.stringify(out.verseObjects) ===
      JSON.stringify([zaln("H1", [w("say")]), t(",\n“"), zaln("H2", [w("The")]), t(".")]),
    `“ moved out of H1 and glued to H2 (got ${JSON.stringify(out.verseObjects)})`,
  );
  assert(content.verseObjects[0].children[1].text === ", \"", "input is not mutated");
}

console.log("curlifyVerseContent leaves curled content alone");
{
  const content = { verseObjects: [zaln("H1", [w("baby’s")]), t(" “ok”")] };
  assert(curlifyVerseContent(content) === content, "same reference when nothing to curl");
  const ms = { verseObjects: [{ ...zaln("H1", [w("x")]), content: "a'b" }] };
  assert(curlifyVerseContent(ms) === ms, "zaln source attributes are never curled");
}

console.log("occurrences are renumbered when the curl makes two words the same");
{
  // The engine numbers occurrences before the curl, so don’t + don't stayed
  // two "don’t 1/1" and the aligner (keyed by text|occurrence) lost one.
  const wo = (text, occ, occs) => ({ text, tag: "w", type: "word", occurrence: occ, occurrences: occs });
  const content = { verseObjects: [zaln("H1", [wo("don’t", "1", "1")]), t(" "), wo("don't", "1", "1"), t(".")] };
  const out = curlifyVerseContent(content);
  const ws = [];
  const walk = (nodes) => { for (const n of nodes) { if (n.type === "word") ws.push(`${n.text} ${n.occurrence}/${n.occurrences}`); if (n.children) walk(n.children); } };
  walk(out.verseObjects);
  assert(ws.join(", ") === "don’t 1/2, don’t 2/2", `numbered 1/2 and 2/2 (got ${ws.join(", ")})`);
}

console.log("an inline \\qs / \\qac / \\qt / \\+qt is not a line break (#1281)");
{
  // usfm-js types these inline character markers "quote", like \q1, but they
  // sit inside a line. Shapes are what usfm.toJSON produces.
  for (const tag of ["qs", "qac", "qt", "qt1", "qt2", "qt3", "qt4", "qt5", "+qt"]) {
    const out = curlifyVerseContent({ verseObjects: [t("Yahweh"), { tag, type: "quote", text: "'s", endTag: `${tag}*` }] });
    assert(out.verseObjects[1].text === "’s", `\\${tag}: 's curls to ’s (got ${JSON.stringify(out.verseObjects[1].text)})`);
  }
  for (const n of ["", "1", "2", "3", "4", "5"]) {
    const ms = { tag: `qt${n}-s`, type: "quote", attrib: ' |who="x"', children: [t("'s")], endTag: `qt${n}-e\\*` };
    const out = curlifyVerseContent({ verseObjects: [t("Yahweh"), ms] });
    const got = out.verseObjects[1].children[0].text;
    assert(got === "’s", `\\qt${n}-s milestone: 's curls to ’s (got ${JSON.stringify(got)})`);
  }
  const unclosed = curlifyVerseContent({ verseObjects: [t("Yahweh"), { tag: "qs", type: "quote", text: "'s", endTag: "" }] });
  assert(unclosed.verseObjects[1].text === "’s", `unclosed \\qs: 's curls to ’s (got ${JSON.stringify(unclosed.verseObjects[1].text)})`);
  // A real line marker still resets: said,\q1 "Turn back." opens.
  const q1 = curlifyVerseContent({ verseObjects: [t("He said,"), { tag: "q1", type: "quote", text: "\"Turn back.\"\n" }] });
  assert(q1.verseObjects[1].text === "“Turn back.”\n", `\\q1 still opens (got ${JSON.stringify(q1.verseObjects[1].text)})`);
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
