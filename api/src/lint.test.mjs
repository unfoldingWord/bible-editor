// Unit tests for the flag/escalate lint (lint.ts).
// Run: node --experimental-strip-types --no-warnings src/lint.test.mjs

import assert from "node:assert/strict";
import usfm from "usfm-js";
import { lintChapterOpeningMarkers, lintPairedPunctuation, lintTnRows, lintTqRows, lintTwlRows, lintUsfmVerses, lintVerseTextQuality } from "./lint.ts";

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// Default note is non-blank so the new empty-note check doesn't fire unless a
// test opts into it. Tests that exercise blank notes pass note explicitly.
const tn = (over) => ({ ref_raw: "1:1", id: "abcd", support_reference: null, note: "a note", chapter: 1, verse: 1, ...over });
const tq = (over) => ({ id: "abcd", chapter: 1, verse: 1, question: "Q?", response: "A.", ...over });
const twl = (over) => ({ id: "abcd", chapter: 1, verse: 1, orig_words: "דָּבָר", tw_link: "rc://*/tw/dict/bible/kt/word", ...over });

t("unmatched closing bracket flagged", () => {
  const i = lintTnRows([tn({ note: "text] more" })]);
  assert.equal(i.length, 1);
  assert.equal(i[0].check, "13. Paired Square Bracket");
  assert.equal(i[0].bucket, "flag");
});
t("unmatched opening bracket flagged", () => {
  const i = lintTnRows([tn({ note: "see [13:1 here" })]);
  assert.equal(i.length, 1);
});
t("mismatched bracket sizes flagged", () => {
  const i = lintTnRows([tn({ note: "[ word ]]" })]);
  assert.equal(i.length, 1);
});
t("balanced brackets pass", () => {
  assert.equal(lintTnRows([tn({ note: "see [[rc://x]] and [13:1]" })]).length, 0);
});
t("alt-label without sentence punctuation flagged", () => {
  const i = lintTnRows([tn({ note: "express it in active form Alternate translation: x" })]);
  assert.ok(i.some((x) => x.check === "12. Alternate translation Label"));
});
t("alt-label after period NOT flagged", () => {
  assert.equal(lintTnRows([tn({ note: "active form. Alternate translation: x" })]).length, 0);
});
t("alt-label with double-space NOT flagged (auto-fixed at export)", () => {
  assert.equal(lintTnRows([tn({ note: "active form  Alternate translation: x" })]).length, 0);
});
t("malformed reference flagged", () => {
  const i = lintTnRows([tn({ ref_raw: "garbage" })]);
  assert.ok(i.some((x) => x.check === "6. Reference"));
});
t("chapter 0 with a numeric verse is rejected (the ISA ee2w shape)", () => {
  const i = lintTnRows([tn({ ref_raw: "0:1" })]);
  assert.ok(i.some((x) => x.check === "6. Reference"));
});
t("front:intro still passes", () => {
  assert.equal(lintTnRows([tn({ ref_raw: "front:intro" })]).filter((x) => x.check === "6. Reference").length, 0);
});
t("1:1 still passes", () => {
  assert.equal(lintTnRows([tn({ ref_raw: "1:1" })]).filter((x) => x.check === "6. Reference").length, 0);
});
t("12:intro still passes", () => {
  assert.equal(lintTnRows([tn({ ref_raw: "12:intro" })]).filter((x) => x.check === "6. Reference").length, 0);
});
t("3:front still passes", () => {
  assert.equal(lintTnRows([tn({ ref_raw: "3:front" })]).filter((x) => x.check === "6. Reference").length, 0);
});
t("1:1-3 bridge still passes", () => {
  assert.equal(lintTnRows([tn({ ref_raw: "1:1-3" })]).filter((x) => x.check === "6. Reference").length, 0);
});
t("malformed rc:// flagged", () => {
  const i = lintTnRows([tn({ support_reference: "not-a-link" })]);
  assert.ok(i.some((x) => x.check === "7. SupportReference"));
});
t("valid rc:// passes", () => {
  assert.equal(lintTnRows([tn({ support_reference: "rc://*/ta/man/translate/figs-metaphor" })]).length, 0);
});
t("issue carries ref + rowId for jump", () => {
  const i = lintTnRows([tn({ ref_raw: "5:7", id: "wxyz", note: "x]" })]);
  assert.equal(i[0].ref, "5:7");
  assert.equal(i[0].rowId, "wxyz");
});

t("review_kind set → adapted-note flag with reason as message", () => {
  const i = lintTnRows([tn({ ref_raw: "36:1-3", chapter: 36, verse: 1, id: "ab12", review_kind: "quote", review_reason: "Adapted from 2 Kings 18:13; verify Hebrew." })]);
  assert.equal(i.length, 1);
  assert.equal(i[0].check, "Adapted note — verify");
  assert.equal(i[0].bucket, "flag");
  assert.equal(i[0].ref, "36:1"); // chapter:verse, not the stale ref_raw range
  assert.equal(i[0].rowId, "ab12");
  assert.equal(i[0].message, "Adapted from 2 Kings 18:13; verify Hebrew.");
});
t("no review_kind → no adapted-note flag", () => {
  assert.equal(lintTnRows([tn({ review_kind: null })]).filter((x) => x.check === "Adapted note — verify").length, 0);
});

// Build content_json from REAL usfm-js output so the test exercises the actual
// node shape (a balanced footnote is one `{tag:"f", endTag:"f*"}` node — the
// close lives in endTag, not as `\f*` text; the original text-node tests missed
// this and let a false-positive bug through).
const verseFromUsfm = (usfmText) => {
  const j = usfm.toJSON(usfmText);
  const vos = j.chapters["1"]["1"].verseObjects;
  return { book: "1CH", chapter: 1, verse: 1, verse_end: null, bible_version: "ULT", version: 1, content_json: JSON.stringify({ verseObjects: vos }) };
};

t("balanced footnote passes (real usfm-js node, endTag set)", () => {
  assert.equal(lintUsfmVerses([verseFromUsfm("\\c 1\n\\p\n\\v 1 word \\f + \\ft a note\\f* end\n")]).length, 0);
});
t("unclosed footnote escalated (real usfm-js node, empty endTag)", () => {
  const i = lintUsfmVerses([verseFromUsfm("\\c 1\n\\p\n\\v 1 word \\f + \\ft a note end\n")]);
  assert.equal(i.length, 1);
  assert.equal(i[0].check, "6. Footnote Syntax");
  assert.equal(i[0].bucket, "escalate");
});
t("verse with \\ft/\\fr inside a balanced footnote is NOT flagged", () => {
  assert.equal(lintUsfmVerses([verseFromUsfm("\\c 1\n\\p\n\\v 1 a \\f + \\fr 1:1 \\ft note\\f* b\n")]).length, 0);
});
t("verse 0 (front) skipped", () => {
  const v = verseFromUsfm("\\c 1\n\\p\n\\v 1 word \\f + \\ft a note end\n");
  assert.equal(lintUsfmVerses([{ ...v, verse: 0 }]).length, 0);
});

