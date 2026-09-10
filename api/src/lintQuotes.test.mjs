// Unit tests for lintTnQuotes / lintAlignmentOccurrences in lint.ts (#763, #764).
// Run from api/:
//   node --experimental-strip-types --no-warnings src/lintQuotes.test.mjs
//
// Not a test framework; a failed assert exits non-zero.
//
// Every fixture below is REAL data pulled from Door43 master, not invented —
// these are the exact rows unfoldingWord's occurrence checker reported for ZEC.
// The calibration that matters: a matcher too strict on maqqef or on Hebrew
// paseq / Greek punctuation reports thousands of false positives (earlier
// drafts hit 162 and then 6,387 corpus-wide). The passing cases here are the
// guard against that regression, and they matter more than the failing ones.

import { lintTnQuotes, lintAlignmentOccurrences, resolveTnQuote } from "./lint.ts";

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; return; }
  console.log(`  ok: ${msg}`);
}

// ── Fixture helpers ─────────────────────────────────────────────────────────

/** A source verse row whose verseObjects are plain `\w` words. */
function sourceVerse(chapter, verse, words) {
  return {
    book: "ZEC", chapter, verse, verse_end: null, bible_version: "UHB",
    content_json: JSON.stringify({
      verseObjects: words.map((text) => ({ type: "word", tag: "w", text })),
    }),
    plain_text: null, version: 1, updated_by: null, updated_at: 0,
  };
}

/** An aligned target verse: milestones described as {content, occurrence, occurrences, words}. */
function alignedVerse(chapter, verse, version, milestones) {
  return {
    book: "ZEC", chapter, verse, verse_end: null, bible_version: version,
    content_json: JSON.stringify({
      verseObjects: milestones.map((m) => ({
        type: "milestone", tag: "zaln",
        content: m.content, occurrence: m.occurrence, occurrences: m.occurrences,
        children: (m.words ?? ["x"]).map((t) => ({ type: "word", tag: "w", text: t })),
      })),
    }),
    plain_text: null, version: 1, updated_by: null, updated_at: 0,
  };
}

function tn(id, chapter, verse, quote) {
  return {
    id, book: "ZEC", chapter, verse, ref_raw: `${chapter}:${verse}`, tags: null,
    support_reference: null, quote, occurrence: 1, note: "n", sort_order: 1,
    version: 1, restored_from_version: null, updated_by: null, updated_at: 0,
    deleted_at: null, trashed_at: null,
  };
}

const only = (rows, src) => lintTnQuotes(rows, src);

// ── ZEC 4:10 — word joiners stripped (the `BYTES` class) ────────────────────
// UHB has הָ⁠אֶ֧בֶן with U+2060 between prefix and stem; the published quote
// does not. Restoring the joiners makes it match, so this must be reported as
// a joiner problem specifically, not a generic "not found".
{
  const src = [sourceVerse(4, 10, ["וְ⁠רָא֞וּ", "אֶת", "הָ⁠אֶ֧בֶן", "הַ⁠בְּדִ֛יל", "בְּ⁠יַ֥ד"])];
  const bad = only([tn("p47e", 4, 10, "הָאֶ֧בֶן הַבְּדִ֛יל")], src);
  assert(bad.length === 1, "ZEC 4:10 stripped word joiners is flagged");
  assert(bad[0]?.check === "Quote is missing word joiners present in the source",
    "ZEC 4:10 is reported as a joiner problem, not a generic miss");

  const good = only([tn("p47e", 4, 10, "הָ⁠אֶ֧בֶן הַ⁠בְּדִ֛יל")], src);
  assert(good.length === 0, "same quote WITH the joiners passes");
}

// ── ZEC 8:1 — English word order, first word repeated (`ORDER+DUP`) ─────────
// The quote builder walked the ULT's English ("And … came", both aligned to
// וַיְהִי) and emitted the same source word twice.
{
  const src = [sourceVerse(8, 1, ["וַ⁠יְהִ֛י", "דְּבַר", "יְהוָ֥ה", "צְבָא֖וֹת", "לֵ⁠אמֹֽר"])];
  const bad = only([tn("hysv", 8, 1, "וַ⁠יְהִ֛י דְּבַר יְהוָ֥ה צְבָא֖וֹת וַ⁠יְהִ֛י")], src);
  assert(bad.length === 1, "ZEC 8:1 duplicated source word is flagged");
  assert(bad[0]?.check === "Quote repeats a source word", "ZEC 8:1 reported as a duplicate");
  assert(bad[0]?.message.includes("וַ⁠יְהִ֛י דְּבַר יְהוָ֥ה צְבָא֖וֹת"),
    "ZEC 8:1 suggests the de-duplicated quote");
}

