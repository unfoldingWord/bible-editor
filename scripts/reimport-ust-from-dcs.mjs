// Reimport script for the verse_end backfill (PR 1 follow-up). Fetches
// USFM directly from git.door43.org for a given book and emits chunked
// SQL files that wipe + reinsert the rows under the new verse_end-aware
// schema.
//
// Usage (from worktree root):
//   node scripts/reimport-ust-from-dcs.mjs ISA NUM            # UST only (the prod fix path)
//   node scripts/reimport-ust-from-dcs.mjs --all ISA NUM      # ULT + UST + UHB/UGNT (local-dev convenience)
//
// Then apply each generated SQL file:
//   (cd api && npx wrangler d1 execute bible_editor --remote --env production --file=../scripts/out/reimport-{ust,ult,uhb}-<BOOK>-NN.sql)
//   Drop `--remote --env production` for local.
//
// Only UST has multi-verse markers (\v 6-9) in the unfoldingWord corpus
// today; the --all mode exists so a fresh local checkout can populate
// every column for browser-driven smoke tests after a worktree wipes
// its D1. Safe to delete once we have a stabler reimport story.

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import usfm from "usfm-js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const args = process.argv.slice(2);
const allMode = args.includes("--all");
const books = args.filter((a) => !a.startsWith("--")).map((b) => b.toUpperCase());
if (books.length === 0) {
  console.error("usage: node scripts/reimport-ust-from-dcs.mjs [--all] <BOOK> [<BOOK>...]");
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

const NT_BOOKS = new Set([
  "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO", "GAL", "EPH",
  "PHP", "COL", "1TH", "2TH", "1TI", "2TI", "TIT", "PHM", "HEB", "JAS",
  "1PE", "2PE", "1JN", "2JN", "3JN", "JUD", "REV",
]);

// Mirror normalizeWordPunctuation from scripts/import-book.mjs so the
// content_json shape is bit-identical to a fresh `import-book.mjs ISA` run.
const LETTER_RE = /[\p{L}\p{M}\p{N}]/u;
function splitWordPunctuation(text) {
  const first = text.search(LETTER_RE);
  if (first === -1) return { leading: text, core: "", trailing: "" };
  let last = text.length - 1;
  while (last >= 0 && !LETTER_RE.test(text[last])) last--;
  return {
    leading: text.slice(0, first),
    core: text.slice(first, last + 1),
    trailing: text.slice(last + 1),
  };
}
function normalizeNode(node) {
  if (!node || typeof node !== "object") return [node];
  if (node.type === "word" && typeof node.text === "string") {
    const s = splitWordPunctuation(node.text);
    if (s.leading === "" && s.trailing === "") return [node];
    const out = [];
    if (s.leading) out.push({ type: "text", text: s.leading });
    if (s.core) out.push({ ...node, text: s.core });
    if (s.trailing) out.push({ type: "text", text: s.trailing });
    return out;
  }
  if (Array.isArray(node.children)) {
    return [{ ...node, children: node.children.flatMap(normalizeNode) }];
  }
  return [node];
}
function normalizeWordPunctuation(verseObjects) {
  if (!Array.isArray(verseObjects)) return verseObjects;
  return verseObjects.flatMap(normalizeNode);
}

function extractPlainText(verseObj) {
  const parts = [];
  const walk = (vos) => {
    for (const vo of vos || []) {
      if (vo.text) parts.push(vo.text);
      if (vo.children) walk(vo.children);
    }
  };
  walk(verseObj.verseObjects);
  return parts.join("").replace(/\s+/g, " ").trim();
}

const q = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

function urlFor(book, num, version) {
  const fname = `${num}-${book}.usfm`;
  switch (version) {
    case "ULT":
      return `https://git.door43.org/unfoldingWord/en_ult/raw/branch/master/${fname}`;
    case "UST":
      return `https://git.door43.org/unfoldingWord/en_ust/raw/branch/master/${fname}`;
    case "UHB":
      return `https://git.door43.org/unfoldingWord/hbo_uhb/raw/branch/master/${fname}`;
    case "UGNT":
      return `https://git.door43.org/unfoldingWord/el-x-koine_ugnt/raw/branch/master/${fname}`;
    default:
      throw new Error(`unknown version: ${version}`);
  }
}

async function reimportVersion(book, num, version) {
  const tag = version.toLowerCase();
  const url = urlFor(book, num, version);
  console.log(`Fetching ${url}`);
  const r = await fetch(url);
  if (!r.ok) {
    console.error(`  ${r.status} ${url} — skipping ${version}`);
    return;
  }
  const raw = await r.text();
  const json = usfm.toJSON(raw);

  const lines = [];
  lines.push(`-- Auto-generated by scripts/reimport-ust-from-dcs.mjs.`);
  lines.push(`-- Book: ${book}, version: ${version}`);
  lines.push(`-- Source: ${url}`);
  lines.push(`-- Generated: ${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`DELETE FROM verses WHERE book = ${q(book)} AND bible_version = ${q(version)};`);
  lines.push(
    `DELETE FROM book_usfm_meta WHERE book = ${q(book)} AND bible_version = ${q(version)};`,
  );

  if (Array.isArray(json.headers) && json.headers.length > 0) {
    lines.push(
      `INSERT OR REPLACE INTO book_usfm_meta (book, bible_version, headers_json) VALUES (${q(book)}, ${q(version)}, ${q(JSON.stringify(json.headers))});`,
    );
  }

  let count = 0;
  let rangeCount = 0;
  for (const chapter of Object.keys(json.chapters || {})) {
    const chNum = parseInt(chapter, 10);
    if (Number.isNaN(chNum)) continue;
    const chapterObj = json.chapters[chapter];
    for (const verseKey of Object.keys(chapterObj)) {
      const m = verseKey.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) continue;
      const vNum = parseInt(m[1], 10);
      let vEnd = null;
      if (m[2]) {
        const end = parseInt(m[2], 10);
        if (end > vNum) {
          vEnd = end;
          rangeCount++;
        }
      }
      const verseObj = chapterObj[verseKey];
      const normalized = {
        ...verseObj,
        verseObjects: normalizeWordPunctuation(verseObj.verseObjects ?? []),
      };
      const text = extractPlainText(normalized);
      const json_blob = JSON.stringify(normalized);
      lines.push(
        `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text) VALUES (${q(book)}, ${q(chNum)}, ${q(vNum)}, ${q(vEnd)}, ${q(version)}, ${q(json_blob)}, ${q(text)});`,
      );
      count++;
    }
  }

  const outDir = resolve(repoRoot, "scripts/out");
  mkdirSync(outDir, { recursive: true });
  // D1 remote `wrangler execute --file` times out on multi-MB single files
  // (D1_RESET_DO). Chunk into ~50-statement files; first chunk carries the
  // DELETE so the order is deterministic.
  const CHUNK = 50;
  const headerCount = lines.findIndex((l) => l.startsWith("INSERT INTO verses"));
  const head = lines.slice(0, headerCount);
  const inserts = lines.slice(headerCount);
  let part = 0;
  const writeChunk = (chunkLines, idx) => {
    const path = resolve(outDir, `reimport-${tag}-${book}-${String(idx).padStart(2, "0")}.sql`);
    writeFileSync(path, chunkLines.join("\n") + "\n", "utf8");
  };
  const first = [...head, ...inserts.slice(0, CHUNK)];
  writeChunk(first, part++);
  for (let i = CHUNK; i < inserts.length; i += CHUNK) {
    writeChunk(inserts.slice(i, i + CHUNK), part++);
  }
  console.log(`  ${version}: ${count} verses, ${rangeCount} ranges, ${part} chunks`);
}

async function reimportBook(book) {
  const num = BOOK_NUMBERS[book];
  if (!num) {
    console.error(`unknown book: ${book}`);
    return;
  }
  const versions = allMode
    ? ["ULT", "UST", NT_BOOKS.has(book) ? "UGNT" : "UHB"]
    : ["UST"];
  for (const v of versions) {
    await reimportVersion(book, num, v);
  }
}

for (const book of books) {
  await reimportBook(book);
}