// Joiner-glued alignment milestone detector (Amos UST AI-aligner defect).
const MAQQEF = "־"; // ־
const MINUS = "−"; // −
t("maqqef-glued milestone x-content escalated as 'Glued alignment'", () => {
  const i = lintUsfmVerses([verseFromUsfm(`\\c 1\n\\p\n\\v 1 \\zaln-s |x-strong="H0853" x-content="את${MAQQEF}הדבר"\\*\\w word\\w*\\zaln-e\\*\n`)]);
  const glued = i.filter((x) => x.check === "Glued alignment");
  assert.equal(glued.length, 1);
  assert.equal(glued[0].bucket, "escalate");
});
t("minus-glued milestone x-content escalated", () => {
  const i = lintUsfmVerses([verseFromUsfm(`\\c 1\n\\p\n\\v 1 \\zaln-s |x-strong="H0518a" x-content="אם${MINUS}נועדו"\\*\\w word\\w*\\zaln-e\\*\n`)]);
  assert.equal(i.filter((x) => x.check === "Glued alignment").length, 1);
});
t("clean single-word milestone is NOT flagged as glued", () => {
  const i = lintUsfmVerses([verseFromUsfm(`\\c 1\n\\p\n\\v 1 \\zaln-s |x-strong="H1" x-content="טוב"\\*\\w good\\w*\\zaln-e\\*\n`)]);
  assert.equal(i.filter((x) => x.check === "Glued alignment").length, 0);
});
t("intra-word U+2060 joiner is NOT flagged as glued", () => {
  // הַ⁠דָּבָר-shaped content: the article joiner U+2060 lives INSIDE one UHB word.
  const i = lintUsfmVerses([verseFromUsfm(`\\c 1\n\\p\n\\v 1 \\zaln-s |x-strong="d:H1697" x-content="ה⁠דבר"\\*\\w word\\w*\\zaln-e\\*\n`)]);
  assert.equal(i.filter((x) => x.check === "Glued alignment").length, 0);
});

// Multi-verse variant of verseFromUsfm: returns one VerseRow per \v in the
// given text, across however many \c chapters it contains. Needed for the
// cross-verse/cross-chapter quote-pairing tests below (verseFromUsfm only
// ever returns chapter 1 verse 1).
//
// The text-quality block further down has its own near-identical
// versesFromUsfm. The two differ only in cases this block never exercises
// (it surfaces chapter-front material as verse 0, and splits verse-range
// keys). Kept separate to keep this a minimal hotfix, not because the
// difference is load-bearing here — sharing one would mean hoisting that
// declaration ~520 lines. See the consolidation follow-up issue.
const quoteVersesFromUsfm = (usfmText) => {
  const j = usfm.toJSON(usfmText);
  const out = [];
  for (const [chapterStr, versesObj] of Object.entries(j.chapters)) {
    const chapter = Number(chapterStr);
    if (!Number.isFinite(chapter)) continue;
    for (const [verseStr, vObj] of Object.entries(versesObj)) {
      const verse = Number(verseStr);
      if (!Number.isFinite(verse)) continue;
      out.push({ book: "1CH", chapter, verse, verse_end: null, bible_version: "ULT", version: 1, content_json: JSON.stringify({ verseObjects: vObj.verseObjects }) });
    }
  }
  return out;
};

// Unmatched curly quotation mark detector (#438).
const quoteChecks = (issues) => issues.filter((x) => x.check === "Quotation Mark");
t("balanced curly quotes pass", () => {
  const i = lintUsfmVerses([verseFromUsfm("\\c 1\n\\p\n\\v 1 he said, “hello.”\n")]);
  assert.equal(quoteChecks(i).length, 0);
});
t("nested balanced curly quotes pass", () => {
  const i = lintUsfmVerses([verseFromUsfm("\\c 1\n\\p\n\\v 1 “outer “inner” more”\n")]);
  assert.equal(quoteChecks(i).length, 0);
});
// Codex review round 2 on PR #483: flagging a leftover, never-closed opening
// quote is itself a false positive — multi-paragraph dialogue in ULT/UST
// re-opens each paragraph with “ and closes only the final one, and
// extractPlainText has already stripped the \p markers that would tell the
// checker where a paragraph (and therefore a legitimate continuation opener)
// begins. So an unclosed “ is deliberately NOT reported at all.
t("an unclosed opening quote is NOT flagged (continuation-opener dialogue convention)", () => {
  const i = quoteChecks(lintUsfmVerses([verseFromUsfm("\\c 1\n\\p\n\\v 1 he said, “hello.\n")]));
  assert.equal(i.length, 0);
});
t("continuation-opener dialogue (a paragraph break that re-opens without closing) is NOT flagged", () => {
  // "“first paragraph…" "“second paragraph…”" — two opens, one close.
  const verses = quoteVersesFromUsfm("\\c 1\n\\p\n\\v 1 “first paragraph statement\n\\p\n\\v 2 “second paragraph statement.”\n");
  assert.equal(quoteChecks(lintUsfmVerses(verses)).length, 0);
});
t("unmatched closing curly quote (no opener anywhere earlier) IS flagged", () => {
  const i = quoteChecks(lintUsfmVerses([verseFromUsfm("\\c 1\n\\p\n\\v 1 he said hello.”\n")]));
  assert.equal(i.length, 1);
  assert.equal(i[0].bucket, "flag");
  assert.match(i[0].message, /Closing quote/);
});
t("straight quotes and apostrophes are NOT linted (out of scope)", () => {
  const i = lintUsfmVerses([verseFromUsfm("\\c 1\n\\p\n\\v 1 don't say \"hello\n")]);
  assert.equal(quoteChecks(i).length, 0);
});
// Codex review round 1 on PR #483: per-verse quote pairing double-flagged
// ordinary multi-verse discourse (ZEC 1:2 opens a quote that 1:3 closes) —
// state has to carry across an ordered sequence of verses, not reset at
// every verse.
t("quote opened in one verse and closed in a later verse of the same chapter is NOT flagged (ZEC 1:2/1:3 shape)", () => {
  const verses = quoteVersesFromUsfm("\\c 1\n\\p\n\\v 1 word\n\\v 2 he said, “hello\n\\v 3 world.”\n");
  assert.equal(quoteChecks(lintUsfmVerses(verses)).length, 0);
});
// Codex review round 2: chapter-scoping (round 1's fix) was ALSO wrong —
// quoted speech can legitimately open near the end of one chapter and close
// in the next, so a chapter boundary must not terminate a quotation either.
t("quote opened near the end of one chapter and closed in the next chapter is NOT flagged (cross-chapter span)", () => {
  const verses = quoteVersesFromUsfm("\\c 1\n\\p\n\\v 1 he said, “hello\n\\c 2\n\\p\n\\v 1 world.”\n");
  assert.equal(quoteChecks(lintUsfmVerses(verses)).length, 0);
});
t("two INDEPENDENT unmatched closing quotes in different chapters are both still flagged (one doesn't consume the other's opener)", () => {
  const verses = quoteVersesFromUsfm("\\c 1\n\\p\n\\v 1 hello.”\n\\c 2\n\\p\n\\v 1 world.”\n");
  const issues = quoteChecks(lintUsfmVerses(verses));
  assert.equal(issues.length, 2);
  assert.deepEqual(issues.map((i) => i.ref).sort(), ["1:1", "2:1"]);
});
t("out-of-order verse rows are sorted before pairing (defensive against caller order)", () => {
  const verses = quoteVersesFromUsfm("\\c 1\n\\p\n\\v 1 word\n\\v 2 he said, “hello\n\\v 3 world.”\n").reverse();
  assert.equal(quoteChecks(lintUsfmVerses(verses)).length, 0);
});

