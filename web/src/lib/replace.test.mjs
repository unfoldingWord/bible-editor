// Smoke test for replace.ts — smart verse edits that preserve word
// alignment (zaln milestones) where possible.
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/replace.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors
// src/lib/alignment.test.mjs.

import { smartEditVerse, smartReplaceVerse, tokenizePlainText, tokenizeEditableText } from "./replace.ts";
import { extractEditableText, extractPlainText } from "./usfm.ts";
import { analyzeAlignmentDelta } from "./alignmentDelta.ts";

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

// ─── Case 15: word edit in a verse WITH markers (markers unchanged) ───────
// The word change must preserve alignment AND leave the markers in place —
// the markers must not pollute the diff anchors.
{
  console.log("\n[Case 15] Word edit beside markers keeps alignment and the markers");
  const q = (tag) => ({ type: "quote", tag });
  const verse = {
    verseObjects: [
      zaln("H1", [w("Come")]), t(", "), q("q2"),
      zaln("H2", [w("for")]), t(" "), zaln("H3", [w("he")]), t("."), q("q1"),
    ],
  };
  const old = extractEditableText(verse); // "Come, \q2 for he.\q1"
  // Replace "for" -> "unto"; markers untouched.
  const r = smartEditVerse(verse, old, "Come, \\q2 unto he.\\q1");
  assert(r.plainText === "Come, unto he.", `text edited (got ${JSON.stringify(r.plainText)})`);
  assert(milestoneCount(r.content) === 2, `unchanged words stay aligned, edited word lifted (got ${milestoneCount(r.content)})`);
  const words = alignedWords(r.content);
  assert(words.find((x) => x.text === "Come")?.strongs.includes("H1"), "'Come' keeps alignment");
  assert(words.find((x) => x.text === "he")?.strongs.includes("H3"), "'he' keeps alignment");
  assert(words.find((x) => x.text === "unto")?.strongs.length === 0, "edited 'unto' is unaligned");
  const quotes = r.content.verseObjects.filter((n) => n.type === "quote").map((n) => n.tag);
  assert(JSON.stringify(quotes) === JSON.stringify(["q2", "q1"]), `both markers preserved in place (got ${JSON.stringify(quotes)})`);
}

// ─── Case 15b: a digit-bearing marker typed GLUED to the next word ────────
// "she didn't use the \q2 button" — a hand-typed \q2 with no trailing space
// (\q2destroy) was left as the literal word "q2destroy" because the marker
// regex demanded a non-letter boundary. A numeric suffix makes the marker
// unambiguous, so it's now recognized even when glued. Disambiguation for the
// bare prefixes (\q vs \qa, \p vs \pi) must still hold.
{
  console.log("\n[Case 15b] Digit-bearing marker glued to the next word is recognized");
  const q = (tag) => ({ type: "quote", tag });
  const verse = {
    verseObjects: [zaln("H1", [w("obeying")]), t(" "), zaln("H2", [w("me")]), t(" "), zaln("H3", [w("destroy")]), t(".")],
  };
  const old = extractEditableText(verse); // "obeying me destroy."
  // Type a \q2 with NO trailing space, glued to "destroy".
  const r = smartEditVerse(verse, old, "obeying me \\q2destroy.");
  const quotes = r.content.verseObjects.filter((n) => n.type === "quote").map((n) => n.tag);
  assert(JSON.stringify(quotes) === JSON.stringify(["q2"]), `glued \\q2 becomes a quote marker (got ${JSON.stringify(quotes)})`);
  const words = alignedWords(r.content).map((x) => x.text);
  assert(!words.some((t) => /q2/.test(t)), `no "q2"/"q2destroy" word survives (got ${JSON.stringify(words)})`);
  assert(words.includes("destroy"), `"destroy" stays a word (got ${JSON.stringify(words)})`);

  // tokenizeEditableText directly: glued digit-bearing forms recognized…
  const glued = tokenizeEditableText("a \\q1word \\pi2line \\qm3meter");
  const gluedTags = glued.filter((n) => n.type !== "text" && !(n.type === "word")).map((n) => n.tag);
  assert(
    JSON.stringify(gluedTags) === JSON.stringify(["q1", "pi2", "qm3"]),
    `glued q1/pi2/qm3 all recognized (got ${JSON.stringify(gluedTags)})`,
  );
  // …but bare prefixes must NOT bite into a longer (out-of-set) marker.
  const qa = tokenizeEditableText("text \\qa ZAYIN");
  assert(
    !qa.some((n) => n.type === "quote" && n.tag === "q"),
    `bare \\q does NOT bite \\qa into \\q + "a" (got ${JSON.stringify(qa.map((n) => n.tag ?? n.type))})`,
  );
  const pi = tokenizeEditableText("a \\pc centered \\mi margin");
  const piTags = pi.filter((n) => n.type === "paragraph").map((n) => n.tag);
  assert(
    JSON.stringify(piTags) === JSON.stringify(["pc", "mi"]),
    `\\pc / \\mi win over their \\p / \\m prefixes (got ${JSON.stringify(piTags)})`,
  );
}

// ─── Case 16: combined word edit + marker removal in one save ─────────────
// A single debounced save changes a word AND deletes markers. Unedited words
// must keep alignment; only the edited word unaligns; the markers are gone.
{
  console.log("\n[Case 16] Combined word edit + marker removal preserves alignment");
  const q = (tag) => ({ type: "quote", tag });
  const verse = {
    verseObjects: [
      zaln("H1", [w("Come")]), t(", "), q("q2"),
      zaln("H2", [w("for")]), t(" "), zaln("H3", [w("he")]), t("."), q("q1"),
    ],
  };
  const old = extractEditableText(verse); // "Come, \q2 for he.\q1"
  // Edit "he" -> "they" AND remove both markers.
  const r = smartEditVerse(verse, old, "Come, for they.");
  assert(r.plainText === "Come, for they.", `text edited (got ${JSON.stringify(r.plainText)})`);
  assert(!r.content.verseObjects.some((n) => n.type === "quote"), "both \\q markers removed");
  assert(milestoneCount(r.content) === 2, `'Come' + 'for' stay aligned (got ${milestoneCount(r.content)})`);
  const words = alignedWords(r.content);
  assert(words.find((x) => x.text === "Come")?.strongs.includes("H1"), "'Come' keeps alignment");
  assert(words.find((x) => x.text === "for")?.strongs.includes("H2"), "'for' keeps alignment");
  assert(words.find((x) => x.text === "they")?.strongs.length === 0, "edited 'they' is unaligned");
}

// ─── Case 17: trailing comma typed after an aligned word keeps alignment ──
// Regression: snapDiffToWordBoundaries treated a trailing connector as an
// edge unconditionally, so typing "," after "good" snapped the match onto
// "good" → localized rewrite re-emitted "good" UNALIGNED. The comma binds
// nothing on its far side (a space follows), so it must stay a boundary
// insertion that leaves both surrounding words aligned.
{
  console.log("\n[Case 17] Typing a comma after a word doesn't unalign the word");
  const verse = {
    verseObjects: [zaln("H1", [w("good")]), t(" "), zaln("H2", [w("word")])],
  };
  const r = smartEditVerse(verse, "good word", "good, word");
  assert(r.plainText === "good, word", `plainText is "good, word" (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content);
  assert(words.find((x) => x.text === "good")?.strongs.includes("H1"), "'good' keeps alignment");
  assert(words.find((x) => x.text === "word")?.strongs.includes("H2"), "'word' keeps alignment");
}

// ─── Case 18: possessive apostrophe after a name keeps alignment ──────────
// "Moses'" tokenizes as "Moses" + "'" (the apostrophe is followed by a space,
// not a letter, so it does NOT bind into the word). Typing it must not snap
// onto / unalign "Moses".
{
  console.log("\n[Case 18] Typing a possessive apostrophe after a name keeps alignment");
  const verse = {
    verseObjects: [zaln("H1", [w("Moses")]), t(" "), zaln("H2", [w("said")])],
  };
  const r = smartEditVerse(verse, "Moses said", "Moses' said");
  assert(r.plainText === "Moses' said", `plainText is "Moses' said" (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content);
  assert(words.find((x) => x.text === "Moses")?.strongs.includes("H1"), "'Moses' keeps alignment");
}

// ─── Case 19: trailing comma after a number doesn't split the number ──────
// The worst case: a trailing list comma after "1,000" snapped mid-number
// (absorbing only the "000" run up to the grouping comma), splitting the
// token AND unaligning it. It must stay "1,000" + a boundary "," .
{
  console.log("\n[Case 19] Typing a list comma after a grouped number keeps it one aligned token");
  const verse = {
    verseObjects: [zaln("H1", [w("1,000")]), t(" "), zaln("H2", [w("men")])],
  };
  const r = smartEditVerse(verse, "1,000 men", "1,000, men");
  assert(r.plainText === "1,000, men", `plainText is "1,000, men" (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content);
  const num = words.filter((x) => x.text === "1,000");
  assert(num.length === 1, `"1,000" stays ONE \\w token (got ${JSON.stringify(words.map((x) => x.text))})`);
  assert(num[0]?.strongs.includes("H1"), "'1,000' keeps alignment");
  assert(words.find((x) => x.text === "men")?.strongs.includes("H2"), "'men' keeps alignment");
}

// ─── Case 20: 1:1 word replace across a line-broken (\n) raw stays aligned ─
// Regression: the skeleton check compared whitespace byte-exactly, so a raw
// "on\nthat" vs replacement "on this" (one normalized space) failed the
// check → localized rewrite unaligned even the UNCHANGED "on". Collapsing
// whitespace in the skeleton keeps the preserve path; only the changed word
// unaligns.
{
  console.log("\n[Case 20] 1:1 replace spanning a \\n keeps unchanged words aligned");
  const verse = {
    verseObjects: [
      zaln("H1", [w("on"), t("\n"), w("that")]),
      t(" "),
      zaln("H2", [w("day")]),
    ],
  };
  const r = smartReplaceVerse(verse, "on that day", /on that/g, 0, 7, "on this");
  assert(r.plainText === "on this day", `plainText is "on this day" (got ${JSON.stringify(r.plainText)})`);
  assert(r.preservedAlignment === true, "stays on the alignment-preserving path");
  const words = alignedWords(r.content);
  assert(words.find((x) => x.text === "on")?.strongs.includes("H1"), "unchanged 'on' keeps alignment");
  assert(words.find((x) => x.text === "day")?.strongs.includes("H2"), "'day' keeps alignment");
  assert(words.find((x) => x.text === "this")?.strongs.length === 0, "edited 'this' is unaligned");
}

// ─── Case 21: reconcile keeps trailing punctuation glued to its word ──────
// Regression for the ZEC 6:12 ULT prod corruption. When a word edit shifts the
// word count before a marker, reconcileMarkers re-lays ALL markers. It must
// drop each marker at the START of the next poetic line — AFTER the trailing
// punctuation that belongs to the preceding word — not wedge it before that
// 0-word punctuation text node (which rendered as `saying \q1 :`, `sprout \q1 ,`,
// `Yahweh \q1 .`). A trailing marker (introducing the next verse) stays at the
// very end, after the final period.
{
  console.log("\n[Case 21] Reconcile lands \\q markers after trailing punctuation, not before it");
  const q = (tag) => ({ type: "quote", tag });
  const verse = {
    verseObjects: [
      zaln("H1", [w("saying", "2", "2")]), t(":\n"), q("q1"),
      zaln("H2", [w("Behold")]), t(", "),
      zaln("H3", [w("sprout")]), t(",\n"), q("q1"),
      zaln("H4", [w("and", "2", "2")]), t(" "), zaln("H5", [w("Yahweh", "2", "2")]), t(".\n"),
      q("q1"), // trailing marker that introduces the next verse
    ],
  };
  const old = extractEditableText(verse); // "saying: \q1 Behold, sprout,\q1 and Yahweh.\q1"
  // Insert a word in the first poetic line — shifts the word count before every
  // marker, so markerSignature changes and reconcileMarkers runs.
  const r = smartEditVerse(verse, old, old.replace("\\q1 Behold", "\\q1 now Behold"));
  const vos = r.content.verseObjects;
  // For every \q1, the immediately preceding sibling must be the punctuation
  // text node — i.e. the marker did NOT jump ahead of it.
  const findText = (i) => {
    for (let j = i - 1; j >= 0; j--) {
      if (vos[j].type === "text") return vos[j].text;
      if (vos[j].type === "quote") continue;
      return null; // a milestone/word sits between — punctuation was displaced
    }
    return null;
  };
  let markerIdx = 0;
  vos.forEach((n, i) => {
    if (n.type !== "quote") return;
    markerIdx++;
    const prevText = findText(i);
    assert(
      prevText !== null && /[:,.]/.test(prevText),
      `\\q1 #${markerIdx} follows its trailing punctuation (prev text ${JSON.stringify(prevText)})`,
    );
  });
  // Alignment for every milestone survives the reconcile.
  const words = alignedWords(r.content);
  assert(words.find((x) => x.text === "Yahweh")?.strongs.includes("H5"), "'Yahweh' keeps alignment");
  assert(words.find((x) => x.text === "Behold")?.strongs.includes("H2"), "'Behold' keeps alignment");
}

// ─── Case 22: reconcile keeps a LEADING marker before opening punctuation ──
// Counterpart to Case 21 and the ZEC 13:7 ULT false-positive: an em-dash that
// OPENS the next poetic line (`companion” \q1 —the declaration`) must stay
// AFTER the marker. The closing quote that trails the previous word stays
// before it; the opening dash that leads the new line stays after it.
{
  console.log("\n[Case 22] Reconcile keeps opening punctuation (em-dash) after the marker");
  const q = (tag) => ({ type: "quote", tag });
  const verse = {
    verseObjects: [
      zaln("H1", [w("companion")]), t("”"), t("\n"), q("q1"),
      t("—"), zaln("H2", [w("the")]), t(" "), zaln("H3", [w("declaration")]),
    ],
  };
  const old = extractEditableText(verse); // "companion”\q1 —the declaration"
  // Insert a word before the marker to force a reconcile.
  const r = smartEditVerse(verse, old, old.replace("companion", "companion now"));
  const vos = r.content.verseObjects;
  const qIdx = vos.findIndex((n) => n.type === "quote");
  const dashIdx = vos.findIndex((n) => n.type === "text" && n.text.startsWith("—"));
  const theIdx = vos.findIndex((n) => n.type === "milestone" && n.children?.some((c) => c.text === "the"));
  assert(qIdx >= 0 && dashIdx > qIdx && dashIdx < theIdx, `em-dash stays AFTER the \\q1 and before "the" (q ${qIdx}, dash ${dashIdx}, the ${theIdx})`);
  // The closing quote stayed BEFORE the marker (glued to "companion").
  const quoteBeforeMarker = vos.slice(0, qIdx).some((n) => n.type === "text" && n.text.includes("”"));
  assert(quoteBeforeMarker, "closing quote stays before the marker");
}

