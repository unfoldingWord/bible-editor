// Tests for the web mirror of canonizeQuote and its use in buildTnQuickRequest
// (issue #959: the quick note writer must send hebrewGuess in UHB bytes).
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/canonizeQuote.test.mjs
//
// Not a test framework; failures exit non-zero. Fixture is the real UHB
// JER 29:4 (hbo_uhb 24-JER.usfm), parsed by usfm-js.

import { canonizeQuote } from "./canonizeQuote.ts";
import { buildTnQuickRequest } from "./tnQuickRequest.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`ok: ${msg}`);
  }
}
const hex = (s) => [...s].map((c) => c.codePointAt(0).toString(16)).join(" ");

const w = (text, lemma, strong, morph) => ({ text, tag: "w", type: "word", lemma, strong, morph });
// Escaped on purpose: editors and tools silently NFC-normalize Hebrew
// literals, which would erase the very byte order under test.
const JER_29_4 = [
  w("\u05db\u05bc\u05b9\u05a5\u05d4", "\u05db\u05bc\u05b9\u05d4", "H3541", "He,D"),
  { type: "text", text: " " },
  w("\u05d0\u05b8\u05de\u05b7\u059b\u05e8", "\u05d0\u05b8\u05de\u05b7\u05e8", "H0559", "He,Vqp3ms"),
  { type: "text", text: " " },
  w("\u05d9\u05b0\u05d4\u05d5\u05b8\u05a5\u05d4", "\u05d9\u05b0\u05d4\u05b9\u05d5\u05b8\u05d4", "H3068", "He,Np"),
  { type: "text", text: " " },
  w("\u05e6\u05b0\u05d1\u05b8\u05d0\u0596\u05d5\u05b9\u05ea", "\u05e6\u05b8\u05d1\u05b8\u05d0", "H6635b", "He,Ncbpa"),
  { type: "text", text: " " },
  w("\u05d0\u05b1\u05dc\u05b9\u05d4\u05b5\u05a3\u05d9", "\u05d0\u05b1\u05dc\u05b9\u05d4\u05b4\u05d9\u05dd", "H0430", "He,Ncmpc"),
  { type: "text", text: " " },
  w("\u05d9\u05b4\u05e9\u05c2\u05b0\u05e8\u05b8\u05d0\u05b5\u0591\u05dc", "\u05d9\u05b4\u05e9\u05c2\u05b0\u05e8\u05b8\u05d0\u05b5\u05dc", "H3478", "He,Np"),
  { type: "text", text: " " },
  w("\u05dc\u05b0\u2060\u05db\u05b8\u05dc", "\u05db\u05bc\u05b9\u05dc", "l:H3605", "He,R:Ncmsc"),
  { type: "text", text: "\u05be" },
  w("\u05d4\u05b7\u05a8\u2060\u05d2\u05bc\u05d5\u05b9\u05dc\u05b8\u0594\u05d4", "\u05d2\u05bc\u05d5\u05b9\u05dc\u05b8\u05d4", "d:H1473", "He,Td:Ncfsa"),
  { type: "text", text: " " },
  w("\u05d0\u05b2\u05e9\u05c1\u05b6\u05e8", "\u05d0\u05b2\u05e9\u05c1\u05b6\u05e8", "H0834a", "He,Tr"),
  { type: "text", text: "\u05be" },
  w("\u05d4\u05b4\u05d2\u05b0\u05dc\u05b5\u05a5\u05d9\u05ea\u05b4\u05d9", "\u05d2\u05bc\u05b8\u05dc\u05b8\u05d4", "H1540", "He,Vhp1cs"),
  { type: "text", text: " " },
  w("\u05de\u05b4\u2060\u05d9\u05e8\u05d5\u05bc\u05e9\u05c1\u05b8\u05dc\u05b7\u0596\u05b4\u05dd", "\u05d9\u05b0\u05e8\u05d5\u05bc\u05e9\u05c1\u05b8\u05dc\u05b7\u05b4\u034f\u05dd", "m:H3389", "He,R:Np"),
  { type: "text", text: " " },
  w("\u05d1\u05bc\u05b8\u05d1\u05b6\u05bd\u05dc\u05b8\u2060\u05d4", "\u05d1\u05bc\u05b8\u05d1\u05b6\u05dc", "H0894", "He,Np:Sd"),
  { type: "text", text: "\u05c3\n\n" },
];
const uhbWords = JER_29_4.filter((n) => n.type === "word").map(({ text, strong, lemma, morph }) => ({
  text,
  strong,
  lemma,
  morph,
}));
const [KOH, AMAR] = [uhbWords[0].text, uhbWords[1].text];
const [LEKHOL, HAGGOLAH, ASHER, HIGLETI] = uhbWords.slice(6, 10).map((x) => x.text);
const MAQAF = "\u05be";

