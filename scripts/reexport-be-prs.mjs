// One-off re-export of the open `{BOOK}-be-*` PRs with the current export code
// (the USFM/TSV formatting normalizers in api/src/{usfmFormat,tsvFormat}.ts).
//
// For each open -be- PR it: reads the book's rows from PROD D1 (read-only, via
// wrangler), renders them with the SAME builders the nightly export uses
// (buildUsfm / buildTn|Tq|TwlTsv), runs the export shrink/alignment guards vs
// current master, validates the render with the unmodified DCS validators, and —
// with --commit — pushes the render onto the existing -be- branch via commitToDcs
// (the real export primitive), advancing the PR so validate-be re-runs.
//
// Dry run (no DCS writes):   node --experimental-strip-types scripts/reexport-be-prs.mjs
// True export (writes DCS):  node --experimental-strip-types scripts/reexport-be-prs.mjs --commit
//
// Auth: DCS_TOKEN (Door43). D1: wrangler prod auth (CF account).

import { writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  buildUsfm,
  buildTnTsv,
  buildTqTsv,
  buildTwlTsv,
  usfmFilename,
  commitToDcs,
  exportTsvShrinkRefused,
  usfmAlignmentShrinkRefused,
} from "../api/src/export.ts";

const COMMIT = process.argv.includes("--commit");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice("--only=".length);
const TOKEN = process.env.DCS_TOKEN;
if (!TOKEN) { console.error("DCS_TOKEN not set"); process.exit(1); }
const BASE = "https://git.door43.org/api/v1";
const H = { Authorization: `token ${TOKEN}` };
const __dirname = dirname(fileURLToPath(import.meta.url));
// Saved copies of the DCS validators (fetched into scratchpad). Optional: if
// absent, validation is skipped and the guards + alignment check still run.
const VALIDATOR_DIR = process.env.DCS_VALIDATOR_DIR || "";

// Open -be- PRs as of 2026-06-20 (repo, book, resource, branch).
const JOBS = [
  ["en_ult", "1CH", "ult", "1CH-be-christopherrsmith-Carolyn1970"],
  ["en_ult", "ISA", "ult", "ISA-be-christopherrsmith-justplainjane47-bethoakes-deferredreward"],
  ["en_ult", "JER", "ult", "JER-be-Grant_Ailie"],
  ["en_ult", "MIC", "ult", "MIC-be-pjoakes-stephenwunrow"],
  ["en_ust", "1CH", "ust", "1CH-be-christopherrsmith-Carolyn1970"],
  ["en_ust", "HOS", "ust", "HOS-be-bethoakes"],
  ["en_ust", "ISA", "ust", "ISA-be-bethoakes-deferredreward"],
  ["en_ust", "MIC", "ust", "MIC-be-pjoakes"],
  ["en_tn", "MIC", "tn", "MIC-be-pjoakes"],
  ["en_tn", "ISA", "tn", "ISA-be-deferredreward-justplainjane47"],
  ["en_tn", "HOS", "tn", "HOS-be-deferredreward-bethoakes"],
];

function d1(sql) {
  // --command (not --file: --file's --json returns exec stats, not rows). Run as
  // one shell string so the SQL stays a single double-quoted arg. SQL is fixed
  // (no user input) and contains no double quotes, so cmd quoting is safe.
  const cmd = `npx wrangler d1 execute bible_editor --remote --env production --json --command "${sql}"`;
  const out = execSync(cmd, { cwd: resolve(__dirname, "../api"), encoding: "utf8", maxBuffer: 1024 * 1024 * 512 });
  const start = out.indexOf("[");
  const parsed = JSON.parse(out.slice(start));
  return parsed[0].results;
}

