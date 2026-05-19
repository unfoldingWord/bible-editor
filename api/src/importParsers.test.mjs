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
  parseTsv,
  refParts,
} from "./importParsers.ts";

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

console.log("\nAll parser smoke checks passed.");