// Fixture sanity: the UHB bytes for כֹּ֥ה are dagesh-before-holam, and NFC
// reorders them — the whole reason this module exists.
assert(hex(KOH) === "5db 5bc 5b9 5a5 5d4", "fixture: UHB koh is 5db 5bc 5b9 5a5 5d4");
assert(hex(KOH.normalize("NFC")) === "5db 5b9 5bc 5a5 5d4", "fixture: NFC koh is 5db 5b9 5bc 5a5 5d4");
assert(ASHER !== ASHER.normalize("NFC"), "fixture: UHB asher differs from its NFC form");

// (1) NFC "koh amar" → UHB bytes, space preserved.
{
  const uhb = `${KOH} ${AMAR}`;
  const q = uhb.normalize("NFC");
  assert(q !== uhb, "case 1: NFC input differs from UHB bytes");
  const out = canonizeQuote(q, uhbWords);
  assert(out === uhb, `case 1: NFC quote comes out in UHB bytes (got ${hex(out)})`);
}

// (2) Maqaf-joined words keep their maqaf and match UHB bytes — both a pair
// whose NFC already equals the UHB and one (asher) whose NFC differs.
{
  const q = LEKHOL + MAQAF + HAGGOLAH;
  const out = canonizeQuote(q.normalize("NFC"), uhbWords);
  assert(out === q, "case 2: lekhol-haggolah keeps maqaf, matches UHB bytes");
  const uhb = ASHER + MAQAF + HIGLETI;
  const q2 = uhb.normalize("NFC");
  assert(q2 !== uhb, "case 2: NFC asher-higleti differs from UHB bytes");
  const out2 = canonizeQuote(q2, uhbWords);
  assert(out2 === uhb, `case 2: NFC asher-higleti → UHB bytes, maqaf preserved (got ${hex(out2)})`);
}

// (3) A token not in the verse is left as-is; its neighbour still canonizes.
{
  const stranger = "\u05e9\u05b8\u05c1\u05dc\u05d5\u05b9\u05dd".normalize("NFC"); // shalom
  const out = canonizeQuote(`${KOH.normalize("NFC")} ${stranger}`, uhbWords);
  assert(out === `${KOH} ${stranger}`, "case 3: unknown token left as-is, known token canonized");
  assert(canonizeQuote(stranger, uhbWords) === stranger, "case 3: no match → input unchanged");
  assert(canonizeQuote(stranger, []) === stranger, "case 3: no UHB words → input unchanged");
}

// (3b) Look-alike source words (issue #959 review). translationCore counts
// occurrences per byte-distinct surface, so the quote must never be moved from
// one look-alike to another. KOH_B is koh in NFC order: same text, other bytes.
{
  const KOH_B = KOH.normalize("NFC");
  const pair = [
    { text: KOH, strong: "H3541", lemma: "", morph: "" },
    { text: KOH_B, strong: "H3541", lemma: "", morph: "" },
  ];
  assert(canonizeQuote(KOH_B, pair) === KOH_B, "case 3b: byte-identical to the 2nd look-alike → kept, not moved to the 1st");
  const withJoiner = "\u05db\u2060\u05bc\u05b9\u05a5\u05d4"; // matches neither byte-exactly
  assert(canonizeQuote(withJoiner, pair) === withJoiner, "case 3b: two distinct candidates → ambiguous, left as-is");
  const bare = "\u05db\u05d4"; // consonants only: stripped tier sees both
  assert(canonizeQuote(bare, pair) === bare, "case 3b: ambiguous stripped tier → left as-is");
  assert(canonizeQuote(bare, [pair[0]]) === KOH, "case 3b: one candidate → adopted");
}