// ── ZEC 10:3 — two words in English order (`ORDER`) ─────────────────────────
// ULT reads "my nose burns"; Hebrew is חָרָה אַפִּי.
{
  const src = [sourceVerse(10, 3, ["עַל", "הָֽ⁠רֹעִים֙", "חָרָ֣ה", "אַפִּ֔⁠י", "וְ⁠עַל"])];
  const bad = only([tn("lqu5", 10, 3, "אַפִּ֔⁠י חָרָ֣ה")], src);
  assert(bad[0]?.check === "Quote words are not in source order", "ZEC 10:3 reported as misordered");
  assert(bad[0]?.message.includes("חָרָ֣ה אַפִּ֔⁠י"), "ZEC 10:3 suggests source order");

  assert(only([tn("lqu5", 10, 3, "חָרָ֣ה אַפִּ֔⁠י")], src).length === 0,
    "the corrected ZEC 10:3 quote passes");
}

// ── ZEC 10:6 — discontiguous parts joined by a space, missing ` & ` ─────────
{
  const src = [sourceVerse(10, 6, ["וְ⁠גִבַּרְתִּ֣י", "אֶת", "בֵּ֣ית", "יְהוּדָ֗ה", "וְ⁠אֶת", "בֵּ֤ית", "יוֹסֵף֙"])];
  const bad = only([tn("wb7s", 10, 6, "אֶת בֵּ֣ית יְהוּדָ֗ה בֵּ֤ית & יוֹסֵף֙")], src);
  assert(bad[0]?.check === "Quote parts are discontiguous but not separated by &",
    "ZEC 10:6 reported as a missing & gap");
}

// ── ZEC 9:13 — a truncated word is simply absent ────────────────────────────
{
  const src = [sourceVerse(9, 13, ["כִּֽי", "דָרַ֨כְתִּי", "לִ֜⁠י"])];
  const bad = only([tn("tvqc", 9, 13, "כִּֽ")], src);
  assert(bad[0]?.check === "Quote does not appear in the source verse",
    "ZEC 9:13 truncated word reported as absent");
}

// ── CALIBRATION: things that must NOT be flagged ────────────────────────────
{
  // en_tn writes a space where the UHB has a maqqef. Tolerated everywhere.
  const src = [sourceVerse(6, 8, ["הַ⁠יּֽוֹצְאִים֙", "אֶל", "אֶ֣רֶץ", "צָפ֔וֹן"])];
  assert(only([tn("ru7v", 6, 8, "הַ⁠יּֽוֹצְאִים֙ אֶל־אֶ֣רֶץ צָפ֔וֹן")], src).length === 0,
    "maqqef in the quote where the source has separate words passes");
  assert(only([tn("ru7v", 6, 8, "הַ⁠יּֽוֹצְאִים֙ אֶל אֶ֣רֶץ צָפ֔וֹן")], src).length === 0,
    "space in the quote where the source has a maqqef passes");
}
{
  // Hebrew paseq inside a quote is punctuation, not a word.
  const src = [sourceVerse(1, 1, ["אֲשֶׁ֤ר", "לֹ֥א", "הָלַךְ֮"])];
  assert(only([tn("n9y3", 1, 1, "אֲשֶׁ֤ר ׀ לֹ֥א הָלַךְ֮")], src).length === 0,
    "Hebrew paseq in a quote is treated as a separator");
}
{
  // NFC vs the UHB's legacy dagesh-before-vowel order is not a defect.
  const legacy = "ב" + "ּ" + "ִ"; // dagesh then hiriq (UHB storage)
  const nfcForm = ("ב" + "ּ" + "ִ").normalize("NFC"); // hiriq then dagesh
  assert(legacy !== nfcForm, "fixture really is byte-distinct");
  const src = [sourceVerse(2, 2, [legacy, "טוֹב"])];
  assert(only([tn("x", 2, 2, `${nfcForm} טוֹב`)], src).length === 0,
    "NFC combining-mark order matches the UHB's legacy order");
}
{
  // Greek punctuation inside a quote must not break the match.
  const src = [sourceVerse(3, 3, ["υἱοῦ", "Δαυεὶδ", "υἱοῦ", "Ἀβραάμ"])];
  assert(only([tn("g1", 3, 3, "υἱοῦ Δαυεὶδ, υἱοῦ Ἀβραάμ")], src).length === 0,
    "Greek comma inside a quote is treated as a separator");
}
{
  // A genuinely discontiguous quote, correctly written with &, passes.
  const src = [sourceVerse(7, 5, ["הֲ⁠צ֥וֹם", "צַמְתֻּ֖⁠נִי", "אָֽנִי", "וְ⁠כִ֥י"])];
  assert(only([tn("q", 7, 5, "הֲ⁠צ֥וֹם צַמְתֻּ֖⁠נִי & אָֽנִי")], src).length === 0,
    "a correct discontiguous quote with & passes");
}
{
  // No source verse → skipped, never flagged.
  assert(only([tn("z", 99, 1, "אֲשֶׁ֤ר")], []).length === 0,
    "a row whose source verse is absent is skipped, not flagged");
  // English support text in the quote field is a different check.
  assert(only([tn("z", 4, 10, "the stone of tin")], [sourceVerse(4, 10, ["אֶת"])]).length === 0,
    "a non-Hebrew/Greek quote is left to other checks");
}

