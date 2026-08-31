#!/usr/bin/env node
// Discovers and runs every src/**/*.test.mjs file in the current workspace,
// so that adding a new test file needs no package.json edit — the enumerated
// `&&`-chain that used to live in api/package.json and web/package.json was
// a conflict magnet: any two concurrently-open PRs that both added a test
// edited that same line and collided with each other there, with nothing
// else in common. See issue #509.
//
// Run from a workspace root (api/ or web/), matching the old package.json
// scripts:
//   node ../scripts/run-tests.mjs
//
// Files run in sorted path order for deterministic output. Stops at the
// first failure, mirroring the old `&&` chain (a later test never runs
// after an earlier one fails).
//
// The per-file flag exceptions from the old api/package.json chain are
// preserved below — extend SQLITE_FILES / EXTRA_IMPORTS if a future test
// needs the same treatment.

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SQLITE_FILES = new Set([
  "src/tsvMergeIntegration.test.mjs",
  "src/tombstoneCollision.test.mjs",
  "src/reimportJourney.test.mjs",
  "src/trashedRowPatch.test.mjs",
  "src/rowsCreateGuard.test.mjs",
  "src/applyVerseRows.test.mjs",
  // The old chain ran this one twice: once plain, once with
  // --experimental-sqlite. Globbing runs each file once, so it takes the
  // sqlite variant — the flag is additive, and the file's sqlite-only cases
  // gate themselves on availability.
  "src/pipelineDispatchTimeout.test.mjs",
  "src/lockOverrideAlert.test.mjs",
  "src/tombstoneReclaim.test.mjs",
  "src/tombstoneSweep.test.mjs",
  "src/aiRowDiffGate.test.mjs",
  "src/masterLineagePersist.test.mjs",
  "src/rowRestoreNoop.test.mjs",
  "src/dismissReview.test.mjs",
  "src/bookLock.test.mjs",
  "src/staleBaseGate.test.mjs",
]);

const EXTRA_IMPORTS = new Map([
  ["src/rowRestoreNoop.test.mjs", "./src/tsResolveHook.mjs"],
  ["src/dismissReview.test.mjs", "./src/tsResolveHook.mjs"],
  ["src/reimportJourney.test.mjs", "./src/tsResolveHook.mjs"],
  ["src/applyVerseRows.test.mjs", "./src/tsResolveHook.mjs"],
  ["src/tombstoneReclaim.test.mjs", "./src/tsResolveHook.mjs"],
  ["src/tombstoneSweep.test.mjs", "./src/tsResolveHook.mjs"],
  ["src/aiRowDiffGate.test.mjs", "./src/tsResolveHook.mjs"],
  ["src/masterLineagePersist.test.mjs", "./src/tsResolveHook.mjs"],
  ["src/staleBaseGate.test.mjs", "./src/tsResolveHook.mjs"],
]);

function findTestFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
      found.push(full);
    }
  }
  return found;
}

const root = process.cwd();
const srcDir = join(root, "src");
if (!statSync(srcDir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`run-tests: no src/ directory under ${root}`);
  process.exit(1);
}

const files = findTestFiles(srcDir)
  .map((f) => relative(root, f).split(sep).join("/"))
  .sort();

if (files.length === 0) {
  console.error("run-tests: no *.test.mjs files found under src/");
  process.exit(1);
}

for (const file of files) {
  const args = ["--experimental-strip-types", "--no-warnings"];
  if (SQLITE_FILES.has(file)) args.push("--experimental-sqlite");
  const extraImport = EXTRA_IMPORTS.get(file);
  if (extraImport) args.push("--import", extraImport);
  args.push(file);

  console.log(`\n> node ${args.join(" ")}`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit", cwd: root });
  if (result.status !== 0) {
    console.error(`\nrun-tests: FAILED at ${file}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\nrun-tests: ${files.length} file(s) passed.`);
