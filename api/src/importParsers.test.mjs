// Smoke test for importParsers.ts against docs/samples/. Run from api/:
//   node --experimental-strip-types --no-warnings src/importParsers.test.mjs
//
// Asserts that the parser produces non-empty output and that filtered ranges
// behave correctly. Not a test framework; failures exit non-zero.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractVersesForRange,
  normalizeWordPunctuation,
  splitGluedAlignmentWords,
  recomputeTargetOccurrences,
  dropDoubledLeadingMarkers,
  parseTsv,
  refParts,
} from "./importParsers.ts";

// Collect target `\w` words with their alignment status (inside a `\zaln-s`?).
function collectWords(nodes, inZaln, acc) {
  for (const n of nodes ?? []) {
    if (!n || typeof n !== "object") continue;
    if (n.type === "word" && n.tag === "w") {
      acc.push({ text: n.text, occurrence: n.occurrence, occurrences: n.occurrences, aligned: inZaln });
    } else if (Array.isArray(n.children)) {
      collectWords(n.children, inZaln || n.tag === "zaln", acc);
    }
  }
  return acc;
}

const here = dirname(fileURLToPath(import.meta.url));
const samples = resolve(here, "../../docs/samples");

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// --- USFM: ULT ZEC chapter 3 ---
{
  const raw = readFileSync(resolve(samples, "en_ult_38-ZEC.usfm"), "utf8");
  const ch3 = extractVersesForRange(raw, 3, 3);
  assert(ch3.length > 0, `extractVersesForRange ULT ZEC 3 yields verses (got ${ch3.length})`);
  assert(
    ch3.every((v) => v.chapter === 3),
    `every extracted verse has chapter=3`,
  );
  const v1 = ch3.find((v) => v.verse === 1);
  assert(v1, `ZEC 3:1 exists`);
  assert(typeof v1.contentJson === "string" && v1.contentJson.length > 50, `ZEC 3:1 has non-trivial content_json`);
  assert(typeof v1.plainText === "string" && v1.plainText.length > 0, `ZEC 3:1 has plain text`);
  console.log(`  ZEC 3 ULT verse count: ${ch3.length}`);
  console.log(`  ZEC 3:1 ULT plain: ${v1.plainText.slice(0, 80)}…`);
}

// --- USFM: chapter outside range returns 0 ---
{
  const raw = readFileSync(resolve(samples, "en_ult_38-ZEC.usfm"), "utf8");
  const noMatch = extractVersesForRange(raw, 99, 99);
  assert(noMatch.length === 0, `out-of-range chapter yields no verses`);
}

// --- USFM: multi-verse block (\v 8-9 in UST ISA 7) preserves the range ---
{
  const raw = readFileSync(resolve(samples, "en_ust_23-ISA.usfm"), "utf8");
  const ch7 = extractVersesForRange(raw, 7, 7);
  const block = ch7.find((v) => v.verse === 8);
  assert(block, `UST ISA 7:8 verse row exists`);
  assert(block.verseEnd === 9, `UST ISA 7:8 carries verseEnd=9 (got ${block.verseEnd})`);
  const singleton = ch7.find((v) => v.verse === 1);
  assert(singleton && singleton.verseEnd === null, `UST ISA 7:1 is singleton (verseEnd null)`);
  // No row at verse=9 — the 8-9 block owns that slot.
  const nine = ch7.find((v) => v.verse === 9);
  assert(!nine, `UST ISA 7:9 has no standalone row (consumed by 8-9 block)`);
  console.log(`  UST ISA 7:8-9 plain: ${block.plainText.slice(0, 80)}…`);
}

// --- USFM: inverted range collapses to singleton ---
{
  const synthetic = "\\id TST\n\\c 1\n\\v 1 first\n\\v 9-8 inverted\n\\v 10 tenth\n";
  const out = extractVersesForRange(synthetic, 1, 1);
  const inv = out.find((v) => v.verse === 9);
  assert(inv, `inverted range row exists at start`);
  assert(inv.verseEnd === null, `inverted range "9-8" collapses to singleton (verseEnd null)`);
}

