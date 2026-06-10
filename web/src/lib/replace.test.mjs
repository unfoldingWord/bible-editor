// Smoke test for replace.ts — smart verse edits that preserve word
// alignment (zaln milestones) where possible.
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/replace.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors
// src/lib/alignment.test.mjs.

import { smartEditVerse, smartReplaceVerse, tokenizePlainText } from "./replace.ts";
import { extractEditableText } from "./usfm.ts";

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

// ─── Case 9: apostrophe typed into a bare top-level word keeps the word ──
{
  console.log("\n[Case 9] Inserting an apostrophe mid-word doesn't delete the word");
  // Bare \w "cant", type "'" between can|t. Previously dropped the straddling
  // leaf and saved just "'". Snap routes it to the in-place word replace.
  const r = smartEditVerse({ verseObjects: [w("cant")] }, "cant", "can't");
  assert(r.plainText === "can't", `plainText is "can't" (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content).map((x) => x.text);
  assert(words.length === 1 && words[0] === "can't", `"can't" is ONE \\w token (got ${JSON.stringify(words)})`);
}

// ─── Case 10: punctuation-append in a 1:1 word replace keeps the punctuation ─
{
  console.log("\n[Case 10] Find/replace that only adds punctuation isn't dropped");
  // find "good" → replace "good," — words map 1:1 but the comma must survive.
  const verse = { verseObjects: [w("good"), t(" "), w("word")] };
  const r = smartReplaceVerse(verse, "good word", /good/g, 0, 4, "good,");
  assert(r.plainText === "good, word", `comma survives (got ${JSON.stringify(r.plainText)})`);
}

// ─── Case 11: digit-grouping comma is intra-word (300,000 is ONE token) ──
{
  console.log("\n[Case 11] Grouping comma keeps a large number one token; prose comma splits");
  const numToks = tokenizePlainText("300,000").filter((n) => n.type === "word").map((n) => n.text);
  assert(numToks.length === 1 && numToks[0] === "300,000", `"300,000" tokenizes as one word (got ${JSON.stringify(numToks)})`);
  const multi = tokenizePlainText("300,000 men, 5,000 left").filter((n) => n.type === "word").map((n) => n.text);
  assert(JSON.stringify(multi) === JSON.stringify(["300,000", "men", "5,000", "left"]), `mixed numbers + prose comma (got ${JSON.stringify(multi)})`);
  const prose = tokenizePlainText("apples, oranges").filter((n) => n.type === "word").map((n) => n.text);
  assert(JSON.stringify(prose) === JSON.stringify(["apples", "oranges"]), `prose comma still splits (got ${JSON.stringify(prose)})`);
  // Typing the comma into an existing number snaps to one \w.
  const r = smartEditVerse({ verseObjects: [w("300000")] }, "300000", "300,000");
  const rWords = alignedWords(r.content).map((x) => x.text);
  assert(r.plainText === "300,000" && rWords.length === 1 && rWords[0] === "300,000", `typed grouping comma stays one chip (got ${JSON.stringify(rWords)})`);
}

// ─── Case 12: a space typed into a bare word splits it without losing text ──
{
  console.log("\n[Case 12] Inserting a space into a bare word splits it, no text loss");
  const r = smartEditVerse({ verseObjects: [w("ab")] }, "ab", "a b");
  assert(r.plainText === "a b", `plainText is "a b" (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content).map((x) => x.text);
  assert(JSON.stringify(words) === JSON.stringify(["a", "b"]), `splits into "a" + "b" (got ${JSON.stringify(words)})`);
}

// Count \zaln milestone nodes in a verseObjects tree.
function milestoneCount(content) {
  let n = 0;
  const walk = (nodes) => {
    for (const x of nodes ?? []) {
      if (!x || typeof x !== "object") continue;
      if (x.tag === "zaln") n++;
      if (Array.isArray(x.children)) walk(x.children);
    }
  };
  walk(content.verseObjects);
  return n;
}

// ─── Case 13: editing inline \q markers must NOT drop alignment ───────────
// Regression for the HOS 6:1 ULT prod incident: removing poetry markers (the
// trailing \q1 kills the diff's common suffix) ballooned the bounding change
// across the verse and flattened all 10 \zaln milestones. A marker-only edit
// changes no word text, so alignment must survive intact.
{
  console.log("\n[Case 13] Removing \\q markers preserves every \\zaln milestone");
  const q = (tag) => ({ type: "quote", tag });
  // "Come, \q2 for he. \q1" with each content word aligned.
  const verse = {
    verseObjects: [
      zaln("H1", [w("Come")]), t(", "),
      q("q2"),
      zaln("H2", [w("for")]), t(" "), zaln("H3", [w("he")]), t("."),
      q("q1"),
    ],
  };
  const old = extractEditableText(verse);
  assert(old === "Come, \\q2 for he.\\q1", `baseline surfaces markers (got ${JSON.stringify(old)})`);
  // User deletes both \q markers; no word/punctuation changes.
  const r = smartEditVerse(verse, old, "Come, for he.");
  assert(r.preservedAlignment === true, "marker-only removal keeps preservedAlignment true");
  assert(milestoneCount(r.content) === 3, `all 3 milestones survive (got ${milestoneCount(r.content)})`);
  assert(r.plainText === "Come, for he.", `text unchanged (got ${JSON.stringify(r.plainText)})`);
  assert(!r.content.verseObjects.some((n) => n.type === "quote"), "the \\q markers are gone");
  const aligned = alignedWords(r.content).map((x) => x.text);
  assert(JSON.stringify(aligned) === JSON.stringify(["Come", "for", "he"]), `all words stay aligned (got ${JSON.stringify(aligned)})`);
}

// ─── Case 14: moving a \q marker keeps alignment and repositions it ───────
{
  console.log("\n[Case 14] Moving a \\q marker preserves alignment");
  const q = (tag) => ({ type: "quote", tag });
  const verse = {
    verseObjects: [zaln("H1", [w("Come")]), t(", "), q("q2"), zaln("H2", [w("for")]), t(" "), zaln("H3", [w("he")]), t(".")],
  };
  const old = extractEditableText(verse); // "Come, \q2 for he."
  // Move the marker to sit before "he" instead of before "for".
  const r = smartEditVerse(verse, old, "Come, for \\q2 he.");
  assert(r.preservedAlignment === true, "marker move keeps preservedAlignment true");
  assert(milestoneCount(r.content) === 3, `all 3 milestones survive the move (got ${milestoneCount(r.content)})`);
  // Marker now sits between the "for" and "he" milestones (a space text node
  // may separate the marker from "he" — both round-trip to a break before "he").
  const idx = r.content.verseObjects.findIndex((n) => n.type === "quote");
  const forIdx = r.content.verseObjects.findIndex((n) => n.tag === "zaln" && n.strong === "H2");
  const heIdx = r.content.verseObjects.findIndex((n) => n.tag === "zaln" && n.strong === "H3");
  assert(idx > forIdx && idx < heIdx, `marker re-anchored between "for" and "he" (markerIdx ${idx}, forIdx ${forIdx}, heIdx ${heIdx})`);
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll replace tests passed.");
