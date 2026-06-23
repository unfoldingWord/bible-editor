// Throwaway analysis: measure how verbatim 2KI 18-20 ↔ ISA 36-39 are at the
// Hebrew word level, derive an evidence-based verse mapping, and estimate the
// share of 2 Kings TN Hebrew quotes that re-anchor cleanly onto Isaiah.
import { readFileSync } from "node:fs";

const nfc = (s) => (s ?? "").normalize("NFC");

// Parse a UHB USFM file → { "ch:v": [surfaceWord, ...] } using \w tokens.
function parseUhb(path) {
  const raw = readFileSync(path, "utf8");
  const out = {};
  let ch = 0, v = 0;
  for (const line of raw.split(/\r?\n/)) {
    let m;
    if ((m = line.match(/^\\c\s+(\d+)/))) { ch = +m[1]; continue; }
    if ((m = line.match(/^\\v\s+(\d+)/))) { v = +m[1]; if (!out[`${ch}:${v}`]) out[`${ch}:${v}`] = []; continue; }
    const wre = /\\w\s+([^|\\]+)\|/g;
    let w;
    while ((w = wre.exec(line))) {
      const surface = nfc(w[1].trim());
      (out[`${ch}:${v}`] ||= []).push(surface);
    }
  }
  return out;
}

// strip maqqef/cantillation-insensitive? Keep simple: compare on NFC surface,
// but also a "bare" form dropping the prefix punctuation ⁠ (U+2060 word joiner)
// and maqqef for fuzzy overlap scoring.
const bare = (w) => nfc(w).replace(/[⁠ ]/g, "").replace(/[֑-֯]/g, ""); // drop cantillation accents

function wordSet(arr) { return new Set(arr.map(bare)); }
function overlap(a, b) {
  const A = wordSet(a), B = wordSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.max(A.size, B.size);
}

const ki = parseUhb("C:/Users/benja/AppData/Local/Temp/kings-isa/uhb_2KI.usfm");
const isa = parseUhb("C:/Users/benja/AppData/Local/Temp/kings-isa/uhb_ISA.usfm");

// Candidate Isaiah verses (36-39).
const isaRefs = Object.keys(isa).filter((k) => { const c = +k.split(":")[0]; return c >= 36 && c <= 39; });

// For each 2KI verse in 18-20, find best-overlapping Isaiah verse.
const kiRefs = Object.keys(ki).filter((k) => { const c = +k.split(":")[0]; return c >= 18 && c <= 20; })
  .sort((a, b) => { const [c1,v1]=a.split(":").map(Number),[c2,v2]=b.split(":").map(Number); return c1-c2||v1-v2; });

console.log("=== Verse mapping (2KI verse → best ISA match, by Hebrew word overlap) ===");
const mapping = {};
for (const kr of kiRefs) {
  let best = null, bestScore = 0;
  for (const ir of isaRefs) {
    const s = overlap(ki[kr], isa[ir]);
    if (s > bestScore) { bestScore = s; best = ir; }
  }
  mapping[kr] = bestScore >= 0.4 ? best : null;
  const tag = bestScore >= 0.7 ? "STRONG" : bestScore >= 0.4 ? "weak " : "NONE ";
  console.log(`2KI ${kr.padEnd(6)} (${String(ki[kr].length).padStart(2)}w) -> ${tag} ${best ? "ISA "+best : "(none)"}  score=${bestScore.toFixed(2)}`);
}

// Quote-match rate: for each 2KI TN note in 18-20 with a Hebrew quote, check
// whether the quote's words form a contiguous subsequence of the mapped Isaiah
// verse's word list (so occurrence can be recomputed).
const tsv = readFileSync("C:/Users/benja/AppData/Local/Temp/kings-isa/tn_2KI.tsv", "utf8").split(/\r?\n/);
const header = tsv[0].split("\t");
const col = (name) => header.indexOf(name);
let total = 0, mappedVerse = 0, quoteClean = 0, quoteFuzzy = 0, quoteFail = 0, noQuote = 0;
const failures = [];
for (const line of tsv.slice(1)) {
  if (!line) continue;
  const c = line.split("\t");
  const ref = c[col("Reference")];
  const [chS, vS] = ref.split(":");
  const ch = +chS;
  if (!(ch >= 18 && ch <= 20)) continue;
  if (!/^\d+$/.test(vS || "")) continue; // skip intro rows
  total++;
  const tgt = mapping[ref];
  if (!tgt) continue;
  mappedVerse++;
  const quote = (c[col("Quote")] || "").trim();
  if (!quote) { noQuote++; continue; }
  // quote may use & to separate discontiguous spans
  const spans = quote.split("&").map((s) => s.trim()).filter(Boolean);
  const isaWords = isa[tgt].map(bare);
  let allFound = true, anyFuzzy = false;
  for (const span of spans) {
    const qWords = span.split(/[\s־]+/).map(bare).filter(Boolean);
    // contiguous subsequence search
    let found = false;
    for (let i = 0; i + qWords.length <= isaWords.length; i++) {
      let ok = true;
      for (let j = 0; j < qWords.length; j++) if (isaWords[i+j] !== qWords[j]) { ok = false; break; }
      if (ok) { found = true; break; }
    }
    if (!found) {
      // fuzzy: all quote words present somewhere in verse?
      const set = new Set(isaWords);
      if (qWords.every((w) => set.has(w))) anyFuzzy = true;
      else { allFound = false; }
    }
  }
  if (allFound && !anyFuzzy) quoteClean++;
  else if (allFound || anyFuzzy) { quoteFuzzy++; }
  else { quoteFail++; failures.push(`${ref}->${tgt}  Q=${quote.slice(0,30)}`); }
}

console.log("\n=== Quote re-anchor feasibility (2KI 18-20 notes) ===");
console.log(`total notes:            ${total}`);
console.log(`verse has ISA parallel: ${mappedVerse}  (${total-mappedVerse} have NO parallel verse)`);
console.log(`  no Hebrew quote:      ${noQuote}`);
console.log(`  quote CLEAN (exact contiguous match): ${quoteClean}`);
console.log(`  quote FUZZY (words present, maybe reordered/split): ${quoteFuzzy}`);
console.log(`  quote FAIL (not found in ISA verse):  ${quoteFail}`);
console.log("\n=== Sample quote failures (text differs here) ===");
for (const f of failures.slice(0, 25)) console.log("  " + f);
