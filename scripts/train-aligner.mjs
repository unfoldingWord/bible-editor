// Offline trainer for the alignment-memory frequency table (align_freq).
//
// Fetches pinned canonical USFM (ULT/UST, from api/data/canonical.json) off
// DCS, walks the gold `\zaln-s` alignment milestones, and counts how often each
// source Strong's number aligns to each target English surface — both single
// words AND the full contiguous phrase a milestone covers (e.g. "the earth").
// Emits scripts/out/align-freq.sql.
//
// This is wordMAP's "alignment memory" reduced to per-token frequencies —
// computed here in Node so the Cloudflare Worker can serve suggestions with a
// single indexed D1 lookup instead of running an aligner at request time
// (Workers have no filesystem and ~128 MB; they can't host the engine). The
// model only changes when a new canonical version publishes: bump the ref in
// canonical.json, re-run this, apply the SQL.
//
// Run (from worktree root):
//   node scripts/train-aligner.mjs                 # curated default set
//   node scripts/train-aligner.mjs --all-ot        # all OT books in the release
//   node scripts/train-aligner.mjs --all-ot --nt   # whole released Bible
//   node scripts/train-aligner.mjs ZEC MAL         # explicit books
// Then apply:
//   npm run db:align:local       # local dev D1
//   npm run db:align:remote      # production D1

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import usfm from "usfm-js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// Standard unfoldingWord USFM filename number prefixes. OT is 01-39, NT 41-67.
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
const OT_BOOKS = Object.keys(BOOK_NUMBERS).filter((b) => +BOOK_NUMBERS[b] <= 39);
const NT_BOOKS = Object.keys(BOOK_NUMBERS).filter((b) => +BOOK_NUMBERS[b] >= 41);
const DEFAULT_SET = [
  "GEN", "EXO", "PSA", "ISA", "JER",
  "HOS", "JOL", "AMO", "OBA", "JON", "MIC", "NAM", "HAB", "ZEP", "HAG", "ZEC", "MAL",
];

const manifest = JSON.parse(
  readFileSync(resolve(repoRoot, "api/data/canonical.json"), "utf8"),
);

const args = process.argv.slice(2);
let books = [];
if (args.includes("--all-ot")) books = books.concat(OT_BOOKS);
if (args.includes("--nt")) books = books.concat(NT_BOOKS);
const explicit = args.filter((a) => !a.startsWith("--")).map((b) => b.toUpperCase());
if (explicit.length) books = explicit;
if (books.length === 0) books = DEFAULT_SET;

// Normalize a Strong's reference to a single lookup key, matching
// api/src/align.ts / web normalizeStrong: first [HG]\d+[a-z]? token (drops
// clitic prefixes like "b:"), leading zeros stripped. "" when no real Strong's.
function normStrong(raw) {
  const m = String(raw || "").match(/[HG]\d+[a-z]?/i);
  if (!m) return "";
  return m[0].toUpperCase().replace(/^([HG])0+/, "$1");
}

const SPACE = String.fromCharCode(32); // computed, never typed inside a literal
const LETTER_RE = /[\p{L}\p{M}\p{N}]/u;
// Lowercase + NFC + trim non-letter edges. "" for tokens with no letters.
function normSurface(t) {
  const s = String(t || "").normalize("NFC").toLowerCase();
  const first = s.search(LETTER_RE);
  if (first < 0) return "";
  let last = s.length - 1;
  while (last >= 0 && !LETTER_RE.test(s[last])) last--;
  return s.slice(first, last + 1);
}

// All target \w leaf surfaces under a node, in order — the English phrase a
// milestone covers (e.g. ["the","earth"] under הָאָרֶץ's H776 milestone).
function leafSurfaces(node) {
  const out = [];
  const rec = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "word" && n.tag === "w") {
      const s = normSurface(n.text);
      if (s) out.push(s);
    } else if (Array.isArray(n.children)) {
      for (const c of n.children) rec(c);
    }
  };
  rec(node);
  return out;
}

// (bible, strong, surface) counts. Fields are joined with a TAB so multi-word
// phrase surfaces (which contain spaces) survive the split at emit time.
const SEP = "\t";
const counts = new Map();
function bump(bible, strong, surface) {
  const k = bible + SEP + strong + SEP + surface;
  counts.set(k, (counts.get(k) || 0) + 1);
}

