// One-time cleanup for existing verses.content_json rows. Applies the SAME two
// transforms importParsers.ts runs on import (imported below, not
// re-implemented):
//   1. normalizeWordPunctuation — strip leading/trailing punctuation off `\w`
//      tokens (e.g. `\w "What\w*` → `"` + `\w What\w*`).
//   2. splitGluedAlignmentWords — de-glue AI-introduced punctuation-spanning
//      `\w` tokens (e.g. `\w out”—the\w*`), lifting the freed words out of
//      their `\zaln-s` so they fall to unaligned for human review.
// Pre-existing imports were written before these guards landed; this heals the
// data already in D1.
//
// Usage (run from repo root; --experimental-strip-types lets this .mjs import
// the .ts transforms directly, same as the *.test.mjs runners):
//   cd api && npx wrangler d1 execute bible_editor --local \
//     --command="SELECT book, chapter, verse, bible_version, content_json FROM verses" \
//     --json > ../scripts/out/verses-dump.json
//   node --experimental-strip-types --no-warnings scripts/normalize-verse-punctuation.mjs scripts/out/verses-dump.json
//   cd api && npx wrangler d1 execute bible_editor --local \
//     --file=../scripts/out/normalize-punctuation.sql
//
// Pass --remote (and --env production) on both wrangler calls when cleaning up
// production D1. The version column is intentionally NOT bumped — this is a
// data fix, not an edit, and outbox / If-Match guards key off user changes.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeWordPunctuation,
  splitGluedAlignmentWords,
} from "../api/src/importParsers.ts";
// Issue #686 item 5: a direct-SQL repair must not leave a row claiming its
// PREVIOUS provenance (e.g. still reading as a Door43-pristine or in-app
// human edit after a script rewrote its content_json). Same vocabulary
// scan-tn-quotes.mjs / scan-source-occurrences.mjs use for this class of fix
// (issue #768): action 'update', source 'system', actor named for the script.
import { PROVENANCE_COLUMNS, provenanceValues } from "../api/src/rowProvenance.ts";

const PROVENANCE = provenanceValues({ action: "update", source: "system", actor: "normalize-verse-punctuation" });

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const inputArg = process.argv[2];
if (!inputArg) {
  console.error("usage: node scripts/normalize-verse-punctuation.mjs <verses-dump.json>");
  process.exit(1);
}
const dumpPath = resolve(process.cwd(), inputArg);

function extractPlainText(verseObj) {
  const parts = [];
  const walk = (vos) => {
    for (const vo of vos || []) {
      if (!vo || typeof vo !== "object") continue;
      if (typeof vo.text === "string") parts.push(vo.text);
      if (Array.isArray(vo.children)) walk(vo.children);
    }
  };
  walk(verseObj.verseObjects || []);
  return parts.join("").replace(/\s+/g, " ").trim();
}

// wrangler d1 execute --json wraps the result set in an array shaped like
// `[ { results: [ { col: value, ... }, ... ], success: true, ... } ]`.
const raw = readFileSync(dumpPath, "utf8");
const parsed = JSON.parse(raw);
const rows = Array.isArray(parsed) && parsed[0]?.results
  ? parsed[0].results
  : Array.isArray(parsed)
    ? parsed
    : parsed.results || [];

if (!Array.isArray(rows) || rows.length === 0) {
  console.error(`no rows found in ${dumpPath}`);
  process.exit(1);
}

const q = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

// Constant across every repaired row, so build the SET/VALUES fragments once.
const PROVENANCE_SET_SQL = PROVENANCE_COLUMNS.map((col, i) => `${col} = ${q(PROVENANCE[i])}`).join(", ");

const updates = [];
let scanned = 0;
let changed = 0;
for (const row of rows) {
  scanned++;
  const { book, chapter, verse, bible_version, content_json } = row;
  if (!content_json) continue;
  let parsedContent;
  try {
    parsedContent = JSON.parse(content_json);
  } catch {
    console.warn(`  · skip ${book} ${chapter}:${verse} ${bible_version} — bad JSON`);
    continue;
  }
  const before = parsedContent.verseObjects;
  if (!Array.isArray(before)) continue;
  const after = splitGluedAlignmentWords(normalizeWordPunctuation(before));
  const beforeStr = JSON.stringify(before);
  const afterStr = JSON.stringify(after);
  if (beforeStr === afterStr) continue;
  changed++;
  const newContent = { ...parsedContent, verseObjects: after };
  const newPlain = extractPlainText(newContent);
  updates.push(
    `UPDATE verses SET content_json = ${q(JSON.stringify(newContent))}, plain_text = ${q(newPlain)}, ${PROVENANCE_SET_SQL} WHERE book = ${q(book)} AND chapter = ${q(chapter)} AND verse = ${q(verse)} AND bible_version = ${q(bible_version)};`,
  );
  // Deliberately NO edit_log row (codex review on PR #784). Both history
  // readers (verses.ts, rows.ts) filter `new_version IS NOT NULL`, and this
  // script does not bump `version` (see the header comment on why: avoiding
  // spurious 409s for concurrent translators). An edit_log row here would
  // carry `new_version = NULL` and be silently invisible to the history
  // dialog — dead data claiming to be an audit trail. The provenance stamp
  // above is the real, durable trace of this repair, matching the same
  // no-edit_log choice already made for bulk verse writes elsewhere
  // (api/src/bookImport.ts's insertVerses, scripts/reimport-ust-from-dcs.mjs).
}

const lines = [];
lines.push("-- Auto-generated by scripts/normalize-verse-punctuation.mjs.");
lines.push(`-- Source: ${dumpPath}`);
lines.push(`-- Generated: ${new Date().toISOString()}`);
lines.push(`-- Rows scanned: ${scanned}`);
lines.push(`-- Rows changed: ${changed}`);
// No explicit BEGIN/COMMIT: D1 rejects raw transaction statements over
// --remote, and `wrangler d1 execute --file` already applies the batch
// atomically (rolls back to the original state if any statement fails).
lines.push(...updates);

const outDir = resolve(repoRoot, "scripts/out");
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, "normalize-punctuation.sql");
writeFileSync(outPath, lines.join("\n") + "\n");

console.log(`wrote ${outPath}`);
console.log(`  rows scanned: ${scanned}`);
console.log(`  rows changed: ${changed}`);
if (changed === 0) {
  console.log("\nNo cleanup needed — every verse is already normalized.");
} else {
  console.log("\nApply:  cd api && npx wrangler d1 execute bible_editor --local --file=../scripts/out/normalize-punctuation.sql");
}