// ── Verse-range references ──────────────────────────────────────────────────
// A tn row stores only the START verse; the range lives in ref_raw ("1:5-6").
// Checking such a quote against verse 5 alone made every word from verse 6 read
// as "not in the verse" — 185 false positives corpus-wide, nearly 3x the real
// defect count. This is the guard.
{
  const src = [sourceVerse(1, 5, ["הוֹאִ֣יל", "מֹשֶׁ֔ה"]), sourceVerse(1, 6, ["יְהוָ֧ה", "דִּבֶּ֥ר"])];
  const row = { ...tn("t7y4", 1, 5, "הוֹאִ֣יל מֹשֶׁ֔ה יְהוָ֧ה דִּבֶּ֥ר"), ref_raw: "1:5-6" };
  assert(lintTnQuotes([row], src).length === 0,
    "a quote spanning a 1:5-6 range resolves across both verses");

  // Same quote WITHOUT the range in ref_raw must still fail — the range is what
  // authorises reading verse 6, not a blanket relaxation.
  const narrow = { ...row, ref_raw: "1:5" };
  assert(lintTnQuotes([narrow], src).length === 1,
    "the same quote anchored at 1:5 only is still flagged");

  // A source verse that is itself a bridge covers every verse it spans.
  const bridged = [{ ...sourceVerse(2, 6, ["אָז", "יִבָּקַ֤ע"]), verse_end: 9 }];
  const atSeven = { ...tn("b1", 2, 7, "אָז יִבָּקַ֤ע"), ref_raw: "2:7" };
  assert(lintTnQuotes([atSeven], bridged).length === 0,
    "a note inside a \\v 6-9 source bridge finds the bridge's words");
}

// ── Confidence gate: never auto-repair an ambiguous match ───────────────────
// Real 2KI 16:17. The source has אֶת at position 4 and ו⁠את at position 9; the
// quote spells BOTH object markers ו⁠את. The first is a drifted spelling of
// position 4 but matches only position 9, so the pair looks like a duplicate —
// and de-duplicating DELETES a real word. The verdict must say so.
{
  const words = ["וַ⁠יְקַצֵּץ֩", "הַ⁠מֶּ֨לֶךְ", "אָחָ֜ז", "אֶת", "הַ⁠מִּסְגְּר֣וֹת",
    "הַ⁠מְּכֹנ֗וֹת", "וַ⁠יָּ֤סַר", "מֵֽ⁠עֲלֵי⁠הֶם֙", "ו⁠את", "הַ⁠כִּיֹּ֔ר", "וְ⁠אֶת", "הַ⁠יָּ֣ם"];
  const v = resolveTnQuote("ו⁠את־הַ⁠מִּסְגְּר֣וֹת הַ⁠מְּכֹנ֗וֹת & ו⁠את־הַ⁠כִּיֹּ֔ר & הַ⁠יָּ֣ם", words);
  assert(v.ok === false, "2KI 16:17 ambiguous quote is flagged");
  assert(v.ok === false && v.confident === false,
    "2KI 16:17 is marked NOT confident, so the repair script leaves it to a human");

  // ZEC 8:1's duplicate is the one we DO understand (English "And … came" both
  // aligned to וַיְהִי), yet it is reported unconfident too — and that is
  // deliberate. Both cases look identical to the matcher: a quote word that can
  // only be placed on an already-claimed source position. Nothing in the data
  // separates "the English repeated it" from "this is a misspelling of the word
  // next door". Since guessing wrong DELETES scripture text, every duplicate
  // goes to a human, with the proposal printed. There are 10 of them corpus-wide.
  const zec = resolveTnQuote("וַ⁠יְהִ֛י דְּבַר יְהוָ֥ה צְבָא֖וֹת וַ⁠יְהִ֛י",
    ["וַ⁠יְהִ֛י", "דְּבַר", "יְהוָ֥ה", "צְבָא֖וֹת", "לֵ⁠אמֹֽר"]);
  assert(zec.ok === false && zec.confident === false,
    "ZEC 8:1's duplicate is also held back for review, not auto-repaired");
  assert(zec.ok === false && zec.suggestion === "וַ⁠יְהִ֛י דְּבַר יְהוָ֥ה צְבָא֖וֹת",
    "…but the corrected quote is still proposed for the reviewer");

  // Order and gap fixes, which never re-use a position, stay automatic.
  const order = resolveTnQuote("אַפִּ֔⁠י חָרָ֣ה", ["חָרָ֣ה", "אַפִּ֔⁠י"]);
  assert(order.ok === false && order.confident === true,
    "a pure re-ordering is auto-repairable");
}