// Reused-source-token detector (ZEC 14:8 UST doubled-Hebrew defect): a single
// physical source token claimed by 2+ alignment chains with DIFFERING chain
// identity. UHB-free — keyed on x-content|x-occurrence, not resolved position.
t("ZEC 14:8 shape (compound + two singles reusing the same tokens) flags once", () => {
  const usfmText =
    `\\c 1\n\\p\n\\v 1 ` +
    `\\zaln-s |x-strong="H1" x-occurrence="1" x-occurrences="1" x-content="קיץ"\\*` +
    `\\zaln-s |x-strong="H2" x-occurrence="1" x-occurrences="1" x-content="חרף"\\*` +
    `\\w whole\\w* \\w year\\w*\\zaln-e\\*\\zaln-e\\* ` +
    `\\zaln-s |x-strong="H1" x-occurrence="1" x-occurrences="1" x-content="קיץ"\\*\\w hot\\w*\\zaln-e\\* ` +
    `\\zaln-s |x-strong="H2" x-occurrence="1" x-occurrences="1" x-content="חרף"\\*\\w cold\\w*\\zaln-e\\*\n`;
  const i = lintUsfmVerses([verseFromUsfm(usfmText)]);
  const reused = i.filter((x) => x.check === "Reused source token");
  assert.equal(reused.length, 1);
  assert.equal(reused[0].bucket, "flag");
});
t("identical-chain pair (legitimate one-token-to-N-target-runs split) is NOT flagged", () => {
  const usfmText =
    `\\c 1\n\\p\n\\v 1 ` +
    `\\zaln-s |x-strong="H1" x-occurrence="1" x-occurrences="1" x-content="אמר"\\*\\w spoke1\\w*\\zaln-e\\* ` +
    `\\zaln-s |x-strong="H1" x-occurrence="1" x-occurrences="1" x-content="אמר"\\*\\w spoke2\\w*\\zaln-e\\*\n`;
  const i = lintUsfmVerses([verseFromUsfm(usfmText)]);
  assert.equal(i.filter((x) => x.check === "Reused source token").length, 0);
});
t("clean verse with distinct source tokens is NOT flagged as reused", () => {
  const i = lintUsfmVerses([
    verseFromUsfm(
      `\\c 1\n\\p\n\\v 1 \\zaln-s |x-strong="H1" x-occurrence="1" x-occurrences="1" x-content="קיץ"\\*\\w summer\\w*\\zaln-e\\* \\zaln-s |x-strong="H2" x-occurrence="1" x-occurrences="1" x-content="חרף"\\*\\w winter\\w*\\zaln-e\\*\n`,
    ),
  ]);
  assert.equal(i.filter((x) => x.check === "Reused source token").length, 0);
});
// A chain that wraps the SAME token twice (the JER 31:33 doubled-milestone
// shape) plus a standalone claiming that token. Chain identity must de-duplicate
// within the chain, or this keys as "A,A" vs "A" and lint flags a verse the
// aligner's findReusedSourceWordIds reports nothing on (its group collapses to
// the single key "A") — a translator clicking through from the lint feed would
// find nothing marked. Measured before the fix: LINT 1, UI 0.
t("within-chain doubling + a standalone is NOT flagged (agrees with the aligner)", () => {
  const z = (c) => `\\zaln-s |x-strong="H1" x-occurrence="1" x-occurrences="1" x-content="${c}"\\*`;
  const usfmText =
    `\\c 1\n\\p\n\\v 1 ` +
    z("קיץ") + z("קיץ") + `\\w whole\\w*\\zaln-e\\*\\zaln-e\\* ` +
    z("קיץ") + `\\w hot\\w*\\zaln-e\\*\n`;
  const i = lintUsfmVerses([verseFromUsfm(usfmText)]);
  assert.equal(i.filter((x) => x.check === "Reused source token").length, 0);
});

const reusedChecks = (issues) => issues.filter((x) => x.check === "Reused source token");

// Chain-signature fix (Change 1): two chains claim the SAME token sequence,
// differing only in one raw x-occurrence — the JER 33:7 false-positive shape.
// Stripping occurrence before joining the chain signature collapses both
// chains to the same signature, so this is no longer seen as two distinct
// chains at all.
t("(A) same sequence differing by one raw occurrence is NOT flagged", () => {
  const z = (c, occ) => `\\zaln-s |x-strong="H1" x-occurrence="${occ}" x-occurrences="2" x-content="${c}"\\*`;
  const usfmText =
    `\\c 1\n\\p\n\\v 1 ` +
    z("קיץ", 1) + z("חרף", 1) + `\\w x1\\w* \\w x2\\w*\\zaln-e\\*\\zaln-e\\* ` +
    z("קיץ", 2) + z("חרף", 1) + `\\w x3\\w* \\w x4\\w*\\zaln-e\\*\\zaln-e\\*\n`;
  const i = lintUsfmVerses([verseFromUsfm(usfmText)]);
  assert.equal(reusedChecks(i).length, 0);
});

// AMO 3:2 shape: a real one, stays flagged. Compound
// [עַל|1, כֵּן|1, אֶפְקֹד|1] plus standalone [אֶפְקֹד|1] — no chain-signature
// collapse applies here (the signatures genuinely differ), so this is
// unaffected by Change 1 and remains flagged.
t("AMO 3:2 shape (compound triple + standalone reusing one key) still flags", () => {
  const z = (c, occ) => `\\zaln-s |x-strong="H1" x-occurrence="${occ}" x-occurrences="1" x-content="${c}"\\*`;
  const usfmText =
    `\\c 1\n\\p\n\\v 1 ` +
    z("עַל", 1) + z("כֵּן", 1) + z("אֶפְקֹד", 1) + `\\w on\\w* \\w that\\w* \\w account\\w*\\zaln-e\\*\\zaln-e\\*\\zaln-e\\* ` +
    z("אֶפְקֹד", 1) + `\\w visit\\w*\\zaln-e\\*\n`;
  const i = lintUsfmVerses([verseFromUsfm(usfmText)]);
  assert.equal(reusedChecks(i).length, 1);
});

// HAB 1:3 shape: chains carry the SAME keys in REVERSED nesting order — a real,
// intentional disagreement with the aligner's marker (see the scope comment on
// hasReusedSourceToken). The signature is order-sensitive, so this still flags.
t("HAB 1:3 shape (reversed nesting) still flags", () => {
  const zA = (occ) => `\\zaln-s |x-strong="H1" x-occurrence="${occ}" x-occurrences="1" x-content="A"\\*`;
  const zB = (occ) => `\\zaln-s |x-strong="H2" x-occurrence="${occ}" x-occurrences="1" x-content="B"\\*`;
  const usfmText =
    `\\c 1\n\\p\n\\v 1 ` +
    zA(1) + zB(1) + `\\w x1\\w* \\w x2\\w*\\zaln-e\\*\\zaln-e\\* ` +
    zB(1) + zA(1) + `\\w x3\\w* \\w x4\\w*\\zaln-e\\*\\zaln-e\\*\n`;
  const i = lintUsfmVerses([verseFromUsfm(usfmText)]);
  assert.equal(reusedChecks(i).length, 1);
});