// --- USFM: plain singleton has verseEnd=null ---
{
  const synthetic = "\\id TST\n\\c 1\n\\v 7 plain content\n";
  const out = extractVersesForRange(synthetic, 1, 1);
  const v7 = out.find((v) => v.verse === 7);
  assert(v7, `singleton verse 7 row exists`);
  assert(v7.verseEnd === null, `singleton has verseEnd null`);
}

// --- TSV: TN ZEC ---
{
  const raw = readFileSync(resolve(samples, "en_tn_tn_ZEC.tsv"), "utf8");
  const { headers, rows } = parseTsv(raw);
  assert(headers.includes("Reference"), `TN TSV has Reference header`);
  assert(headers.includes("ID"), `TN TSV has ID header`);
  assert(headers.includes("Note"), `TN TSV has Note header`);
  const ch3 = rows.filter((r) => {
    const [ch] = refParts(r["Reference"]);
    return ch === 3;
  });
  assert(ch3.length > 0, `TN ZEC 3 has rows (got ${ch3.length})`);
  console.log(`  ZEC 3 TN row count: ${ch3.length}`);
  console.log(`  ZEC 3 TN first row: ${JSON.stringify(ch3[0]).slice(0, 120)}…`);
}

// --- TSV: TQ ZEC ---
{
  const raw = readFileSync(resolve(samples, "en_tq_tq_ZEC.tsv"), "utf8");
  const { headers, rows } = parseTsv(raw);
  assert(headers.includes("Question"), `TQ TSV has Question header`);
  const ch3 = rows.filter((r) => {
    const [ch] = refParts(r["Reference"]);
    return ch === 3;
  });
  assert(ch3.length > 0, `TQ ZEC 3 has rows (got ${ch3.length})`);
  console.log(`  ZEC 3 TQ row count: ${ch3.length}`);
}

// --- refParts edge cases ---
{
  assert(JSON.stringify(refParts("3:1")) === JSON.stringify([3, 1]), "refParts 3:1");
  assert(JSON.stringify(refParts("front:intro")) === JSON.stringify([0, 0]), "refParts front:intro");
  assert(JSON.stringify(refParts("1:intro")) === JSON.stringify([1, 0]), "refParts 1:intro");
  assert(JSON.stringify(refParts("1:1-3")) === JSON.stringify([1, 1]), "refParts 1:1-3");
  assert(JSON.stringify(refParts(null)) === JSON.stringify([0, 0]), "refParts null");
}

// --- normalizeWordPunctuation: strip leading/trailing punct off `\w` text ---
{
  // bare `\w "What\w*` at top level
  const input = [
    { type: "word", tag: "w", text: '"What', occurrence: "1", occurrences: "1" },
  ];
  const out = normalizeWordPunctuation(input);
  assert(out.length === 2, `"\\w \\"What\\w*" splits into 2 nodes (got ${out.length})`);
  assert(out[0].type === "text" && out[0].text === '"', `leading quote becomes text node`);
  assert(out[1].type === "word" && out[1].text === "What", `core text is "What"`);
}
{
  // trailing punctuation: `\w seeing?"\w*`
  const out = normalizeWordPunctuation([
    { type: "word", tag: "w", text: 'seeing?"', occurrence: "1", occurrences: "1" },
  ]);
  assert(out.length === 2, `"\\w seeing?\\"\\w*" splits into 2 nodes`);
  assert(out[0].type === "word" && out[0].text === "seeing", `core text is "seeing"`);
  assert(out[1].type === "text" && out[1].text === '?"', `trailing ?\\" becomes text node`);
}
{
  // multi-word `\w` content stays intact
  const out = normalizeWordPunctuation([
    { type: "word", tag: "w", text: "of the LORD", occurrence: "1", occurrences: "1" },
  ]);
  assert(out.length === 1, `multi-word \\w stays one node`);
  assert(out[0].text === "of the LORD", `multi-word \\w content preserved`);
}
{
  // intra-word apostrophe / hyphen — leave alone
  const out = normalizeWordPunctuation([
    { type: "word", tag: "w", text: "don't", occurrence: "1", occurrences: "1" },
    { type: "word", tag: "w", text: "hello-world", occurrence: "1", occurrences: "1" },
  ]);
  assert(out.length === 2 && out[0].text === "don't" && out[1].text === "hello-world", `apostrophe / hyphen stay intra-word`);
}
{
  // descends into milestone children (the real bug pattern)
  const out = normalizeWordPunctuation([
    {
      type: "milestone",
      tag: "zaln",
      strong: "H1",
      content: "א",
      children: [
        { type: "word", tag: "w", text: '"What', occurrence: "1", occurrences: "1" },
      ],
      endTag: "zaln-e\\*",
    },
  ]);
  assert(out.length === 1 && out[0].type === "milestone", `milestone preserved at top level`);
  const kids = out[0].children;
  assert(kids.length === 2, `milestone child \\w "What\\w* splits into 2 children`);
  assert(kids[0].type === "text" && kids[0].text === '"', `inner leading quote becomes text`);
  assert(kids[1].type === "word" && kids[1].text === "What", `inner core is "What"`);
}
{
  // all-punctuation `\w` collapses to plain text
  const out = normalizeWordPunctuation([
    { type: "word", tag: "w", text: '"', occurrence: "1", occurrences: "1" },
  ]);
  assert(out.length === 1 && out[0].type === "text" && out[0].text === '"', `all-punctuation \\w becomes text`);
}
{
  // numeric `\w 30\w*` (UST uses these for measurements) — preserve as one token
  const out = normalizeWordPunctuation([
    { type: "word", tag: "w", text: "30", occurrence: "1", occurrences: "1" },
  ]);
  assert(out.length === 1 && out[0].type === "word" && out[0].text === "30", `numeric \\w stays one token`);
}