// ─── Case 22b: an em-dash typed at the END of a line stays before the marker ──
// The reported prod bug (PRO 6:9-style poetry): the translator types `—` at the
// end of the `\q1` line, right after "city", then saves — and the em-dash jumps
// to the START of the next (`\q2`) line: `city \q2 —(and …`. Counterpart to Case
// 22: there the dash OPENED the next line and had to stay AFTER the marker; here
// the translator put it BEFORE the marker, so it must stay there. The fix honors
// the typed position rather than treating every em-dash as opening punctuation.
{
  console.log("\n[Case 22b] An em-dash typed at a line end stays before the marker");
  const q = (tag) => ({ type: "quote", tag });
  const verse = {
    verseObjects: [
      q("q1"),
      zaln("H1", [w("the")]), t(" "), zaln("H2", [w("city")]), t("\n"), q("q2"),
      t("("), zaln("H3", [w("and")]), t(" "), zaln("H4", [w("wisdom")]), t("),"),
    ],
  };
  const old = extractEditableText(verse); // "\q1 the city \q2 (and wisdom),"
  // Type an em-dash right after "city", before the \q2 marker token.
  const r = smartEditVerse(verse, old, old.replace("city", "city—"));
  const vos = r.content.verseObjects;
  const qIdx = vos.findIndex((n) => n.type === "quote" && n.tag === "q2");
  const dashBeforeMarker = vos.slice(0, qIdx).some((n) => n.type === "text" && n.text.includes("—"));
  const dashAfterMarker = vos.slice(qIdx + 1).some((n) => n.type === "text" && n.text.includes("—"));
  assert(dashBeforeMarker && !dashAfterMarker, `em-dash stays BEFORE the \\q2 (on the line it was typed), not after it (raw ${JSON.stringify(r.plainText)})`);
  // The opening paren that leads the next line stays AFTER the marker.
  const parenAfterMarker = vos.slice(qIdx + 1).some((n) => n.type === "text" && n.text.includes("("));
  assert(parenAfterMarker, "the opening paren stays after the marker (leads the next line)");
  // Alignment is untouched — pure punctuation edit.
  const words = alignedWords(r.content);
  assert(words.find((x) => x.text === "city")?.strongs.includes("H2"), "'city' keeps its alignment");
  assert(words.find((x) => x.text === "and")?.strongs.includes("H3"), "'and' keeps its alignment");
}

// ─── Case 23: opening quote parked on a marker node is surfaced & editable ──
// usfm-js attaches the leading punctuation after a marker (`\q2 “I am…`) to the
// MARKER node's own `text` (ISA 28:12 / 28:15, 151 such nodes in ISA UST alone).
// It used to be invisible in the editor and dropped on reconcile. extractEditableText
// must now surface it, and a far-away word edit must keep it (lifted to a text node).
{
  console.log("\n[Case 23] Quote parked on a \\q marker node is visible and survives edits");
  const qText = (tag, text) => ({ type: "quote", tag, text });
  const verse = {
    verseObjects: [
      zaln("H1", [w("earlier")]), t(",\n"),
      qText("q2", "“"), // ← opening quote on the marker node (usfm-js shape)
      zaln("H2", [w("I"), t(" "), w("am"), t(" "), w("offering")]), t(".”\n"),
    ],
  };
  const old = extractEditableText(verse);
  assert(old.includes("\\q2 “"), `editable baseline surfaces the opening quote (got ${JSON.stringify(old)})`);
  // Edit a far word; the hidden quote must survive, lifted to a text node after the marker.
  const r = smartEditVerse(verse, old, old.replace("earlier", "before"));
  const vos = r.content.verseObjects;
  const qi = vos.findIndex((n) => n.type === "quote");
  assert(typeof vos[qi].text !== "string", "marker node no longer carries text (lifted out)");
  assert(vos[qi + 1]?.type === "text" && vos[qi + 1].text.includes("“"), "the opening quote is now a text node right after the marker");
  assert(r.plainText.includes("“"), `the opening quote is not lost (got ${JSON.stringify(r.plainText)})`);
  // The quoted clause after the marker is untouched, so its alignment survives.
  assert(alignedWords(r.content).find((x) => x.text === "offering")?.strongs.includes("H2"), "the post-quote milestone keeps its alignment");
}

// ─── Case 24: typing an opening quote after a marker lands AFTER it ──────────
// The priority bug: adding `"` in front of the first word of a poetic line must
// not "pop" the quote in front of the \q marker.
{
  console.log("\n[Case 24] Typing a quote after a \\q marker keeps it after the marker");
  const q = (tag) => ({ type: "quote", tag });
  const verse = {
    verseObjects: [
      zaln("H1", [w("says")]), t(":\n"), q("q1"),
      zaln("H2", [w("Behold")]), t(", "), zaln("H3", [w("a"), t(" "), w("man")]), t(".\n"),
    ],
  };
  const old = extractEditableText(verse); // "says: \q1 Behold, a man."
  const r = smartEditVerse(verse, old, old.replace("\\q1 Behold", '\\q1 "Behold'));
  const vos = r.content.verseObjects;
  const qi = vos.findIndex((n) => n.type === "quote");
  const quoteBeforeMarker = vos.slice(0, qi).some((n) => n.type === "text" && n.text.includes('"'));
  assert(!quoteBeforeMarker, "the typed quote did NOT pop in front of the marker");
  assert(vos[qi + 1]?.type === "text" && vos[qi + 1].text.includes('"'), "the typed quote sits in a text node right after the marker");
  assert(alignedWords(r.content).find((x) => x.text === "Behold")?.strongs.includes("H2"), "'Behold' keeps its alignment");
}

// ─── Case 25: a space typed INSIDE an aligned word keeps the whole verse aligned ─
// The "felt bug": inserting a space (or any non-word char) mid-word used to
// partially overlap the \w leaf NESTED inside a \zaln milestone, which bailed
// to a whole-verse flat tokenize — every milestone in the verse vanished.
// Now the straddling leaf is split in place, so only the touched word's
// milestone splits and every OTHER milestone survives.
{
  console.log("\n[Case 25] Mid-word space keeps every other milestone aligned");
  const verse = {
    verseObjects: [
      zaln("H1", [w("alpha")]), t(" "),
      zaln("H2", [w("beta")]), t(" "),
      zaln("H3", [w("gamma")]),
    ],
  };
  const r = smartEditVerse(verse, "alpha beta gamma", "alpha be ta gamma");
  assert(r.plainText === "alpha be ta gamma", `plainText is "alpha be ta gamma" (got ${JSON.stringify(r.plainText)})`);
  assert(milestoneCount(r.content) >= 3, `no full unalign — at least the 3 source milestones survive (got ${milestoneCount(r.content)})`);
  const words = alignedWords(r.content);
  assert(words.find((x) => x.text === "alpha")?.strongs.includes("H1"), "untouched 'alpha' keeps alignment");
  assert(words.find((x) => x.text === "gamma")?.strongs.includes("H3"), "untouched 'gamma' keeps alignment");
  // The split fragments stay inside the original milestone (still aligned).
  assert(words.find((x) => x.text === "be")?.strongs.includes("H2"), "split 'be' fragment stays aligned to H2");
  assert(words.find((x) => x.text === "ta")?.strongs.includes("H2"), "split 'ta' fragment stays aligned to H2");
}