async function dcsRaw(repo, path, ref) {
  const r = await fetch(`${BASE}/repos/unfoldingWord/${repo}/raw/${path}?ref=${encodeURIComponent(ref)}`, {
    headers: { ...H, Accept: "text/plain" },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`raw ${repo}/${path}@${ref} -> ${r.status}`);
  return (await r.text());
}

const FILE = { ult: usfmFilename, ust: usfmFilename, tn: (b) => `tn_${b}.tsv`, tq: (b) => `tq_${b}.tsv`, twl: (b) => `twl_${b}.tsv` };

function render(book, resource) {
  if (resource === "tn") {
    const rows = d1(`SELECT * FROM tn_rows WHERE book='${book}' AND deleted_at IS NULL AND trashed_at IS NULL ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`);
    return { content: rows.length === 0 ? "" : buildTnTsv(rows), rowCount: rows.length };
  }
  if (resource === "tq") {
    const rows = d1(`SELECT * FROM tq_rows WHERE book='${book}' AND deleted_at IS NULL ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`);
    return { content: rows.length === 0 ? "" : buildTqTsv(rows), rowCount: rows.length };
  }
  if (resource === "twl") {
    const rows = d1(`SELECT * FROM twl_rows WHERE book='${book}' AND deleted_at IS NULL ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`);
    return { content: rows.length === 0 ? "" : buildTwlTsv(rows), rowCount: rows.length };
  }
  const bibleVersion = resource.toUpperCase();
  const verses = d1(`SELECT * FROM verses WHERE book='${book}' AND bible_version='${bibleVersion}' ORDER BY chapter, verse`);
  const metaRows = d1(`SELECT headers_json FROM book_usfm_meta WHERE book='${book}' AND bible_version='${bibleVersion}'`);
  let headers = null;
  if (metaRows[0]?.headers_json) {
    try { const p = JSON.parse(metaRows[0].headers_json); if (Array.isArray(p)) headers = p; } catch { /* synth */ }
  }
  return { content: buildUsfm({ book, bibleVersion, headers, verses }), rowCount: verses.length };
}

function tsvDataRows(text) {
  if (!text) return 0;
  return text.split("\n").filter((l, i) => i > 0 && l.trim() !== "").length;
}

function validate(repo, book, file, content) {
  if (!VALIDATOR_DIR) return { skipped: true };
  const validator = repo === "en_tn" ? "validate_tn_files.py" : "validate_usfm_files.py";
  const vpath = resolve(VALIDATOR_DIR, validator);
  if (!existsSync(vpath)) return { skipped: true };
  const dir = resolve(VALIDATOR_DIR, `_run_${repo}_${book}`);
  mkdirSync(dir, { recursive: true });
  copyFileSync(vpath, resolve(dir, validator));
  // manifest fetched once per repo into VALIDATOR_DIR/manifest_<repo>.yaml
  const man = resolve(VALIDATOR_DIR, `manifest_${repo}.yaml`);
  if (existsSync(man)) copyFileSync(man, resolve(dir, "manifest.yaml"));
  writeFileSync(resolve(dir, file), content);
  let out;
  try { out = execFileSync("python", [validator, "--book", book.toLowerCase()], { cwd: dir, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }); }
  catch (e) { out = (e.stdout || "") + (e.stderr || ""); }
  const errs = out.split("\n").filter((l) => l.trim().startsWith("- ["))
    .filter((l) => !/Files Exist Check/.test(l)); // ignore single-file-staging artifact
  const by = {};
  for (const e of errs) { const m = e.match(/- \[(.+?)\]/); if (m) by[m[1]] = (by[m[1]] || 0) + 1; }
  return { total: errs.length, by, errs };
}

const countAlign = (t) => [(t.match(/\\zaln-s\b/g) || []).length, (t.match(/\\w\s/g) || []).length].join("/");

async function main() {
  console.log(`Mode: ${COMMIT ? "TRUE EXPORT (will commit to DCS)" : "DRY RUN (no DCS writes)"}\n`);
  const jobs = ONLY ? JOBS.filter(([r, b, res]) => `${b}/${res}`.toLowerCase().includes(ONLY.toLowerCase())) : JOBS;
  const report = [];
  for (const [repo, book, resource, branch] of jobs) {
    const file = FILE[resource](book);
    const tag = `${repo} ${book} ${resource} (${branch})`;
    try {
      const built = render(book, resource);
      const master = await dcsRaw(repo, file, "master");
      const branchFile = await dcsRaw(repo, file, branch);

      // Guards vs master (same as the nightly export).
      let guard = "ok";
      if (resource === "ult" || resource === "ust") {
        const res = usfmAlignmentShrinkRefused(built.content, master || "");
        if (res.refused) guard = `ALIGNMENT-LOSS REFUSED: ${res.offenders.slice(0, 5).map((o) => o.ref).join(", ")}`;
      } else {
        if (exportTsvShrinkRefused(built.rowCount, tsvDataRows(master))) guard = `SHRINK REFUSED (${built.rowCount} vs master ${tsvDataRows(master)})`;
      }

      // Alignment-count diff vs last night's branch render (sanity: formatting-only).
      let alignNote = "";
      if ((resource === "ult" || resource === "ust") && branchFile) {
        alignNote = countAlign(built.content) === countAlign(branchFile) ? "align==branch" : `ALIGN DELTA vs branch (${countAlign(branchFile)} -> ${countAlign(built.content)})`;
      }

      const v = validate(repo, book, file, built.content);
      const changedVsBranch = branchFile == null ? "new file" : (branchFile === built.content ? "no change" : "CHANGED");

      let committed = "—";
      const guardOk = guard === "ok" && !/ALIGN DELTA/.test(alignNote);
      if (COMMIT && guardOk && changedVsBranch !== "no change") {
        const target = { baseUrl: "https://git.door43.org", token: TOKEN, owner: "unfoldingWord", repo, branch };
        const r = await commitToDcs(target, file, built.content, `bible-editor export: ${book} ${resource} formatting normalization`, { forceBranch: true });
        committed = r.changed ? `committed ${r.commitSha.slice(0, 8)}` : "no-op (branch already matches)";
      } else if (COMMIT && !guardOk) {
        committed = "BLOCKED by guard";
      }

      const vstr = v.skipped ? "validate:skipped" : `validate:${v.total}${v.total ? " " + JSON.stringify(v.by) : ""}`;
      console.log(`✓ ${tag}\n    rows=${built.rowCount} guard=${guard} ${alignNote} ${vstr} vsBranch=${changedVsBranch} ${COMMIT ? "| " + committed : ""}`);
      report.push({ tag, guard, alignNote, v: v.skipped ? "skip" : v.total, changedVsBranch, committed });
    } catch (e) {
      console.log(`✗ ${tag}\n    ERROR: ${e.message}`);
      report.push({ tag, error: e.message });
    }
  }
  console.log("\n==== summary ====");
  for (const r of report) console.log(JSON.stringify(r));
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
