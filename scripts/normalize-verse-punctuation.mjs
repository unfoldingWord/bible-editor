// One-time cleanup: strip leading/trailing punctuation off `\w` tokens in
// existing verses.content_json rows. Pre-existing imports were written
// with raw source-USFM contents — when the upstream ULT/UST author put
// quotes / question marks INSIDE the `\w` markers (e.g. `\w "What\w*`),
// the aligner shows those characters as part of draggable chips. Going
// forward, importParsers.ts normalizes on the way in (see PR for context);
// this script applies the same transform to data already in D1.
//
// Usage:
//   cd api && npx wrangler d1 execute bible_editor --local \
//     --command="SELECT book, chapter, verse, bible_version, content_json FROM verses" \
//     --json > ../scripts/out/verses-dump.json
//   node scripts/normalize-verse-punctuation.mjs scripts/out/verses-dump.json
//   cd api && npx wrangler d1 execute bible_editor --local \
//     --file=../scripts/out/normalize-punctuation.sql
//
// Pass --remote on both wrangler calls when cleaning up production D1.
// The version column is intentionally NOT bumped — this is a data fix,
// not an edit, and outbox / If-Match guards key off changes by users.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const inputArg = process.argv[2];
if (!inputArg) {
  console.error("usage: node scripts/normalize-verse-punctuation.mjs <verses-dump.json>");
  process.exit(1);
}
const dumpPath = resolve(process.cwd(), inputArg);

// Mirror of `normalizeWordPunctuation` in api/src/importParsers.ts —
// see that file for the rationale.
const LETTER_RE = /[\p{L}\p{M}\p{N}]/u;
function splitWordPunctuation(text) {
  const first = text.search(LETTER_RE);
  if (first < 0) return { leading: text, core: "", trailing: "" };
  let last = first;
  for (let i = text.length - 1; i >= first; i--) {
    if (LETTER_RE.test(text[i])) { last = i; break; }
  }
  return { leading: text.slice(0, first), core: text.slice(first, last + 1), trailing: text.slice(last + 1) };
}
function normalizeNode(node) {
  if (!node || typeof node !== "object") return [node];
  if (node.type === "word" && node.tag === "w" && typeof node.text === "string") {
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
  const after = normalizeWordPunctuation(before);
  const beforeStr = JSON.stringify(before);
  const afterStr = JSON.stringify(after);
  if (beforeStr === afterStr) continue;
  changed++;
  const newContent = { ...parsedContent, verseObjects: after };
  const newPlain = extractPlainText(newContent);
  updates.push(
    `UPDATE verses SET content_json = ${q(JSON.stringify(newContent))}, plain_text = ${q(newPlain)} WHERE book = ${q(book)} AND chapter = ${q(chapter)} AND verse = ${q(verse)} AND bible_version = ${q(bible_version)};`,
  );
}

const lines = [];
lines.push("-- Auto-generated by scripts/normalize-verse-punctuation.mjs.");
lines.push(`-- Source: ${dumpPath}`);
lines.push(`-- Generated: ${new Date().toISOString()}`);
lines.push(`-- Rows scanned: ${scanned}`);
lines.push(`-- Rows changed: ${changed}`);
lines.push("BEGIN TRANSACTION;");
lines.push(...updates);
lines.push("COMMIT;");

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