// ─── Case 26: a bracket typed inside an aligned word keeps the verse aligned ─
{
  console.log("\n[Case 26] Mid-word bracket keeps every other milestone aligned");
  const verse = {
    verseObjects: [
      zaln("H1", [w("alpha")]), t(" "),
      zaln("H2", [w("beta")]), t(" "),
      zaln("H3", [w("gamma")]),
    ],
  };
  const r = smartEditVerse(verse, "alpha beta gamma", "alpha be{ta gamma");
  assert(r.plainText === "alpha be{ta gamma", `the bracket survives (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content);
  assert(words.find((x) => x.text === "alpha")?.strongs.includes("H1"), "untouched 'alpha' keeps alignment");
  assert(words.find((x) => x.text === "gamma")?.strongs.includes("H3"), "untouched 'gamma' keeps alignment");
  // The inserted "{" is a bare (unaligned) text/token between the fragments.
  assert(milestoneCount(r.content) >= 3, `no full unalign (got ${milestoneCount(r.content)})`);
}

// ─── Case 27: mid-word edit inside a COMPOUND (nested) milestone preserves it ─
// The straddling-leaf split must recurse through nested \zaln-s so a mid-word
// edit inside the inner phrase doesn't collapse the outer alignment either.
{
  console.log("\n[Case 27] Mid-word edit inside nested \\zaln-s keeps both ancestors");
  const r = smartEditVerse(makeNested(), "on that day.", "on th at day.");
  assert(r.plainText === "on th at day.", `plainText is "on th at day." (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content);
  assert(words.find((x) => x.text === "on")?.strongs.join() === "H1,H2", "'on' keeps BOTH nested ancestors");
  assert(words.find((x) => x.text === "day")?.strongs.join() === "H1,H2", "'day' keeps BOTH nested ancestors");
  // Split fragments of "that" keep both ancestors too (not flattened to bare).
  assert(words.find((x) => x.text === "th")?.strongs.join() === "H1,H2", "split 'th' keeps both nested ancestors");
  assert(words.find((x) => x.text === "at")?.strongs.join() === "H1,H2", "split 'at' keeps both nested ancestors");
}

// ─── Case 28: inserting a word BEFORE an aligned word keeps the neighbour ─────
// The dominant collateral-unalign bug: inserting "truly" before "the" diffs
// (because both start with "t") as a mid-"the" straddle; snap then absorbed the
// untouched "the" and re-tokenized it UNALIGNED. canonicalizePureInsertion
// slides the insertion onto the word boundary first, so only the new word is
// unaligned and every existing word keeps its alignment.
{
  console.log("\n[Case 28] Inserting a word before an aligned neighbour keeps the neighbour aligned");
  const verse = {
    verseObjects: [
      zaln("H1", [w("In")]), t(" "),
      zaln("H2", [w("the")]), t(" "),
      zaln("H3", [w("day")]),
    ],
  };
  const r = smartEditVerse(verse, "In the day", "In truly the day");
  assert(r.plainText === "In truly the day", `plainText is "In truly the day" (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content);
  assert(words.find((x) => x.text === "In")?.strongs.includes("H1"), "'In' keeps alignment");
  assert(words.find((x) => x.text === "the")?.strongs.includes("H2"), "untouched 'the' keeps alignment (was the bug)");
  assert(words.find((x) => x.text === "day")?.strongs.includes("H3"), "'day' keeps alignment");
  assert(words.find((x) => x.text === "truly")?.strongs.length === 0, "inserted 'truly' is unaligned");
}

// ─── Case 29: one→two word edit ("angry" → "also angry") keeps "angry" ─────────
// Same family via the 1→2 word path: the minimal diff aliases on the shared
// leading "a"; without canonicalization "angry" unaligned even though only
// "also" was added in front of it.
{
  console.log("\n[Case 29] Adding a word in front of an aligned word keeps that word aligned");
  const verse = {
    verseObjects: [zaln("H1", [w("was")]), t(" "), zaln("H2", [w("angry")])],
  };
  const r = smartEditVerse(verse, "was angry", "was also angry");
  assert(r.plainText === "was also angry", `plainText is "was also angry" (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content);
  assert(words.find((x) => x.text === "was")?.strongs.includes("H1"), "'was' keeps alignment");
  assert(words.find((x) => x.text === "angry")?.strongs.includes("H2"), "untouched 'angry' keeps alignment (was the bug)");
  assert(words.find((x) => x.text === "also")?.strongs.length === 0, "inserted 'also' is unaligned");
}

// ─── Case 30: canonicalization must NOT break a genuine word-extension ─────────
// Guard: "Th" typed before "is" still snaps to one word "This" (no aliased
// non-straddling position exists), and a digit against a number still extends.
{
  console.log("\n[Case 30] Genuine word-extensions still snap (canonicalization is a no-op for them)");
  const r1 = smartEditVerse({ verseObjects: [zaln("H1", [w("is")])] }, "is", "This");
  const w1 = alignedWords(r1.content).map((x) => x.text);
  assert(r1.plainText === "This" && w1.length === 1 && w1[0] === "This", `"Th"+"is" → one "This" (got ${JSON.stringify(w1)})`);
  const r2 = smartEditVerse({ verseObjects: [zaln("H1", [w("weighs")]), t(" "), zaln("H2", [w("0")])] }, "weighs 0", "weighs 30");
  const w2 = alignedWords(r2.content).map((x) => x.text);
  assert(w2.includes("30") && !w2.includes("3"), `digit extends "0"→"30" as one token (got ${JSON.stringify(w2)})`);
}

// ─── Case 31: brackets around an aligned phrase keep every word aligned ───────
// Perry's MIC 5:14 report: wrapping an already-aligned phrase in `{...}` must
// NOT unalign it. The bracket chars change the punctuation skeleton, so the
// preserve path bails; the relayout keeps every \w (and its milestone) and just
// drops the new brackets in as text. Here the whole phrase is ONE milestone
// (the 5:14 shape), brackets land mid-phrase.
{
  console.log("\n[Case 31] Brackets around an aligned phrase (single milestone) keep alignment");
  const verse = {
    verseObjects: [
      zaln("H1", [w("remove"), t(" "), w("the"), t(" "), w("poles"), t(" "), w("worship"), t(" "), w("goddess"), t(" "), w("Asherah")]),
    ],
  };
  const r = smartEditVerse(verse, "remove the poles worship goddess Asherah", "remove the {poles worship goddess} Asherah");
  assert(r.plainText === "remove the {poles worship goddess} Asherah", `brackets survive (got ${JSON.stringify(r.plainText)})`);
  assert(r.preservedAlignment === true, "preservedAlignment stays true");
  const words = alignedWords(r.content);
  assert(words.length === 6 && words.every((x) => x.strongs.includes("H1")), `all 6 words stay aligned to H1 (got ${JSON.stringify(words.map((x) => [x.text, x.strongs]))})`);
}

// ─── Case 32: brackets spanning MULTIPLE milestones keep each word aligned ─────
// MIC 5:5 `{the army of} Assyria`: the bracketed words live in separate
// milestones. The relayout must keep each milestone and splice the brackets at
// the range edges (here `{` before "the", `}` after "of").
{
  console.log("\n[Case 32] Brackets spanning several milestones keep every milestone aligned");
  const verse = {
    verseObjects: [
      zaln("H1", [w("the")]), t(" "), zaln("H2", [w("army")]), t(" "), zaln("H3", [w("of")]), t(" "), zaln("H4", [w("Assyria")]),
    ],
  };
  const r = smartEditVerse(verse, "the army of Assyria", "{the army of} Assyria");
  assert(r.plainText === "{the army of} Assyria", `brackets survive (got ${JSON.stringify(r.plainText)})`);
  assert(r.preservedAlignment === true, "preservedAlignment stays true");
  assert(milestoneCount(r.content) === 4, `all 4 milestones survive (got ${milestoneCount(r.content)})`);
  const words = alignedWords(r.content);
  assert(words.find((x) => x.text === "the")?.strongs.includes("H1"), "'the' keeps alignment");
  assert(words.find((x) => x.text === "of")?.strongs.includes("H3"), "'of' keeps alignment");
  assert(words.find((x) => x.text === "Assyria")?.strongs.includes("H4"), "'Assyria' keeps alignment");
}

// ─── Case 33: wrapping a single aligned word in parentheses keeps it aligned ───
{
  console.log("\n[Case 33] Parenthesising one aligned word keeps it aligned");
  const verse = {
    verseObjects: [zaln("H1", [w("see")]), t(" "), zaln("H2", [w("now")]), t(" "), zaln("H3", [w("this")])],
  };
  const r = smartEditVerse(verse, "see now this", "see (now) this");
  assert(r.plainText === "see (now) this", `parens survive (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content);
  assert(words.find((x) => x.text === "now")?.strongs.includes("H2"), "'now' keeps alignment (parens are boundary text)");
  assert(words.find((x) => x.text === "see")?.strongs.includes("H1") && words.find((x) => x.text === "this")?.strongs.includes("H3"), "flanking words keep alignment");
}

// ─── Case 34: moving a period across a \q line break is no longer a no-op ──────
// MIC 5:12 "refuses to move the period": the trailing period sat AFTER the \q1
// line break (`among you \q1 .`), so the period dangled on the next line. Moving
// it onto "you" used to no-op — markerSignature counted only words before the
// marker, which is unchanged by reordering a (word-less) period around it. The
// signature now includes the trailing punctuation, so reconcileMarkers runs and
// re-lays the \q1 after the period. Alignment is untouched.
{
  console.log("\n[Case 34] Moving a period across a \\q marker takes effect and keeps alignment");
  const q = (tag) => ({ type: "quote", tag });
  const verse = {
    verseObjects: [zaln("H1", [w("among"), t(" "), w("you")]), q("q1"), t(".")],
  };
  const old = extractEditableText(verse); // period after the \q1
  const newPlain = old.replace("you" + "\\q1" + " .", "you. " + "\\q1");
  assert(newPlain !== old, `mutation produced a change (old ${JSON.stringify(old)})`);
  const r = smartEditVerse(verse, old, newPlain);
  assert(JSON.stringify(r.content) !== JSON.stringify(verse), "the edit actually changes the content (no longer a no-op)");
  const vos = r.content.verseObjects;
  const qi = vos.findIndex((n) => n.type === "quote" && n.tag === "q1");
  assert(qi >= 0, "the \\q1 marker is still present");
  const periodBefore = vos.slice(0, qi).some((n) => n.type === "text" && n.text.includes("."));
  assert(periodBefore, "the period now sits BEFORE the \\q1 (on the same line as 'you')");
  const words = alignedWords(r.content);
  assert(words.find((x) => x.text === "you")?.strongs.includes("H1") && words.find((x) => x.text === "among")?.strongs.includes("H1"), "alignment survives the period move");
}

// ─── Case 35: insert a word AND add brackets in ONE save (MIC 5:14, the report) ─
// "Fix the whole verse at once": the translator inserts "that" AND wraps the
// phrase in { } in a single edit. The 7 survivors keep their milestone; only
// the new "that" is bare; brackets are text. (Word count changed, so this hits
// the new smartRebuildRange tier, not the equal-count relayout.)
{
  console.log("\n[Case 35] Insert a word + brackets in one save keeps the survivors aligned");
  const verse = {
    verseObjects: [
      zaln("Hthe", [w("the", "1", "2")]), t(" "),
      zaln("Hphr", [w("poles"), t(" "), w("you"), t(" "), w("use"), t(" "), w("to"), t(" "), w("worship"), t(" "), w("the", "2", "2"), t(" "), w("goddess")]), t(" "),
      zaln("Hash", [w("Asherah")]),
    ],
  };
  const old = extractEditableText(verse);
  const r = smartEditVerse(verse, old, "the {poles that you use to worship the goddess} Asherah");
  assert(r.plainText === "the {poles that you use to worship the goddess} Asherah", `plainText exact (got ${JSON.stringify(r.plainText)})`);
  assert(r.preservedAlignment === true, "preservedAlignment is true");
  const words = alignedWords(r.content);
  for (const wd of ["poles", "you", "use", "to", "worship", "goddess"]) assert(words.find((x) => x.text === wd)?.strongs.includes("Hphr"), `'${wd}' keeps Hphr alignment`);
  assert(words.find((x) => x.text === "that")?.strongs.length === 0, "inserted 'that' is unaligned");
  assert(words.find((x) => x.text === "Asherah")?.strongs.includes("Hash"), "'Asherah' keeps alignment");
}

// ─── Case 36: insert a word spanning SEPARATE milestones + brackets ────────────
{
  console.log("\n[Case 36] Insert across separate milestones keeps each milestone aligned");
  const verse = {
    verseObjects: [zaln("H1", [w("the")]), t(" "), zaln("H2", [w("army")]), t(" "), zaln("H3", [w("of")]), t(" "), zaln("H4", [w("Assyria")])],
  };
  const r = smartEditVerse(verse, "the army of Assyria", "{the great army of} Assyria");
  assert(r.plainText === "{the great army of} Assyria", `plainText exact (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content);
  assert(words.find((x) => x.text === "the")?.strongs.includes("H1"), "'the' keeps H1");
  assert(words.find((x) => x.text === "army")?.strongs.includes("H2"), "'army' keeps H2");
  assert(words.find((x) => x.text === "of")?.strongs.includes("H3"), "'of' keeps H3");
  assert(words.find((x) => x.text === "great")?.strongs.length === 0, "inserted 'great' is unaligned");
}

// ─── Case 37: insert + bracket inside a NESTED compound milestone ──────────────
// Generalizes Case 27 to a changed word count: on/that/day must keep BOTH
// nested ancestors; the inserted "very" is bare; brackets are text.
{
  console.log("\n[Case 37] Insert + bracket inside nested \\zaln-s keeps both ancestors");
  const r = smartEditVerse(makeNested(), "on that day.", "on that {very} day.");
  assert(r.plainText === "on that {very} day.", `plainText exact (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content);
  assert(words.find((x) => x.text === "on")?.strongs.join() === "H1,H2", "'on' keeps BOTH nested ancestors");
  assert(words.find((x) => x.text === "day")?.strongs.join() === "H1,H2", "'day' keeps BOTH nested ancestors");
  assert(words.find((x) => x.text === "that")?.strongs.join() === "H1,H2", "'that' keeps BOTH nested ancestors");
  assert(words.find((x) => x.text === "very")?.strongs.length === 0, "inserted 'very' is unaligned");
}

// ─── Case 38: duplicate-word correctness (LCS, not greedy) ─────────────────────
// A second "the" elsewhere must not be transplanted onto; insert maps cleanly.
{
  console.log("\n[Case 38] Duplicate words: each survivor keeps its OWN milestone; new word bare");
  const verse = {
    verseObjects: [zaln("H1", [w("the", "1", "2")]), t(" "), zaln("H2", [w("king")]), t(" "), zaln("H3", [w("of")]), t(" "), zaln("H4", [w("the", "2", "2")]), t(" "), zaln("H5", [w("land")])],
  };
  const r = smartEditVerse(verse, "the king of the land", "the {good king} of the land");
  assert(r.plainText === "the {good king} of the land", `plainText exact (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content);
  assert(words.filter((x) => x.text === "the")[0]?.strongs.includes("H1"), "first 'the' keeps H1");
  assert(words.filter((x) => x.text === "the")[1]?.strongs.includes("H4"), "second 'the' keeps H4 (not transplanted)");
  assert(words.find((x) => x.text === "king")?.strongs.includes("H2"), "'king' keeps H2");
  assert(words.find((x) => x.text === "good")?.strongs.length === 0, "inserted 'good' is unaligned");
}

// ─── Case 39: delete a word + brackets; no empty milestone left behind ─────────
{
  console.log("\n[Case 39] Delete a word + brackets shrinks the milestone, prunes empties");
  const verse = {
    verseObjects: [zaln("H1", [w("poles"), t(" "), w("you"), t(" "), w("use")]), t(" "), zaln("H2", [w("often")])],
  };
  const r = smartEditVerse(verse, "poles you use often", "{poles use} often");
  assert(r.plainText === "{poles use} often", `plainText exact (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content);
  assert(!words.some((x) => x.text === "you"), "'you' was deleted");
  assert(words.find((x) => x.text === "poles")?.strongs.includes("H1"), "'poles' keeps H1");
  assert(words.find((x) => x.text === "use")?.strongs.includes("H1"), "'use' keeps H1");
  // no zaln node with zero \w descendants
  const deadMilestone = (nodes) => nodes.some((n) => {
    if (!n || typeof n !== "object") return false;
    if (n.tag === "zaln") { const hasW = JSON.stringify(n).includes('"tag":"w"'); if (!hasW) return true; }
    return Array.isArray(n.children) ? deadMilestone(n.children) : false;
  });
  assert(!deadMilestone(r.content.verseObjects), "no empty \\zaln milestone survives the deletion");
}

// ─── Case 40: split possessive (Yahweh’s / Asherahs) stays aligned ─────────────
// WORD_RUN_RE binds these into one token though the tree stores them as separate
// \w leaves (connector-split or adjacent across a milestone boundary). The word
// UNIT logic must keep them aligned when a sibling word is inserted + bracketed.
{
  console.log("\n[Case 40] Split possessive words stay aligned through a combined edit");
  // connector-split: "Yahweh’s" = \w + ’ + \w in one milestone
  const v1 = { verseObjects: [zaln("H1", [w("Yahweh"), t("’"), w("s")]), t(" "), zaln("H2", [w("people")])] };
  const r1 = smartEditVerse(v1, "Yahweh’s people", "Yahweh’s {chosen people}");
  assert(r1.plainText === "Yahweh’s {chosen people}", `plainText exact (got ${JSON.stringify(r1.plainText)})`);
  const w1 = alignedWords(r1.content);
  assert(w1.find((x) => x.text === "Yahweh")?.strongs.includes("H1") && w1.find((x) => x.text === "s")?.strongs.includes("H1"), "'Yahweh’s' (both leaves) keeps H1");
  assert(w1.find((x) => x.text === "people")?.strongs.includes("H2"), "'people' keeps H2");
  assert(w1.find((x) => x.text === "chosen")?.strongs.length === 0, "inserted 'chosen' is unaligned");
  // adjacent across a milestone boundary: "Asherahs" = \w "Asherah" + \w "s"
  const v2 = { verseObjects: [zaln("H1", [w("your")]), t(" "), zaln("H2", [w("Asherah")]), zaln("H3", [w("s")]), t(" "), zaln("H4", [w("poles")])] };
  const r2 = smartEditVerse(v2, "your Asherahs poles", "your {tall Asherahs} poles");
  assert(r2.plainText === "your {tall Asherahs} poles", `plainText exact (got ${JSON.stringify(r2.plainText)})`);
  const w2 = alignedWords(r2.content);
  assert(w2.find((x) => x.text === "Asherah")?.strongs.includes("H2") && w2.find((x) => x.text === "s")?.strongs.includes("H3"), "'Asherahs' (both milestones) stays aligned");
  assert(w2.find((x) => x.text === "tall")?.strongs.length === 0, "inserted 'tall' is unaligned");
}

// ─── Case 41: combined edit never LOSES text (self-check safety net) ───────────
// A gnarly one-shot insert+replace+delete+brackets must round-trip the typed
// text exactly — if smartRebuildRange can't, it falls back, never corrupts.
{
  console.log("\n[Case 41] Gnarly combined edit preserves text exactly (no loss)");
  const verse = {
    verseObjects: [zaln("H1", [w("alpha")]), t(" "), zaln("H2", [w("beta")]), t(" "), zaln("H3", [w("gamma")]), t(" "), zaln("H4", [w("delta")])],
  };
  // insert "X" before beta, replace gamma→GG, delete delta, wrap in brackets.
  const r = smartEditVerse(verse, "alpha beta gamma delta", "{alpha X beta GG}");
  assert(r.plainText === "{alpha X beta GG}", `text round-trips exactly (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content);
  assert(words.find((x) => x.text === "alpha")?.strongs.includes("H1"), "'alpha' keeps H1");
  assert(words.find((x) => x.text === "beta")?.strongs.includes("H2"), "'beta' keeps H2");
  assert(words.find((x) => x.text === "GG")?.strongs.length === 0, "replaced 'GG' is unaligned");
  assert(!words.some((x) => x.text === "delta"), "'delta' was deleted");
}

// Reusable: assert no \zaln milestone is left without a \w descendant.
function noEmptyMilestone(content) {
  const hasWord = (arr) => arr.some((n) => n && typeof n === "object" && ((n.type === "word" && n.tag === "w") || (Array.isArray(n.children) && hasWord(n.children))));
  const walk = (ns) => {
    for (const n of ns ?? []) {
      if (!n || typeof n !== "object") continue;
      if (n.tag === "zaln" && Array.isArray(n.children) && !hasWord(n.children)) return false;
      if (Array.isArray(n.children) && !walk(n.children)) return false;
    }
    return true;
  };
  return walk(content.verseObjects);
}

// ─── Case 42: deleting a word that shares a boundary letter doesn't shatter a neighbour ─
// "conceived again and" → delete "again": the minimal diff aliases on the shared
// 'a' of "again"/"and" and (pre-fix) split the untouched "and" into "a"+"nd"
// with "a" falsely aligned to "again"'s Hebrew. canonicalizePureDeletion slides
// the deletion to the whole-word boundary so "and" survives intact.
{
  console.log("\n[Case 42] Deleting a word doesn't split a boundary-sharing neighbour");
  const verse = {
    verseObjects: [zaln("H1", [w("conceived")]), t(" "), zaln("H2", [w("again")]), t(" "), zaln("H3", [w("and")])],
  };
  const r = smartEditVerse(verse, "conceived again and", "conceived and");
  assert(r.plainText === "conceived and", `plainText exact (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content);
  assert(!words.some((x) => x.text === "a" || x.text === "nd"), "no 'a'/'nd' fragments — 'and' stayed whole");
  assert(words.find((x) => x.text === "and")?.strongs.includes("H3"), "'and' keeps its OWN alignment (not 'again's H2)");
  assert(words.find((x) => x.text === "conceived")?.strongs.includes("H1"), "'conceived' keeps alignment");
  assert(!words.some((x) => x.text === "again"), "'again' was deleted");
  assert(noEmptyMilestone(r.content), "no empty \\zaln left by the deletion");
}

// ─── Case 43: replacing the only word of a word+punctuation milestone prunes the husk ─
// The ZEC 1:1 shape: a milestone wraps [w "saying", text ","]. Replacing "saying"
// lifts it out, leaving the milestone wrapping only ",". That wordless \zaln must
// be pruned (else usfm-js serializes a dangling \zaln-s…\*,\zaln-e\*).
{
  console.log("\n[Case 43] Replacing a milestone's only word prunes the wordless husk");
  const verse = {
    verseObjects: [zaln("H1", [w("good")]), t(" "), zaln("H2", [w("saying"), t(",")])],
  };
  const r = smartEditVerse(verse, "good saying,", "good speaking,");
  assert(r.plainText === "good speaking,", `plainText exact (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content);
  assert(words.find((x) => x.text === "good")?.strongs.includes("H1"), "'good' keeps alignment");
  assert(words.find((x) => x.text === "speaking")?.strongs.length === 0, "edited 'speaking' is unaligned");
  assert(noEmptyMilestone(r.content), "no wordless \\zaln husk around the trailing comma");
  assert(r.plainText.includes(","), "the trailing comma survives");
}

// ─── Cases 44-47: \qs (Selah) character wrapper — content, not a line marker ─
// usfm-js parses `\qs Selah\qs*` as a `type:"quote"` wrapper (so isInFlowMarker
// matches it) carrying an aligned \zaln milestone around \w "Selah", plus a
// trailing newline text node, and `endTag:"qs*"`. It holds verse CONTENT, not a
// line break — the real HAB 3:3/3:9/3:13 ULT shape. Build the fixture to match.
const qsWrap = (selahStrong = "H5542") => ({
  tag: "qs",
  type: "quote",
  nextChar: "\n",
  endTag: "qs*",
  children: [zaln(selahStrong, [w("Selah")]), t("\n")],
});

// ─── Case 44: editing ELSEWHERE in a \qs verse keeps "Selah" + its alignment ─
// The bug: extractEditableText emitted a literal "\qs" token and didn't surface
// the wrapped word, so the diff baseline lacked "Selah". An edit far from the
// Selah (comma→semicolon) then dropped the whole \qs wrapper.
{
  console.log("\n[Case 44] Edit elsewhere in a \\qs verse preserves Selah + alignment");
  const verse = {
    verseObjects: [zaln("H1", [w("Paran")]), t(", "), qsWrap(), zaln("H2", [w("His")])],
  };
  const baseline = extractEditableText(verse);
  assert(baseline.includes("Selah"), `baseline surfaces "Selah" (got ${JSON.stringify(baseline)})`);
  assert(!baseline.includes("\\qs"), "baseline has no literal \\qs token");
  const r = smartEditVerse(verse, baseline, baseline.replace(", ", "; "));
  const words = alignedWords(r.content);
  const selah = words.find((x) => x.text === "Selah");
  assert(!!selah, "'Selah' survives an edit elsewhere in the verse");
  assert(selah && selah.strongs.includes("H5542"), "'Selah' keeps its \\zaln alignment");
  assert(words.find((x) => x.text === "Paran")?.strongs.includes("H1"), "'Paran' stays aligned");
  assert(words.find((x) => x.text === "His")?.strongs.includes("H2"), "'His' stays aligned");
}

// ─── Case 45: a pure-marker edit in a \qs verse doesn't drop the \qs wrapper ─
// reconcileMarkers filtered out isInFlowMarker nodes; \qs is type:"quote" so it
// was dropped along with Selah. The wrapper must be kept as a content node.
{
  console.log("\n[Case 45] Marker edit in a \\qs verse keeps the \\qs wrapper");
  const verse = {
    verseObjects: [zaln("H1", [w("Paran")]), t(". "), qsWrap(), { type: "quote", tag: "q1" }, zaln("H2", [w("His")])],
  };
  const baseline = extractEditableText(verse);
  const r = smartEditVerse(verse, baseline, baseline.replace(" \\q1", "")); // delete the \q1 line marker
  const words = alignedWords(r.content);
  const selah = words.find((x) => x.text === "Selah");
  assert(!!selah, "'Selah' survives the marker edit");
  assert(selah && selah.strongs.includes("H5542"), "'Selah' keeps its \\zaln alignment");
  assert(words.find((x) => x.text === "His")?.strongs.includes("H2"), "'His' stays aligned");
}

// ─── Case 46: deleting "Selah" near \qs degrades gracefully (no whole-verse unalign) ─
{
  console.log("\n[Case 46] Deleting Selah only unaligns Selah, not the whole verse");
  const verse = {
    verseObjects: [zaln("H1", [w("Paran")]), t(". "), qsWrap(), zaln("H2", [w("His")])],
  };
  const baseline = extractEditableText(verse);
  const r = smartEditVerse(verse, baseline, baseline.replace("Selah ", ""));
  const words = alignedWords(r.content);
  assert(!words.some((x) => x.text === "Selah"), "'Selah' was deleted");
  assert(words.find((x) => x.text === "Paran")?.strongs.includes("H1"), "'Paran' stays aligned");
  assert(words.find((x) => x.text === "His")?.strongs.includes("H2"), "'His' stays aligned (no whole-verse unalign)");
  assert(noEmptyMilestone(r.content), "no wordless \\zaln husk left behind");
}

// ─── Case 47: unclosed legacy \qs (endTag:"") is still treated as content ─
// Older gatewayEdit emitted the wrapper without its close → `{tag:"qs",
// endTag:""}`. isCharacterWrapper matches the known tag defensively, so the
// wrapped word still surfaces and survives an edit elsewhere.
{
  console.log("\n[Case 47] Unclosed legacy \\qs (endTag:'') still surfaces its content");
  const verse = {
    verseObjects: [
      zaln("H1", [w("Paran")]),
      t(", "),
      { tag: "qs", type: "quote", endTag: "", children: [zaln("H5542", [w("Selah")]), t("\n")] },
      zaln("H2", [w("His")]),
    ],
  };
  const baseline = extractEditableText(verse);
  assert(baseline.includes("Selah"), `unclosed \\qs surfaces "Selah" (got ${JSON.stringify(baseline)})`);
  const r = smartEditVerse(verse, baseline, baseline.replace(", ", "; "));
  const selah = alignedWords(r.content).find((x) => x.text === "Selah");
  assert(!!selah, "'Selah' survives the edit");
  assert(selah && selah.strongs.includes("H5542"), "'Selah' keeps its alignment");
}

// Transplant detector: for the ORIGINAL verse, record the set of milestone
// strongs each aligned surface text ever sat under. A result \w is a TRANSPLANT
// iff its innermost milestone strong was never held by ANY aligned instance of
// that surface text originally — i.e. a fragment of one word is now rendered
// aligned to Hebrew it never belonged to. (The instance-LCS check is unreliable
// for duplicate words; this \zaln-tree check is the ground truth.)
function transplantStrongsBySurface(content) {
  const map = new Map();
  const walk = (nodes, strongs) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "word" && n.tag === "w" && strongs.length > 0) {
        const set = map.get(n.text) ?? new Set();
        for (const s of strongs) set.add(s);
        map.set(n.text, set);
      }
      if (Array.isArray(n.children)) walk(n.children, n.tag === "zaln" && n.strong ? [...strongs, n.strong] : strongs);
    }
  };
  walk(content.verseObjects, []);
  return map;
}
function transplants(origContent, resultContent) {
  const orig = transplantStrongsBySurface(origContent);
  const out = [];
  for (const wd of alignedWords(resultContent)) {
    if (wd.strongs.length === 0) continue;
    const innermost = wd.strongs[wd.strongs.length - 1];
    const set = orig.get(wd.text);
    if (!set || !set.has(innermost)) out.push({ text: wd.text, strong: innermost });
  }
  return out;
}

// ─── Case 48: swapping two boundary-sharing words never transplants Hebrew ─────
// HOS 7:3 UST shape: swap 'their'/'the' (they share the prefix "the"). The
// minimal diff cut mid-"their", so localizedRewriteVerse split that milestone and
// left "the" inside 'their'/'king's Hebrew (the article showing the Hebrew for
// "king"). snapReplacementToWordBoundaries widens the mid-word replacement to
// whole words so the reordered words go BARE — never onto foreign Hebrew.
{
  console.log("\n[Case 48] Swapping two boundary-sharing words: no Hebrew transplant");
  const verse = {
    verseObjects: [
      zaln("Htheir", [w("their")]), t(" "),
      zaln("Hking", [w("king")]), t(" "),
      zaln("Hthe", [w("the")]), t(" "),
      zaln("Hpeople", [w("people")]),
    ],
  };
  const r = smartEditVerse(verse, "their king the people", "the king their people");
  assert(r.plainText === "the king their people", `plainText exact (got ${JSON.stringify(r.plainText)})`);
  const tp = transplants(verse, r.content);
  assert(tp.length === 0, `no \\w aligned to foreign Hebrew (got ${JSON.stringify(tp)})`);
  const words = alignedWords(r.content);
  // The unmoved 'people' keeps its own alignment; reordered 'the'/'their' go bare.
  assert(words.find((x) => x.text === "people")?.strongs.includes("Hpeople"), "unmoved 'people' keeps alignment");
  assert(!words.some((x) => x.text === "the" && x.strongs.includes("Htheir")), "'the' is NOT transplanted onto 'their's Hebrew");
}

// ─── Case 49: affix-overlap swap (net/dragnet) never transplants Hebrew ────────
// HAB 1:16 ULT shape: 'net' is a suffix of 'dragnet'. Swapping them diffs across
// the shared "net", so the trailing fragment 'net' used to survive inside
// 'dragnet's milestone (l:H4365a). Whole-word snapping drops both milestones.
{
  console.log("\n[Case 49] Affix-overlap swap (net/dragnet): no Hebrew transplant");
  const verse = {
    verseObjects: [
      zaln("Hnet", [w("net")]), t(" "),
      zaln("Hand", [w("and")]), t(" "),
      zaln("Hdragnet", [w("dragnet")]),
    ],
  };
  const r = smartEditVerse(verse, "net and dragnet", "dragnet and net");
  assert(r.plainText === "dragnet and net", `plainText exact (got ${JSON.stringify(r.plainText)})`);
  const tp = transplants(verse, r.content);
  assert(tp.length === 0, `no \\w aligned to foreign Hebrew (got ${JSON.stringify(tp)})`);
  assert(!alignedWords(r.content).some((x) => x.text === "net" && x.strongs.includes("Hdragnet")), "'net' is NOT transplanted onto 'dragnet's Hebrew");
}

// ─── Case 50: single-word mid-word edits still keep their OWN alignment ────────
// Guard that the swap snap is scoped to MULTI-word replacements: a Case-5 / Case-27
// style single-word edit must still keep its fragments aligned to that word's own
// Hebrew (no over-eager widening that unaligns a legitimate in-word edit).
{
  console.log("\n[Case 50] Single-word mid-word edits keep their own alignment (snap is a no-op)");
  // Case-27 shape: "that" → "th at" inside nested \zaln-s — the split fragments
  // are NEW surface texts, so they legitimately inherit "that"'s OWN Hebrew (H1,H2).
  // This is the protected case the swap snap must NOT break: a single-word in-word
  // edit keeps its own alignment rather than going bare.
  const r1 = smartEditVerse(makeNested(), "on that day.", "on th at day.");
  const w1 = alignedWords(r1.content);
  assert(w1.find((x) => x.text === "th")?.strongs.join() === "H1,H2", "split 'th' keeps its OWN nested ancestors (not foreign)");
  assert(w1.find((x) => x.text === "at")?.strongs.join() === "H1,H2", "split 'at' keeps its OWN nested ancestors (not foreign)");
  assert(w1.find((x) => x.text === "on")?.strongs.join() === "H1,H2", "unmoved 'on' keeps both ancestors");
  // Case-5 shape: single-word replace "that" → "this" — edited word lifts, 'day' stays.
  const flat = { verseObjects: [zaln("H2", [w("on"), t(" "), w("that"), t(" "), w("day")]), t(".")] };
  const r2 = smartEditVerse(flat, "on that day.", "on this day.");
  const tp2 = transplants(flat, r2.content);
  assert(tp2.length === 0, `single-word replace makes no transplant (got ${JSON.stringify(tp2)})`);
  assert(alignedWords(r2.content).find((x) => x.text === "day")?.strongs.includes("H2"), "unchanged 'day' keeps alignment");
}

// ─── Case 51: insert a bare word before a marker, next to a boundary- ─────
// sharing milestone word — the neighbour must NOT be corrupted (HAB 1:12/3:1).
{
  console.log("\n[Case 51] Insert bare word before a marker: neighbour word not corrupted");
  // Shape mirrors HAB 1:12 UST: a leading milestone whose text carries a `\n`
  // (so raw whitespace width diverges from the normalized editable baseline),
  // then "...times. \q2 You...". The earlier `\n` is what shifted the raw
  // offset and split "times" into "time"+"s" onto the inserted word.
  const q2 = { type: "quote", tag: "q2" };
  const verse = {
    verseObjects: [
      zaln("H1", [t("\n"), w("from")]),
      t(" "),
      zaln("H6924a", [w("times")]),
      t(". "),
      q2,
      t(" "),
      zaln("H859", [w("You")]),
    ],
  };
  const oldPlain = extractEditableText(verse);
  // Insert " NEWB" immediately after "times", before the period.
  const idx = oldPlain.indexOf("times") + "times".length;
  const newPlain = oldPlain.slice(0, idx) + " NEWB" + oldPlain.slice(idx);
  const r = smartEditVerse(verse, oldPlain, newPlain);
  const words = alignedWords(r.content);
  const texts = words.map((x) => x.text);
  assert(texts.includes("times"), `'times' survives intact (got ${JSON.stringify(texts)})`);
  assert(!texts.includes("time"), "'times' is NOT corrupted to 'time'");
  const times = words.find((x) => x.text === "times");
  assert(times && times.strongs.includes("H6924a"), "'times' keeps its milestone alignment");
  const newb = words.find((x) => x.text === "NEWB");
  assert(newb && newb.strongs.length === 0, "inserted 'NEWB' is a bare unaligned word");
  // 's' must NOT have migrated onto NEWB.
  assert(!texts.includes("s"), "no stray 's' fragment migrated off 'times'");
}

// ─── Case 52: punctuation-only re-punctuation between unchanged words ─────
// keeps every survivor aligned even when the diff edge lands mid-gap (HOS 1:1).
{
  console.log("\n[Case 52] Punct-only edit between unchanged words: survivors stay aligned");
  // "Uzziah, Jotham, Ahaz," — re-punctuated to "(Uzziah); Jotham — Ahaz," —
  // the diff stops after the comma following "Jotham" (mid the ", " text node),
  // which used to drop to localizedRewrite and unalign the untouched names.
  const verse = {
    verseObjects: [
      zaln("H1", [w("Uzziah")]),
      t(", "),
      zaln("H2", [w("Jotham")]),
      t(", "),
      zaln("H3", [w("Ahaz")]),
      t(","),
    ],
  };
  const oldPlain = extractEditableText(verse); // "Uzziah, Jotham, Ahaz,"
  const newPlain = "(Uzziah); Jotham — Ahaz,";
  const r = smartEditVerse(verse, oldPlain, newPlain);
  assert(r.plainText === "(Uzziah); Jotham — Ahaz,", `plainText exact (got ${JSON.stringify(r.plainText)})`);
  assert(r.preservedAlignment === true, "preservedAlignment stays true");
  const words = alignedWords(r.content);
  for (const [name, strong] of [["Uzziah", "H1"], ["Jotham", "H2"], ["Ahaz", "H3"]]) {
    const found = words.find((x) => x.text === name);
    assert(found && found.strongs.includes(strong), `unchanged '${name}' keeps alignment ${strong}`);
  }
}

// ─── Case 53: combined wrap+insert whose range SPANS a \q keeps survivors ──────
// The HAB 3:17 ULT bug: a single save wraps the whole verse in {} AND inserts a
// word, so the bounding edit range crosses inline \q line breaks. rangeIsClean
// used to bail on ANY in-range marker → localizedRewriteVerse re-tokenized the
// whole marker-spanning box UNALIGNED, flattening unchanged survivors at the
// edges (47 aligned → 0). The marker-aware smartRebuildRange now passes inert
// line-break markers through and keeps survivors on BOTH sides aligned.
{
  console.log("\n[Case 53] Wrap+insert spanning a \\q keeps survivors on both sides aligned");
  const q = (tag) => ({ type: "quote", tag });
  const verse = {
    verseObjects: [
      zaln("H1", [w("alpha")]), t(" "), zaln("H2", [w("beta")]), t(",\n"), q("q1"),
      zaln("H3", [w("gamma")]), t(" "), zaln("H4", [w("delta")]),
    ],
  };
  const old = extractEditableText(verse); // "alpha beta,\q1 gamma delta"
  // Insert "X" after alpha AND wrap the whole verse in {} in one save — the
  // bounding range crosses the \q1.
  const newPlain = "{alpha X beta, \\q1 gamma delta}";
  const r = smartEditVerse(verse, old, newPlain);
  assert(r.plainText === "{alpha X beta, gamma delta}", `plainText exact (got ${JSON.stringify(r.plainText)})`);
  const words = alignedWords(r.content);
  // Survivors on the LEFT side of the marker keep alignment.
  assert(words.find((x) => x.text === "alpha")?.strongs.includes("H1"), "left survivor 'alpha' keeps H1");
  assert(words.find((x) => x.text === "beta")?.strongs.includes("H2"), "left survivor 'beta' keeps H2");
  // Survivors on the RIGHT side of the marker keep alignment.
  assert(words.find((x) => x.text === "gamma")?.strongs.includes("H3"), "right survivor 'gamma' keeps H3");
  assert(words.find((x) => x.text === "delta")?.strongs.includes("H4"), "right survivor 'delta' keeps H4");
  assert(words.find((x) => x.text === "X")?.strongs.length === 0, "inserted 'X' is unaligned");
  // The \q1 marker survived.
  assert(r.content.verseObjects.some((n) => n.type === "quote" && n.tag === "q1"), "the \\q1 marker survives the edit");
}

// ─── Case 54: a trailing comma before a \q stays BEFORE the marker ─────────────
// The fidelity guard from the reverted naive fix: smartRebuildRange's gap re-lay
// attaches an inter-word gap as the FOLLOWING word's leading text, which trapped
// a trailing comma INSIDE the next milestone AFTER the marker (`beta \q1 ,`
// instead of `beta, \q1`). Moving a comma across a line break is a CONTENT change
// the project guards against (Cases 21/22). The marker-aware split emits the
// CLOSING run as a bare text node BEFORE the marker, never inside a milestone.
{
  console.log("\n[Case 54] Trailing comma before a \\q stays before the marker (not trapped)");
  const q = (tag) => ({ type: "quote", tag });
  const verse = {
    verseObjects: [
      zaln("H1", [w("alpha")]), t(" "), zaln("H2", [w("beta")]), t(",\n"), q("q1"),
      zaln("H3", [w("gamma")]),
    ],
  };
  const old = extractEditableText(verse); // "alpha beta,\q1 gamma"
  const r = smartEditVerse(verse, old, "{alpha X beta, \\q1 gamma}");
  const vos = r.content.verseObjects;
  const qi = vos.findIndex((n) => n.type === "quote" && n.tag === "q1");
  assert(qi >= 0, "the \\q1 marker is present");
  // The node immediately before the marker (skipping nothing) is a bare text
  // node carrying the comma — the comma is NOT inside the following milestone.
  const prev = vos[qi - 1];
  assert(prev && prev.type === "text" && prev.text.includes(","), `comma is a bare text node right before the marker (prev ${JSON.stringify(prev)})`);
  // The milestone AFTER the marker (gamma) must NOT start with the comma.
  const after = vos[qi + 1];
  const afterFirstText = after && Array.isArray(after.children) ? after.children.find((c) => c.type === "text") : null;
  assert(!afterFirstText || !afterFirstText.text.includes(","), "the comma is NOT trapped inside the following milestone");
  assert(alignedWords(r.content).find((x) => x.text === "gamma")?.strongs.includes("H3"), "'gamma' keeps alignment");
}

// ─── Case 55: opening punctuation after a \q stays AFTER the marker ────────────
// Counterpart to Case 54 / Case 22: an em-dash that OPENS the next poetic line
// (`companion” \q1 —the`) leads the new line, so it must stay AFTER the marker.
// The CLOSING split skips whitespace + closing punctuation only; the leading dash
// stays in the remainder that leads the next word, after the marker.
{
  console.log("\n[Case 55] Opening punctuation after a \\q stays after the marker");
  const q = (tag) => ({ type: "quote", tag });
  const verse = {
    verseObjects: [
      zaln("H1", [w("companion")]), t("”\n"), q("q1"),
      t("—"), zaln("H2", [w("the")]), t(" "), zaln("H3", [w("word")]),
    ],
  };
  const old = extractEditableText(verse); // "companion”\q1 —the word"
  // Wrap + insert spanning the marker.
  const r = smartEditVerse(verse, old, "{companion” \\q1 —the great word}");
  const vos = r.content.verseObjects;
  const qi = vos.findIndex((n) => n.type === "quote" && n.tag === "q1");
  assert(qi >= 0, "the \\q1 marker is present");
  // The closing curly quote stays BEFORE the marker.
  const quoteBefore = vos.slice(0, qi).some((n) => n.type === "text" && n.text.includes("”"));
  assert(quoteBefore, "closing quote ” stays before the marker");
  // The opening em-dash stays AFTER the marker (as a bare text node OR as the
  // leading text of the next milestone — either way it leads the new line). It
  // must NOT have leaked before the marker.
  const dashBeforeMarker = vos.slice(0, qi).some(
    (n) => (n.type === "text" && n.text.includes("—")) ||
           (Array.isArray(n.children) && n.children.some((c) => c.type === "text" && c.text.includes("—"))),
  );
  assert(!dashBeforeMarker, "em-dash did NOT leak before the marker");
  const dashAfterMarker = vos.slice(qi + 1).some(
    (n) => (n.type === "text" && n.text.includes("—")) ||
           (Array.isArray(n.children) && n.children.some((c) => c.type === "text" && c.text.includes("—"))),
  );
  assert(dashAfterMarker, "em-dash stays AFTER the marker (leading the new line)");
  assert(alignedWords(r.content).find((x) => x.text === "companion")?.strongs.includes("H1"), "'companion' keeps alignment");
  assert(alignedWords(r.content).find((x) => x.text === "word")?.strongs.includes("H3"), "'word' keeps alignment");
}

// --- Case 55b: a word edit that ALSO adds a line-ending em-dash keeps the dash
// before the marker -----------------------------------------------------------
// The reported prod class (em-dash typed at the end of a poetic line), but here
// combined with a word change so it routes through the diff tier (smartReplace-
// Verse) rather than the pure-punctuation relayout of Case 22b. Typing the dash
// changes the marker's adjacent punctuation, flipping markerSignature ->
// markersChanged, so Step 2 reconcileMarkers (which honors the typed position,
// #240) owns the placement and keeps the dash on the line it was typed.
{
  console.log("\n[Case 55b] Word edit + line-ending em-dash keeps the dash before the marker");
  const q = (tag) => ({ type: "quote", tag });
  const verse = {
    verseObjects: [
      zaln("H1", [w("the")]), t(" "), zaln("H2", [w("city")]), t("\n"), q("q2"),
      zaln("H3", [w("and")]), t(" "), zaln("H4", [w("wisdom")]),
    ],
  };
  const old = extractEditableText(verse); // "the city \q2 and wisdom"
  // Change "city"->"town" AND append an em-dash at the end of the \q1 line.
  const r = smartEditVerse(verse, old, old.replace("city", "town—"));
  const vos = r.content.verseObjects;
  const qi = vos.findIndex((n) => n.type === "quote" && n.tag === "q2");
  assert(qi >= 0, "the \\q2 marker is present");
  const hasDash = (arr) => arr.some((n) => (n.type === "text" && n.text.includes("—")) || (Array.isArray(n.children) && n.children.some((c) => c.type === "text" && c.text.includes("—"))));
  assert(hasDash(vos.slice(0, qi)) && !hasDash(vos.slice(qi + 1)), `em-dash stays BEFORE the \\q2 marker, on the line it was typed (raw ${JSON.stringify(r.plainText)})`);
  assert(alignedWords(r.content).find((x) => x.text === "and")?.strongs.includes("H3"), "'and' keeps its alignment");
  assert(alignedWords(r.content).find((x) => x.text === "wisdom")?.strongs.includes("H4"), "'wisdom' keeps its alignment");
}

// ─── Case 56: deleting a clause-final word doesn't push its punctuation across a \q ─
// HOS 8:3 shape: a milestone wraps [w "good", text ";"] right before a \q line
// break. Deleting "good" empties that milestone; the leftover ";" must stay a
// bare text node BEFORE the \q (on the previous line), not be wedged after it.
// (Pruning the wordless milestone BEFORE reconcileMarkers is what enables its
// closing-punctuation rule to keep the ";" put — the ZEC 6:12 corruption class.)
{
  console.log("\n[Case 56] Deleting a clause-final word keeps its punctuation before the \\q");
  const q = (tag) => ({ type: "quote", tag });
  const verse = {
    verseObjects: [zaln("H1", [w("rejected")]), t(" "), zaln("H2", [w("good"), t(";")]), t("\n"), q("q2"), zaln("H3", [w("enemy")])],
  };
  const old = extractEditableText(verse);
  const r = smartEditVerse(verse, old, old.replace("good", "").replace(/\s+;/, ";"));
  const vos = r.content.verseObjects;
  const qi = vos.findIndex((n) => n.type === "quote" && n.tag === "q2");
  assert(qi >= 0, "the \\q2 marker survives");
  const semiBefore = vos.slice(0, qi).some((n) => n.type === "text" && n.text.includes(";"));
  const semiAfter = vos.slice(qi + 1).some((n) => n.type === "text" && typeof n.text === "string" && n.text.trimStart().startsWith(";"));
  assert(semiBefore && !semiAfter, "';' stays BEFORE the \\q2 (not pushed onto the next line)");
  assert(!vos.some((n) => n.text === "good") && !alignedWords(r.content).some((x) => x.text === "good"), "'good' was deleted");
  assert(alignedWords(r.content).find((x) => x.text === "enemy")?.strongs.includes("H3"), "'enemy' keeps alignment");
  assert(noEmptyMilestone(r.content), "no empty \\zaln left behind");
}

// ─── Case 57: a \qs wrapper carrying its OWN text survives an unrelated edit ───
// usfm-js's shape for a bare `\qs Selah\qs*` (no inner \zaln) puts "Selah" on the
// wrapper node's `text`. liftMarkerText (run before every edit) must NOT lift it
// out — doing so moves "Selah" OUTSIDE the \qs…\qs* wrapper (`\qs\qs* Selah`),
// corrupting the structure on the next save. Reviewer-reported; complements the
// children-shape \qs coverage in Cases 44–47.
{
  console.log("\n[Case 57] Direct-text \\qs wrapper keeps its content inside the wrapper");
  const verse = {
    verseObjects: [
      zaln("H1", [w("Praise")]), t(". "),
      { type: "quote", tag: "qs", endTag: "qs\\*", text: "Selah" },
      t("\n"), { type: "quote", tag: "q1" },
    ],
  };
  const old = extractEditableText(verse);
  const r = smartEditVerse(verse, old, old.replace("Praise", "Praises")); // unrelated edit, far from \qs
  const qs = r.content.verseObjects.find((n) => n.tag === "qs");
  assert(qs && qs.text === "Selah", "the \\qs node still carries its 'Selah' text (not lifted out)");
  assert(!r.content.verseObjects.some((n) => n.type === "text" && n.text === "Selah"), "'Selah' was NOT lifted to a bare sibling outside the wrapper");
  assert(r.plainText.includes("Selah"), "'Selah' survives in the text");
}

// ─── Case 58: opening + closing quotes added at the verse EDGES keep alignment ─
// ZEC 7:14: the user wraps a whole prose verse in single quotes — `‘` before the
// first word AND `’` before the verse-final `”`. Two disjoint punctuation
// insertions at opposite ends collapse via diffSingleChange into ONE bounding
// change spanning the whole verse, whose right edge lands mid trailing-punct
// leaf. That failed the boundary gate on every preserve/relayout/rebuild tier,
// so it dropped to localizedRewriteVerse and flattened ALL milestones (16→0 in
// prod). The pure-punctuation whole-verse relayout must keep every milestone.
{
  console.log("\n[Case 58] Opening + closing quotes at the verse edges keep all alignment");
  const verse = {
    verseObjects: [
      zaln("H1", [w("For")]), t(" "),
      zaln("H2", [w("I"), t(" "), w("will"), t(" "), w("scatter")]), t(" "),
      zaln("H3", [w("them")]), t(".”\n\n"),
    ],
  };
  const old = extractEditableText(verse); // "For I will scatter them.”"
  const next = ("‘" + old).replace(/\.”/, ".’”"); // ‘…scatter them.’”
  const r = smartEditVerse(verse, old, next);
  assert(r.preservedAlignment === true, "alignment is reported preserved");
  assert(alignedWords(r.content).length === 5, `all 5 \\w survive (got ${alignedWords(r.content).length})`);
  const ms = (n) => (JSON.stringify(n).match(/"milestone"/g) || []).length;
  assert(ms(r.content) === 3, `all 3 milestones survive (got ${ms(r.content)})`);
  assert(r.plainText === "‘For I will scatter them.’”", `text exact (got ${JSON.stringify(r.plainText)})`);
  // The opening quote lands OUTSIDE the first milestone, top level (uW form
  // `\v N “\zaln-s …`), not buried inside the first \zaln.
  const vos = r.content.verseObjects;
  assert(vos[0]?.type === "text" && vos[0].text === "‘", "opening quote is a top-level text node before the first milestone");
  assert(vos[1]?.type === "milestone", "the first milestone immediately follows the opening quote");
  // Structural trailing whitespace (the \n\n before the next verse) is kept.
  assert(JSON.stringify(r.content.verseObjects).includes(".’”\\n\\n"), "trailing \\n\\n structural whitespace is preserved");
}

// ─── Case 59: edge quotes on a verse with a TRAILING marker keep alignment ────
// ZEC 8:3: a prose verse aligned with a verse-final `\q1` line break, wrapped in
// `‘…!’`. The marker is purely TRAILING (no word after it), so the relayout
// must still fire — the old "bail on ANY marker" gate left this at a partial
// unalign (17→3 in prod). Step 2 reconcileMarkers keeps the closing `’` and the
// `\q1` in place. (An INTERIOR marker now also relays — Cases 60/61 — with
// Step 2 reconcileMarkers re-placing the marker.)
{
  console.log("\n[Case 59] Edge quotes on a verse with a trailing \\q1 keep all alignment");
  const verse = {
    verseObjects: [
      zaln("H1", [w("Yahweh"), t(" "), w("says")]), t(" "),
      zaln("H2", [w("this")]), t(": "),
      zaln("H3", [w("I"), t(" "), w("return")]), t("!\n\n"),
      { type: "quote", tag: "q1" },
    ],
  };
  const old = extractEditableText(verse); // "Yahweh says this: I return! \q1"
  const next = old.replace("this: I", "this: ‘I").replace("return!", "return!’");
  const r = smartEditVerse(verse, old, next);
  assert(r.preservedAlignment === true, "alignment reported preserved");
  assert(milestoneCount(r.content) === 3, `all 3 milestones survive (got ${milestoneCount(r.content)})`);
  assert(alignedWords(r.content).find((x) => x.text === "return")?.strongs.includes("H3"), "'return' keeps alignment");
  // plainText (rebuildRaw) excludes markers by design; the editable view surfaces them.
  assert(extractEditableText(r.content) === "Yahweh says this: ‘I return!’ \\q1", `editable text exact incl. trailing marker (got ${JSON.stringify(extractEditableText(r.content))})`);
  // The trailing \q1 stays AFTER the closing quote, last node in the verse.
  const vos = r.content.verseObjects;
  assert(vos[vos.length - 1]?.type === "quote" && vos[vos.length - 1]?.tag === "q1", "the \\q1 marker survives as the final node");
}

// ─── Case 60: an INTERIOR marker relays, reconcile keeps the quote on its side ─
// A marker with words on BOTH sides can have a gap that spans it. The whole-verse
// relayout now fires anyway (it gets the marker-STRIPPED text right); the typed
// `“` lands before the marker in the relayout, but forced Step 2 reconcileMarkers
// re-places the marker so the opening quote stays AFTER it (CLOSING rule). The
// alternative — bailing to the diff path — flattened verses dense with interior
// markers (HOS 9:17, Case 61).
{
  console.log("\n[Case 60] Edge quote on a verse with an INTERIOR marker doesn't pop the quote");
  const verse = {
    verseObjects: [
      zaln("H1", [w("he")]), t(" "), zaln("H2", [w("said")]), t(": "),
      { type: "quote", tag: "q1" },
      zaln("H3", [w("Come")]), t("!"),
    ],
  };
  const old = extractEditableText(verse); // "he said: \q1 Come!"
  const r = smartEditVerse(verse, old, old.replace("\\q1 Come", '\\q1 “Come'));
  const vos = r.content.verseObjects;
  const qi = vos.findIndex((n) => n.type === "quote");
  const quoteBeforeMarker = vos.slice(0, qi).some((n) => n.type === "text" && n.text.includes("“"));
  assert(!quoteBeforeMarker, "the typed quote did NOT pop in front of the marker");
  assert(alignedWords(r.content).find((x) => x.text === "Come")?.strongs.includes("H3"), "'Come' keeps alignment");
}

// ─── Case 61: HOS 9:17 — edge quotes on a verse dense with INTERIOR markers ───
// The reported bug: putting quotes around HOS 9:17 UST (a poetic verse threaded
// with \q2/\q2/\q1 between words) unaligned the WHOLE verse. The old gate bailed
// the relayout on the first interior marker → localizedRewrite flattened every
// \zaln. The relayout now fires across all the markers; Step 2 reconcileMarkers
// re-places each one. All milestones must survive and the markers stay put.
{
  console.log("\n[Case 61] HOS 9:17: edge quotes with multiple interior markers keep all alignment");
  const verse = {
    verseObjects: [
      zaln("H1", [w("Hosea"), t(" "), w("says")]), t(","),
      { type: "quote", tag: "q2" },
      zaln("H2", [w("The"), t(" "), w("God")]), t(" "),
      zaln("H3", [w("will"), t(" "), w("reject"), t(" "), w("them")]), t("."),
      { type: "quote", tag: "q1" },
      zaln("H4", [w("They"), t(" "), w("wander")]), t("."),
    ],
  };
  const before = extractEditableText(verse); // "Hosea says, \q2 The God will reject them. \q1 They wander."
  const after = "“" + before + "”";
  const r = smartEditVerse(verse, before, after);
  assert(r.preservedAlignment, "alignment reported preserved");
  const ms = alignedWords(r.content);
  assert(ms.length === 9, `all 9 \\w survive (got ${ms.length})`);
  assert(ms.find((x) => x.text === "reject")?.strongs.includes("H3"), "'reject' keeps its H3 alignment");
  assert(ms.find((x) => x.text === "wander")?.strongs.includes("H4"), "'wander' keeps its H4 alignment");
  const markers = r.content.verseObjects.filter((n) => n.type === "quote");
  assert(markers.length === 2, `both interior markers survive (got ${markers.length})`);
  // Round-trip: the editable text re-extracted from the result (which re-
  // synthesizes marker-adjacent spacing) must equal what the user typed.
  assert(extractEditableText(r.content) === after,
    `round-trips to the typed text (got ${JSON.stringify(extractEditableText(r.content))})`);
}

// ─── Real-corpus fixtures (parsed from en_ult@e2418e7221 via usfm-js, then ───
// slimmed to the fields the engine reads). NOT hand-fabricated alignment trees:
// these are the verbatim parse of the pre-export DCS baseline that the NUM 24
// alignment-loss investigation traced. Provenance + extraction probe documented
// in the PR; re-derive with usfm.toJSON on 04-NUM.usfm / 13-1CH.usfm.

// 1CH 4:21 — a long genealogy: 33/33 aligned, "of" ×7, "the" ×6, comma-separated
// clauses. The shape the 1CH 4:21 prod report covered (current engine preserves
// 32/33; only the actually-edited word unaligns).
const CH1_4_21 = () => ({"verseObjects":[{"type":"milestone","tag":"zaln","strong":"H1121a","lemma":"בֵּן","morph":"He,Ncmpc","occurrence":"1","occurrences":"1","content":"בְּנֵי֙","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"The","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"sons","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"of","occurrence":"1","occurrences":"7"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"H7956","lemma":"שֵׁלָה","morph":"He,Np","occurrence":"1","occurrences":"1","content":"שֵׁלָ֣ה","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"Shelah","occurrence":"1","occurrences":"1"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"H1121a","lemma":"בֵּן","morph":"He,Ncmsc","occurrence":"1","occurrences":"1","content":"בֶן","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"the","occurrence":"1","occurrences":"6"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"son","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"of","occurrence":"2","occurrences":"7"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"H3063","lemma":"יְהוּדָה","morph":"He,Np","occurrence":"1","occurrences":"1","content":"יְהוּדָ֔ה","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"Judah","occurrence":"1","occurrences":"1"}]},{"type":"text","text":": "},{"type":"milestone","tag":"zaln","strong":"H6147","lemma":"עֵר","morph":"He,Np","occurrence":"1","occurrences":"1","content":"עֵ֚ר","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"Er","occurrence":"1","occurrences":"1"}]},{"type":"text","text":", "},{"type":"milestone","tag":"zaln","strong":"H0001","lemma":"אָב","morph":"He,Ncmsc","occurrence":"1","occurrences":"2","content":"אֲבִ֣י","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"the","occurrence":"2","occurrences":"6"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"father","occurrence":"1","occurrences":"2"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"of","occurrence":"3","occurrences":"7"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"H3922","lemma":"לֵכָה","morph":"He,Np","occurrence":"1","occurrences":"1","content":"לֵכָ֔ה","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"Lekah","occurrence":"1","occurrences":"1"}]},{"type":"text","text":", "},{"type":"milestone","tag":"zaln","strong":"c:H3935","lemma":"לַעְדָּה","morph":"He,C:Np","occurrence":"1","occurrences":"1","content":"וְ⁠לַעְדָּ֖ה","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"and","occurrence":"1","occurrences":"2"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"Laadah","occurrence":"1","occurrences":"1"}]},{"type":"text","text":", "},{"type":"milestone","tag":"zaln","strong":"H0001","lemma":"אָב","morph":"He,Ncmsc","occurrence":"2","occurrences":"2","content":"אֲבִ֣י","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"the","occurrence":"3","occurrences":"6"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"father","occurrence":"2","occurrences":"2"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"of","occurrence":"4","occurrences":"7"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"H4762","lemma":"מַרְאֵשָׁה","morph":"He,Np","occurrence":"1","occurrences":"1","content":"מָרֵשָׁ֑ה","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"Mareshah","occurrence":"1","occurrences":"1"}]},{"type":"text","text":", "},{"type":"milestone","tag":"zaln","strong":"c:H4940","lemma":"מִשְׁפָּחָה","morph":"He,C:Ncfpc","occurrence":"1","occurrences":"1","content":"וּ⁠מִשְׁפְּח֛וֹת","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"and","occurrence":"2","occurrences":"2"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"the","occurrence":"4","occurrences":"6"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"clans","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"of","occurrence":"5","occurrences":"7"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"H1004b","lemma":"בַּיִת","morph":"He,Ncmsc","occurrence":"1","occurrences":"1","content":"בֵּית","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"the","occurrence":"5","occurrences":"6"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"house","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"of","occurrence":"6","occurrences":"7"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"H5656","lemma":"עֲבֹדָה","morph":"He,Ncfsc","occurrence":"1","occurrences":"1","content":"עֲבֹדַ֥ת","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"the","occurrence":"6","occurrences":"6"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"service","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"of","occurrence":"7","occurrences":"7"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"d:H0948","lemma":"בּוּץ","morph":"He,Td:Ncmsa","occurrence":"1","occurrences":"1","content":"הַ⁠בֻּ֖ץ","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"linen","occurrence":"1","occurrences":"1"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"l:H1004b","lemma":"בַּיִת","morph":"He,R:Ncmsc","occurrence":"1","occurrences":"1","content":"לְ⁠בֵ֥ית","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"at","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"Beth","occurrence":"1","occurrences":"1"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"H0791","lemma":"אַשְׁבֵּעַ","morph":"He,Np","occurrence":"1","occurrences":"1","content":"אַשְׁבֵּֽעַ","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"Ashbea","occurrence":"1","occurrences":"1"}]},{"type":"text","text":" \n"}]});

// NUM 24:8 — 35/35 aligned; interleaved with \q1/\q2 line markers. The prod
// edit was a heavy multi-clause rewrite (eat→devour, break→crush, strike→
// shatter, + reordering). The current engine SHOULD keep every untouched word
// aligned and only unalign the words that genuinely changed.
const NUM_24_8 = () => ({"verseObjects":[{"type":"milestone","tag":"zaln","strong":"H0410","lemma":"אֵל","morph":"He,Ncmsa","occurrence":"1","occurrences":"1","content":"אֵ֚ל","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"God","occurrence":"1","occurrences":"1"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"H3318","lemma":"יָצָא","morph":"He,Vhrmsc:Sp3ms","occurrence":"1","occurrences":"1","content":"מוֹצִיא֣⁠וֹ","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"is","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"bringing","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"him","occurrence":"1","occurrences":"2"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"out","occurrence":"1","occurrences":"1"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"m:H4714","lemma":"מִצְרַיִם","morph":"He,R:Np","occurrence":"1","occurrences":"1","content":"מִ⁠מִּצְרַ֔יִם","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"from","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"Egypt","occurrence":"1","occurrences":"1"}]},{"type":"text","text":",\n"},{"type":"quote","tag":"q1"},{"type":"milestone","tag":"zaln","strong":"k:H8443","lemma":"תּוֹעָפָה","morph":"He,R:Ncfpc","occurrence":"1","occurrences":"1","content":"כְּ⁠תוֹעֲפֹ֥ת","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"like","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"the","occurrence":"1","occurrences":"2"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"horns","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"of","occurrence":"1","occurrences":"1"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"H7214","lemma":"רְאֵם","morph":"He,Ncmsa","occurrence":"1","occurrences":"1","content":"רְאֵ֖ם","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"a","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"wild","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"ox","occurrence":"1","occurrences":"1"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"l","lemma":"","morph":"He,R:Sp3ms","occurrence":"1","occurrences":"1","content":"ל֑⁠וֹ","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"for","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"him","occurrence":"2","occurrences":"2"}]},{"type":"text","text":".\n"},{"type":"quote","tag":"q2"},{"type":"milestone","tag":"zaln","strong":"H0398","lemma":"אָכַל","morph":"He,Vqi3ms","occurrence":"1","occurrences":"1","content":"יֹאכַ֞ל","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"He","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"will","occurrence":"1","occurrences":"3"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"eat","occurrence":"1","occurrences":"1"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"H1471a","lemma":"גּוֹי","morph":"He,Ncmpa","occurrence":"1","occurrences":"1","content":"גּוֹיִ֣ם","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"the","occurrence":"2","occurrences":"2"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"nations","occurrence":"1","occurrences":"1"}]},{"type":"text","text":", "},{"type":"milestone","tag":"zaln","strong":"H6862c","lemma":"צַר","morph":"He,Ncmpc:Sp3ms","occurrence":"1","occurrences":"1","content":"צָרָ֗י⁠ו","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"his","occurrence":"1","occurrences":"2"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"enemies","occurrence":"1","occurrences":"1"}]},{"type":"text","text":".\n"},{"type":"quote","tag":"q2"},{"type":"milestone","tag":"zaln","strong":"c:H6106","lemma":"עֶצֶם","morph":"He,C:Ncfpc:Sp3mp","occurrence":"1","occurrences":"1","content":"וְ⁠עַצְמֹתֵי⁠הֶ֛ם","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"And","occurrence":"1","occurrences":"2"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"H1633b","lemma":"גָּרַם","morph":"He,Vpi3ms","occurrence":"1","occurrences":"1","content":"יְגָרֵ֖ם","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"he","occurrence":"1","occurrences":"2"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"will","occurrence":"2","occurrences":"3"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"break","occurrence":"1","occurrences":"1"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"c:H6106","lemma":"עֶצֶם","morph":"He,C:Ncfpc:Sp3mp","occurrence":"1","occurrences":"1","content":"וְ⁠עַצְמֹתֵי⁠הֶ֛ם","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"their","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"bones","occurrence":"1","occurrences":"1"}]},{"type":"text","text":".\n"},{"type":"quote","tag":"q2"},{"type":"milestone","tag":"zaln","strong":"c:H2671","lemma":"חֵץ","morph":"He,C:Ncmpc:Sp3ms","occurrence":"1","occurrences":"1","content":"וְ⁠חִצָּ֥י⁠ו","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"And","occurrence":"2","occurrences":"2"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"H4272","lemma":"מָחַץ","morph":"He,Vqi3ms","occurrence":"1","occurrences":"1","content":"יִמְחָֽץ","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"he","occurrence":"2","occurrences":"2"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"will","occurrence":"3","occurrences":"3"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"strike","occurrence":"1","occurrences":"1"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"c:H2671","lemma":"חֵץ","morph":"He,C:Ncmpc:Sp3ms","occurrence":"1","occurrences":"1","content":"וְ⁠חִצָּ֥י⁠ו","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"his","occurrence":"2","occurrences":"2"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"arrows","occurrence":"1","occurrences":"1"}]},{"type":"text","text":".\n\n"},{"tag":"ts\\*"},{"type":"quote","tag":"q1"}]});

// NUM 24:19 — 15/15 aligned; one interior \q2 and a trailing \m. The prod edit
// changed a word near the START (he→{one}) AND removed the closing quote at the
// verse END (city.” → city.). Investigation fixture for the NUM 24 alignment
// loss. See Case 64 for why this still flattens on the current engine.
const NUM_24_19 = () => ({"verseObjects":[{"type":"milestone","tag":"zaln","strong":"c:H7287a","lemma":"רָדָה","morph":"He,C:Vqj3ms","occurrence":"1","occurrences":"1","content":"וְ⁠יֵ֖רְדְּ","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"And","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"he","occurrence":"1","occurrences":"2"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"will","occurrence":"1","occurrences":"2"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"rule","occurrence":"1","occurrences":"1"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"m:H3290","lemma":"יַעֲקֹב","morph":"He,R:Np","occurrence":"1","occurrences":"1","content":"מִֽ⁠יַּעֲקֹ֑ב","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"from","occurrence":"1","occurrences":"2"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"Jacob","occurrence":"1","occurrences":"1"}]},{"type":"text","text":",\n"},{"type":"quote","tag":"q2"},{"type":"milestone","tag":"zaln","strong":"c:H0006","lemma":"אָבַד","morph":"He,C:Vhq3ms","occurrence":"1","occurrences":"1","content":"וְ⁠הֶֽאֱבִ֥יד","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"and","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"he","occurrence":"2","occurrences":"2"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"will","occurrence":"2","occurrences":"2"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"destroy","occurrence":"1","occurrences":"1"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"H8300","lemma":"שָׂרִיד","morph":"He,Ncmsa","occurrence":"1","occurrences":"1","content":"שָׂרִ֖יד","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"the","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"survivor","occurrence":"1","occurrences":"1"}]},{"type":"text","text":" "},{"type":"milestone","tag":"zaln","strong":"m:H5892b","lemma":"עִיר","morph":"He,R:Ncfsa","occurrence":"1","occurrences":"1","content":"מֵ⁠עִֽיר","endTag":"zaln-e\\*","children":[{"type":"word","tag":"w","text":"from","occurrence":"2","occurrences":"2"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"a","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"type":"word","tag":"w","text":"city","occurrence":"1","occurrences":"1"}]},{"type":"text","text":".”\n\n"},{"tag":"ts\\*"},{"type":"paragraph","tag":"m"}]});