// --- splitGluedAlignmentWords: de-glue AI punctuation-spanning `\w` tokens ---
{
  // (a) glued token inside a zaln → fragments fall out to unaligned, the
  // preceding aligned word stays put, punctuation rides as a text node.
  const out = splitGluedAlignmentWords([
    {
      type: "milestone", tag: "zaln", strong: "H1", content: "הוֹצֵאתִיהָ",
      children: [
        { type: "word", tag: "w", text: "it", occurrence: "1", occurrences: "1" },
        { type: "text", text: " " },
        { type: "word", tag: "w", text: "out”—the", occurrence: "1", occurrences: "1" },
      ],
    },
  ]);
  const words = collectWords(out, false, []);
  assert(!words.some((w) => w.text === "out”—the"), `glued "out”—the" is no longer a single \\w token`);
  const wOut = words.find((w) => w.text === "out");
  const wThe = words.find((w) => w.text === "the");
  const wIt = words.find((w) => w.text === "it");
  assert(wOut && wOut.aligned === false, `"out" falls out to unaligned`);
  assert(wThe && wThe.aligned === false, `"the" falls out to unaligned`);
  assert(wIt && wIt.aligned === true, `preceding "it" stays aligned`);
  assert(out.some((n) => n.type === "text" && n.text === "”—"), `punctuation "”—" rides as a top-level text node`);
}
{
  // (b) occurrence recompute: the freed "the" plus an existing "the" resolve to
  // a consistent 1/2 + 2/2 (the glued token carried a bogus 1/1).
  const out = splitGluedAlignmentWords([
    { type: "milestone", tag: "zaln", strong: "H1", content: "א",
      children: [{ type: "word", tag: "w", text: "out”—the", occurrence: "1", occurrences: "1" }] },
    { type: "text", text: " " },
    { type: "milestone", tag: "zaln", strong: "H2", content: "ב",
      children: [{ type: "word", tag: "w", text: "the", occurrence: "1", occurrences: "1" }] },
  ]);
  const thes = collectWords(out, false, []).filter((w) => w.text === "the");
  assert(thes.length === 2, `two "the" tokens after split (got ${thes.length})`);
  assert(thes.every((w) => w.occurrences === "2"), `both "the" share occurrences="2"`);
  assert(
    JSON.stringify(thes.map((w) => w.occurrence).sort()) === JSON.stringify(["1", "2"]),
    `"the" occurrences numbered 1 and 2`,
  );
}
{
  // (c) negatives — never split; clean input returns the SAME array (no-op).
  const multi = [{ type: "word", tag: "w", text: "of the LORD", occurrence: "1", occurrences: "1" }];
  assert(splitGluedAlignmentWords(multi) === multi, `multi-word "of the LORD" untouched (identity)`);
  const intra = [
    { type: "word", tag: "w", text: "don't", occurrence: "1", occurrences: "1" },
    { type: "word", tag: "w", text: "hello-world", occurrence: "1", occurrences: "1" },
  ];
  assert(splitGluedAlignmentWords(intra) === intra, `apostrophe / hyphen words untouched`);
  const range = [{ type: "word", tag: "w", text: "1914–1918", occurrence: "1", occurrences: "1" }];
  assert(splitGluedAlignmentWords(range) === range, `number range "1914–1918" untouched (dash between digits)`);
}

