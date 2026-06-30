// Sweep the GL corpus (ULT + UST) in D1 for joiner-glued alignment milestones —
// a `\zaln-s` whose x-content spans a maqqef/minus, gluing two original-language
// words into one source token (the AI-aligner defect first seen in Amos UST that
// strands the joined word in the aligner). Meant for a weekly sweep so a future
// bad AI run is caught corpus-wide, beyond the per-exported-book nightly detector.
//
// Usage (run from repo root):
//   node scripts/scan-glued-alignment.mjs            # LOCAL dev D1 (bible_editor_dev)
//   node scripts/scan-glued-alignment.mjs --remote   # PROD D1 (bible_editor)
//   node scripts/scan-glued-alignment.mjs --remote --book AMO
// Exit code 1 when any glued milestone is found (0 = clean), so a routine can alert.
//
// A cheap server-side pre-filter (instr on maqqef U+05BE + minus U+2212 — the two
// glue joiners that never occur in English target text) narrows the scan; the
// precise check then confirms the joiner sits INSIDE a `\zaln-s` x-content. Hyphen/
// dash-only glue (rare; those chars also appear in English prose, so they can't be
// cheaply pre-filtered) is still caught precisely by the nightly export detector
// (api/src/lint.ts hasGluedMilestone).

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const remote = process.argv.includes("--remote");
const bi = process.argv.indexOf("--book");
const book = bi >= 0 ? process.argv[bi + 1] : null;
const db = remote ? "bible_editor" : "bible_editor_dev";
const envFlag = remote ? "--remote --env production" : "--local";
const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "api");

const where = [
  "bible_version IN ('ULT','UST')",
  "(instr(content_json, char(1470)) > 0 OR instr(content_json, char(8722)) > 0)", // U+05BE maqqef, U+2212 minus
  book ? `book = '${book.replace(/'/g, "''")}'` : null,
].filter(Boolean).join(" AND ");
const sql = `SELECT book, chapter, verse, bible_version, content_json FROM verses WHERE ${where} ORDER BY book, chapter, verse`;

console.error(`Scanning ${remote ? "PROD" : "local"} D1 (${db})${book ? ` for ${book}` : ""}…`);
let raw;
try {
  raw = execSync(`npx wrangler d1 execute ${db} ${envFlag} --json --command "${sql.replace(/"/g, '\\"')}"`, {
    cwd: apiDir,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
} catch (e) {
  console.error("wrangler query failed:", e instanceof Error ? e.message : String(e));
  process.exit(2);
}
const jsonStart = raw.indexOf("[");
if (jsonStart < 0) { console.error("no JSON in wrangler output"); process.exit(2); }
const rows = JSON.parse(raw.slice(jsonStart)).flatMap((p) => p.results ?? []);

// The cross-word glue joiners (NOT the zero-width U+2060/U+200D that sit inside one UHB word).
const isGlue = (cp) => cp === 0x05be || cp === 0x002d || (cp >= 0x2010 && cp <= 0x2015) || cp === 0x2212;
const gluedContents = (vos) => {
  const out = [];
  const walk = (list) => {
    for (const n of list ?? []) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "milestone" && n.tag === "zaln" && typeof n.content === "string") {
        for (const ch of n.content) if (isGlue(ch.codePointAt(0))) { out.push(n.content); break; }
      }
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(vos);
  return out;
};

let total = 0;
const byBook = new Map();
for (const r of rows) {
  let vos;
  try { vos = JSON.parse(r.content_json).verseObjects; } catch { continue; }
  const glued = gluedContents(vos);
  if (!glued.length) continue;
  total += glued.length;
  byBook.set(`${r.book} ${r.bible_version}`, (byBook.get(`${r.book} ${r.bible_version}`) ?? 0) + glued.length);
  console.log(`${r.book} ${r.chapter}:${r.verse} ${r.bible_version}: ${glued.join("  |  ")}`);
}
const summary = byBook.size ? ` (${[...byBook].map(([b, n]) => `${b}=${n}`).join(", ")})` : "";
console.log(`\nGlued alignment milestones found: ${total}${summary}`);
process.exit(total > 0 ? 1 : 0);
