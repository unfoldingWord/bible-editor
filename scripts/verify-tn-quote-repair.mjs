// Safety check for the SQL that scripts/scan-tn-quotes.mjs emits.
//
// Two properties, both cheap and both worth having before writing to prod:
//   1. Every proposed quote RESOLVES against its source verse. A repair that
//      still fails the lint is worse than no repair.
//   2. The repair uses exactly the source positions the original quote already
//      referenced — it may reorder and regroup them, but it must not introduce
//      a word the note never quoted, and (except for a de-duplication) must not
//      drop one. This is what catches a mis-assigned repeated word, which the
//      `confident` flag alone does not: `confident` only rules out RE-USING a
//      position, not choosing the wrong one among several identical surfaces.
//
// Usage:
//   node --experimental-strip-types --no-warnings \
//     scripts/verify-tn-quote-repair.mjs scripts/out/dump/tn.json scripts/out/dump/src-all.json

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTnQuote, sourceWordsByRef, wordsForRow } from "../api/src/lint.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [tnPath, srcPath] = process.argv.slice(2);
if (!tnPath || !srcPath) {
  console.error("usage: node scripts/verify-tn-quote-repair.mjs <tn-dump.json> <src-dump.json>");
  process.exit(1);
}
function rowsOf(p) {
  const raw = JSON.parse(readFileSync(resolve(repoRoot, p), "utf8"));
  if (Array.isArray(raw) && Array.isArray(raw[0]?.results)) return raw[0].results;
  return raw.results ?? raw;
}

const JOINERS = /[⁠‍﻿]/g;
const SEPS = /[־׀׃,.;··:!?"“”'’‘()[\]{}—–-]+/g;
const norm = (s) => s.normalize("NFC").replace(SEPS, " ").replace(/\s+/g, " ").trim();
const bare = (s) => norm(s).replace(JOINERS, "");
const wordsOf = (q) => q.split("&").flatMap((p) => norm(p).split(" ")).filter(Boolean).map(bare);

const srcByBook = new Map();
for (const r of rowsOf(srcPath)) {
  if (!srcByBook.has(r.book)) srcByBook.set(r.book, []);
  srcByBook.get(r.book).push(r);
}
const wordsByBook = new Map();
for (const [b, rows] of srcByBook) wordsByBook.set(b, sourceWordsByRef(rows));

let repairs = 0, bad = 0;
for (const r of rowsOf(tnPath)) {
  const quote = (r.quote ?? "").trim();
  if (!quote || !/[֐-׿Ͱ-Ͽἀ-῿]/.test(quote)) continue;
  const byRef = wordsByBook.get(r.book);
  if (!byRef) continue;
  const words = wordsForRow(byRef, r.chapter, r.verse, r.ref_raw);
  if (!words.length) continue;
  const v = resolveTnQuote(quote, words);
  if (v.ok || !v.suggestion || !v.confident) continue;
  repairs++;

  const problems = [];
  const after = resolveTnQuote(v.suggestion, words);
  if (!after.ok) problems.push(`repaired quote STILL fails (${after.kind})`);

  // Multiset comparison, order-independent.
  const before = wordsOf(quote).sort();
  const fixed = wordsOf(v.suggestion).sort();
  const added = fixed.filter((w) => !before.includes(w));
  const dropped = before.filter((w) => !fixed.includes(w));
  if (added.length) problems.push(`ADDS word(s) the note never quoted: ${added.join(", ")}`);
  if (dropped.length) problems.push(`DROPS quoted word(s): ${dropped.join(", ")}`);

  if (problems.length) {
    bad++;
    console.log(`\n!! ${r.book} ${r.ref_raw} ${r.id} [${v.kind}]`);
    console.log(`   was: ${quote}`);
    console.log(`   fix: ${v.suggestion}`);
    for (const p of problems) console.log(`   -> ${p}`);
  }
}
console.log(`\nchecked ${repairs} proposed repair(s); ${bad} failed a safety property`);
process.exit(bad ? 1 : 0);