// --- integration: real ZEC 5:4 through extractVersesForRange ---
{
  const raw = readFileSync(resolve(samples, "en_ult_38-ZEC.usfm"), "utf8");
  const v4 = extractVersesForRange(raw, 5, 5).find((v) => v.verse === 4);
  assert(v4, "ZEC 5:4 ULT exists");
  const words = collectWords(JSON.parse(v4.contentJson).verseObjects, false, []);
  assert(
    !words.some((w) => w.text === "out”—the" || w.text === "Armies—“and"),
    `ZEC 5:4 glued tokens out”—the / Armies—“and are split`,
  );
  assert(words.some((w) => w.text === "out" && !w.aligned), `ZEC 5:4 "out" fell out to unaligned`);
  assert(words.some((w) => w.text === "Armies" && !w.aligned), `ZEC 5:4 "Armies" fell out to unaligned`);
  assert(words.some((w) => w.text === "the" && !w.aligned), `ZEC 5:4 freed "the" is unaligned`);
  assert(words.some((w) => w.text === "and" && !w.aligned), `ZEC 5:4 freed "and" is unaligned`);
  const thes = words.filter((w) => w.text === "the");
  assert(new Set(thes.map((w) => w.occurrences)).size === 1, `all "the" agree on the occurrences total`);
  assert(new Set(thes.map((w) => w.occurrence)).size === thes.length, `"the" occurrence numbers are unique`);
  assert(v4.plainText.includes("out”—the"), `plain_text still reads "out”—the" (split is text-invariant)`);
  console.log(`  ZEC 5:4 ULT words: ${words.length}; out/Armies unaligned, "the"×${thes.length} renumbered`);
}