// Genuine repeat: two chains claim DIFFERENT occurrences of a word — not a
// defect, so NOT flagged (occurrence keeps them as distinct tokens; the two
// keys never share a signature set in the first place).
t("genuine two-occurrence repeat is NOT flagged", () => {
  const z = (occ) => `\\zaln-s |x-strong="H1" x-occurrence="${occ}" x-occurrences="2" x-content="A"\\*`;
  const usfmText = `\\c 1\n\\p\n\\v 1 ` + z(1) + `\\w x1\\w*\\zaln-e\\* ` + z(2) + `\\w x2\\w*\\zaln-e\\*\n`;
  const i = lintUsfmVerses([verseFromUsfm(usfmText)]);
  assert.equal(reusedChecks(i).length, 0);
});

// Guard against Change 1 weakening token IDENTITY: a legal compound [A|1, B|1]
// plus a standalone claiming a DIFFERENT occurrence of A ([A|2]) must stay
// unflagged — occurrence must still distinguish the two A tokens even though
// the chain SIGNATURE now strips it for comparison purposes.
t("legal compound [A|1,B|1] + standalone [A|2] is NOT flagged (token identity keeps occurrence)", () => {
  const zA = (occ) => `\\zaln-s |x-strong="H1" x-occurrence="${occ}" x-occurrences="2" x-content="A"\\*`;
  const zB = () => `\\zaln-s |x-strong="H2" x-occurrence="1" x-occurrences="1" x-content="B"\\*`;
  const usfmText =
    `\\c 1\n\\p\n\\v 1 ` +
    zA(1) + zB() + `\\w x1\\w* \\w x2\\w*\\zaln-e\\*\\zaln-e\\* ` +
    zA(2) + `\\w x3\\w*\\zaln-e\\*\n`;
  const i = lintUsfmVerses([verseFromUsfm(usfmText)]);
  assert.equal(reusedChecks(i).length, 0);
});

// Regression pins for a source-token-count suppression that was tried and
// reverted: it treated "source has >= N physical tokens of this content" as
// proof the N chains claiming it were merely mis-numbered rather than genuinely
// reused, and so would flip both of these to unflagged.
//
// These pin LINT's behaviour for the two shapes, which is what the suppressor
// would change. They are NOT both evidence of real alignment defects — that
// claim was measured with a census script that mis-paired verse-bridge rows:
// 1CH 6:78 UST is a genuine defect (marker flags 4 words), but LEV 24:10 UST is
// NOT (marker flags 0; it is a lint false positive). See the scope comment on
// hasReusedSourceToken. Keep both pins — a suppressor flipping them is still the
// signal worth catching — but do not cite the LEV one as proof of corruption.
t("LEV 24:10 shape (standalone + compound sharing one key) still flags", () => {
  const zBen = (occ) => `\\zaln-s |x-strong="H1" x-occurrence="${occ}" x-occurrences="2" x-content="בֶּן"\\*`;
  const zWoman = () => `\\zaln-s |x-strong="H2" x-occurrence="1" x-occurrences="1" x-content="הָאִשָּׁה"\\*`;
  const zIsraelite = () => `\\zaln-s |x-strong="H3" x-occurrence="1" x-occurrences="1" x-content="הַיִּשְׂרְאֵלִית"\\*`;
  const usfmText =
    `\\c 1\n\\p\n\\v 1 ` +
    zBen(1) + `\\w son\\w*\\zaln-e\\* ` +
    zBen(1) + zWoman() + zIsraelite() + `\\w son2\\w* \\w woman\\w* \\w israelite\\w*\\zaln-e\\*\\zaln-e\\*\\zaln-e\\*\n`;
  const i = lintUsfmVerses([verseFromUsfm(usfmText)]);
  assert.equal(reusedChecks(i).length, 1);
});
// The accepted hole in the occurrence-insensitive signature, pinned so it is a
// documented decision rather than a surprise. `[A|1, B|1]` and `[A|1, B|2]` both
// sign as "A,B", so a reused A is NOT reported here when the source genuinely
// holds two B tokens. Indistinguishable from the JER 33:7 split above without
// running the occurrence reform (see the scope comment on hasReusedSourceToken):
// the old full-key signature reported this shape but cost 8 false positives
// corpus-wide, versus 1 verse for this one. The aligner's marker still catches
// it. If this assertion ever needs to change, re-measure BOTH directions first.
t("KNOWN GAP: [A|1,B|1] + [A|1,B|2] is not reported (occurrence-insensitive signature)", () => {
  const zA = () => `\\zaln-s |x-strong="H1" x-occurrence="1" x-occurrences="1" x-content="A"\\*`;
  const zB = (occ) => `\\zaln-s |x-strong="H2" x-occurrence="${occ}" x-occurrences="2" x-content="B"\\*`;
  const usfmText =
    `\\c 1\n\\p\n\\v 1 ` +
    zA() + zB(1) + `\\w x1\\w* \\w x2\\w*\\zaln-e\\*\\zaln-e\\* ` +
    zA() + zB(2) + `\\w x3\\w* \\w x4\\w*\\zaln-e\\*\\zaln-e\\*\n`;
  const i = lintUsfmVerses([verseFromUsfm(usfmText)]);
  assert.equal(reusedChecks(i).length, 0);
});

// Another instance of the SAME accepted hole above, not the HAB 1:3 shape:
// `[A|1,A|2]` and `[A|2,A|1]` are a same-content reversal — the two chains'
// unique-key lists agree on content sequence ("A,A") and differ only in
// occurrence order, so they sign identically and collapse. HAB 1:3 still
// flags because its two chains carry DIFFERENT x-content (אָוֶן vs וְעָמָל) in
// reversed order, which keeps the signatures genuinely distinct — reversed
// nesting alone is not what falls into this hole, only reversed nesting of
// the SAME content.
t("KNOWN GAP: same-content reversal [A|1,A|2] + [A|2,A|1] is not reported", () => {
  const zA = (occ) => `\\zaln-s |x-strong="H1" x-occurrence="${occ}" x-occurrences="2" x-content="A"\\*`;
  const usfmText =
    `\\c 1\n\\p\n\\v 1 ` +
    zA(1) + zA(2) + `\\w x1\\w* \\w x2\\w*\\zaln-e\\*\\zaln-e\\* ` +
    zA(2) + zA(1) + `\\w x3\\w* \\w x4\\w*\\zaln-e\\*\\zaln-e\\*\n`;
  const i = lintUsfmVerses([verseFromUsfm(usfmText)]);
  assert.equal(reusedChecks(i).length, 0);
});

