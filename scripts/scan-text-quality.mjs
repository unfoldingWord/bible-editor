// Measure the issue-#438 text-quality lint checks against the REAL published
// corpus (en_ult / en_ust / en_tn on DCS master) BEFORE trusting them — the
// STATE.md rule: a ported validator's fidelity is measured, not eyeballed.
// Published master is presumed mostly clean, so every hit is either a genuine
// latent defect (good — the check earns its place) or a false positive the
// check must be tuned to stop reporting.
//
// Reuses the REAL linters from api/src/lint.ts so the scan can never drift
// from what ships.
//
// Usage (from repo root):
//   node --experimental-strip-types scripts/scan-text-quality.mjs                    # default book set
//   node --experimental-strip-types scripts/scan-text-quality.mjs --books RUT,JER
//   node --experimental-strip-types scripts/scan-text-quality.mjs --examples 20      # more examples per check
//
// Exit code is ALWAYS 0 — this is a census, not a gate.

import usfm from "usfm-js";
import { lintPairedPunctuation, lintVerseTextQuality, lintTnRows, lintTqRows } from "../api/src/lint.ts";
import { BOOK_NUMBERS } from "../api/src/dcsSources.ts";

const argv = process.argv.slice(2);
const bi = argv.indexOf("--books");
const ei = argv.indexOf("--examples");
const MAX_EXAMPLES = ei >= 0 ? Number(argv[ei + 1]) : 8;
// Default set exercises the risky shapes: prose dialogue (GEN, RUT), poetry
// (PSA), deep quote nesting (ISA, JER), NT prose (MAT, JHN, ROM), apocalyptic
// bracket/number density (REV).
const BOOKS = bi >= 0 ? argv[bi + 1].split(",").map((b) => b.trim().toUpperCase()) : ["GEN", "RUT", "PSA", "ISA", "JER", "MAT", "JHN", "ROM", "REV"];

const DCS = "https://git.door43.org";

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

// usfm-js whole-book JSON -> VerseRow-shaped objects (content_json per verse),
// mirroring what import-book.mjs stores in D1. Chapter-front material keys as
// "front" in usfm-js and verse 0 in D1.
function toVerseRows(book, bibleVersion, json) {
  const rows = [];
  for (const [chStr, verses] of Object.entries(json.chapters ?? {})) {
    const chapter = Number(chStr);
    if (!Number.isFinite(chapter)) continue;
    for (const [vStr, obj] of Object.entries(verses)) {
      const verse = vStr === "front" ? 0 : Number(vStr.split("-")[0]);
      if (!Number.isFinite(verse)) continue;
      rows.push({
        book, chapter, verse, verse_end: null, bible_version: bibleVersion, version: 1,
        content_json: JSON.stringify({ verseObjects: obj.verseObjects ?? [] }),
      });
    }
  }
  return rows;
}

function parseTsv(text) {
  const lines = text.split("\n").filter((l) => l.length > 0);
  const header = lines[0].split("\t");
  return lines.slice(1).map((l) => {
    const cells = l.split("\t");
    const row = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

const NEW_CHECKS = new Set([
  "Straight quote", "Invisible character", "Doubled space", "Doubled punctuation",
  "Punctuation spacing", "Paired punctuation", "Bad character combination", "Unbalanced quotation marks",
]);

const tally = new Map(); // "check @ resourceClass" -> { count, examples: [] }
function record(book, resource, issue) {
  if (!NEW_CHECKS.has(issue.check)) return;
  const cls = resource === "ult" || resource === "ust" ? "usfm" : resource;
  const key = `${issue.check} @ ${cls}`;
  const t = tally.get(key) ?? { count: 0, examples: [] };
  t.count++;
  if (t.examples.length < MAX_EXAMPLES) t.examples.push(`${book} ${resource} ${issue.ref}  ${issue.message}`);
  tally.set(key, t);
}

let versesScanned = 0;
let rowsScanned = 0;
for (const book of BOOKS) {
  const num = BOOK_NUMBERS[book];
  if (!num) {
    console.error(`unknown book ${book}`);
    continue;
  }
  for (const resource of ["ult", "ust"]) {
    const url = `${DCS}/unfoldingWord/en_${resource}/raw/branch/master/${num}-${book}.usfm`;
    const raw = await fetchText(url);
    const rows = toVerseRows(book, resource.toUpperCase(), usfm.toJSON(raw));
    versesScanned += rows.length;
    for (const i of lintVerseTextQuality(rows)) record(book, resource, i);
    for (const i of lintPairedPunctuation(rows)) record(book, resource, i);
  }
  {
    const raw = await fetchText(`${DCS}/unfoldingWord/en_tn/raw/branch/master/tn_${book}.tsv`);
    const rows = parseTsv(raw).map((r, idx) => {
      const [ch, v] = (r.Reference ?? "").split(":");
      return {
        id: r.ID || `row${idx}`, book, chapter: Number(ch) || 0, verse: Number(v) || 0,
        ref_raw: r.Reference ?? "", support_reference: r.SupportReference || null,
        quote: r.Quote || null, occurrence: null, note: r.Note || null,
        tags: null, sort_order: idx, review_kind: null, review_reason: null,
      };
    });
    rowsScanned += rows.length;
    for (const i of lintTnRows(rows)) record(book, "tn", i);
  }
  {
    const raw = await fetchText(`${DCS}/unfoldingWord/en_tq/raw/branch/master/tq_${book}.tsv`);
    const rows = parseTsv(raw).map((r, idx) => {
      const [ch, v] = (r.Reference ?? "").split(":");
      return {
        id: r.ID || `row${idx}`, book, chapter: Number(ch) || 0, verse: Number(v) || 0,
        ref_raw: r.Reference ?? "", quote: r.Quote || null, occurrence: null,
        question: r.Question || null, response: r.Response || null,
        tags: null, sort_order: idx, review_kind: null, review_reason: null,
      };
    });
    rowsScanned += rows.length;
    for (const i of lintTqRows(rows)) record(book, "tq", i);
  }
  console.error(`scanned ${book}`);
}

console.log(`\n${BOOKS.length} books, ${versesScanned} verse rows (ULT+UST), ${rowsScanned} tn+tq rows\n`);
for (const check of NEW_CHECKS) {
  for (const cls of ["usfm", "tn", "tq"]) {
    const t = tally.get(`${check} @ ${cls}`);
    if (!t) continue;
    console.log(`${check} @ ${cls}: ${t.count}`);
    for (const ex of t.examples) console.log(`    ${ex}`);
  }
}
