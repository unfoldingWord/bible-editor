// Fails if any src/**/*.test.mjs file on disk is absent from its workspace's
// package.json `test` script. Registered-but-deleted entries are not
// checked here — only files present on disk that no script references.
//
// Run from repo root: node scripts/check-test-registration.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");

function findTestFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...findTestFiles(full));
    } else if (entry.endsWith(".test.mjs")) {
      out.push(full);
    }
  }
  return out;
}

const workspaces = ["api", "web"];
let missing = [];

for (const workspace of workspaces) {
  const workspaceRoot = join(repoRoot, workspace);
  const pkgPath = join(workspaceRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const testScript = pkg.scripts?.test ?? "";

  const testFiles = findTestFiles(join(workspaceRoot, "src"));
  for (const file of testFiles) {
    const rel = relative(workspaceRoot, file).split("\\").join("/");
    if (!testScript.includes(rel)) {
      missing.push(`${workspace}/${rel}`);
    }
  }
}

if (missing.length > 0) {
  console.error("The following test files exist but are not registered in their workspace's `test` script:");
  for (const m of missing) console.error(`  - ${m}`);
  console.error("\nAdd them to the relevant package.json `scripts.test` chain.");
  process.exit(1);
}

console.log("All src/**/*.test.mjs files are registered in their workspace's test script.");