t("1CH 6:78 shape (differing x-occurrences on the shared token) still flags", () => {
  const zEt = (occ, occs) => `\\zaln-s |x-strong="H1" x-occurrence="${occ}" x-occurrences="${occs}" x-content="וְאֶת"\\*`;
  const zQedemoth = () => `\\zaln-s |x-strong="H2" x-occurrence="1" x-occurrences="1" x-content="קְדֵמוֹת"\\*`;
  const usfmText =
    `\\c 1\n\\p\n\\v 1 ` +
    zEt(1, 3) + `\\w and1\\w*\\zaln-e\\* ` +
    zEt(1, 4) + zQedemoth() + `\\w and2\\w* \\w qedemoth\\w*\\zaln-e\\*\\zaln-e\\*\n`;
  const i = lintUsfmVerses([verseFromUsfm(usfmText)]);
  assert.equal(reusedChecks(i).length, 1);
});

// ── Blank required-field checks (the manual review_kind='blank-note' stamps,
// now computed dynamically). tn note, tq question/response, twl OrigWords/TWLink.
t("empty tn note flagged with chapter:verse ref + rowId", () => {
  const i = lintTnRows([tn({ chapter: 8, verse: 3, id: "j53u", note: "" })]);
  const blank = i.filter((x) => x.check === "Empty note");
  assert.equal(blank.length, 1);
  assert.equal(blank[0].bucket, "flag");
  assert.equal(blank[0].ref, "8:3");
  assert.equal(blank[0].rowId, "j53u");
});
t("whitespace-only tn note flagged as empty", () => {
  assert.equal(lintTnRows([tn({ note: "   \n\t" })]).filter((x) => x.check === "Empty note").length, 1);
});
t("null tn note flagged as empty", () => {
  assert.equal(lintTnRows([tn({ note: null })]).filter((x) => x.check === "Empty note").length, 1);
});
t("section-header note (# Heading) NOT flagged as empty", () => {
  assert.equal(lintTnRows([tn({ note: "# The LORD calls Jeremiah" })]).filter((x) => x.check === "Empty note").length, 0);
});

t("empty tq question flagged", () => {
  const i = lintTqRows([tq({ chapter: 2, verse: 5, id: "qq11", question: "" })]);
  const blank = i.filter((x) => x.check === "Empty question");
  assert.equal(blank.length, 1);
  assert.equal(blank[0].bucket, "flag");
  assert.equal(blank[0].ref, "2:5");
  assert.equal(blank[0].rowId, "qq11");
});
t("empty tq response flagged", () => {
  assert.equal(lintTqRows([tq({ response: "  " })]).filter((x) => x.check === "Empty response").length, 1);
});
t("tq with both question and response passes", () => {
  assert.equal(lintTqRows([tq({})]).length, 0);
});
t("tq blank on both fields flags twice", () => {
  assert.equal(lintTqRows([tq({ question: "", response: null })]).length, 2);
});

t("empty twl OrigWords flagged", () => {
  const i = lintTwlRows([twl({ chapter: 6, verse: 1, id: "hwip", orig_words: "" })]);
  const blank = i.filter((x) => x.check === "Empty OrigWords");
  assert.equal(blank.length, 1);
  assert.equal(blank[0].bucket, "flag");
  assert.equal(blank[0].ref, "6:1");
  assert.equal(blank[0].rowId, "hwip");
});
t("empty twl TWLink flagged", () => {
  assert.equal(lintTwlRows([twl({ tw_link: "" })]).filter((x) => x.check === "Empty TWLink").length, 1);
});
t("twl with both fields present passes", () => {
  assert.equal(lintTwlRows([twl({})]).length, 0);
});

// Chapter-opening paragraph marker (#378). Built from real usfm-js output so the
// tests exercise the actual node placement: a `\p` before `\v 1` lands on the
// chapter-FRONT pseudo-verse (stored as verse 0), not on verse 1.
const chapterRows = (usfmText, { dropFront = false } = {}) => {
  const j = usfm.toJSON(usfmText);
  const ch = j.chapters["1"];
  const base = { book: "MIC", verse_end: null, bible_version: "ULT", version: 1 };
  const rows = [];
  for (const [key, val] of Object.entries(ch)) {
    const verse = key === "front" ? 0 : parseInt(key, 10);
    if (!Number.isFinite(verse)) continue;
    if (dropFront && verse === 0) continue;
    rows.push({ ...base, chapter: 1, verse, content_json: JSON.stringify({ verseObjects: val.verseObjects }) });
  }
  return rows;
};

