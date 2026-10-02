// Focused tests for the Stage 6 ledger read. Run from api/:
// node --experimental-strip-types --no-warnings src/masterLineageLedger.test.mjs

import { readLedgerMasterLineage } from "./masterLineageLedger.ts";
import { backfillDcsRepoGap } from "./dcsCommitBackfill.ts";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

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

// Issue #856: the hourly dcs_commits retention sweep can delete rows and
// raise coverage_since between this function's poll-floor read and its
// commit-window read. Simulate that interleaving directly: the mock answers
// the poll query with the OLD floor (which confirmedAt satisfies), then jumps
// coverage_since forward as a side effect of the commit query resolving —
// standing in for the sweep landing in between. Without the re-read this fix
// adds, the stale poll answer alone would let a truncated window through as
// "ledger_complete".
{
  let coverageSince = 100;
  const raceDb = {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (!sql.includes("dcs_repo_polls")) return null;
              return { last_sha: "tip", last_status: "ok", gap_since_sha: null, last_success_at: 200, coverage_since: coverageSince };
            },
            async all() {
              coverageSince = 5000; // the sweep lands "during" this query
              return { results: [row("old_human", files, 200, "human")] };
            },
          };
        },
      };
    },
  };
  const result = await readLedgerMasterLineage(raceDb, "en_ust", "24-JER.usfm", 200, "tip");
  ok(
    !result.usable && result.reason === "ledger_floor_moved",
    "a coverage floor raised between the poll read and the commit read is caught, not silently trusted",
  );
}

// Issue #691: a PLAIN late push. A human commit authored AND committed before
// the window opened, but pushed (first seen by the poller) after it, carries
// an old committed_at, so a read bounded only by committed_at misses it. The
// ledger's seen_at is arrival time, the closest thing to push time we have,
// so the read must also admit a row first seen after the window opened.
// Real schema (every migration), real SQL: the mock db above ignores WHERE.
{
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(f, dir), "utf8"));
  }
  const realDb = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              const r = sqlite.prepare(sql).all(...args);
              return r.length ? r[0] : null;
            },
            async all() {
              return { results: sqlite.prepare(sql).all(...args) };
            },
          };
        },
      };
    },
  };
  const COVERAGE = 1_000_000; // first clean poll; its bootstrap rows carry seen_at = COVERAGE
  const WINDOW = COVERAGE + 10 * 86400;
  sqlite
    .prepare(
      `INSERT INTO dcs_repo_polls (repo, last_sha, last_committed_at, last_attempted_at, last_success_at,
                                    last_status, gap_since_sha, gap_at, coverage_since)
       VALUES ('en_ust', 'tip', ?, ?, ?, 'ok', NULL, NULL, ?)`,
    )
    .run(WINDOW + 7200, WINDOW + 7200, WINDOW + 7200, COVERAGE);
  const insert = (sha, committedAt, seenAt, classification = "human") =>
    sqlite
      .prepare(
        `INSERT INTO dcs_commits (repo, sha, parent_sha, author_name, author_email, committed_at, message,
                                   classification, classification_reason, files_json, seen_at)
         VALUES ('en_ust', ?, NULL, 'Editor', 'editor@example.org', ?, 'hand fix', ?, 'unrecognized', ?, ?)`,
      )
      .run(sha, committedAt, classification, files, seenAt);
  // Bootstrap-era history: committed and first seen long before the window.
  insert("bootstrap-old", COVERAGE - 86400, COVERAGE);
  // Arrived before the window opened (old dates, seen before WINDOW).
  insert("seen-before", WINDOW - 5 * 86400, WINDOW - 100);
  // The plain late push: both dates a week before WINDOW, first seen after it.
  insert("late-push", WINDOW - 7 * 86400, WINDOW + 3600);

  const result = await readLedgerMasterLineage(realDb, "en_ust", "24-JER.usfm", WINDOW, "tip");
  ok(result.usable, "a current, gap-free real-schema ledger is usable");
  const shas = (result.lineage?.commits ?? []).map((c) => c.sha);
  ok(shas.includes("late-push"), "a commit first seen after the window opened is admitted despite old dates (#691)");
  ok(result.lineage?.hasHumanCommit === true, "...and flips the gate's verdict to human-found for that window");
  ok(!shas.includes("seen-before") && !shas.includes("bootstrap-old"), "commits already seen before the window stay out");

  // A window starting exactly at the coverage floor must not pull in the
  // whole bootstrap batch, whose seen_at equals that floor.
  const atFloor = await readLedgerMasterLineage(realDb, "en_ust", "24-JER.usfm", COVERAGE, "tip");
  ok(
    atFloor.usable && !(atFloor.lineage?.commits ?? []).some((c) => c.sha === "bootstrap-old"),
    "bootstrap rows seen AT the window start are not treated as late arrivals",
  );
}

