// Corpus measurement for lintAlignmentOccurrences (#764): how many alignment
// milestones declare occurrence numbers the source verse contradicts.
//
// This runs the SAME exported lint the editor shows, so the number here is the
// number of flags a translator would see. That matters: the check has no
// dismiss control, so every flag is permanent until the data is repaired.
//
// Usage (dumps produced the same way as scan-tn-quotes.mjs):
//   node --experimental-strip-types --no-warnings scripts/scan-alignment-occurrences.mjs \
//     scripts/out/dump/aligned scripts/out/dump
//
// Repair is NOT here — scripts/scan-source-occurrences.mjs already owns it via
// correctSourceOccurrences, which fixes the unambiguous appears-once case.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lintAlignmentOccurrences, sourceWordsByRef } from "../api/src/lint.ts";
import { correctSourceOccurrences } from "../web/src/lib/sourceOccurrences.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// --post-repair answers the question that decides whether this check can ship
// on by default: how many flags SURVIVE scripts/scan-source-occurrences.mjs.
// Flags the repair clears are transient; flags it cannot clear are what a
// translator is left staring at, with no dismiss control.
const postRepair = process.argv.includes("--post-repair");
const [alignedDir, srcDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!alignedDir || !srcDir) {
  console.error("usage: node scripts/scan-alignment-occurrences.mjs <aligned-dir> <src-dir>");
  process.exit(1);
}
const rowsOf = (p) => {
  const raw = JSON.parse(readFileSync(p, "utf8"));
  if (Array.isArray(raw) && Array.isArray(raw[0]?.results)) return raw[0].results;
  return raw.results ?? raw;
};

const perBook = [];
const byKind = new Map();
let total = 0;
for (const f of readdirSync(resolve(repoRoot, alignedDir)).filter((f) => f.endsWith(".json"))) {
  const book = f.replace(/\.json$/, "");
  const srcPath = resolve(repoRoot, join(srcDir, `src-${book}.json`));
  if (!existsSync(srcPath)) { console.error(`no source dump for ${book}`); continue; }
  let aligned;
  try { aligned = rowsOf(resolve(repoRoot, join(alignedDir, f))); } catch { console.error(`unreadable: ${book}`); continue; }
  const srcRows = rowsOf(srcPath);
  const byRef = sourceWordsByRef(srcRows);
  if (postRepair) {
    const srcByKey = new Map();
    for (const r of srcRows) srcByKey.set(`${r.chapter}:${r.verse}`, r);
    for (const r of aligned) {
      const src = srcByKey.get(`${r.chapter}:${r.verse}`);
      if (!src) continue;
      try {
        const vo = JSON.parse(r.content_json)?.verseObjects;
        const srcVo = JSON.parse(src.content_json)?.verseObjects;
        if (!Array.isArray(vo) || !Array.isArray(srcVo) || !srcVo.length) continue;
        const { changed, verseObjects } = correctSourceOccurrences(vo, srcVo);
        if (changed) r.content_json = JSON.stringify({ verseObjects });
      } catch { /* leave the row as-is */ }
    }
  }
  let n = 0;
  for (const version of ["ULT", "UST"]) {
    const issues = lintAlignmentOccurrences(aligned.filter((r) => r.bible_version === version), byRef);
    n += issues.length;
    for (const i of issues) byKind.set(i.check, (byKind.get(i.check) ?? 0) + 1);
  }
  if (n) perBook.push([book, n]);
  total += n;
}
perBook.sort((a, b) => b[1] - a[1]);
console.log(`total flags: ${total}`);
console.log("by kind:");
for (const [k, v] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
console.log("by book:");
for (const [b, n] of perBook) console.log(`  ${b.padEnd(5)} ${n}`);