t("chapter opened by \\p passes", () => {
  assert.equal(lintChapterOpeningMarkers(chapterRows("\\c 1\n\\p\n\\v 1 word\n")).length, 0);
});
t("chapter opened by \\q1 passes", () => {
  assert.equal(lintChapterOpeningMarkers(chapterRows("\\c 1\n\\q1\n\\v 1 word\n")).length, 0);
});
t("chapter with NO intro row flagged (the MIC 5 ULT case)", () => {
  const i = lintChapterOpeningMarkers(chapterRows("\\c 1\n\\p\n\\v 1 word\n", { dropFront: true }));
  assert.equal(i.length, 1);
  assert.equal(i[0].check, "Chapter opening marker");
  assert.equal(i[0].bucket, "flag");
  assert.equal(i[0].ref, "1:0");
  assert.match(i[0].message, /no chapter-intro row/);
});
t("intro row present but carrying no opening marker flagged", () => {
  // \d (Psalm superscription) is chapter-front content but is NOT a paragraph
  // marker, so the chapter still opens unmarked.
  const i = lintChapterOpeningMarkers(chapterRows("\\c 1\n\\d a title\n\\v 1 word\n"));
  assert.equal(i.length, 1);
  assert.equal(i[0].ref, "1:0");
  assert.doesNotMatch(i[0].message, /no chapter-intro row/);
});
t("\\ts\\* alone does not count as an opening marker", () => {
  const i = lintChapterOpeningMarkers(chapterRows("\\c 1\n\\ts\\*\n\\v 1 word\n"));
  assert.equal(i.length, 1);
});
t("a front row ending in \\b still flags (blank line is not a paragraph opener)", () => {
  const rows = [
    { book: "MIC", chapter: 1, verse: 0, verse_end: null, bible_version: "ULT", version: 1,
      content_json: JSON.stringify({ verseObjects: [{ type: "paragraph", tag: "b" }] }) },
    { book: "MIC", chapter: 1, verse: 1, verse_end: null, bible_version: "ULT", version: 1,
      content_json: JSON.stringify({ verseObjects: [{ type: "text", text: "word" }] }) },
  ];
  assert.equal(lintChapterOpeningMarkers(rows).length, 1);
});
t("chapter with no verse 1 is not judged", () => {
  const rows = chapterRows("\\c 1\n\\p\n\\v 1 word\n").filter((r) => r.verse !== 1);
  assert.equal(lintChapterOpeningMarkers(rows).length, 0);
});
t("mid-verse \\q1 in verse 1 does NOT count as an opening marker", () => {
  // Regression: an Array.some() over verse 1 passed every poetic chapter, because
  // poetry verses carry their own mid-verse line breaks. Real case: MIC 2:1 UST,
  // which has no intro row and whose verse 1 is poetry — it must still flag.
  const rows = [
    { book: "MIC", chapter: 2, verse: 1, verse_end: null, bible_version: "UST", version: 1,
      content_json: JSON.stringify({ verseObjects: [
        { type: "milestone", tag: "zaln", content: "ה֧וֹי" },
        { type: "text", text: "Woe" },
        { type: "quote", tag: "q1" },
        { type: "text", text: "to those" },
      ] }) },
  ];
  const i = lintChapterOpeningMarkers(rows);
  assert.equal(i.length, 1);
  assert.equal(i[0].ref, "2:0");
});
t("marker only counts on verse 0 when it TRAILS the front matter", () => {
  // A \d Psalm title AFTER the marker means the marker no longer introduces
  // verse 1, so the chapter opens unmarked.
  const rows = [
    { book: "PSA", chapter: 3, verse: 0, verse_end: null, bible_version: "ULT", version: 1,
      content_json: JSON.stringify({ verseObjects: [
        { type: "quote", tag: "q1" },
        { type: "section", tag: "d", text: "A psalm of David." },
      ] }) },
    { book: "PSA", chapter: 3, verse: 1, verse_end: null, bible_version: "ULT", version: 1,
      content_json: JSON.stringify({ verseObjects: [{ type: "text", text: "word" }] }) },
  ];
  assert.equal(lintChapterOpeningMarkers(rows).length, 1);
});
t("a \\ts\\* after the marker does not hide it (Micah 4 shape)", () => {
  // Prod stores trailing runs as `\q1` then `\ts\*`. A scan that stopped at the
  // divider would report a correctly-marked chapter as bare. All three usfm-js
  // shapes of the divider must be transparent.
  for (const ts of [{ tag: "ts\\*" }, { tag: "ts*" }, { tag: "ts", content: "\\*" }]) {
    const rows = [
      { book: "MIC", chapter: 4, verse: 0, verse_end: null, bible_version: "ULT", version: 1,
        content_json: JSON.stringify({ verseObjects: [{ type: "quote", tag: "q1" }, ts] }) },
      { book: "MIC", chapter: 4, verse: 1, verse_end: null, bible_version: "ULT", version: 1,
        content_json: JSON.stringify({ verseObjects: [{ type: "text", text: "word" }] }) },
    ];
    assert.equal(lintChapterOpeningMarkers(rows).length, 0, `divider shape ${JSON.stringify(ts)} should be transparent`);
  }
});
t("whitespace between the marker and the verse edge does not hide it", () => {
  const rows = [
    { book: "MIC", chapter: 4, verse: 0, verse_end: null, bible_version: "ULT", version: 1,
      content_json: JSON.stringify({ verseObjects: [{ type: "quote", tag: "q1" }, { type: "text", text: "\n" }] }) },
    { book: "MIC", chapter: 4, verse: 1, verse_end: null, bible_version: "ULT", version: 1,
      content_json: JSON.stringify({ verseObjects: [{ type: "text", text: "word" }] }) },
  ];
  assert.equal(lintChapterOpeningMarkers(rows).length, 0);
});
t("marker parked on verse 1 itself is accepted (no false positive)", () => {
  const rows = [
    { book: "MIC", chapter: 1, verse: 1, verse_end: null, bible_version: "ULT", version: 1,
      content_json: JSON.stringify({ verseObjects: [{ type: "paragraph", tag: "p" }, { type: "text", text: "word" }] }) },
  ];
  assert.equal(lintChapterOpeningMarkers(rows).length, 0);
});
t("each unmarked chapter reported once, in chapter order", () => {
  const mk = (chapter) => ({ book: "MIC", chapter, verse: 1, verse_end: null, bible_version: "ULT", version: 1,
    content_json: JSON.stringify({ verseObjects: [{ type: "text", text: "word" }] }) });
  const i = lintChapterOpeningMarkers([mk(5), mk(2)]);
  assert.deepEqual(i.map((x) => x.ref), ["2:0", "5:0"]);
});
t("corrupt intro content_json does not throw and still flags", () => {
  const rows = [
    { book: "MIC", chapter: 1, verse: 0, verse_end: null, bible_version: "ULT", version: 1, content_json: "{not json" },
    { book: "MIC", chapter: 1, verse: 1, verse_end: null, bible_version: "ULT", version: 1,
      content_json: JSON.stringify({ verseObjects: [{ type: "text", text: "word" }] }) },
  ];
  assert.equal(lintChapterOpeningMarkers(rows).length, 1);
});

// The export no longer HOLDs a book for a blank required field (DCS raises all
// five at severity="warning" and merges anyway), so this in-app lint is the ONLY
// thing that tells an editor the row is broken. Assert every kind still flags,
// and that no message claims a validation failure that does not happen.
t("blank required fields stay flagged in-app for every kind", () => {
  const flagged = (issues, check) => issues.filter((x) => x.check === check);
  assert.equal(flagged(lintTnRows([tn({ chapter: 1, verse: 1, note: "" })]), "Empty note").length, 1);
  const tqIssues = lintTqRows([tq({ chapter: 2, verse: 5, question: "", response: "" })]);
  assert.equal(flagged(tqIssues, "Empty question").length, 1);
  assert.equal(flagged(tqIssues, "Empty response").length, 1);
  const twlIssues = lintTwlRows([twl({ chapter: 3, verse: 7, orig_words: "", tw_link: "" })]);
  assert.equal(flagged(twlIssues, "Empty OrigWords").length, 1);
  assert.equal(flagged(twlIssues, "Empty TWLink").length, 1);
  // Every blank-field message must be actionable and must NOT assert that DCS
  // rejects/blocks the row — the wrong claim the removed export gate was built
  // on. Match the CLAIM, not one phrasing of it, and only over the blank-field
  // issues (a row can carry unrelated issues whose bucket is not "flag").
  const BLANK_CHECKS = new Set(["Empty note", "Empty question", "Empty response", "Empty OrigWords", "Empty TWLink"]);
  const blankIssues = [...tqIssues, ...twlIssues, ...lintTnRows([tn({ note: "" })])].filter((x) =>
    BLANK_CHECKS.has(x.check),
  );
  assert.equal(blankIssues.length, 5);
  // Anchored on DCS/validator/merge as the SUBJECT of the rejection, so a
  // legitimate future message that merely uses the word "reject" about something
  // else ("the TWL matcher rejects a blank source string") does not false-fail,
  // while every phrasing of the stale claim is caught.
  const STALE_CLAIM =
    /(?:DCS|validator|validation|whole-repo)[^.]{0,30}\b(?:reject|refus|fail|block)|\b(?:reject|refus|fail|block)\w*[^.]{0,30}(?:DCS|validator|validation|whole-repo)|(?:can'?t|cannot|won'?t|will not)\s+merge|unmergeable|block\w*\s+(?:the\s+)?merg/i;
  for (const i of blankIssues) {
    assert.ok(!STALE_CLAIM.test(i.message), `stale DCS-rejection claim in: ${i.message}`);
    // Actionable: states the publish consequence, and what the editor should do.
    assert.ok(/publishes/.test(i.message), `no publish consequence stated in: ${i.message}`);
    assert.ok(/delete the row/.test(i.message), `no remedy offered in: ${i.message}`);
    assert.equal(i.bucket, "flag");
  }
});

