// Regression test for GitHub issue #985: the POST-APPLY CHECKS survivor query
// emitted into the generated SQL header must count survivors across the same
// scope the dump was scanned over, not just the books this run repaired.
// A survivor (refused / plain_text-only / release-locked / --exclude'd row)
// routinely sits in a DIFFERENT book than any repaired row, so filtering the
// survivor SELECT down to "books actually repaired" made it return 0 even on
// a fully successful apply.
//
// Runs the real CLI end-to-end against a synthetic dump — no production data,
// no network, no D1 — and inspects the generated SQL text.
//
// Run from the repo root:
//   npm run test:scripts
//   node --no-warnings scripts/repair-number-split-verses.test.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, "repair-number-split-verses.mjs");

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok: ${msg}`);
}

// GEN is release-locked (PUBLISHED_BOOKS); ZEC is not. Both rows carry the
// same repairable defect. GEN is skipped as release-locked and becomes the
// one EXPECTED SURVIVOR — in a book this run never repairs.
const row = (book, version) => ({
  book,
  bible_version: "ULT",
  chapter: 1,
  verse: 1,
  version,
  content_json: JSON.stringify({ verseObjects: [{ type: "text", text: "There were 24, 000 men." }] }),
  plain_text: "There were 24, 000 men.",
});
const dump = [row("ZEC", 1), row("GEN", 1)];

function run(extraArgs, label) {
  const dir = mkdtempSync(join(tmpdir(), "number-split-985-"));
  const dumpPath = join(dir, "dump.json");
  const sqlPath = join(dir, "out.sql");
  writeFileSync(dumpPath, JSON.stringify(dump), "utf8");
  try {
    execFileSync(
      process.execPath,
      [scriptPath, dumpPath, "--out", sqlPath, "--force", ...extraArgs],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    // ZEC's repair + GEN's release-lock skip: no refusals, so this should exit 0.
    console.error(e.stdout, e.stderr);
    throw new Error(`${label}: CLI exited non-zero unexpectedly`);
  }
  const sql = readFileSync(sqlPath, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return sql;
}

console.log("no --book/--bible-version filter: survivor query must not be scoped to ZEC only");
{
  const sql = run([], "unfiltered");
  assert(sql.includes("Expect EXACTLY 1 survivor(s)"), "header expects exactly the 1 GEN survivor");
  const glob = sql.split("plain_text GLOB")[1].split("ORDER BY")[0];
  assert(!glob.includes("book IN"), `survivor SELECT must not filter by book when the scan was unfiltered (got: ${glob})`);
}

console.log("\n--book ZEC,GEN: survivor query must scope to the SCAN (both), not the repaired book (ZEC alone)");
{
  const sql = run(["--book", "ZEC,GEN"], "book-filtered");
  const glob = sql.split("plain_text GLOB")[1].split("ORDER BY")[0];
  assert(glob.includes("book IN ('GEN', 'ZEC')"), `survivor SELECT must include GEN even though only ZEC was repaired (got: ${glob})`);
}

console.log(`\nrepair-number-split-verses: all ${passed} assertions passed`);