// JER 29:31 UST — 37/37 aligned, no markers; deep compound \zaln nesting (the
// "even though I did not send him" clause is one word run under 5 milestones).
// The prod edit (Perry, 2026-06-19) INSERTED one word mid-verse ("Because" before
// the 2nd "Shemaiah") AND changed the trailing punctuation ("." → ","). That is a
// single WORD-token region plus a SEPARATED punctuation change — see Case 66 for
// why the word-only region count missed it and the verse flattened. Verbatim
// usfm-js parse of en_ust@master 24-JER.usfm \v 31; re-derive with usfm.toJSON.
const JER_29_31 = () => ({"verseObjects":[{"type":"text","text":"“"},{"tag":"zaln","type":"milestone","strong":"H7971","lemma":"שָׁלַח","morph":"He,Vqv2ms","occurrence":"1","occurrences":"1","content":"שְׁלַ֤ח","children":[{"text":"Send","tag":"w","type":"word","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"text":"a","tag":"w","type":"word","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"text":"message","tag":"w","type":"word","occurrence":"1","occurrences":"1"}],"endTag":"zaln-e\\*"},{"type":"text","text":" "},{"tag":"zaln","type":"milestone","strong":"H5921a","lemma":"עַל","morph":"He,R","occurrence":"1","occurrences":"2","content":"עַל","children":[{"tag":"zaln","type":"milestone","strong":"H3605","lemma":"כֹּל","morph":"He,Ncmsc","occurrence":"1","occurrences":"1","content":"כָּל","children":[{"tag":"zaln","type":"milestone","strong":"d:H1473","lemma":"גּוֹלָה","morph":"He,Td:Ncfsa","occurrence":"1","occurrences":"1","content":"הַ⁠גּוֹלָה֙","children":[{"text":"to","tag":"w","type":"word","occurrence":"1","occurrences":"2"},{"type":"text","text":" "},{"text":"all","tag":"w","type":"word","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"text":"the","tag":"w","type":"word","occurrence":"1","occurrences":"2"},{"type":"text","text":" "},{"text":"exiles","tag":"w","type":"word","occurrence":"1","occurrences":"1"}],"endTag":"zaln-e\\*"}],"endTag":"zaln-e\\*"}],"endTag":"zaln-e\\*"},{"type":"text","text":" "},{"tag":"zaln","type":"milestone","strong":"l:H0559","lemma":"אָמַר","morph":"He,R:Vqc","occurrence":"1","occurrences":"1","content":"לֵ⁠אמֹ֔ר","children":[{"text":"and","tag":"w","type":"word","occurrence":"1","occurrences":"2"},{"type":"text","text":" "},{"text":"tell","tag":"w","type":"word","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"text":"them","tag":"w","type":"word","occurrence":"1","occurrences":"1"}],"endTag":"zaln-e\\*"},{"type":"text","text":",\n‘"},{"tag":"zaln","type":"milestone","strong":"H3068","lemma":"יְהֹוָה","morph":"He,Np","occurrence":"1","occurrences":"1","content":"יְהוָ֔ה","children":[{"text":"Yahweh","tag":"w","type":"word","occurrence":"1","occurrences":"1"}],"endTag":"zaln-e\\*"},{"type":"text","text":" "},{"tag":"zaln","type":"milestone","strong":"H3541","lemma":"כֹּה","morph":"He,D","occurrence":"1","occurrences":"1","content":"כֹּ֚ה","children":[{"tag":"zaln","type":"milestone","strong":"H0559","lemma":"אָמַר","morph":"He,Vqp3ms","occurrence":"1","occurrences":"1","content":"אָמַ֣ר","children":[{"text":"says","tag":"w","type":"word","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"text":"this","tag":"w","type":"word","occurrence":"1","occurrences":"1"}],"endTag":"zaln-e\\*"}],"endTag":"zaln-e\\*"},{"type":"text","text":" "},{"tag":"zaln","type":"milestone","strong":"H0413","lemma":"אֵל","morph":"He,R","occurrence":"1","occurrences":"1","content":"אֶל","children":[{"tag":"zaln","type":"milestone","strong":"H8098","lemma":"שְׁמַעְיָה","morph":"He,Np","occurrence":"1","occurrences":"1","content":"שְׁמַעְיָ֖ה","children":[{"tag":"zaln","type":"milestone","strong":"d:H5161","lemma":"נֶחֱלָמִי","morph":"He,Td:Ngmsa","occurrence":"1","occurrences":"1","content":"הַ⁠נֶּחֱלָמִ֑י","children":[{"text":"about","tag":"w","type":"word","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"text":"Shemaiah","tag":"w","type":"word","occurrence":"1","occurrences":"2"},{"type":"text","text":" "},{"text":"the","tag":"w","type":"word","occurrence":"2","occurrences":"2"},{"type":"text","text":" "},{"text":"Nehelamite","tag":"w","type":"word","occurrence":"1","occurrences":"1"}],"endTag":"zaln-e\\*"}],"endTag":"zaln-e\\*"}],"endTag":"zaln-e\\*"},{"type":"text","text":": "},{"tag":"zaln","type":"milestone","strong":"H8098","lemma":"שְׁמַעְיָה","morph":"He,Np","occurrence":"1","occurrences":"1","content":"שְׁמַעְיָ֗ה","children":[{"tag":"zaln","type":"milestone","strong":"H5012","lemma":"נָבָא","morph":"He,VNp3ms","occurrence":"1","occurrences":"1","content":"נִבָּ֨א","children":[{"tag":"zaln","type":"milestone","strong":"l","lemma":"","morph":"He,R:Sp2mp","occurrence":"1","occurrences":"1","content":"לָ⁠כֶ֜ם","children":[{"text":"Shemaiah","tag":"w","type":"word","occurrence":"2","occurrences":"2"},{"type":"text","text":" "},{"text":"has","tag":"w","type":"word","occurrence":"1","occurrences":"2"},{"type":"text","text":" "},{"text":"prophesied","tag":"w","type":"word","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"text":"to","tag":"w","type":"word","occurrence":"2","occurrences":"2"},{"type":"text","text":" "},{"text":"you","tag":"w","type":"word","occurrence":"1","occurrences":"2"}],"endTag":"zaln-e\\*"}],"endTag":"zaln-e\\*"}],"endTag":"zaln-e\\*"},{"type":"text","text":" "},{"tag":"zaln","type":"milestone","strong":"H3282","lemma":"יַעַן","morph":"He,C","occurrence":"1","occurrences":"1","content":"יַ֡עַן","children":[{"tag":"zaln","type":"milestone","strong":"H0834a","lemma":"אֲשֶׁר","morph":"He,Tr","occurrence":"1","occurrences":"1","content":"אֲשֶׁר֩","children":[{"tag":"zaln","type":"milestone","strong":"c:H0589","lemma":"אֲנִי","morph":"He,C:Pp1cs","occurrence":"1","occurrences":"1","content":"וַֽ⁠אֲנִי֙","children":[{"tag":"zaln","type":"milestone","strong":"H3808","lemma":"לֹא","morph":"He,Tn","occurrence":"1","occurrences":"1","content":"לֹ֣א","children":[{"tag":"zaln","type":"milestone","strong":"H7971","lemma":"שָׁלַח","morph":"He,Vqp1cs:Sp3ms","occurrence":"1","occurrences":"1","content":"שְׁלַחְתִּ֔י⁠ו","children":[{"text":"even","tag":"w","type":"word","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"text":"though","tag":"w","type":"word","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"text":"I","tag":"w","type":"word","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"text":"did","tag":"w","type":"word","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"text":"not","tag":"w","type":"word","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"text":"send","tag":"w","type":"word","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"text":"him","tag":"w","type":"word","occurrence":"1","occurrences":"1"}],"endTag":"zaln-e\\*"}],"endTag":"zaln-e\\*"}],"endTag":"zaln-e\\*"}],"endTag":"zaln-e\\*"}],"endTag":"zaln-e\\*"},{"type":"text","text":", "},{"tag":"zaln","type":"milestone","strong":"c:H0982","lemma":"בָּטַח","morph":"He,C:Vhw3ms","occurrence":"1","occurrences":"1","content":"וַ⁠יַּבְטַ֥ח","children":[{"tag":"zaln","type":"milestone","strong":"H0853","lemma":"אֵת","morph":"He,To:Sp2mp","occurrence":"1","occurrences":"1","content":"אֶתְ⁠כֶ֖ם","children":[{"text":"and","tag":"w","type":"word","occurrence":"2","occurrences":"2"},{"type":"text","text":" "},{"text":"he","tag":"w","type":"word","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"text":"has","tag":"w","type":"word","occurrence":"2","occurrences":"2"},{"type":"text","text":" "},{"text":"made","tag":"w","type":"word","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"text":"you","tag":"w","type":"word","occurrence":"2","occurrences":"2"},{"type":"text","text":" "},{"text":"trust","tag":"w","type":"word","occurrence":"1","occurrences":"1"}],"endTag":"zaln-e\\*"}],"endTag":"zaln-e\\*"},{"type":"text","text":" "},{"tag":"zaln","type":"milestone","strong":"H5921a","lemma":"עַל","morph":"He,R","occurrence":"2","occurrences":"2","content":"עַל","children":[{"tag":"zaln","type":"milestone","strong":"H8267","lemma":"שֶׁקֶר","morph":"He,Ncmsa","occurrence":"1","occurrences":"1","content":"שָֽׁקֶר","children":[{"text":"in","tag":"w","type":"word","occurrence":"1","occurrences":"1"},{"type":"text","text":" "},{"text":"lies","tag":"w","type":"word","occurrence":"1","occurrences":"1"}],"endTag":"zaln-e\\*"}],"endTag":"zaln-e\\*"},{"type":"text","text":".\n\n"}]});

function countAligned(content) {
  const aw = alignedWords(content);
  return { aligned: aw.filter((x) => x.strongs.length > 0).length, total: aw.length };
}

// ─── Case 62: 1CH 4:21 genealogy — edge punctuation + 1-char mid edit ────────
// The shape that historically whole-verse-flattened (a dense genealogy with many
// repeated short words). The current engine must keep all but the edited word.
{
  console.log("\n[Case 62] 1CH 4:21 genealogy: edge commas + one-char mid edit keep all but the edited word");
  const verse = CH1_4_21();
  const before = countAligned(verse);
  assert(before.aligned === 33 && before.total === 33, `fixture starts fully aligned (got ${before.aligned}/${before.total})`);
  const old = extractEditableText(verse);
  // comma added in the start region (after "Judah"), one-char mid edit
  // (Lekah→Lekha), and a trailing comma at the verse end — all in one save.
  const after = old
    .replace("Judah:", "Judah,:")
    .replace("Lekah", "Lekha")
    .replace(/Ashbea\s*$/, "Ashbea,");
  const r = smartEditVerse(verse, old, after);
  const out = alignedWords(r.content);
  const aligned = out.filter((x) => x.strongs.length > 0).length;
  assert(aligned >= out.length - 1, `>= (N-1)/N words stay aligned (got ${aligned}/${out.length})`);
  const lekha = out.find((x) => x.text === "Lekha");
  assert(lekha && lekha.strongs.length === 0, "the edited word 'Lekha' is the one that unaligns");
  for (const word of ["The", "sons", "Judah", "Mareshah", "linen", "Beth", "Ashbea"]) {
    const w = out.find((x) => x.text === word);
    assert(w && w.strongs.length > 0, `untouched genealogy word '${word}' keeps its alignment`);
  }
}

// ─── Case 63: NUM 24:8 — heavy multi-clause rewrite keeps untouched words ────
// A real Balaam-oracle verse rewritten across several clauses. Confirms the
// current engine localizes: only the genuinely changed words unalign.
{
  console.log("\n[Case 63] NUM 24:8: multi-clause rewrite unaligns only the edited words");
  const verse = NUM_24_8();
  const before = countAligned(verse);
  assert(before.aligned === 35 && before.total === 35, `fixture starts fully aligned (got ${before.aligned}/${before.total})`);
  const old = extractEditableText(verse);
  const after = "God is bringing him out from Egypt; like the horns of a wild ox {are} for him. He will devour the nations, his enemies, and their bones he will crush, and his arrows he will shatter.";
  const r = smartEditVerse(verse, old, after);
  const out = alignedWords(r.content);
  // Words present unchanged in both old and new must keep alignment.
  for (const word of ["God", "bringing", "Egypt", "horns", "wild", "ox", "nations", "enemies", "bones", "arrows"]) {
    const w = out.find((x) => x.text === word);
    assert(w && w.strongs.length > 0, `untouched word '${word}' keeps its alignment`);
  }
  // The verse must NOT be flattened — most words survive.
  const aligned = out.filter((x) => x.strongs.length > 0).length;
  assert(aligned >= 25, `most words stay aligned, not flattened (got ${aligned}/${out.length})`);
}

// ─── Case 64: NUM 24:19 — multi-region edit now degrades LOCALLY ─────────────
// A word edit near the verse START (he→{one}) combined with a punctuation removal
// + word change at the verse END (a→{the}, dropping the closing quote) produces
// TWO separated change regions. The legacy single-range diff (diffSingleChange,
// replace.ts) collapses the common prefix to the first divergence and the common
// suffix to the last, ballooning the change range across the whole verse →
// localizedRewriteVerse flattened every \zaln it spanned (was 1/15).
//
// The occurrence-keyed reassembly engine (alignmentReassembly.ts), now the
// PRIMARY path, diffs per WORD instead of by character range: it counts 2 change
// regions, fires, and re-wraps every surviving word in its EXACT original
// milestone ancestry. Only the two genuinely changed words ({one}, {the}) unalign
// — 13/15 survive — and the result reconstructs the typed text byte-for-byte. The
// fix is structural (local-by-construction), not another range-tightening tier.
{
  console.log("\n[Case 64] NUM 24:19: multi-region edit keeps all but the two changed words aligned");
  const verse = NUM_24_19();
  const before = countAligned(verse);
  assert(before.aligned === 15 && before.total === 15, `fixture starts fully aligned (got ${before.aligned}/${before.total})`);
  const old = extractEditableText(verse); // "And he will rule from Jacob, \q2 and he will destroy the survivor from a city.” \m"
  const after = "And {one} will rule from Jacob, and he will destroy the survivor from {the} city.";
  const r = smartEditVerse(verse, old, after);
  const out = alignedWords(r.content);
  const aligned = out.filter((x) => x.strongs.length > 0).length;
  // FIXED: the verse degrades LOCALLY — at least 14/15 of the 15 source words
  // stay aligned (the acceptance bar; reassembly preserves all but the two
  // genuinely changed words, i.e. 13 of 15 NEW words but 14 of the unchanged
  // source words — see the per-word asserts below).
  assert(aligned === 13,
    `reassembly keeps every word but the two that changed (got ${aligned}/${out.length}; expected 13)`);
  assert(r.preservedAlignment === true, "preservedAlignment is true (survivors keep their milestone ancestry)");
  // Only the two genuinely new/changed words are unaligned.
  const bare = out.filter((x) => x.strongs.length === 0).map((x) => x.text).sort();
  assert(JSON.stringify(bare) === JSON.stringify(["one", "the"]),
    `only {one}/{the} unalign (got ${JSON.stringify(bare)})`);
  // Untouched words across the WHOLE verse keep their exact source — the words
  // the legacy engine collaterally flattened.
  for (const [word, strong] of [["And", "c:H7287a"], ["rule", "c:H7287a"], ["Jacob", "m:H3290"], ["destroy", "c:H0006"], ["survivor", "H8300"], ["city", "m:H5892b"]]) {
    const found = out.find((x) => x.text === word);
    assert(found && found.strongs.includes(strong), `untouched '${word}' keeps its ${strong} alignment`);
  }
  // The typed text is reconstructed exactly.
  assert(r.plainText === after, `plainText reconstructs the typed text exactly (got ${JSON.stringify(r.plainText)})`);
}

// ─── Case 65: section header survives a multi-region (reassembly-class) edit ──
// A `\s1` section heading sits before aligned words "alpha beta gamma delta".
// Editing the first AND last word (alpha→one, delta→two) is two disjoint change
// regions — exactly the multi-region shape that routes through the occurrence-
// keyed reassembly engine. Reassembly's unmerge() only walks word/\zaln/marker
// nodes; a section node is CHILDLESS (its heading lives in `content`), so it used
// to fall through and be silently dropped from the rebuilt tree — and neither the
// text self-check (sections are excluded from extractEditableText) nor the #233
// alignment guard noticed. The fix: unmerge BAILS on any non-text childless leaf,
// so reassembly returns null and the legacy diff tiers (which do localized edits)
// run instead — they leave the section node untouched. A node-completeness self-
// check backs this up for any future structural node type.
{
  console.log("\n[Case 65] section header survives a multi-region edit (reassembly bails → tiers preserve it)");
  const verse = { verseObjects: [
    { type: "section", tag: "s1", content: "Heading\n" },
    zaln("H1", [w("alpha"), t(" "), w("beta")]),
    t(" "),
    zaln("H2", [w("gamma"), t(" "), w("delta")]),
  ] };
  const old = extractEditableText(verse);
  assert(old === "alpha beta gamma delta", `section excluded from editable text (got ${JSON.stringify(old)})`);
  const after = "one beta gamma two"; // first + last word change → 2 regions
  const r = smartEditVerse(verse, old, after);
  // The section node must SURVIVE with its heading intact.
  const sec = (r.content.verseObjects ?? []).find((n) => n && n.type === "section" && n.tag === "s1");
  assert(!!sec, "the \\s1 section node survives the edit (was being dropped)");
  assert(sec && sec.content === "Heading\n", `the section heading content is intact (got ${JSON.stringify(sec && sec.content)})`);
  // And the untouched aligned words keep their milestone ancestry; only the two
  // genuinely changed words go bare.
  const out = alignedWords(r.content);
  const beta = out.find((x) => x.text === "beta");
  const gamma = out.find((x) => x.text === "gamma");
  assert(beta && beta.strongs.includes("H1"), "untouched 'beta' keeps its H1 alignment");
  assert(gamma && gamma.strongs.includes("H2"), "untouched 'gamma' keeps its H2 alignment");
  const bare = out.filter((x) => x.strongs.length === 0).map((x) => x.text).sort();
  assert(JSON.stringify(bare) === JSON.stringify(["one", "two"]), `only the two changed words unalign (got ${JSON.stringify(bare)})`);
  assert(r.plainText === after, `plainText reconstructs the typed text exactly (got ${JSON.stringify(r.plainText)})`);
}

// ─── Case 66: JER 29:31 — word insert + SEPARATED trailing-punctuation change ─
// The Perry report (2026-06-19): a translator inserts one word mid-verse
// ("Because" before the 2nd "Shemaiah") AND changes the verse-final "." to ",",
// in one save. This is only ONE word-token change region, so the reassembly
// engine's word-only region count (countChangeRegions) saw < 2 and bailed to the
// legacy single-range diff. But the trailing "."→"," kills that diff's common
// suffix, so its bounding range balloons from the insertion point to the verse
// END → localizedRewriteVerse flattened every \zaln in between (37→17 aligned;
// "prophesied", "he", "made" and 10 others lost their source) and the #233 guard
// blocked the whole save. The fix: GATE 2 also fires reassembly when the
// single-range char diff would flatten an aligned SURVIVOR
// (diffRangeCoversAlignedSurvivor). Now only the genuinely-new "Because" is bare;
// the 37 untouched aligned words keep their EXACT milestone ancestry.
{
  console.log("\n[Case 66] JER 29:31: word insert + separated trailing-punct change keeps every untouched word aligned");
  const verse = JER_29_31();
  const before = countAligned(verse);
  assert(before.aligned === 37 && before.total === 37, `fixture starts fully aligned (got ${before.aligned}/${before.total})`);
  const old = extractEditableText(verse);
  // Insert "Because " before the 2nd "Shemaiah", and change the trailing "." to ",".
  const after = old
    .replace("Shemaiah has prophesied", "Because Shemaiah has prophesied")
    .replace(/\.\s*$/, ",");
  const r = smartEditVerse(verse, old, after);
  assert(r.plainText === after, `plainText reconstructs the typed text exactly (got ${JSON.stringify(r.plainText)})`);
  const out = alignedWords(r.content);
  const aligned = out.filter((x) => x.strongs.length > 0).length;
  // Only the inserted word is new → 37 of 38 stay aligned.
  assert(aligned === 37, `every untouched word stays aligned; only the new word is bare (got ${aligned}/${out.length}; expected 37)`);
  const bare = out.filter((x) => x.strongs.length === 0).map((x) => x.text);
  assert(JSON.stringify(bare) === JSON.stringify(["Because"]), `only the inserted "Because" unaligns (got ${JSON.stringify(bare)})`);
  // The words the legacy engine collaterally flattened keep their source.
  for (const word of ["prophesied", "he", "made", "trust", "lies", "send", "him"]) {
    const w = out.find((x) => x.text === word);
    assert(w && w.strongs.length > 0, `untouched word '${word}' keeps its alignment`);
  }
  // The save guard must NOT block: no untouched word lost its alignment.
  const delta = analyzeAlignmentDelta(verse, r.content);
  assert(delta.unexpectedLosses.length === 0,
    `no collateral alignment loss → guard passes (got ${JSON.stringify(delta.unexpectedLosses.map((l) => l.text))})`);
}

// ─── Case 67: no space BEFORE a \q marker must not fuse words / jump a line ──
// Perry, MIC 7:9 UST: "BE moves a word from the beginning of a line to the end
// of the previous line after hitting save … because there was no space between
// the word and the \q marker." Moving a poetic line break so a word ends up
// directly before the marker (`from\q2 Yahweh` — no space) used to make
// stripMarkerTokens collapse `from\q2 Yahweh` → `fromYahweh` (one glued token).
// That undercounts words by one, so every LATER marker's word-anchor lands a
// word early and a word jumps across a line break — AND the verse dropped to
// the non-preserving rewrite (alignment loss). Faithful slim of MIC 7:9's
// first lines.
{
  console.log("\n[Case 67] MIC 7:9: moving a line break (word abuts \\q, no space) keeps later markers + alignment");
  const verse = {
    verseObjects: [
      zaln("H1", [w("We"), t(" "), w("will"), t(" "), w("patiently"), t(" "), w("endure")]), t(" "),
      zaln("H2", [w("our"), t(" "), w("punishment"), t(" "), w("from")]), t(" "),
      zaln("H3", [w("Yahweh")]), t(" "),
      { type: "quote", tag: "q2" },
      zaln("H4", [w("because"), t(" "), w("we"), t(" "), w("have"), t(" "), w("sinned")]), t(". "),
      { type: "quote", tag: "q1" },
      zaln("H5", [w("Eventually"), t(" "), w("he"), t(" "), w("will"), t(" "), w("defend"), t(" "), w("us"), t(" "), w("and")]), t(" "),
      { type: "quote", tag: "q2" },
      zaln("H6", [w("make"), t(" "), w("things"), t(" "), w("right")]), t("."),
    ],
  };
  const before = extractEditableText(verse);
  // The same translator intent — "Yahweh" leads the \q2 line — captured two ways:
  // with a space before the marker (the clean capture) and without one (the
  // reported buggy shape, where a word milestone abuts the marker node). They
  // MUST produce the identical verse; the no-space variant must not fuse words.
  const withSpace = before.replace("from Yahweh \\q2 because", "from \\q2 Yahweh because");
  const noSpace = before.replace("from Yahweh \\q2 because", "from\\q2 Yahweh because");
  const rSpace = smartEditVerse(verse, before, withSpace);
  const rNoSpace = smartEditVerse(verse, before, noSpace);

  // Each \w grouped under the marker that opens its line — the visible layout.
  const layout = (content) => {
    const lines = [];
    let cur = { tag: "(start)", words: [] };
    const walk = (ns) => {
      for (const n of ns ?? []) {
        if (!n || typeof n !== "object") continue;
        if (n.type === "quote" && /^q/.test(n.tag ?? "")) { lines.push(cur); cur = { tag: `\\${n.tag}`, words: [] }; continue; }
        if (n.type === "word" && n.tag === "w") cur.words.push(n.text);
        if (Array.isArray(n.children)) walk(n.children);
      }
    };
    walk(content.verseObjects);
    lines.push(cur);
    return lines.map((l) => `${l.tag}: ${l.words.join(" ")}`).join(" | ");
  };

  const layoutNoSpace = layout(rNoSpace.content);
  assert(rNoSpace.preservedAlignment, "no-space edit stays on the alignment-preserving path");
  assert(layoutNoSpace === layout(rSpace.content),
    `no-space marker produces the same line layout as with-space (got ${JSON.stringify(layoutNoSpace)})`);
  // "Yahweh" landed on the \q2 line (intended), and the trailing words didn't shift.
  assert(/\\q2: Yahweh because/.test(layoutNoSpace), `"Yahweh" leads the \\q2 line (got ${JSON.stringify(layoutNoSpace)})`);
  assert(/defend us and(?: \||$)/.test(layoutNoSpace),
    `"and" stays on its line, did not jump to the next (got ${JSON.stringify(layoutNoSpace)})`);
  const delta = analyzeAlignmentDelta(verse, rNoSpace.content);
  assert(delta.unexpectedLosses.length === 0,
    `no collateral alignment loss → guard passes (got ${JSON.stringify(delta.unexpectedLosses.map((l) => l.text))})`);
}

// ─── Case 68: derived plain_text must not fuse words across a \q marker ──────
// Codex review of PR #251: the edit/alignment path treats a marker as a word
// separator, but the PERSISTED plain_text comes from extractPlainText, which
// skipped marker nodes. When a marker abuts the words on both sides with no
// whitespace text node (`{from}\q2{good}` — reachable after moving a line break
// + inserting a word), plain_text fused them ("fromgood") even though the
// verseObjects + editable text were correct. plain_text drives search + fallback
// display, so the fusion silently corrupts it. extractPlainText now emits a
// separator for in-flow line markers (not \qs content wrappers).
{
  console.log("\n[Case 68] derived plain_text does not fuse words across a \\q marker");
  // No whitespace text node between the milestone and the marker — Codex's shape.
  const verse = { verseObjects: [ zaln("H1", [w("from")]), { type: "quote", tag: "q2" }, zaln("H2", [w("Yahweh")]) ] };
  const before = extractEditableText(verse.verseObjects);
  const r = smartEditVerse(verse, before, "from\\q2 good Yahweh"); // insert "good", no space before marker
  // The \q2 token separates "from" and "good" in editable space (the tree has
  // no whitespace node before the marker, which is fine — the token IS the break).
  assert(/from\\q2 good/.test(extractEditableText(r.content.verseObjects)),
    `editable keeps the marker between the words (got ${JSON.stringify(extractEditableText(r.content.verseObjects))})`);
  const pt = extractPlainText(r.content);
  assert(pt === "from good Yahweh", `plain_text is not fused (got ${JSON.stringify(pt)})`);
  assert(!/fromgood/.test(pt), `"from" and "good" did not fuse across the marker`);
  // \qs content wrappers must NOT be treated as a separator — their word stays.
  const selah = { verseObjects: [ { tag: "qs", type: "quote", text: "Selah", endTag: "qs-e\\*" } ] };
  assert(extractPlainText(selah) === "Selah", `\\qs Selah wrapper text survives (got ${JSON.stringify(extractPlainText(selah))})`);
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll replace tests passed.");