// --- recomputeTargetOccurrences: heal malformed / colliding occurrence data ---
// Reproduces the real ZEC 5:3 production corruption: every `occurrences="1"`
// and a colliding (text, occurrence) pair — two "is" both stamped
// occurrence="2" — which made one highlight key match two physical words and
// hid duplicates from the colors filter. Target `\w` are nested inside
// `\zaln-s` milestones (the ULT/UST shape).
{
  const vos = [
    {
      type: "milestone", tag: "zaln", content: "זֹאת", occurrence: "1", occurrences: "1",
      children: [
        { type: "word", tag: "w", text: "This", occurrence: "1", occurrences: "1" },
        { type: "word", tag: "w", text: "is", occurrence: "2", occurrences: "1" },
      ],
    },
    { type: "text", text: " " },
    {
      type: "milestone", tag: "zaln", content: "הַגֹּנֵב", occurrence: "1", occurrences: "1",
      children: [
        { type: "word", tag: "w", text: "who", occurrence: "1", occurrences: "1" },
        { type: "word", tag: "w", text: "is", occurrence: "2", occurrences: "1" },
        { type: "word", tag: "w", text: "stealing", occurrence: "1", occurrences: "1" },
      ],
    },
  ];
  const ret = recomputeTargetOccurrences(vos);
  assert(ret === vos, `recompute mutates in place and returns the same array`);
  const words = collectWords(vos, false, []);
  const ises = words.filter((w) => w.text === "is");
  assert(ises.length === 2, `two "is" tokens collected`);
  assert(ises.every((w) => w.occurrences === "2"), `both "is" now occurrences="2" (was the bogus "1")`);
  assert(
    JSON.stringify(ises.map((w) => w.occurrence)) === JSON.stringify(["1", "2"]),
    `colliding "is" renumbered 1,2 in document order`,
  );
  const stealing = words.find((w) => w.text === "stealing");
  assert(stealing.occurrence === "1" && stealing.occurrences === "1", `singleton "stealing" is 1/1`);
  // The fix must NOT touch the source `\zaln-s` milestone occurrence.
  assert(vos[0].occurrence === "1" && vos[2].occurrence === "1", `source milestone occurrence untouched`);
}
{
  // Clean, already-correct input → values unchanged (no-op / round-trip safe).
  const vos = [
    { type: "word", tag: "w", text: "the", occurrence: "1", occurrences: "2" },
    { type: "text", text: " " },
    { type: "word", tag: "w", text: "the", occurrence: "2", occurrences: "2" },
    { type: "word", tag: "w", text: "earth", occurrence: "1", occurrences: "1" },
  ];
  recomputeTargetOccurrences(vos);
  const words = collectWords(vos, false, []);
  const thes = words.filter((w) => w.text === "the");
  assert(
    JSON.stringify(thes.map((w) => `${w.occurrence}/${w.occurrences}`)) === JSON.stringify(["1/2", "2/2"]),
    `clean "the" 1/2,2/2 unchanged (no-op)`,
  );
  const earth = words.find((w) => w.text === "earth");
  assert(earth.occurrence === "1" && earth.occurrences === "1", `clean singleton unchanged`);
}
{
  // Source UHB shape: bare `\w` (no \zaln-s) with NO occurrence attribute —
  // usfm-js leaves it undefined on import, so the two כָל in ZEC 5:3 would
  // both default to `כָל|1` and a single note quote highlights both. The read
  // boundary recomputes them by position. Mirrors the verse parsed live above.
  const vos = [
    { type: "word", tag: "w", text: "כָל" },
    { type: "text", text: "־" },
    { type: "word", tag: "w", text: "הָאָרֶץ" },
    { type: "text", text: " " },
    { type: "word", tag: "w", text: "כָל" },
    { type: "text", text: "־" },
    { type: "word", tag: "w", text: "הַגֹּנֵב" },
  ];
  recomputeTargetOccurrences(vos);
  const words = collectWords(vos, false, []);
  const kols = words.filter((w) => w.text === "כָל");
  assert(
    JSON.stringify(kols.map((w) => `${w.occurrence}/${w.occurrences}`)) === JSON.stringify(["1/2", "2/2"]),
    `undefined-occurrence source כָל numbered 1/2,2/2 (was both undefined→1)`,
  );
}
{
  // Non-array / empty input is tolerated (defensive guard for the read/write
  // boundaries that pass `parsed.verseObjects` of unknown shape).
  assert(recomputeTargetOccurrences(undefined) === undefined, `undefined passes through`);
  const empty = [];
  assert(recomputeTargetOccurrences(empty) === empty, `empty array is a no-op`);
}