// The negative regex above is only worth having if it actually bites. Pin the
// phrasings that must fail it and the innocent ones that must not, so a future
// loosening of the pattern is caught here rather than by a wrong banner.
t("stale-DCS-claim detector catches every phrasing, spares innocent ones", () => {
  const STALE_CLAIM =
    /(?:DCS|validator|validation|whole-repo)[^.]{0,30}\b(?:reject|refus|fail|block)|\b(?:reject|refus|fail|block)\w*[^.]{0,30}(?:DCS|validator|validation|whole-repo)|(?:can'?t|cannot|won'?t|will not)\s+merge|unmergeable|block\w*\s+(?:the\s+)?merg/i;
  for (const bad of [
    "Empty note — this row will fail DCS validation. Add a note.",
    "Empty note — will fail the DCS validator.",
    "Empty note — DCS refuses this row.",
    "Empty note — rejected by DCS's whole-repo validator.",
    "Empty note — this render won't merge.",
    "Empty note — produces an unmergeable PR.",
    "Empty note — blocks merging.",
    "Empty note — blocks the merge.",
  ]) {
    assert.ok(STALE_CLAIM.test(bad), `should have been caught: ${bad}`);
  }
  for (const ok of [
    "Empty note — DCS only warns, so this row publishes blank on the next export. Add a note or delete the row.",
    "Empty OrigWords — the TWL matcher rejects a blank source string. Add the word(s) or delete the row.",
    "Empty note — the row publishes blank; delete the row if it is not needed.",
  ]) {
    assert.ok(!STALE_CLAIM.test(ok), `false positive on: ${ok}`);
  }
});

// ---------------------------------------------------------------------------
// Text-quality checks (issue #438, ported from uw-content-validation).
// Fixtures built from REAL usfm-js output, per the house rule above. Every
// tuning decision here was measured against en_ult/en_ust/en_tn master via
// scripts/scan-text-quality.mjs — see the PR for the corpus numbers.
// ---------------------------------------------------------------------------

// All verses of a book usfm string, in order (verseFromUsfm above returns only
// 1:1). Chapter-front material keys as "front" in usfm-js → verse 0 here.
const versesFromUsfm = (usfmText) => {
  const j = usfm.toJSON(usfmText);
  const rows = [];
  for (const [chStr, verses] of Object.entries(j.chapters ?? {})) {
    for (const [vStr, obj] of Object.entries(verses)) {
      rows.push({
        book: "1CH", chapter: Number(chStr), verse: vStr === "front" ? 0 : Number(vStr.split("-")[0]),
        verse_end: null, bible_version: "ULT", version: 1,
        content_json: JSON.stringify({ verseObjects: obj.verseObjects ?? [] }),
      });
    }
  }
  return rows;
};
const quality = (usfmText) => lintVerseTextQuality(versesFromUsfm(usfmText));
const paired = (usfmText) => lintPairedPunctuation(versesFromUsfm(usfmText));

t("straight quotes in verse prose flagged; typographic ones pass", () => {
  const i = quality('\\c 1\n\\p\n\\v 1 he said "hi" and left\n').filter((x) => x.check === "Straight quote");
  assert.equal(i.length, 2);
  assert.equal(i[0].bucket, "flag");
  assert.equal(i[0].ref, "1:1");
  assert.equal(quality("\\c 1\n\\p\n\\v 1 he said “hi” and the servant’s ox\n").filter((x) => x.check === "Straight quote").length, 0);
});
t("straight quote inside a FOOTNOTE is not verse prose — not flagged", () => {
  assert.equal(quality('\\c 1\n\\p\n\\v 1 word \\f + \\ft he said "x"\\f* end\n').filter((x) => x.check === "Straight quote").length, 0);
});
t("no-break space in verse prose flagged once per kind, with count", () => {
  const i = quality("\\c 1\n\\p\n\\v 1 two words and more\n").filter((x) => x.check === "Invisible character");
  assert.equal(i.length, 1);
  assert.ok(/2 invisible no-break space/.test(i[0].message));
});
t("doubled space inside one text node flagged", () => {
  const i = quality("\\c 1\n\\p\n\\v 1 two  spaces here\n").filter((x) => x.check === "Doubled space");
  assert.equal(i.length, 1);
});
t("whitespace split ACROSS alignment nodes is NOT a doubled space (JER 23:37 shape)", () => {
  // "you"'s chain carries an inner trailing space AND the inter-line break
  // flattens to a second space — rendered USFM has ONE space (measured: raw
  // JER 23 contains zero doubled spaces; the naive flatten reported 17).
  const aligned =
    '\\c 1\n\\p\n\\v 1 \\zaln-s |x-content="א"\\*\\w Thus\\w*\\zaln-e\\*\n' +
    '\\zaln-s |x-content="ב"\\*\\w you\\w* \\zaln-e\\*\n' +
    '\\zaln-s |x-content="ג"\\*\\w say\\w*\\zaln-e\\*\n';
  assert.equal(quality(aligned).filter((x) => x.check === "Doubled space").length, 0);
});
t("doubled '.' flagged with the ellipsis hint; a real ellipsis passes", () => {
  const i = quality("\\c 1\n\\p\n\\v 1 happen soon.. God will\n").filter((x) => x.check === "Doubled punctuation");
  assert.equal(i.length, 1);
  assert.ok(/ellipsis/.test(i[0].message));
  assert.equal(quality("\\c 1\n\\p\n\\v 1 wait… now\n").filter((x) => x.check === "Doubled punctuation").length, 0);
});
t("comma glued to the next word flagged; comma before UST implied-text brace passes", () => {
  const bad = quality("\\c 1\n\\p\n\\v 1 And you,devastated one\n").filter((x) => x.check === "Punctuation spacing");
  assert.equal(bad.length, 1);
  const braces = quality("\\c 1\n\\p\n\\v 1 word, {that is,} its blood\n").filter((x) => x.check === "Punctuation spacing");
  assert.equal(braces.length, 0);
});
t("space before a comma flagged; spaced closing-quote convention passes", () => {
  const bad = quality("\\c 1\n\\p\n\\v 1 word , more\n").filter((x) => x.check === "Punctuation spacing");
  assert.equal(bad.length, 1);
  // Adjacent closing quotes are conventionally space-separated (JER 27:11
  // ULT ends `.’ ” ’ ” ”`). Pair balance is lintPairedPunctuation's business,
  // not this check's.
  const conv = quality("\\c 1\n\\p\n\\v 1 he said, ‘go.’ ” more\n").filter((x) => x.check === "Punctuation spacing");
  assert.equal(conv.length, 0);
});
t("verse-leading punctuation at a poetry line break is not 'glued' (separator counts as space)", () => {
  assert.equal(quality("\\c 1\n\\q1\n\\v 1 line one,\n\\q2 and line two\n").filter((x) => x.check === "Punctuation spacing").length, 0);
});