// (3c) A quote repeating a word the verse has once: the extra copy is already
// byte-identical to UHB, so it is kept, not moved to a same-consonant look-alike.
{
  const kah = "\u05db\u05b8\u05d4"; // same consonants as koh, other pointing
  const verse = [
    { text: KOH, strong: "H3541", lemma: "", morph: "" },
    { text: kah, strong: "H3541", lemma: "", morph: "" },
  ];
  assert(canonizeQuote(`${KOH} ${KOH}`, verse) === `${KOH} ${KOH}`, "case 3c: repeated byte-identical word kept");
}

// (4) buildTnQuickRequest sends hebrewGuess in UHB bytes on both paths.
{
  const nfcKoh = KOH.normalize("NFC");
  const verse = (content, plain_text) => ({ verse: 4, verse_end: null, content, plain_text });
  // ULT aligned with NFC milestone content, as AI alignments often are.
  const ultVo = [
    { type: "milestone", tag: "zaln", content: nfcKoh, strong: "H3541", children: [
      { text: "Thus", tag: "w", type: "word", occurrence: "1", occurrences: "1" },
    ] },
    { type: "text", text: " says Yahweh" },
  ];
  const data = {
    verses: {
      ULT: { 4: verse({ verseObjects: ultVo }, "Thus says Yahweh") },
      UST: { 4: verse({ verseObjects: [] }, "This is what Yahweh says") },
      UHB: { 4: verse({ verseObjects: JER_29_4 }, "") },
    },
  };
  const row = {
    book: "JER",
    chapter: 29,
    verse: 4,
    support_reference: "rc://*/ta/man/translate/figs-explicit",
    occurrence: 1,
  };

  const heb = buildTnQuickRequest({ ...row, quote: `${nfcKoh} ${AMAR}` }, data);
  assert(
    heb.ok && heb.request.hebrewGuess === `${KOH} ${AMAR}`,
    `case 4: Hebrew-mode hebrewGuess is UHB bytes (got ${heb.ok ? hex(heb.request.hebrewGuess) : heb.error.reason})`,
  );

  const eng = buildTnQuickRequest({ ...row, quote: "Thus" }, data);
  assert(
    eng.ok && eng.request.hebrewGuess === KOH,
    `case 4: English-mode hebrewGuess is UHB bytes (got ${eng.ok ? hex(eng.request.hebrewGuess) : eng.error.reason})`,
  );

  // Bridged row: exact tier only, so a consonant-only token is not rewritten.
  const bare = "\u05db\u05d4";
  const bridged = buildTnQuickRequest({ ...row, ref_raw: "29:4-5", quote: bare }, data);
  assert(bridged.ok && bridged.request.hebrewGuess === bare, "case 4: bridged row → strict, consonant-only token unchanged");
  const single = buildTnQuickRequest({ ...row, ref_raw: "29:4", quote: bare }, data);
  assert(single.ok && single.request.hebrewGuess === KOH, "case 4: single-verse row → consonant-only token adopts UHB koh");

  // No UHB verse (NT book): hebrewGuess passes through untouched.
  const noUhb = buildTnQuickRequest({ ...row, quote: `${nfcKoh} ${AMAR}` }, {
    verses: { ULT: data.verses.ULT, UST: data.verses.UST },
  });
  assert(
    noUhb.ok && noUhb.request.hebrewGuess === `${nfcKoh} ${AMAR}`,
    "case 4: no UHB words → hebrewGuess unchanged",
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall canonizeQuote tests passed");
