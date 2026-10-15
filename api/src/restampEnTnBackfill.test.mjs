// Tests for the one-time #691 correction, scripts/restamp-en-tn-backfill-seen-at.sql.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/restampEnTnBackfill.test.mjs
//
// Not a test framework; failures exit non-zero. Runs the LITERAL script file
// against real SQLite seeded through the real migrations, like
// dcsCommitsSweep.test.mjs.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(here, "..", "..", "scripts", "restamp-en-tn-backfill-seen-at.sql"), "utf8");

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
  const dir = join(here, "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    d.exec(readFileSync(join(dir, f), "utf8"));
  }
  return d;
}

const GAP_AT = 1789091175;
const FLOOR = 1789605346; // en_tn coverage_since in production
const BACKFILL_RAN = 1790975160; // the old backfill's stamp, 2026-10-02

function seed(d) {
  d.prepare(`INSERT INTO dcs_repo_polls (repo, gap_at, coverage_since) VALUES ('en_tn', ?, ?)`).run(GAP_AT, FLOOR);
  d.prepare(`INSERT INTO dcs_repo_polls (repo, coverage_since) VALUES ('en_ult', ?)`).run(FLOOR);
  const row = d.prepare(
    `INSERT INTO dcs_commits (repo, sha, committed_at, classification, seen_at) VALUES (?, ?, ?, 'human', ?)`,
  );
  // Backfilled by the old code: old commit, stamped when the backfill ran.
  row.run("en_tn", "backfilled", FLOOR - 86400 * 30, BACKFILL_RAN);
  // Forward poll after the floor: a new commit, seen promptly.
  row.run("en_tn", "recent", FLOOR + 86400, FLOOR + 86400 + 60);
  // Bootstrap row: old commit, stamped at the floor itself (not after it).
  row.run("en_tn", "bootstrap", FLOOR - 86400, FLOOR);
  // Same shape as "backfilled" but in another repo: out of scope.
  row.run("en_ult", "other-repo", FLOOR - 86400 * 30, BACKFILL_RAN);
}

function seenAt(d, repo, sha) {
  return d.prepare(`SELECT seen_at FROM dcs_commits WHERE repo = ? AND sha = ?`).get(repo, sha).seen_at;
}

console.log("restamp-en-tn-backfill-seen-at.sql");
{
  const d = freshDb();
  seed(d);
  d.exec(SCRIPT);
  assert(seenAt(d, "en_tn", "backfilled") === GAP_AT, "an old en_tn row stamped after the floor is restamped to gap_at");
  assert(seenAt(d, "en_tn", "recent") === FLOOR + 86400 + 60, "a commit dated after the floor keeps its stamp");
  assert(seenAt(d, "en_tn", "bootstrap") === FLOOR, "a row stamped at the floor (not after it) keeps its stamp");
  assert(seenAt(d, "en_ult", "other-repo") === BACKFILL_RAN, "another repo is not touched");

  // The ledger read's predicate (masterLineageLedger.ts) for a window opening
  // a day after the floor no longer admits the backfilled row.
  const admitted = d
    .prepare(
      `SELECT sha FROM dcs_commits
        WHERE repo = 'en_tn' AND (committed_at >= ?1 OR committed_at IS NULL OR seen_at > ?1) ORDER BY sha`,
    )
    .all(FLOOR + 3600)
    .map((r) => r.sha);
  assert(JSON.stringify(admitted) === JSON.stringify(["recent"]), `window read admits only the real new commit (got ${admitted})`);

  const before = d.prepare(`SELECT repo, sha, seen_at FROM dcs_commits ORDER BY repo, sha`).all();
  d.exec(SCRIPT);
  const after = d.prepare(`SELECT repo, sha, seen_at FROM dcs_commits ORDER BY repo, sha`).all();
  assert(JSON.stringify(before) === JSON.stringify(after), "a second run changes nothing");
}

{
  // The script's one write must be a single UPDATE of dcs_commits.seen_at.
  const statements = SCRIPT.split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  assert(statements.length === 1, "the script holds exactly one statement");
  assert(/^UPDATE dcs_commits\s+SET seen_at = \d+\s+WHERE repo = 'en_tn'/.test(statements[0]), "that statement updates only en_tn seen_at");
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
