// Regression tests for the dcs_commits retention sweep (issue #692 item 1).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/dcsCommitsSweep.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors editLogSweep.test.mjs:
// runs the LITERAL production SQL (DCS_COMMITS_SWEEP_SQL) against real
// SQLite, seeded through the real migrations, so the tested schema cannot
// drift from what production runs.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DCS_COMMITS_SWEEP_SQL, DCS_COMMITS_RETENTION_SECONDS } from "./dcsCommitsSweep.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function freshDb() {
  const d = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    d.exec(readFileSync(join(dir, f), "utf8"));
  }
  return d;
}

function commitRow(d, { repo, sha, committedAt = null, seenAt, classification = "human" }) {
  d.prepare(
    `INSERT INTO dcs_commits (repo, sha, committed_at, classification, seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(repo, sha, committedAt, classification, seenAt);
}

function survivingShas(d) {
  return d.prepare(`SELECT sha FROM dcs_commits ORDER BY sha`).all().map((r) => r.sha);
}

function sweep(d, cutoff) {
  d.prepare(DCS_COMMITS_SWEEP_SQL).run(cutoff);
}

console.log("\n[rows older than the cutoff are swept, newer rows survive]");
{
  const d = freshDb();
  commitRow(d, { repo: "en_tn", sha: "old1", committedAt: 1000, seenAt: 1000 });
  commitRow(d, { repo: "en_tn", sha: "new1", committedAt: 9000, seenAt: 9000 });
  sweep(d, 5000);
  assert(survivingShas(d).join(",") === "new1", "only the row at/after the cutoff survives");
}

console.log("\n[a NULL committed_at (unparseable Door43 date) ages out on seen_at instead of surviving forever]");
{
  const d = freshDb();
  commitRow(d, { repo: "en_tn", sha: "nulldate_old", committedAt: null, seenAt: 1000 });
  commitRow(d, { repo: "en_tn", sha: "nulldate_new", committedAt: null, seenAt: 9000 });
  sweep(d, 5000);
  assert(
    survivingShas(d).join(",") === "nulldate_new",
    "COALESCE(committed_at, seen_at) falls back to seen_at, so a NULL-date row is not permanently exempt",
  );
}

console.log("\n[the exported retention constant matches the ~18-month figure the issue asked for]");
{
  const eighteenMonthsish = 548 * 86400;
  assert(DCS_COMMITS_RETENTION_SECONDS === eighteenMonthsish, "DCS_COMMITS_RETENTION_SECONDS is 548 days in seconds");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("\nAll assertions passed");
}
