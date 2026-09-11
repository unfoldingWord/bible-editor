// Smoke test for openingPunct.ts — hoisting a stranded opening quote/bracket
// out of the preceding word's \zaln milestone to a top-level text node.
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/openingPunct.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors src/lib/replace.test.mjs.

import usfm from "usfm-js";
import { hoistOpeningPunctuation, OPENING_PUNCT_RE, concatVerseText } from "./openingPunct.ts";

let failed = 0;
let ran = 0;
function assert(cond, msg) {
  ran++;
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const w = (text, occ = "1", occs = "1") => ({ text, tag: "w", type: "word", occurrence: occ, occurrences: occs });
const t = (text) => ({ type: "text", text });
const zaln = (strong, children) => ({
  tag: "zaln", type: "milestone", strong, lemma: "x", morph: "x",
  occurrence: "1", occurrences: "1", content: "x", children, endTag: "zaln-e\\*",
});

// Flattened concatenated text of a verseObjects array (for round-trip checks).
function concatText(nodes) {
  let out = "";
  for (const n of nodes ?? []) {
    if (!n || typeof n !== "object") continue;
    if (typeof n.text === "string") out += n.text;
    if (Array.isArray(n.children)) out += concatText(n.children);
  }
  return out;
}

function milestoneTrailingHasOpener(nodes) {
  for (const n of nodes ?? []) {
    if (!n || typeof n !== "object") continue;
    if (n.type === "milestone" && n.tag === "zaln" && Array.isArray(n.children)) {
      // Find the trailing text after the last word leaf, across the whole subtree.
      const flat = [];
      const flatten = (kids) => {
        for (const k of kids) {
          if (!k || typeof k !== "object") continue;
          if (k.type === "word" && k.tag === "w") flat.push({ kind: "word" });
          else if (k.type === "text") flat.push({ kind: "text", text: k.text ?? "" });
          else if (Array.isArray(k.children)) flatten(k.children);
        }
      };
      flatten(n.children);
      let lastWord = -1;
      flat.forEach((s, i) => { if (s.kind === "word") lastWord = i; });
      const trailing = flat.slice(lastWord + 1).filter((s) => s.kind === "text").map((s) => s.text).join("");
      if (OPENING_PUNCT_RE.test(trailing)) return true;
      if (milestoneTrailingHasOpener(n.children)) return true;
    }
  }
  return false;
}

function countMilestones(nodes) {
  let n2 = 0;
  for (const n of nodes ?? []) {
    if (!n || typeof n !== "object") continue;
    if (n.type === "milestone" && n.tag === "zaln") {
      n2++;
      if (Array.isArray(n.children)) n2 += countMilestones(n.children);
    }
  }
  return n2;
}

// ─── Case a: JER 31:18 shape — trailing ", ‘" inside the first milestone ────
{
  console.log("\n[Case a] JER 31:18 shape: trailing opener hoisted to top-level text between milestones");
  const before = {
    verseObjects: [
      zaln("H1", [w("himself"), t(",\n‘")]),
      zaln("H2", [w("You"), t(" "), w("disciplined"), t(" "), w("me")]),
    ],
  };
  const beforeText = concatText(before.verseObjects);
  const after = hoistOpeningPunctuation(before.verseObjects);
  assert(!milestoneTrailingHasOpener(after), "no milestone's trailing leaf matches OPENING_PUNCT_RE after hoist");
  assert(concatText(after) === beforeText, "concatenated text round-trips exactly");
  const topLevelText = after.filter((n) => n.type === "text").map((n) => n.text).join("");
  assert(topLevelText.includes("‘"), "opener now appears as top-level text");
  assert(countMilestones(after) === 2, "milestone count unchanged");
  // Idempotent.
  const twice = hoistOpeningPunctuation(after);
  assert(JSON.stringify(twice) === JSON.stringify(after), "idempotent on re-run");
  // Input not mutated.
  assert(before.verseObjects[0].children[1].text === ",\n‘", "input verseObjects left untouched");
}

// ─── Case b: nested milestone chain — trailing leaf in the INNER milestone ──
{
  console.log("\n[Case b] nested milestone: trailing leaf in inner milestone hoists to top level after the OUTER milestone");
  const before = {
    verseObjects: [
      zaln("OUTER", [zaln("INNER", [w("say"), t(", ‘")])]),
      zaln("NEXT", [w("The"), t(" "), w("one")]),
    ],
  };
  const beforeText = concatText(before.verseObjects);
  const after = hoistOpeningPunctuation(before.verseObjects);
  assert(!milestoneTrailingHasOpener(after), "no milestone's trailing leaf matches OPENING_PUNCT_RE after hoist");
  assert(concatText(after) === beforeText, "concatenated text round-trips exactly");
  assert(after.length === 3, "a new top-level text node was inserted between the milestones (got length " + after.length + ")");
  assert(after[1].type === "text" && after[1].text === ", ‘", "hoisted text lands right after the OUTER milestone");
  assert(after[0].tag === "zaln" && after[0].strong === "OUTER", "outer milestone stays first");
  assert(after[2].tag === "zaln" && after[2].strong === "NEXT", "next milestone stays last");
}

// ─── Case c: trailing ", " (no opener) — untouched ──────────────────────────
{
  console.log("\n[Case c] trailing closing punctuation without an opener is left untouched");
  const before = {
    verseObjects: [
      zaln("H1", [w("Judah"), t(", ")]),
      zaln("H2", [w("Er")]),
    ],
  };
  const after = hoistOpeningPunctuation(before.verseObjects);
  assert(JSON.stringify(after) === JSON.stringify(before.verseObjects), "tree is deep-equal to the input (no-op)");
}

// ─── Case d: opener already leading child of the FOLLOWING milestone ────────
{
  console.log("[Case d] opener already stored as leading child of the following milestone is left untouched");
  const before = {
    verseObjects: [
      zaln("H1", [w("say")]),
      t(", "),
      zaln("H2", [t("‘"), w("The")]),
    ],
  };
  const after = hoistOpeningPunctuation(before.verseObjects);
  assert(JSON.stringify(after) === JSON.stringify(before.verseObjects), "tree is deep-equal to the input (no-op)");
}

// ─── Case e: next top-level sibling is an in-flow \q1 marker — skip ─────────
{
  console.log("[Case e] a \\q1 marker as the next sibling blocks the hoist (never cross a line break)");
  const before = {
    verseObjects: [
      zaln("H1", [w("say"), t(", ‘")]),
      { type: "quote", tag: "q1" },
      zaln("H2", [w("The")]),
    ],
  };
  const after = hoistOpeningPunctuation(before.verseObjects);
  assert(JSON.stringify(after) === JSON.stringify(before.verseObjects), "tree is deep-equal to the input (no-op)");
}

// ─── Case f: opener followed by an existing top-level text sibling ─────────
{
  console.log("[Case f] opener prepends to an existing top-level text sibling instead of inserting a new node");
  const before = {
    verseObjects: [
      zaln("H1", [w("say"), t(", ‘")]),
      t("The"),
      zaln("H2", [w("one")]),
    ],
  };
  const beforeText = concatText(before.verseObjects);
  const after = hoistOpeningPunctuation(before.verseObjects);
  assert(after.length === 3, "no new node inserted — prepended onto the existing text sibling (got length " + after.length + ")");
  assert(after[1].type === "text" && after[1].text === ", ‘The", "opener prepended onto the existing top-level text");
  assert(concatText(after) === beforeText, "concatenated text round-trips exactly");
}

// ─── Case f2: a structural newline sibling (usfm-js keeps `\n` between milestones
// as a text node — the real parsed JER 31:10 shape) must NOT end up after the opener
{
  console.log("[Case f2] opener steps over a newline sibling so it stays glued to the next \\zaln-s");
  const before = {
    verseObjects: [
      zaln("H1", [w("say"), t(", ‘")]),
      t("\n"),
      zaln("H2", [w("The")]),
    ],
  };
  const after = hoistOpeningPunctuation(before.verseObjects);
  assert(after.length === 3, "no new node inserted (got length " + after.length + ")");
  assert(after[1].type === "text" && after[1].text === ",\n‘", `closing part (trailing space dropped), then the newline, then the opener (got ${JSON.stringify(after[1].text)})`);
  assert(!milestoneTrailingHasOpener(after), "opener no longer inside the milestone");
  const rendered = usfm.toUSFM({ chapters: { 1: { 1: { verseObjects: after } } } }, { forcedNewLines: true });
  assert(/\\zaln-e\\\*,\s*\n‘\\zaln-s/.test(rendered), `renders as \\zaln-e\\*, ⏎ ‘\\zaln-s (got ${JSON.stringify(rendered)})`);
  assert(!/‘\s*\n/.test(rendered), "the opener never ends a line");
  const twice = hoistOpeningPunctuation(after);
  assert(JSON.stringify(twice) === JSON.stringify(after), "idempotent on re-run");
}

// ─── Case g (render proof): hoisted tree renders on ONE line, not split ─────
// Mirrors how api/src/export.ts:1806 buildUsfm calls usfm.toUSFM. Proves the
// hoist actually fixes the Door43 rendering defect, not just the tree shape.
{
  console.log("\n[render] hoisted tree serializes as `\\zaln-e\\*, ‘\\zaln-s` on one line, never opener-then-\\zaln-e\\*");
  const defective = [
    zaln("H1", [w("say"), t(", ‘")]),
    zaln("H2", [w("The"), t(" "), w("one")]),
  ];
  const hoisted = hoistOpeningPunctuation(defective);
  const rendered = usfm.toUSFM({ chapters: { "1": { "1": { verseObjects: hoisted } } } }, { forcedNewLines: true });
  assert(rendered.includes("\\zaln-e\\*, ‘\\zaln-s"), `rendered USFM keeps the opener on the same line as the \\zaln-e\\* it follows (got ${JSON.stringify(rendered)})`);
  assert(!/[“‘(\[{]\s*\\zaln-e\\\*/.test(rendered), `no opener immediately precedes a \\zaln-e\\* close (got ${JSON.stringify(rendered)})`);
}

// ─── Case h (F1): whitespace-only sibling must not hide a \q1 guard ────────
{
  console.log("\n[Case h] whitespace-only text sibling before a \\q1 marker still blocks the hoist (F1)");
  const before = {
    verseObjects: [
      zaln("H1", [w("say"), t(", ‘")]),
      t("\n"),
      { type: "quote", tag: "q1" },
      zaln("H2", [w("The")]),
    ],
  };
  const after = hoistOpeningPunctuation(before.verseObjects);
  assert(JSON.stringify(after) === JSON.stringify(before.verseObjects), "tree is deep-equal to the input (no-op)");
}

// ─── Case i (F5): nested chain within one OUTER — INNER1's opener bubbles ──
// only as far as INNER2, since OUTER's own trailing text (after its last
// word, inside INNER2) is then empty.
{
  console.log(
    "[Case i] nested chain OUTER[INNER1[say, ‘], INNER2[The]]: INNER1's opener hoists to a text node between the two INNERs (F5)",
  );
  const before = {
    verseObjects: [
      zaln("OUTER", [zaln("INNER1", [w("say"), t(", ‘")]), zaln("INNER2", [w("The")])]),
    ],
  };
  const beforeText = concatVerseText(before.verseObjects);
  const after = hoistOpeningPunctuation(before.verseObjects);
  assert(!milestoneTrailingHasOpener(after), "no milestone's trailing leaf matches OPENING_PUNCT_RE after hoist");
  assert(concatVerseText(after) === beforeText, "concatenated text round-trips exactly");
  assert(after.length === 1 && after[0].tag === "zaln" && after[0].strong === "OUTER", "OUTER stays the sole top-level node");
  const outerChildren = after[0].children;
  assert(outerChildren.length === 3, "a new text node was inserted between INNER1 and INNER2 (got length " + outerChildren.length + ")");
  assert(outerChildren[0].tag === "zaln" && outerChildren[0].strong === "INNER1", "INNER1 stays first");
  assert(outerChildren[1].type === "text" && outerChildren[1].text === ", ‘", "hoisted text lands between the two INNER milestones");
  assert(outerChildren[2].tag === "zaln" && outerChildren[2].strong === "INNER2", "INNER2 stays last");
  const rendered = usfm.toUSFM({ chapters: { "1": { "1": { verseObjects: after } } } }, { forcedNewLines: true });
  assert(rendered.includes("\\zaln-e\\*, ‘\\zaln-s"), `renders as \\zaln-e\\*, ‘\\zaln-s (got ${JSON.stringify(rendered)})`);
}

console.log(`\n${ran} assertion(s) ran, ${failed} failed.`);
if (failed > 0) {
  console.error(`\n${failed} failure(s).`);
  process.exit(1);
} else {
  console.log("\nAll openingPunct tests passed.");
}