// ── dropDoubledLeadingMarkers: direct unit tests for the matching / text logic ─
function isInFlow(n) {
  return !!n && (n.type === "quote" || n.type === "paragraph");
}
{
  // No predecessor (verse 1 / chapter-front) → identity, even if curr leads with
  // a marker: that marker may be the only copy.
  const curr = [{ tag: "q1", type: "quote" }, { type: "text", text: "x" }];
  assert(dropDoubledLeadingMarkers(null, curr) === curr, `null prev → identity`);
}
{
  // Prev ends with no in-flow marker → nothing to double → identity.
  const prev = [{ type: "text", text: "done." }];
  const curr = [{ tag: "q1", type: "quote" }, { type: "text", text: "x" }];
  assert(dropDoubledLeadingMarkers(prev, curr) === curr, `no trailing marker on prev → identity`);
}
{
  // Different tag (prev trails \p, curr leads \q1) → NOT a double → identity.
  const prev = [{ type: "text", text: "done." }, { tag: "p", type: "paragraph" }];
  const curr = [{ tag: "q1", type: "quote" }, { type: "text", text: "x" }];
  assert(dropDoubledLeadingMarkers(prev, curr) === curr, `mismatched tag → identity (no false positive)`);
}
{
  // Bare doubled \q1 (the real ULT/UST shape — content rides in a following
  // milestone): drop the leading marker cleanly, keep everything after.
  const prev = [{ type: "text", text: "sixteen" }, { tag: "q1", type: "quote", nextChar: " " }];
  const curr = [
    { tag: "q1", type: "quote", nextChar: " " },
    { type: "milestone", tag: "zaln", children: [{ tag: "w", type: "word", text: "Workers" }] },
  ];
  const out = dropDoubledLeadingMarkers(prev, curr);
  assert(out !== curr, `bare double → trimmed copy (not identity)`);
  assert(!isInFlow(out[0]), `bare double: leading \\q1 dropped`);
  assert(out.length === 1 && out[0].type === "milestone", `bare double: milestone content preserved`);
}
{
  // Doubled \q1 with fused verse BODY text (the AI bare-text shape): drop the
  // marker but KEEP the body as a plain text node — no data loss.
  const prev = [{ type: "text", text: "sixteen" }, { tag: "q1", type: "quote", nextChar: " " }];
  const curr = [{ tag: "q1", type: "quote", text: "In the beginning" }];
  const out = dropDoubledLeadingMarkers(prev, curr);
  assert(out.length === 1 && out[0].type === "text" && out[0].text === "In the beginning",
    `fused body text preserved as text node when marker dropped`);
  assert(!isInFlow(out[0]), `fused-body case: no leading marker remains`);
}
{
  // Stacked \qa LETTER + \q1 doubled: both markers de-dup, in order. The acrostic
  // letter on \qa repeats the trailing \qa's own text, so it is DROPPED (already
  // on verse N-1) and never doubled into the body; the \q1's fused body survives.
  const prev = [
    { type: "text", text: "third" },
    { tag: "qa", type: "quote", text: "BET\n" },
    { tag: "q1", type: "quote", nextChar: " " },
  ];
  const curr = [
    { tag: "qa", type: "quote", text: "BET " },
    { tag: "q1", type: "quote", text: "fourth" },
  ];
  const out = dropDoubledLeadingMarkers(prev, curr);
  assert(out.every((n) => !isInFlow(n)), `stacked: both \\qa and \\q1 leading markers dropped`);
  assert(!out.some((n) => n.type === "text" && /BET/.test(n.text)), `stacked: acrostic letter NOT doubled into body`);
  assert(out.some((n) => n.type === "text" && n.text === "fourth"), `stacked: \\q1 body "fourth" preserved`);
}

