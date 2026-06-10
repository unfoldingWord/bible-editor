// Smoke test for replace.ts — smart verse edits that preserve word
// alignment (zaln milestones) where possible.
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/replace.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors
// src/lib/alignment.test.mjs.

import { smartEditVerse, smartReplaceVerse, tokenizePlainText } from "./replace.ts";

let failed = 0;
function assert(cond, msg) {
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

// \w nodes in document order with the strongs of their \zaln-s ancestors.
function alignedWords(content) {
  const out = [];
  const walk = (nodes, strongs) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "word" && n.tag === "w") out.push({ text: n.text, strongs });
      if (Array.isArray(n.children)) {
        walk(n.children, n.tag === "zaln" ? [...strongs, n.strong] : strongs);
      }
    }
  };
  walk(content.verseObjects, []);
  return out;
}

// Nested (compound) alignment: outer \zaln-s whose only child is an inner
// \zaln-s spanning the whole phrase — the UHB/UGNT multi-source shape.
const makeNested = () => ({
  verseObjects: [
    zaln("H1", [zaln("H2", [w("on"), t(" "), w("that"), t(" "), w("day")])]),
    t("."),
  ],
});

// ─── Case 1: nested \zaln-s — insertion inside the compound phrase ──────
{
  console.log("\n[Case 1] Nested \\zaln-s: insertion keeps surrounding text + alignment");
  const r = smartEditVerse(makeNested(), "on that day.", "on that very day.");
  assert(r.plainText === "on that very day.", `plainText is "on that very day." (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content);
  const day = words.find((x) => x.text === "day");
  assert(!!day, "'day' survives the edit");
  assert(day && day.strongs.includes("H1") && day.strongs.includes("H2"), "'day' keeps BOTH nested milestone ancestors");
  const on = words.find((x) => x.text === "on");
  assert(on && on.strongs.includes("H1") && on.strongs.includes("H2"), "'on' keeps BOTH nested milestone ancestors");
  const very = words.find((x) => x.text === "very");
  assert(very && very.strongs.length === 0, "inserted 'very' is unaligned");
}

// ─── Case 2: nested \zaln-s — 1→2 word replacement mid-phrase ───────────
{
  console.log("\n[Case 2] Nested \\zaln-s: word-count-changing replacement keeps flanking text");
  const r = smartEditVerse(makeNested(), "on that day.", "on this same day.");
  assert(r.plainText === "on this same day.", `plainText is "on this same day." (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content);
  const day = words.find((x) => x.text === "day");
  assert(day && day.strongs.includes("H1") && day.strongs.includes("H2"), "'day' keeps BOTH nested milestone ancestors");
  const on = words.find((x) => x.text === "on");
  assert(on && on.strongs.includes("H1") && on.strongs.includes("H2"), "'on' keeps BOTH nested milestone ancestors");
}

// ─── Case 3: flat control — single-level milestone, same insertion ──────
{
  console.log("\n[Case 3] Flat control: single-level milestone insertion");
  const flat = {
    verseObjects: [zaln("H2", [w("on"), t(" "), w("that"), t(" "), w("day")]), t(".")],
  };
  const r = smartEditVerse(flat, "on that day.", "on that very day.");
  assert(r.plainText === "on that very day.", `plainText is "on that very day." (got ${JSON.stringify(r.plainText)})`);
  const day = alignedWords(r.content).find((x) => x.text === "day");
  assert(day && day.strongs.includes("H2"), "'day' keeps its milestone ancestor");
}

// ─── Case 4: zero-word edits actually apply ──────────────────────────────
{
  console.log("\n[Case 4] Whitespace / punctuation-only edits are not discarded");
  const two = { verseObjects: [w("hello"), t(" "), w("world")] };
  const r = smartEditVerse(two, "hello world", "helloworld");
  assert(r.plainText === "helloworld", `joining two words applies (got ${JSON.stringify(r.plainText)})`);

  const dot = { verseObjects: [w("end"), t(".")] };
  const r2 = smartEditVerse(dot, "end.", "end");
  assert(r2.plainText === "end", `dropping a trailing period applies (got ${JSON.stringify(r2.plainText)})`);
}

// ─── Case 5: word-replacement preserve path still works ──────────────────
{
  console.log("\n[Case 5] Regression: 1:1 word replacement still preserves alignment");
  const flat = {
    verseObjects: [zaln("H2", [w("on"), t(" "), w("that"), t(" "), w("day")]), t(".")],
  };
  const r = smartEditVerse(flat, "on that day.", "on this day.");
  assert(r.plainText === "on this day.", `plainText is "on this day." (got ${JSON.stringify(r.plainText)})`);
  assert(r.preservedAlignment === true, "preservedAlignment stays true on the in-place path");
  const words = alignedWords(r.content);
  const edited = words.find((x) => x.text === "this");
  assert(edited && edited.strongs.length === 0, "edited 'this' is lifted out of the milestone");
  const day = words.find((x) => x.text === "day");
  assert(day && day.strongs.includes("H2"), "unchanged 'day' keeps its milestone");
}

// ─── Case 6: ASCII apostrophe binds a word run ───────────────────────────
{
  console.log("\n[Case 6] Straight apostrophe is an intra-word connector");
  const toks = tokenizePlainText("don't stop");
  const words = toks.filter((n) => n.type === "word").map((n) => n.text);
  assert(words[0] === "don't", `tokenizePlainText keeps "don't" one token (got ${JSON.stringify(words)})`);
  const toksCurly = tokenizePlainText("don’t stop");
  const wordsCurly = toksCurly.filter((n) => n.type === "word").map((n) => n.text);
  assert(wordsCurly[0] === "don’t", "curly apostrophe still binds too");

  // ONLY_WORD_RE derives from WORD_RUN_RE.source — the single-leaf in-place
  // path must accept an apostrophized result as one clean word.
  const verse = { verseObjects: [w("cant"), t(" "), w("go")] };
  const r = smartReplaceVerse(verse, "cant go", /ant/g, 1, 3, "an't");
  assert(r.plainText === "can't go", `single-leaf edit yields "can't go" (got ${JSON.stringify(r.plainText)})`);
  const outWords = alignedWords(r.content).map((x) => x.text);
  assert(outWords[0] === "can't", `"can't" stays a single \\w token (got ${JSON.stringify(outWords)})`);
}

// ─── Case 7: digit insertion snaps to the adjacent number token ──────────
{
  console.log("\n[Case 7] Digit typed against an existing number extends the token");
  const verse = { verseObjects: [w("weighs"), t(" "), w("0"), t(" "), w("shekels")] };
  const r = smartEditVerse(verse, "weighs 0 shekels", "weighs 30 shekels");
  assert(r.plainText === "weighs 30 shekels", `plainText is "weighs 30 shekels" (got ${JSON.stringify(r.plainText)})`);
  const outWords = alignedWords(r.content).map((x) => x.text);
  assert(outWords.includes("30"), `"30" is ONE \\w token, not glued "3"+"0" chips (got ${JSON.stringify(outWords)})`);
  assert(!outWords.includes("3"), "no stray standalone '3' chip");
}

// ─── Case 8: quantified-space user regex must not throw ──────────────────
{
  console.log("\n[Case 8] relaxWhitespace survives regex-mode patterns with quantified spaces");
  // `son {2}of` relaxed naively becomes `son\s+{2}of` — "nothing to repeat".
  const verse = { verseObjects: [w("the"), t(" "), w("son"), t("  "), w("of"), t(" "), w("man")] };
  let r = null;
  let threw = false;
  try {
    r = smartReplaceVerse(verse, "the son  of man", /son {2}of/g, 4, 7, "child");
  } catch {
    threw = true;
  }
  assert(!threw, "smartReplaceVerse does not throw on `son {2}of`");
  assert(r && r.plainText === "the child man", `replacement applies (got ${r && JSON.stringify(r.plainText)})`);

  // ` {1}` matches the single space of normalized plain text — the realistic
  // crash: a match IS found, then relaxWhitespace exploded on replace.
  const verse2 = { verseObjects: [w("the"), t(" "), w("son"), t(" "), w("of"), t(" "), w("man")] };
  let r2 = null;
  let threw2 = false;
  try {
    r2 = smartReplaceVerse(verse2, "the son of man", /son {1}of/g, 4, 6, "child");
  } catch {
    threw2 = true;
  }
  assert(!threw2, "smartReplaceVerse does not throw on `son {1}of`");
  assert(r2 && r2.plainText === "the child man", `replacement applies (got ${r2 && JSON.stringify(r2.plainText)})`);
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll replace tests passed.");
