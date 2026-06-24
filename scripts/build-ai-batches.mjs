// Build per-batch input files for the AI adaptation loop, from adapt-batch.json
// + the cached UHBs. Only FLAGGED notes (review_kind != null) need the AI. Each
// note gets the source + target verse word lists so a subagent can return an
// EXACT Isaiah surface span (validated downstream). Batches ~12 notes, grouped
// by Isaiah chapter. OFFLINE.
//
// Run: node scripts/build-ai-batches.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "out/kings-isa");
const inDir = resolve(outDir, "ai/in");
mkdirSync(inDir, { recursive: true });
const src = resolve(outDir, "src");

const nfc = (s) => (s ?? "").normalize("NFC");
// Per-verse surface word list (NFC), order preserved.
function parseUhbWords(raw) {
  const out = {};
  let ch = 0, v = 0;
  for (const line of raw.split(/\r?\n/)) {
    let m;
    if ((m = line.match(/^\\c\s+(\d+)/))) { ch = +m[1]; v = 0; continue; }
    if ((m = line.match(/^\\v\s+(\d+)/))) { v = +m[1]; out[`${ch}:${v}`] ||= []; continue; }
    const wre = /\\w\s+([^|\\]+)\|/g;
    let w;
    while ((w = wre.exec(line))) (out[`${ch}:${v}`] ||= []).push(nfc(w[1].trim()));
  }
  return out;
}

const notes = JSON.parse(readFileSync(resolve(outDir, "adapt-batch.json"), "utf8")).notes;
const kiWords = parseUhbWords(readFileSync(resolve(src, "hbo_uhb__12-2KI.usfm"), "utf8"));
const isaWords = parseUhbWords(readFileSync(resolve(src, "hbo_uhb__23-ISA.usfm"), "utf8"));

const flagged = notes.filter((n) => n.review_kind);
// group by chapter, then chunk
const byChapter = {};
for (const n of flagged) (byChapter[n.isaChapter] ||= []).push(n);

let batchNo = 0;
const manifest = [];
for (const ch of Object.keys(byChapter).sort((a, b) => +a - +b)) {
  const list = byChapter[ch];
  for (let i = 0; i < list.length; i += 12) {
    batchNo++;
    const slice = list.slice(i, i + 12);
    const items = slice.map((n) => ({
      sourceId: n.sourceId,
      sourceRef: n.sourceRef,
      isaRef: n.isaRef,
      zone: n.zone,
      support_reference: n.support_reference,
      kingsQuote: n.kingsQuote,
      deterministicQuote: n.quote,
      occurrence: n.occurrence,
      flag: n.review_reason,
      kingsNote: n.kingsNote,
      currentNote: n.note,           // deterministic note (cross-ref links already dropped→plain)
      kingsUlt: n.kingsUlt,
      isaUlt: n.isaUlt,
      kingsVerseWords: kiWords[n.sourceRef] || [],
      isaVerseWords: isaWords[n.isaRef] || [],
    }));
    const p = resolve(inDir, `batch${String(batchNo).padStart(2, "0")}.json`);
    writeFileSync(p, JSON.stringify({ batch: batchNo, isaChapter: +ch, items }, null, 2));
    manifest.push({ batch: batchNo, isaChapter: +ch, count: slice.length, file: p });
  }
}
writeFileSync(resolve(outDir, "ai", "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`flagged notes: ${flagged.length}`);
console.log(`batches: ${batchNo} (≤12 notes each), grouped by Isaiah chapter`);
manifest.forEach((m) => console.log(`  batch${String(m.batch).padStart(2, "0")} ch${m.isaChapter} (${m.count})`));
