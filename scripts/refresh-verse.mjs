// Recover a single verse's content from the original USFM in docs/samples,
// for cases where a database verse has been corrupted by an earlier round
// of buggy alignment serialization (or any other in-place damage). Emits
// a small SQL file that UPDATEs only the targeted verse — every other row
// stays untouched.
//
// Run:
//   node scripts/refresh-verse.mjs ZEC 1 10 ULT
// Then apply:
//   (cd api && npx wrangler d1 execute bible_editor --local --file=../scripts/out/refresh-ZEC-1-10-ULT.sql)
//
// version is bumped so optimistic-concurrency clients pick up the change
// on their next outbox round-trip. plain_text is recomputed from the
// usfm-js verse-objects tree using the same logic as import-book.mjs.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import usfm from "usfm-js";
import { isHeaderLabelNode, nestWordLabels } from "../api/src/importParsers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const [, , bookArg, chArg, vArg, bvArg] = process.argv;
const book = (bookArg || "").toUpperCase();
const chapter = parseInt(chArg || "", 10);
const verse = parseInt(vArg || "", 10);
const bibleVersion = (bvArg || "ULT").toUpperCase();

if (!book || !Number.isFinite(chapter) || !Number.isFinite(verse)) {
  console.error("usage: node scripts/refresh-verse.mjs <BOOK> <CHAPTER> <VERSE> [ULT|UST|UHB]");
  console.error("example: node scripts/refresh-verse.mjs ZEC 1 10 ULT");
  process.exit(1);
}

const BOOK_NUMBERS = {
  GEN: "01", EXO: "02", LEV: "03", NUM: "04", DEU: "05", JOS: "06", JDG: "07",
  RUT: "08", "1SA": "09", "2SA": "10", "1KI": "11", "2KI": "12", "1CH": "13",
  "2CH": "14", EZR: "15", NEH: "16", EST: "17", JOB: "18", PSA: "19",
  PRO: "20", ECC: "21", SNG: "22", ISA: "23", JER: "24", LAM: "25",
  EZK: "26", DAN: "27", HOS: "28", JOL: "29", AMO: "30", OBA: "31",
  JON: "32", MIC: "33", NAM: "34", HAB: "35", ZEP: "36", HAG: "37",
  ZEC: "38", MAL: "39",
  MAT: "41", MRK: "42", LUK: "43", JHN: "44", ACT: "45",
  ROM: "46", "1CO": "47", "2CO": "48", GAL: "49", EPH: "50",
  PHP: "51", COL: "52", "1TH": "53", "2TH": "54", "1TI": "55",
  "2TI": "56", TIT: "57", PHM: "58", HEB: "59", JAS: "60",
  "1PE": "61", "2PE": "62", "1JN": "63", "2JN": "64", "3JN": "65",
  JUD: "66", REV: "67",
};

const num = BOOK_NUMBERS[book];
if (!num) {
  console.error(`unknown book code: ${book}`);
  process.exit(1);
}

const samples = resolve(repoRoot, "docs/samples");
const sourcePath = (() => {
  if (bibleVersion === "ULT") return resolve(samples, `en_ult_${num}-${book}.usfm`);
  if (bibleVersion === "UST") return resolve(samples, `en_ust_${num}-${book}.usfm`);
  if (bibleVersion === "UHB") return resolve(samples, `hbo_uhb_${num}-${book}.usfm`);
  if (bibleVersion === "UGNT") return resolve(samples, `el-x-koine_ugnt_${num}-${book}.usfm`);
  return null;
})();
if (!sourcePath || !existsSync(sourcePath)) {
  console.error(`source USFM not found for ${book} ${bibleVersion}: ${sourcePath}`);
  process.exit(1);
}

const raw = readFileSync(sourcePath, "utf8");
const json = usfm.toJSON(raw);
const chapterObj = json.chapters?.[String(chapter)];
if (!chapterObj) {
  console.error(`chapter ${chapter} not present in ${sourcePath}`);
  process.exit(1);
}

// usfm-js sometimes keys verses as plain "10" or "10-12" — check the
// exact key first, then any range that covers our number.
let verseObj = chapterObj[String(verse)];
let matchedKey = String(verse);
if (!verseObj) {
  for (const k of Object.keys(chapterObj)) {
    const m = k.match(/^(\d+)-(\d+)$/);
    if (m && verse >= parseInt(m[1], 10) && verse <= parseInt(m[2], 10)) {
      verseObj = chapterObj[k];
      matchedKey = k;
      break;
    }
  }
}
if (!verseObj) {
  console.error(`verse ${verse} not present in ${book} ${chapter} (${bibleVersion})`);
  process.exit(1);
}

function extractPlainText(vObj) {
  const parts = [];
  const walk = (vos) => {
    for (const vo of vos || []) {
      // A `\sp` speaker label's text is not verse text (#1339); same skip as
      // extractPlainText in api/src/importParsers.ts and web/src/lib/usfm.ts.
      if (isHeaderLabelNode(vo)) continue;
      if (vo.text) parts.push(vo.text);
      if (vo.children) walk(vo.children);
    }
  };
  walk(vObj.verseObjects);
  return parts.join("").replace(/\s+/g, " ").trim();
}

// A `\sp` label written as words goes into its label node, as on import (#1350).
verseObj = { ...verseObj, verseObjects: nestWordLabels(verseObj.verseObjects ?? []) };
const text = extractPlainText(verseObj);
const json_blob = JSON.stringify(verseObj);
const q = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

const outDir = resolve(repoRoot, "scripts/out");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `refresh-${book}-${chapter}-${verse}-${bibleVersion}.sql`);

const now = Math.floor(Date.now() / 1000);
const lines = [
  `-- Refresh ${book} ${chapter}:${verse} (${bibleVersion}) from ${sourcePath}`,
  `-- usfm-js key: ${matchedKey}`,
  `-- Generated: ${new Date().toISOString()}`,
  `BEGIN TRANSACTION;`,
  `UPDATE verses`,
  `   SET content_json = ${q(json_blob)},`,
  `       plain_text   = ${q(text)},`,
  `       version      = version + 1,`,
  `       updated_at   = ${now}`,
  ` WHERE book = ${q(book)}`,
  `   AND chapter = ${q(chapter)}`,
  `   AND verse = ${q(verse)}`,
  `   AND bible_version = ${q(bibleVersion)};`,
  `INSERT INTO edit_log (kind, row_key, prev_version, new_version, action, payload_json)`,
  `  SELECT 'verse', ${q(`${book}/${chapter}/${verse}/${bibleVersion}`)}, version - 1, version, 'refresh-from-source', ${q(json_blob)}`,
  `    FROM verses WHERE book = ${q(book)} AND chapter = ${q(chapter)} AND verse = ${q(verse)} AND bible_version = ${q(bibleVersion)};`,
  `COMMIT;`,
];
writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
console.log(`wrote ${outPath}`);
console.log(
  `apply: (cd api && npx wrangler d1 execute bible_editor --local --file=../scripts/out/refresh-${book}-${chapter}-${verse}-${bibleVersion}.sql)`,
);
