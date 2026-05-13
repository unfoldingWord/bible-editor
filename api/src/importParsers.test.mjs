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

console.log("\nAll parser smoke checks passed.");
