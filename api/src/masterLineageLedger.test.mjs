// Focused tests for the Stage 6 ledger read. Run from api/:
// node --experimental-strip-types --no-warnings src/masterLineageLedger.test.mjs

import { readLedgerMasterLineage } from "./masterLineageLedger.ts";
import { readFileSync } from "node:fs";

let failed = 0;
function ok(value, message) {
  if (!value) {
    console.error(`FAIL: ${message}`);
    failed++;
  } else console.log(`  ok: ${message}`);
}

const row = (sha, files, committed_at = 100, classification = "human", message = "hand fix") => ({
  repo: "en_ust",
  sha,
  parent_sha: null,
  author_name: "Editor",
  author_email: "editor@example.org",
  committed_at,
  message,
  classification,
  classification_reason: "unrecognized",
  files_json: files,
});

function db({ poll = { last_sha: "tip", last_status: "ok", gap_since_sha: null, last_success_at: 200, coverage_since: 100 }, rows = [] } = {}) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              return sql.includes("dcs_repo_polls") ? poll : null;
            },
            async all() {
              return { results: rows };
            },
          };
        },
      };
    },
  };
}

const files = JSON.stringify(["24-JER.usfm"]);

{
  const migration = readFileSync(new URL("../migrations/0065_dcs_coverage_floor.sql", import.meta.url), "utf8");
  ok(migration.includes("ADD COLUMN coverage_since INTEGER"), "the migration adds a nullable coverage floor");
  ok(migration.includes("NULL floor"), "the migration documents pre-migration rows as untrusted");
}

// The lower boundary is inclusive, and the path decision is made from the
// complete repo-scoped file list rather than from the path-filtered API.
{
  const result = await readLedgerMasterLineage(
    db({ rows: [row("at-boundary", files, 100), row("other-file", JSON.stringify(["01-GEN.usfm"]), 101)] }),
    "en_ust",
    "24-JER.usfm",
    100,
    "tip",
  );
  ok(result.usable, "a current, gap-free ledger is usable");
  ok(result.lineage?.commits.length === 1 && result.lineage.commits[0].sha === "at-boundary", "committer window is inclusive and ref-scoped");
}

for (const [name, setup] of [
  ["missing poll", { poll: null }],
  ["stale tip", { poll: { last_sha: "old", last_status: "ok", gap_since_sha: null, last_success_at: 200, coverage_since: 100 } }],
  ["unconfirmed poll", { poll: { last_sha: "tip", last_status: "ok", gap_since_sha: null, last_success_at: null, coverage_since: 100 } }],
  ["poll gap", { poll: { last_sha: "tip", last_status: "page_cap", gap_since_sha: "gap", last_success_at: 200, coverage_since: 100 } }],
  ["null files", { rows: [row("bad", null)] }],
  ["malformed files", { rows: [row("bad", "not-json")] }],
  ["capped files", { rows: [row("bad", JSON.stringify(Array.from({ length: 50 }, (_, i) => `f${i}`)))] }],
  ["unknown classification", { rows: [row("bad", files, 100, "mystery")] }],
]) {
  const result = await readLedgerMasterLineage(db(setup), "en_ust", "24-JER.usfm", 100, "tip");
  ok(!result.usable, `${name} refuses ledger authority`);
}

{
  const result = await readLedgerMasterLineage(
    db({ rows: [row("old", files, 99)] }),
    "en_ust",
    "24-JER.usfm",
    99,
    "tip",
  );
  ok(!result.usable && result.reason === "ledger_window_before_coverage_floor", "a confirmedAt before the proven floor refuses ledger authority");
}

{
  const result = await readLedgerMasterLineage(db({ rows: [row("not-target", JSON.stringify(["01-GEN.usfm"]))] }), "en_ust", "24-JER.usfm", 100, "tip");
  ok(result.usable && result.lineage?.commits.length === 0, "a complete ledger can prove no commit touched the requested file");
}

{
  const result = await readLedgerMasterLineage(db({ rows: [row("merge-ours", files, 101, "ours", "Merge pull request 'bible-editor: JER ust → master (#1)'")] }), "en_ust", "24-JER.usfm", 100, "tip");
  ok(result.usable && result.lineage?.commits[0].kind === "ours", "stored merge-aware classification remains ours");
}

if (failed) process.exit(1);
console.log("masterLineageLedger: all assertions passed");
