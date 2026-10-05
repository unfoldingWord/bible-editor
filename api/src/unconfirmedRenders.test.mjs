// #1029 review (A1): book_resource_syncs.unconfirmed_renders_json lists the
// renders pushed since master was last confirmed. It must shrink whenever
// master is confirmed, including by the two convergence paths in
// bookReimport.ts (byte match and lineage), not only by a direct push
// confirmation. Otherwise a maintainer who reverts master to an older render
// of ours, after master had already caught up to a newer one, is read as
// "master lagging" and the revert report is suppressed.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings \
//     --import ./src/tsResolveHook.mjs src/unconfirmedRenders.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { markOwnPublishConvergedForTest, markLineageConfirmedConvergedForTest } from "./bookReimport.ts";
import { RECORD_PUSHED_RENDER_SQL, shouldComputeRevertEntries } from "./export.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Minimal D1 shim over node:sqlite (same shape as masterLineagePersist.test.mjs).
function makeDb(sqlite) {
  const mk = (sql, args) => ({
    sql,
    args,
    bind: (...a) => mk(sql, a),
    all() {
      return { results: sqlite.prepare(sql).all(...args), success: true };
    },
    first() {
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
    },
    run() {
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
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
  sqlite.exec(
    `INSERT INTO book_resource_syncs (book, resource, source_sha, synced_at, origin)
     VALUES ('JER', 'tn', 'x', 0, 'export')`,
  );
  const record = (sha, readAt, confirm, editId) =>
    sqlite.prepare(RECORD_PUSHED_RENDER_SQL).run("JER", "tn", sha, readAt, confirm, editId, `k/${sha}`);
  const list = () =>
    JSON.parse(
      sqlite.prepare(`SELECT unconfirmed_renders_json j FROM book_resource_syncs WHERE book = 'JER'`).get().j ?? "null",
    );
  return { env: { DB: makeDb(sqlite) }, record, list };
}

console.log("\n[byte-match convergence: R5 and R6 merge, maintainer reverts master to R5]");
{
  const { env, record, list } = freshEnv();
  record("R4", 400, 1, 40); // confirmed by its own push
  record("R5", 500, 0, 50); // PR not merged yet
  record("R6", 600, 0, 60); // PR not merged yet
  eq(list(), ["R4", "R5", "R6"], "R5 and R6 are both unconfirmed before the merges are seen");
  // Both PRs merge; the next sync sees master == R6 (the current pushed render).
  const stamped = await markOwnPublishConvergedForTest(env, "JER", "tn", 600, 60, "mastersha");
  eq(stamped, true, "the convergence stamp landed");
  eq(list(), ["R6"], "convergence on R6 drops every older render from the list");
  // A maintainer reverts master to R5's bytes. That is a foreign move, not lag.
  eq(
    shouldComputeRevertEntries(true, "master content", "R5", "R6", list()),
    true,
    "master reverted to R5 after R6 was confirmed -> the revert report still runs",
  );
}

console.log("\n[lineage convergence resets the list the same way]");
{
  const { env, record, list } = freshEnv();
  record("R5", 500, 0, 50);
  record("R6", 600, 0, 60);
  const stamped = await markLineageConfirmedConvergedForTest(env, "JER", "tn", {
    pushedBlobSha: "R6",
    pushedReadAt: 600,
    pushedEditId: 60,
  });
  eq(stamped, true, "the lineage stamp landed");
  eq(list(), ["R6"], "lineage convergence on R6 drops every older render from the list");
}

console.log("\n[a stale byte-match stamp for an older read leaves the list alone]");
{
  const { env, record, list } = freshEnv();
  record("R5", 500, 0, 50);
  record("R6", 600, 0, 60);
  await markOwnPublishConvergedForTest(env, "JER", "tn", 500, 50, null);
  eq(list(), ["R5", "R6"], "a recognition of an older read does not discard the newer render");
}

if (failed) {
  console.error(`\nunconfirmedRenders.test.mjs: ${failed} failure(s)`);
  process.exit(1);
}
console.log("\nunconfirmedRenders.test.mjs: all assertions passed");