// ── ZEC 9:13, the truncated word Rich Mahn asked about ──────────────────────
// The quote is `כִּֽ`; the UHB word is `כִּֽי`. The tool DETECTS it but must not
// invent the missing letter — it routes to manual review with no suggestion.
{
  const words = ["כִּֽי", "דָרַ֨כְתִּי", "לִ֜⁠י"];
  const broken = resolveTnQuote("כִּֽ", words);
  assert(broken.ok === false && broken.kind === "absent", "ZEC 9:13 `כִּֽ` is flagged as absent");
  assert(broken.ok === false && broken.suggestion === "",
    "ZEC 9:13 offers NO suggestion — the tool never invents source text");
  assert(resolveTnQuote("כִּֽי", words).ok === true, "the corrected `כִּֽי` resolves");
}

// ── Alignment occurrence invariant (#764) ───────────────────────────────────
{
  const src = [sourceVerse(8, 1, ["וַ⁠יְהִ֛י", "דְּבַר", "יְהוָ֥ה", "צְבָא֖וֹת", "לֵ⁠אמֹֽר"])];

  // Real ULT ZEC 8:1: וַ⁠יְהִ֛י carries occ=1/1 AND occ=2/1.
  const ult = [alignedVerse(8, 1, "ULT", [
    { content: "וַ⁠יְהִ֛י", occurrence: 1, occurrences: 1, words: ["And"] },
    { content: "דְּבַר", occurrence: 1, occurrences: 1, words: ["the", "word"] },
    { content: "וַ⁠יְהִ֛י", occurrence: 2, occurrences: 1, words: ["came"] },
  ])];
  const bad = lintAlignmentOccurrences(ult, src);
  assert(bad.length === 1, "ULT ZEC 8:1 out-of-range occurrence is flagged");
  assert(bad[0]?.check === "Alignment occurrence out of range",
    "ULT ZEC 8:1 reported as out of range");

  // Real UST ZEC 1:16 shape: declares 2 occurrences of a word present once.
  const src16 = [sourceVerse(1, 16, ["יְהוָ֗ה", "נְאֻ֖ם", "יְהוָ֣ה"])];
  const ust = [alignedVerse(1, 16, "UST", [
    { content: "יְהוָ֗ה", occurrence: 1, occurrences: 2, words: ["Yahweh"] },
  ])];
  const bad16 = lintAlignmentOccurrences(ust, src16);
  assert(bad16[0]?.check === "Alignment declares the wrong occurrence count",
    "UST ZEC 1:16 accent-insensitive occurrence count is flagged");

  // Discontinuous alignment — ONE occurrence split across two milestones — is
  // legitimate and must not be flagged. This is the false-positive trap.
  const disc = [alignedVerse(8, 1, "ULT", [
    { content: "דְּבַר", occurrence: 1, occurrences: 1, words: ["the"] },
    { content: "דְּבַר", occurrence: 1, occurrences: 1, words: ["word"] },
  ])];
  assert(lintAlignmentOccurrences(disc, src).length === 0,
    "repeated milestones for one occurrence (discontinuous alignment) pass");

  // A word genuinely occurring twice, numbered 1 and 2, passes.
  const twice = [alignedVerse(1, 16, "ULT", [
    { content: "יְהוָ֗ה", occurrence: 1, occurrences: 1, words: ["Yahweh"] },
    { content: "יְהוָ֣ה", occurrence: 1, occurrences: 1, words: ["Yahweh"] },
  ])];
  assert(lintAlignmentOccurrences(twice, src16).length === 0,
    "two distinct accented surfaces each numbered 1/1 pass (the ULT convention)");
}

if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1); }
console.log("\nall lintQuotes assertions passed");