// Walk verseObjects, carrying the stack of active source Strong's from
// enclosing `\zaln-s` milestones. Each milestone contributes its full
// contiguous English phrase (multi-word, so "the earth" stays one unit); each
// `\w` word also counts toward every active Strong's (per-word memory + the
// lexicon-fallback basis). Mirrors the milestone/word shape in web alignment.ts.
function walkAlign(nodes, active, bible, stats) {
  for (const n of nodes || []) {
    if (!n || typeof n !== "object") continue;
    if (n.type === "milestone" && n.tag === "zaln") {
      const s = normStrong(n.strong);
      if (s) {
        const phrase = leafSurfaces(n);
        if (phrase.length >= 2) {
          bump(bible, s, phrase.join(SPACE));
          stats.pairs++;
        }
      }
      walkAlign(n.children || [], s ? [...active, s] : active, bible, stats);
    } else if (n.type === "word" && n.tag === "w") {
      const surf = normSurface(n.text);
      if (surf) {
        for (const s of active) {
          bump(bible, s, surf);
          stats.pairs++;
        }
      }
    } else if (Array.isArray(n.children)) {
      walkAlign(n.children, active, bible, stats);
    }
  }
}

for (const res of manifest.resources) {
  const alignedOt = [];
  const alignedNt = [];
  for (const book of books) {
    const num = BOOK_NUMBERS[book];
    if (!num) {
      console.warn(`  unknown book: ${book}`);
      continue;
    }
    const url = `https://git.door43.org/${res.repo}/raw/${res.ref}/${num}-${book}.usfm`;
    process.stdout.write(`  ${res.bible} ${book} ... `);
    let r;
    try {
      r = await fetch(url);
    } catch (e) {
      console.log(`fetch failed (${e?.message ?? e}) - skip`);
      continue;
    }
    if (!r.ok) {
      console.log(`${r.status} - not in release, skip`);
      continue;
    }
    const json = usfm.toJSON(await r.text());
    const stats = { pairs: 0 };
    let vCount = 0;
    for (const ch of Object.values(json.chapters || {})) {
      for (const v of Object.values(ch)) {
        walkAlign(v.verseObjects || [], [], res.bible, stats);
        vCount++;
      }
    }
    // A book present in the release but not yet word-aligned contributes no
    // \zaln-s pairs — exclude it so the model reflects only released+aligned
    // canon (the actual basis for suggestions).
    if (stats.pairs === 0) {
      console.log(`${vCount} verses, 0 aligned - skip (not yet aligned)`);
      continue;
    }
    (+num <= 39 ? alignedOt : alignedNt).push(book);
    console.log(`ok (${vCount} verses, ${stats.pairs} aligned words)`);
  }
  console.log(
    `${res.bible}: ${alignedOt.length + alignedNt.length} aligned books (OT ${alignedOt.length}, NT ${alignedNt.length})`,
  );
  console.log(`  OT aligned: ${alignedOt.join(SPACE) || "(none)"}`);
}

const esc = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const VALSEP = "," + SPACE;
const lines = [
  "-- Auto-generated by scripts/train-aligner.mjs. Do not edit by hand.",
  `-- Generated: ${new Date().toISOString()}`,
  `-- bibles: ${manifest.resources.map((r) => r.bible).join(VALSEP)}`,
  `-- books: ${books.join(SPACE)}`,
  "DELETE FROM align_freq;",
];
const entries = [...counts.entries()];
let phraseRows = 0;
const BATCH = 100;
for (let i = 0; i < entries.length; i += BATCH) {
  const batch = entries.slice(i, i + BATCH);
  lines.push("INSERT OR REPLACE INTO align_freq (bible, strong, surface, count) VALUES");
  lines.push(
    batch
      .map(([k, c]) => {
        const [bible, strong, surface] = k.split(SEP);
        if (surface.indexOf(SPACE) >= 0) phraseRows++;
        return "(" + [esc(bible), esc(strong), esc(surface), c].join(VALSEP) + ")";
      })
      .join("," + "\n") + ";",
  );
}

const outDir = resolve(repoRoot, "scripts/out");
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, "align-freq.sql");
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(`\nwrote ${outPath}`);
console.log(`  ${entries.length} rows (${phraseRows} phrase, ${entries.length - phraseRows} single-word)`);
console.log(`  ${(lines.join("\n").length / 1024 / 1024).toFixed(2)} MB`);
console.log("\nApply: npm run db:align:local   (or db:align:remote for production)");