// Issue #691 review A1: the gap BACKFILL must not make historic commits look
// like late arrivals. Timeline: a capped bootstrap poll at T1 opens a gap
// (gap_at = T1); a later clean poll at T2 sets coverage_since = T2 while the
// gap is still open; the backfill at T3 inserts the repo's older history. A
// window with confirmedAt in [T2, T3) must not read that history as in-window,
// while a commit the forward poll genuinely first saw after the window still is.
{
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(f, dir), "utf8"));
  }
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    async first() {
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...args) };
    },
    async run() {
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  const env = {
    DB: {
      prepare: (sql) => mk(sql, []),
      async batch(stmts) {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        return out;
      },
    },
  };
  const T1 = 2_000_000;
  const T2 = T1 + 3600;
  const T3 = T2 + 6 * 3600;
  sqlite
    .prepare(
      `INSERT INTO dcs_repo_polls (repo, last_sha, last_committed_at, last_attempted_at, last_success_at,
                                    last_status, gap_since_sha, gap_at, gap_frontier_json, coverage_since)
       VALUES ('en_ust', 'tip', ?, ?, ?, 'ok', 'boot-oldest', ?, ?, ?)`,
    )
    .run(T2, T2, T2, T1, JSON.stringify(["hist1"]), T2);
  // The repo's older history, reached by the backfill walk from the frontier.
  const oldDate = new Date((T1 - 400 * 86400) * 1000).toISOString();
  const histCommit = (sha, parent) => ({
    sha,
    commit: { message: `hand fix ${sha}`, author: { email: "h@x", name: "Editor", date: oldDate }, committer: { date: oldDate } },
    author: null,
    parents: parent ? [{ sha: parent }] : [],
    files: [{ filename: "24-JER.usfm", status: "modified" }],
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === "x-hasmore" ? "false" : k.toLowerCase() === "x-pagecount" ? "1" : null) },
    json: async () => [histCommit("hist1", "hist2"), histCommit("hist2", null)],
  });
  let res;
  try {
    res = await backfillDcsRepoGap(env, "en_ust", T3);
  } finally {
    globalThis.fetch = realFetch;
  }
  ok(res.resolved === true && res.inserted === 2, "the backfill walks the history and closes the gap");
  // A genuine late push the forward poll first saw after the window opened.
  sqlite
    .prepare(
      `INSERT INTO dcs_commits (repo, sha, parent_sha, author_name, author_email, committed_at, message,
                                 classification, classification_reason, files_json, seen_at)
       VALUES ('en_ust', 'late-push', NULL, 'Editor', 'h@x', ?, 'hand fix', 'human', 'unrecognized', ?, ?)`,
    )
    .run(T1 - 7 * 86400, files, T3 + 300);

  const result = await readLedgerMasterLineage(env.DB, "en_ust", "24-JER.usfm", T2 + 600, "tip");
  const shas = (result.lineage?.commits ?? []).map((c) => c.sha);
  ok(result.usable, "the ledger is usable once the gap is closed");
  ok(!shas.includes("hist1") && !shas.includes("hist2"), "backfilled history is not read as arriving inside a window that opened before the backfill ran");
  ok(shas.includes("late-push"), "...while a genuine late push in the same window still is");
}

if (failed) process.exit(1);
console.log("masterLineageLedger: all assertions passed");
