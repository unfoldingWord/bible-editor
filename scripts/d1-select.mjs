#!/usr/bin/env node
// Run ONE read-only SQL statement against the production D1 database.
//
// Exists so agents can be allowlisted for prod reads (see
// .claude/settings.json) without being allowlisted for prod writes: the SQL
// goes through scripts/lib/readOnlySql.mjs first, and anything that is not a
// single SELECT / WITH…SELECT / EXPLAIN is refused before wrangler runs.
// wrangler is spawned directly (no shell), and the SQL travels as ONE
// `--command=<sql>` argument, so it can never be parsed as a wrangler option
// (a separate argument starting with `--file=…` would be).
//
// Usage (from the repo root or any worktree):
//   node scripts/d1-select.mjs "SELECT book, COUNT(*) n FROM verses GROUP BY book"
//   node scripts/d1-select.mjs --out scripts/out/947/JER-UST.json "SELECT ... WHERE book='JER'"
//
// Prints wrangler's --json output (or writes it to --out). Keep queries
// narrow: a heavy ad-hoc query can hit D1's CPU limit and reset the prod DB
// (STATE.md, code 7429).

import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
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
  console.error('usage: node scripts/d1-select.mjs [--out scripts/out/<name>.json] "<one SELECT statement>"');
  process.exit(2);
}
// --out may only create/replace a .json file under this checkout's scripts/out/
// (git-ignored). Anything wider turns an allowlisted prod READ into an
// unprompted write of query-controlled bytes anywhere on disk (~/.bashrc, a git
// hook). The parent directory is checked by realpath and the target must not
// be a symlink, so neither `..` nor a planted link can leave scripts/out/.
const outRoot = resolve(repoRoot, "scripts", "out");
if (out) {
  const target = resolve(out);
  if (!target.startsWith(outRoot + sep) || !target.endsWith(".json")) {
    console.error(`refused: --out must be a .json file under ${outRoot}`);
    process.exit(2);
  }
  mkdirSync(dirname(target), { recursive: true });
  let isLink = false;
  try { isLink = lstatSync(target).isSymbolicLink(); } catch { /* does not exist yet */ }
  if (isLink || !(realpathSync(dirname(target)) + sep).startsWith(realpathSync(outRoot) + sep)) {
    console.error(`refused: --out resolves outside ${outRoot}`);
    process.exit(2);
  }
  out = target;
}
const sql = args[0];
const problem = readOnlySqlProblem(sql);
if (problem) {
  console.error(`refused: ${problem}`);
  process.exit(2);
}

const wrangler = resolve(repoRoot, "node_modules/wrangler/bin/wrangler.js");
let result;
try {
  result = execFileSync(
    process.execPath,
    [wrangler, "d1", "execute", "bible_editor", "--remote", "--env", "production", "--json", `--command=${sql}`],
    { cwd: resolve(repoRoot, "api"), encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
  );
} catch (e) {
  // wrangler --json reports query errors on stdout; show them, not a Node stack.
  process.stderr.write(e.stdout || String(e.message) + "\n");
  process.exit(1);
}
if (out) {
  writeFileSync(out, result);
  console.error(`wrote ${out} (${result.length} bytes)`);
} else {
  process.stdout.write(result);
}