t("a quotation spanning verses is balanced — no pair issues", () => {
  assert.equal(paired("\\c 1\n\\p\n\\v 1 he said, “first verse\n\\v 2 second verse.”\n").length, 0);
});
t("closing ” with no opener flagged at ITS verse", () => {
  const i = paired("\\c 1\n\\p\n\\v 1 plain text\n\\v 2 tail of quote.”\n");
  assert.equal(i.length, 1);
  assert.equal(i[0].check, "Paired punctuation");
  assert.equal(i[0].ref, "1:2");
  assert.ok(/no matching opening “/.test(i[0].message));
});
t("unclosed “ flagged at the OPENER's verse", () => {
  const i = paired("\\c 1\n\\p\n\\v 1 quiet start\n\\v 2 he said, “never closed\n\\v 3 more text\n");
  assert.equal(i.length, 1);
  assert.equal(i[0].ref, "1:2");
  assert.ok(/never closed/.test(i[0].message));
});
t("English continuation: “ re-opened at a \\p paragraph start is not a second opener", () => {
  const cont = "\\c 1\n\\p\n\\v 1 he said, “first paragraph\n\\p\n\\v 2 “second paragraph.”\n";
  assert.equal(paired(cont).length, 0);
});
t("a “ at a mere \\q poetry line start is a REAL opener (nested quotes), not a continuation", () => {
  // Balanced when both close…
  const ok = "\\c 1\n\\q1\n\\v 1 he said, “line one\n\\q1 “inner line” outer end”\n";
  assert.equal(paired(ok).length, 0);
  // …and the leftover is reported when they don't (LIFO: the line-start “
  // matched the first ”, so the leftover is verse 1's opener).
  const bad = "\\c 1\n\\q1\n\\v 1 he said, “line one\n\\q1\n\\v 2 “inner line” outer never closes\n";
  const i = paired(bad);
  assert.equal(i.length, 1);
  assert.equal(i[0].ref, "1:1");
});
t("’ is also the apostrophe: never flagged without an open ‘", () => {
  assert.equal(paired("\\c 1\n\\p\n\\v 1 the servants’ house\n").length, 0);
});
t("unclosed ‘ flagged", () => {
  const i = paired("\\c 1\n\\p\n\\v 1 he said, ‘never closed\n");
  assert.equal(i.length, 1);
  assert.ok(/single quotation mark/.test(i[0].message));
});
t("KNOWN GAP: a possessive ’ silently closes a real ‘ (accepted, mirrors uw-content-validation)", () => {
  assert.equal(paired("\\c 1\n\\p\n\\v 1 he said, ‘James’ house is fine\n").length, 0);
});
t("brace closed by a bracket flagged both ways (JER 2:10 UST {west] shape)", () => {
  const i = paired("\\c 1\n\\p\n\\v 1 you go {west] to the islands\n");
  assert.equal(i.length, 2);
  assert.ok(i.some((x) => /closing \]/.test(x.message)));
  assert.ok(i.some((x) => /opening \{/.test(x.message)));
});
t("chapter-front (verse 0) text participates in pair matching", () => {
  // Opener parked before \v 1 (usfm-js keys it under "front") — the closer in
  // verse 1 must find it.
  assert.equal(paired("\\c 1\n\\p “front matter\n\\v 1 closes here”\n").length, 0);
});

t("unbalanced “ in note prose flagged (GEN tn 10:1 shape)", () => {
  const i = lintTnRows([tn({ note: "Here, **sons** means “descendants. The author is identifying" })]);
  assert.equal(i.filter((x) => x.check === "Unbalanced quotation marks").length, 1);
  assert.equal(i[0].rowId, "abcd");
});
t("AT-fragment quotes inside [ ] are masked, not unbalanced (GEN tn 2:18 shape)", () => {
  const i = lintTnRows([tn({ note: "Alternate translation: [Next, Yahweh who is God declared, “It is not good]" })]);
  assert.equal(i.filter((x) => x.check === "Unbalanced quotation marks").length, 0);
});
t("doubled space in a note NOT flagged — auto-fixed at export (normalizeNoteWhitespace)", () => {
  const i = lintTnRows([tn({ note: "the author  wrote this\\n  - and a list item" })]);
  assert.equal(i.filter((x) => x.check === "Doubled space").length, 0);
});
t("tC Create \\[\\[ artifact flagged as a bad combination", () => {
  const i = lintTnRows([tn({ note: "word \\[\\[link\\]\\] end" })]);
  assert.equal(i.filter((x) => x.check === "Bad character combination").length, 2);
});
t("zero-width space in a note flagged; word joiner INSIDE a Hebrew word exempt", () => {
  const zwsp = lintTnRows([tn({ note: "a zero​width space" })]);
  assert.equal(zwsp.filter((x) => x.check === "Invisible character").length, 1);
  const hebrew = lintTnRows([tn({ note: "the word בְּ⁠רֵאשִׁית here" })]);
  assert.equal(hebrew.filter((x) => x.check === "Invisible character").length, 0);
  const latin = lintTnRows([tn({ note: "a word⁠joiner here" })]);
  assert.equal(latin.filter((x) => x.check === "Invisible character").length, 1);
});
t("tq question and response get the same text-quality checks", () => {
  const i = lintTqRows([tq({ question: "What did “he say?", response: "plain answer." })]);
  assert.equal(i.filter((x) => x.check === "Unbalanced quotation marks").length, 1);
  assert.equal(i[0].rowId, "abcd");
});
t("text-quality messages never claim DCS rejects the content", () => {
  const STALE_CLAIM =
    /(?:DCS|validator|validation|whole-repo)[^.]{0,30}\b(?:reject|refus|fail|block)|\b(?:reject|refus|fail|block)\w*[^.]{0,30}(?:DCS|validator|validation|whole-repo)|(?:can'?t|cannot|won'?t|will not)\s+merge|unmergeable|block\w*\s+(?:the\s+)?merg/i;
  const all = [
    ...quality('\\c 1\n\\p\n\\v 1 bad"text,glued soon.. two  spaces here , see\n'),
    ...paired("\\c 1\n\\p\n\\v 1 “open ‘open {west]\n"),
    ...lintTnRows([tn({ note: "means “broken. And \\[\\[bad and two  spaces and​zwsp" })]),
  ];
  assert.ok(all.length >= 8, `expected a rich issue set to vet, got ${all.length}`);
  for (const i of all) {
    assert.ok(!STALE_CLAIM.test(i.message), `stale DCS-rejection claim in: ${i.message}`);
    assert.equal(i.bucket, "flag");
  }
});

// The cleanup chip's title comes from review_kind, because the flags it covers
// say opposite things and the title is the first — often only — line a
// translator reads. "Merged Door43 edit" over a row whose edit was KEPT states
// the reverse of what happened, and a reference move merged nothing at all.
t("review flag titles come from review_kind, not one hardcoded string per kind", () => {
  const title = (rows, lint) => lint(rows).filter((i) => i.check.endsWith("— verify"))[0].check;

  assert.equal(
    title([tq({ review_kind: "merge_kept", review_reason: "Your response was kept over Door43's." })], lintTqRows),
    "Kept over Door43 — verify",
    "a kept row is not titled as a merged Door43 edit",
  );
  assert.equal(
    title([tq({ review_kind: "merge_conflict", review_reason: "A Door43 edit was merged over yours." })], lintTqRows),
    "Merged Door43 edit — verify",
    "a master-wins conflict keeps its existing title",
  );
  assert.equal(
    title([twl({ review_kind: "ref_moved", review_reason: "Reference differs." })], lintTwlRows),
    "Reference differs from Door43 — verify",
    "a reference move is not reported as a merge at all",
  );
  assert.equal(
    title([tn({ review_kind: "quote", review_reason: "Adapted from a parallel passage." })], lintTnRows),
    "Adapted note — verify",
    "an unmapped flag keeps its kind's pre-existing wording",
  );
});

console.log(`\n${passed} lint tests passed`);
