// Sweep the GL corpus (ULT + UST) in D1 for the "doubled source word" alignment
// defect — a single top-level `\zaln-s` COMPOUND card whose nested source chain
// references the SAME UHB word twice (or spans a non-contiguous UHB run), so the
// aligner renders the Hebrew doubled (JER 31:33 ULT `אֶת אֶת בֵּית`). DISTINCT
// from the maqqef-glue defect (scan-glued-alignment.mjs).
//
// Reuses the ONE detector — web/src/lib/alignment.ts detectDoubledSourceMilestones,
// UHB-anchored — so the sweep and any future import cleaner can never drift.
// Runs with strip-types.
//
// Usage (from repo root):
//   node --experimental-strip-types scripts/scan-doubled-source.mjs            # LOCAL dev D1
//   node --experimental-strip-types scripts/scan-doubled-source.mjs --remote   # PROD D1
//   node --experimental-strip-types scripts/scan-doubled-source.mjs --remote --book JER
//   node --experimental-strip-types scripts/scan-doubled-source.mjs --remote --reason duplicate
//
// Needs the UHB source per (book,chapter,verse) — read straight from D1
// (bible_version='UHB'). Exit code 1 when any issue is found (0 = clean).

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { detectDoubledSourceMilestones } from "../web/src/lib/alignment.ts";

const argv = process.argv.slice(2);
const remote = argv.includes("--remote");
const bi = argv.indexOf("--book");
const book = bi >= 0 ? argv[bi + 1] : null;
// The defect signature is `duplicate` (a card referencing the same UHB word
// twice). `noncontiguous` is exploratory only — it fires on legit UST paraphrase
// compounds that group non-adjacent Hebrew — so it is EXCLUDED by default. Pass
// `--reason noncontiguous` or `--all-reasons` to inspect it.
const ri = argv.indexOf("--reason");
const allReasons = argv.includes("--all-reasons");
const onlyReason = ri >= 0 ? argv[ri + 1] : (allReasons ? null : "duplicate");
const db = remote ? "bible_editor" : "bible_editor_dev";
const envFlag = remote ? "--remote --env production" : "--local";
const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "api");

// Books with UHB source (OT). Matches the task's corpus list.
const OT_BOOKS = "1CH 1SA 2KI AMO DAN DEU ECC EZK GEN HAB HAG HOS ISA JER LAM MIC NUM OBA PSA RUT ZEC".split(" ");
const books = book ? [book] : OT_BOOKS;

function query(sql) {
  // wrangler stdout is flaky through a pipe; capture to a string via execSync
  // (stdout pipe, stderr inherited) and slice from the first '['. Retry the
  // occasional transient CF auth/rate error (code 10000) a few times.
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    let raw;
    try {
      raw = execSync(
        `npx wrangler d1 execute ${db} ${envFlag} --json --command "${sql.replace(/"/g, '\\"')}"`,
        { cwd: apiDir, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (e) {
      lastErr = e;
      const out = String(e?.stdout ?? "");
      if (out.includes("10000") || out.includes("Authentication")) { continue; } // transient → retry
      throw e;
    }
    const i = raw.indexOf("[");
    if (i < 0) { lastErr = new Error("no JSON in wrangler output"); continue; }
    return JSON.parse(raw.slice(i)).flatMap((p) => p.results ?? []);
  }
  throw lastErr;
}

let totalIssues = 0;
let totalVerses = 0;
const byBookVersion = new Map();

for (const bk of books) {
  // Pull ULT/UST + UHB for the whole book in one query.
  const rows = query(
    `SELECT chapter, verse, bible_version, version, updated_by, content_json FROM verses ` +
    `WHERE book='${bk.replace(/'/g, "''")}' AND bible_version IN ('ULT','UST','UHB') ` +
    `ORDER BY chapter, verse, bible_version`,
  );
  // Index UHB by chapter:verse.
  const uhb = new Map();
  for (const r of rows) {
    if (r.bible_version !== "UHB") continue;
    try { uhb.set(`${r.chapter}:${r.verse}`, JSON.parse(r.content_json).verseObjects ?? []); } catch { /* skip */ }
  }
  let bookIssues = 0;
  for (const r of rows) {
    if (r.bible_version !== "ULT" && r.bible_version !== "UST") continue;
    const src = uhb.get(`${r.chapter}:${r.verse}`);
    if (!src) continue; // no UHB → can't anchor
    let vos;
    try { vos = JSON.parse(r.content_json).verseObjects ?? []; } catch { continue; }
    const issues = detectDoubledSourceMilestones(vos, src)
      .filter((iss) => !onlyReason || iss.reason === onlyReason);
    if (!issues.length) continue;
    totalVerses++;
    for (const iss of issues) {
      totalIssues++;
      bookIssues++;
      const key = `${bk} ${r.bible_version}`;
      byBookVersion.set(key, (byBookVersion.get(key) ?? 0) + 1);
      const chain = iss.sources.map((s) => `${s.strong}:${s.content}(occ${s.occurrence}@p${s.position})`).join(" › ");
      console.log(
        `${bk} ${r.chapter}:${r.verse} ${r.bible_version} [v${r.version} ub=${r.updated_by}] ${iss.reason}: ` +
        `[${chain}] → "${iss.targets.join(" ")}"`,
      );
    }
  }
  console.error(`  ${bk}: ${bookIssues} issue(s)`);
}

const summary = byBookVersion.size
  ? ` (${[...byBookVersion].map(([b, n]) => `${b}=${n}`).join(", ")})`
  : "";
console.log(`\nDoubled-source issues: ${totalIssues} across ${totalVerses} verse(s)${summary}`);
process.exit(totalIssues > 0 ? 1 : 0);
