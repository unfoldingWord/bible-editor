// Smoke test for staleSkipRemedy and the sync_withholds read/write pair —
// the export_stale banner's remedy text (issue #829). Run from api/:
//   node --experimental-sqlite --experimental-strip-types --no-warnings src/syncWithholds.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors reimportSyncGate.test.mjs.
//
// Regression under test: recordStaleSkipAlert (exportWorkflow.ts) used to
// assert a single unmeasured cause — "the pre-export sync didn't catch up;
// re-run the sync" — for EVERY export_stale skip, including a deliberate
// chapters_locked withhold the reimport step already knew about and could not
// have fixed by re-running (project_alert_must_only_state_measured_cause).
// staleSkipRemedy renders the actual measured cause instead, and honestly
// says "no reason on record" rather than guessing one when nothing was
// persisted.
//
// Second regression under test (codex review of PR #834): recordSyncWithhold/
// clearSyncWithhold only run from the reimport-sync step's per-resource loop,
// so a resource THIS run's reimport never reaches that loop for (a book-level
// reimport failure, or a stale-base hold decided at staging time) leaves a
// PREVIOUS run's row untouched. Without a generation check, tonight's
// recordStaleSkipAlert could read yesterday's reason as though it were
// measured tonight — the exact "asserts an unmeasured cause" bug #829 exists
// to end, just moved one layer down. readSyncWithhold's `runId` parameter is
// the fix: it must return null, not a stale row, when the row's run_id
// doesn't match the caller's own run.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { staleSkipRemedy, recordSyncWithhold, clearSyncWithhold, readSyncWithhold } from "./syncWithholds.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (actual !== expected) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function withhold(overrides = {}) {
  return {
    book: "JER",
    resource: "ult",
    reason: "chapters_locked",
    count: 1,
    occurredAt: 1_700_000_000_000,
    ...overrides,
  };
}

console.log("\n[staleSkipRemedy]");

// THE ABLATION the issue's success check asks for: with no recorded reason,
// the remedy must say so honestly, never assert the old generic cause.
eq(
  staleSkipRemedy(null),
  "D1 is behind master; this run recorded no reason.",
  "no withhold row on record → honest 'no reason' text, not a guessed cause",
);

// Every reason renders distinct, cause-naming text — and none of them repeats
// the old wrong-in-general remedy ('re-run the sync').
const reasons = [
  "chapters_locked",
  "prune_locked",
  "conflict_skipped",
  "tombstone_blocked",
  "counts_incomplete",
  "structure_overlap",
  "systemic_refusal",
  "merge_record_failed",
  "apply_incomplete",
];
for (const reason of reasons) {
  const text = staleSkipRemedy(withhold({ reason, count: 3 }));
  eq(typeof text === "string" && text.length > 0, true, `${reason} → produces non-empty text`);
  eq(
    text.includes("re-run the sync for"),
    false,
    `${reason} → does not repeat the old blanket 're-run the sync' remedy`,
  );
}

// A deliberate hold (chapters_locked) must read as "will self-heal", not as
// something re-running the sync fixes — this is the exact wrong-remedy bug.
eq(
  staleSkipRemedy(withhold({ reason: "chapters_locked", count: 2 })).includes("2 chapter(s)"),
  true,
  "chapters_locked → names the measured chapter count",
);
eq(
  /pipeline job/.test(staleSkipRemedy(withhold({ reason: "chapters_locked" }))),
  true,
  "chapters_locked → names the real cause (an active pipeline job holding the chapter)",
);

// A human-actionable reason points at something to go look at, not "re-run".
eq(
  /human/.test(staleSkipRemedy(withhold({ reason: "conflict_skipped", count: 6 }))),
  true,
  "conflict_skipped → tells the operator this needs a human, not a re-run",
);
eq(
  /human/.test(staleSkipRemedy(withhold({ reason: "structure_overlap", count: 1 }))),
  true,
  "structure_overlap → tells the operator this needs a human",
);

// count: 0 (the boolean-flag reasons) must not render a stray "0 " prefix.
eq(
  staleSkipRemedy(withhold({ reason: "systemic_refusal", count: 0 })).startsWith("0 "),
  false,
  "a zero count is omitted from the rendered text, not printed as '0 '",
);

console.log("\n[recordSyncWithhold / readSyncWithhold / clearSyncWithhold — real schema]");

// Minimal D1 shim over node:sqlite — same shape as dismissReview.test.mjs.
function makeDb(sqlite) {
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    first() {
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
    },
    run() {
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  return { prepare: (sql) => mk(sql, []) };
}

function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  return { DB: makeDb(sqlite) };
}

{
  const env = freshEnv();
  const ok = await recordSyncWithhold(env, "JER", "ult", "chapters_locked", 2, 1_700_000_000_000, "run-A");
  eq(ok, true, "recordSyncWithhold against the real migrated schema succeeds");
  const read = await readSyncWithhold(env, "JER", "ult", "run-A");
  eq(read?.reason, "chapters_locked", "readSyncWithhold with the SAME runId returns the recorded reason");
  eq(read?.count, 2, "…and the recorded count");
}

{
  // THE BUG this section exists to catch: a row recorded by run-A must not be
  // handed to run-B as though run-B measured it — this is the codex-review
  // fix (misattributing a previous run's withhold to tonight's skip).
  const env = freshEnv();
  await recordSyncWithhold(env, "JER", "ult", "chapters_locked", 2, 1_700_000_000_000, "run-A");
  const read = await readSyncWithhold(env, "JER", "ult", "run-B");
  eq(read, null, "readSyncWithhold with a DIFFERENT runId returns null, not run-A's stale reason");
  eq(
    staleSkipRemedy(read),
    "D1 is behind master; this run recorded no reason.",
    "…so the banner honestly says no reason was recorded, rather than naming yesterday's cause",
  );
}

{
  // A later run for the SAME resource overwrites the row (and its runId) —
  // the table holds "what did the MOST RECENT run measure", not a history.
  const env = freshEnv();
  await recordSyncWithhold(env, "JER", "ult", "chapters_locked", 2, 1_700_000_000_000, "run-A");
  await recordSyncWithhold(env, "JER", "ult", "systemic_refusal", 0, 1_700_000_100_000, "run-B");
  eq(await readSyncWithhold(env, "JER", "ult", "run-A"), null, "run-A's now-overwritten row no longer matches run-A");
  eq(
    (await readSyncWithhold(env, "JER", "ult", "run-B"))?.reason,
    "systemic_refusal",
    "run-B reads its own freshly-recorded reason",
  );
}

{
  // Once a pair syncs cleanly, clearSyncWithhold releases the row outright —
  // even a same-run read must not resurrect a cleared reason.
  const env = freshEnv();
  await recordSyncWithhold(env, "JER", "ult", "chapters_locked", 2, 1_700_000_000_000, "run-A");
  await clearSyncWithhold(env, "JER", "ult");
  eq(await readSyncWithhold(env, "JER", "ult", "run-A"), null, "a cleared row reads as null even for its own run");
}

{
  // Different (book, resource) pairs are independent rows.
  const env = freshEnv();
  await recordSyncWithhold(env, "JER", "ult", "chapters_locked", 1, 1_700_000_000_000, "run-A");
  eq(await readSyncWithhold(env, "JER", "ust", "run-A"), null, "a withhold on ult does not leak onto ust");
}

if (failed > 0) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
} else {
  console.log("\nAll staleSkipRemedy / sync_withholds checks passed.");
}