// ── extractVersesForRange: end-to-end collapse of doubled in-flow markers ──────
function firstVo(extract) {
  const vos = JSON.parse(extract.contentJson).verseObjects;
  return (vos && vos[0]) || null;
}
function lastSignificantVo(extract) {
  const vos = JSON.parse(extract.contentJson).verseObjects ?? [];
  for (let i = vos.length - 1; i >= 0; i--) {
    const o = vos[i];
    const t = typeof o?.text === "string" ? o.text : null;
    if (t !== null && /^\s*$/.test(t)) continue;
    return o;
  }
  return null;
}
function quoteCount(extract, tag) {
  const vos = JSON.parse(extract.contentJson).verseObjects ?? [];
  return vos.filter((n) => n.type === "quote" && (tag == null || n.tag === tag)).length;
}
{
  // (a) `\q1 \v 17 \q1` → the trailing \q1 stays on v16 (single copy), the
  // leading doubled \q1 is removed from v17; verse body is preserved.
  const raw = "\\id TST\n\\c 1\n\\v 16 sixteen content\n\\q1 \\v 17 \\q1 seventeen content\n";
  const out = extractVersesForRange(raw, 1, 1);
  const v16 = out.find((v) => v.verse === 16);
  const v17 = out.find((v) => v.verse === 17);
  assert(v16 && v17, `(a) v16 + v17 extracted`);
  const last16 = lastSignificantVo(v16);
  assert(isInFlow(last16) && last16.tag === "q1", `(a) v16 ends with its trailing \\q1`);
  assert(quoteCount(v16, "q1") === 1, `(a) v16 carries exactly one \\q1 (not doubled)`);
  assert(!isInFlow(firstVo(v17)), `(a) v17 no longer leads with a doubled \\q1`);
  assert(quoteCount(v17, "q1") === 0, `(a) v17 has no leading \\q1 marker`);
  assert(v17.plainText.includes("seventeen content"), `(a) v17 verse body preserved`);
}
{
  // (b) Legit single `\q1 \v 17` (the marker trails v16 only) is untouched.
  const raw = "\\id TST\n\\c 1\n\\v 16 sixteen content\n\\q1 \\v 17 seventeen content\n";
  const out = extractVersesForRange(raw, 1, 1);
  const v16 = out.find((v) => v.verse === 16);
  const v17 = out.find((v) => v.verse === 17);
  const last16 = lastSignificantVo(v16);
  assert(isInFlow(last16) && last16.tag === "q1", `(b) v16 keeps its single trailing \\q1`);
  assert(quoteCount(v16, "q1") === 1, `(b) v16 still has exactly one \\q1`);
  assert(!isInFlow(firstVo(v17)), `(b) legit single: v17 leads with content, not a marker`);
  assert(v17.plainText.includes("seventeen content"), `(b) v17 body intact`);
}
{
  // (c) Chapter-front holds the first \q1 copy; verse 1's leading \q1 must NEVER
  // be dropped (front is not a predecessor — the copy could be the only one).
  const raw = "\\id TST\n\\c 1\n\\q1 \\v 1 \\q1 first line\n\\v 2 second\n";
  const out = extractVersesForRange(raw, 1, 1);
  const v1 = out.find((v) => v.verse === 1);
  assert(v1, `(c) v1 extracted`);
  const first1 = firstVo(v1);
  assert(isInFlow(first1) && first1.tag === "q1", `(c) verse 1 leading \\q1 preserved`);
  assert(v1.plainText.includes("first line"), `(c) verse 1 body intact`);
}
{
  // (d) Stacked `\qa LETTER` + `\q1` doubled → both de-dup; the acrostic letter
  // is not duplicated into v4's body, and v4's body text survives.
  const raw = "\\id TST\n\\c 1\n\\v 3 third\n\\qa BET\n\\q1 \\v 4 \\qa BET \\q1 fourth content\n";
  const out = extractVersesForRange(raw, 1, 1);
  const v3 = out.find((v) => v.verse === 3);
  const v4 = out.find((v) => v.verse === 4);
  assert(v3 && v4, `(d) v3 + v4 extracted`);
  assert(quoteCount(v3) === 2, `(d) v3 keeps both trailing markers (\\qa + \\q1)`);
  assert(!isInFlow(firstVo(v4)), `(d) v4 no longer leads with a marker`);
  assert(quoteCount(v4) === 0, `(d) v4 has no leading \\qa / \\q1`);
  assert(!/BET/.test(v4.plainText), `(d) acrostic letter not doubled into v4 body`);
  assert(v4.plainText.includes("fourth content"), `(d) v4 body preserved`);
}

// ── Real-data validation: en_ust ISA carries live upstream doubled-\q1 anomalies
// at 19:9 and 54:3 (leading \q1 in storage duplicating 19:8 / 54:2's trailing
// \q1). The importer must collapse them while keeping the prior verse's copy and
// losing no verse content. (65:16 is clean in this snapshot — single marker.)
{
  const raw = readFileSync(resolve(samples, "en_ust_23-ISA.usfm"), "utf8");
  for (const [ch, prevV, anomV] of [[19, 8, 9], [54, 2, 3]]) {
    const chOut = extractVersesForRange(raw, ch, ch);
    const prev = chOut.find((v) => v.verse === prevV);
    const anom = chOut.find((v) => v.verse === anomV);
    assert(prev && anom, `ISA ${ch}: verses ${prevV} + ${anomV} extracted`);
    const lastPrev = lastSignificantVo(prev);
    assert(isInFlow(lastPrev) && lastPrev.tag === "q1", `ISA ${ch}:${prevV} keeps its trailing \\q1`);
    assert(!isInFlow(firstVo(anom)), `ISA ${ch}:${anomV} no longer leads with a doubled \\q1`);
    assert(firstVo(anom).type === "milestone", `ISA ${ch}:${anomV} content (\\zaln-s) intact after de-dup`);
    assert(anom.plainText.length > 0, `ISA ${ch}:${anomV} retains verse text`);
    console.log(`  ISA ${ch}:${anomV} doubled \\q1 collapsed; ${prevV} trailing \\q1 kept`);
  }
}

console.log("\nAll parser smoke checks passed.");
