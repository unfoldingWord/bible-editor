#!/usr/bin/env node
// Run ONE read-only SQL statement against the production D1 database.
//
// Exists so agents can be allowlisted for prod reads (see
// .claude/settings.json) without being allowlisted for prod writes: the SQL
// goes through scripts/lib/readOnlySql.mjs first, and anything that is not a
// single SELECT / WITH…SELECT / EXPLAIN is refused before wrangler runs.
// wrangler is spawned directly (no shell), so the SQL cannot escape into the
// command line.
//
// Usage (from the repo root or any worktree):
//   node scripts/d1-select.mjs "SELECT book, COUNT(*) n FROM verses GROUP BY book"
//   node scripts/d1-select.mjs --out scripts/out/947/JER-UST.json "SELECT ... WHERE book='JER'"
//
// Prints wrangler's --json output (or writes it to --out). Keep queries
// narrow: a heavy ad-hoc query can hit D1's CPU limit and reset the prod DB
// (STATE.md, code 7429).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readOnlySqlProblem } from "./lib/readOnlySql.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let out = null;
const oi = args.indexOf("--out");
if (oi !== -1) {
  out = args[oi + 1];
  args.splice(oi, 2);
}
if (args.length !== 1 || !out && oi !== -1) {
  console.error('usage: node scripts/d1-select.mjs [--out <file>] "<one SELECT statement>"');
  process.exit(2);
}
const sql = args[0];
const problem = readOnlySqlProblem(sql);
if (problem) {
  console.error(`refused: ${problem}`);
  process.exit(2);
}

const wrangler = resolve(repoRoot, "node_modules/wrangler/bin/wrangler.js");
const result = execFileSync(
  process.execPath,
  [wrangler, "d1", "execute", "bible_editor", "--remote", "--env", "production", "--json", "--command", sql],
  { cwd: resolve(repoRoot, "api"), encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
);
if (out) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, result);
  console.error(`wrote ${out} (${result.length} bytes)`);
} else {
  process.stdout.write(result);
}
