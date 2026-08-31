// Regression coverage for issue #551 (PR #554 review): persistMasterLineage
// must actually reach the D1 row, both when book_resource_syncs already has a
// row for the (book, resource) pair (the common case — loadMasterLineage only
// ever runs once master_confirmed_at is non-null, which today always traces
// back to an existing row) and when it does not (the defensive UPSERT
// fallback a reviewer asked for, in case that invariant ever breaks).
//
// Run from api/ (needs the sqlite + strip-types flags, and the resolve hook so
// persistMasterLineageForTest can pull in bookReimport.ts's own extensionless
// application-module imports):
//   node --experimental-sqlite --experimental-strip-types --no-warnings \
//     --import ./src/tsResolveHook.mjs src/masterLineagePersist.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { persistMasterLineageForTest } from "./bookReimport.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Minimal D1 shim over node:sqlite — same shape as applyVerseRows.test.mjs /
// reimportJourney.test.mjs.
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
  return { sqlite, env: { DB: makeDb(sqlite) } };
}

function readRow(sqlite, book, resource) {
  return sqlite
    .prepare(
      `SELECT source_sha, origin, synced_at, master_lineage_json, master_lineage_sha, master_lineage_computed_at,
              master_lineage_confirmed_edit_id, master_lineage_confirmed_at
         FROM book_resource_syncs WHERE book = ? AND resource = ?`,
    )
    .all(book, resource)[0];
}

const SUMMARY = {
  mayHoldHumanEdit: true,
  hasHumanCommit: true,
  incomplete: false,
  incompleteReason: "",
  counts: { ours: 1, ai: 0, human: 2 },
  humanShas: ["abc123"],
};

console.log("\n[persistMasterLineage: an EXISTING (book, resource) row is updated, other columns untouched]");
{
  const { env, sqlite } = freshEnv();
  sqlite.exec(
    `INSERT INTO book_resource_syncs (book, resource, source_sha, synced_at, origin, master_confirmed_at)
     VALUES ('JER', 'tn', 'deadbeef', 1000, 'reimport', 900)`,
  );

  // #661: confirmedEditId/confirmedAt are the merge boundary THIS run's
  // lineage walk was bounded by — passed alongside the snapshot so the
  // boundary a given snapshot used is answerable from the row later.
  await persistMasterLineageForTest(env, "JER", "tn", SUMMARY, "cafef00d", 4242, 900);

  const row = readRow(sqlite, "JER", "tn");
  eq(row.master_lineage_json, JSON.stringify(SUMMARY), "the compact summary is stored verbatim as JSON");
  eq(row.master_lineage_sha, "cafef00d", "the as-of sha is stored");
  eq(typeof row.master_lineage_computed_at, "number", "a computed_at timestamp is stamped");
  eq(
    row.master_lineage_confirmed_edit_id,
    4242,
    "#661: master_lineage_confirmed_edit_id captures this run's merge boundary alongside the snapshot",
  );
  eq(
    row.master_lineage_confirmed_at,
    900,
    "#661: master_lineage_confirmed_at captures this run's merge boundary alongside the snapshot",
  );
  eq(row.source_sha, "deadbeef", "source_sha — a different watermark's field — is left untouched");
  eq(row.origin, "reimport", "origin is left untouched, not stomped by the lineage write");
  eq(row.synced_at, 1000, "synced_at is left untouched");
  // master_confirmed_at (the LIVE watermark) is untouched by the lineage
  // write, unlike master_lineage_confirmed_at (the snapshot-scoped copy) —
  // the two are deliberately separate columns, see 0057's own comment.
  eq(
    sqlite.prepare(`SELECT master_confirmed_at FROM book_resource_syncs WHERE book = 'JER' AND resource = 'tn'`).all()[0]
      .master_confirmed_at,
    900,
    "the live master_confirmed_at watermark is left untouched by the lineage write",
  );
}

console.log("\n[persistMasterLineage: NO existing row — inserts one instead of silently no-oping]");
{
  const { env, sqlite } = freshEnv();
  eq(readRow(sqlite, "ZEC", "ust"), undefined, "sanity: no row exists yet for this pair");

  await persistMasterLineageForTest(env, "ZEC", "ust", SUMMARY, "f00dcafe", 17, 555);

  const row = readRow(sqlite, "ZEC", "ust");
  eq(row !== undefined, true, "a row was inserted rather than the write silently affecting zero rows");
  eq(row.master_lineage_json, JSON.stringify(SUMMARY), "the summary lands on the new row");
  eq(row.master_lineage_sha, "f00dcafe", "the as-of sha lands on the new row");
  eq(row.master_lineage_confirmed_edit_id, 17, "#661: the boundary edit id lands on the new row too");
  eq(row.master_lineage_confirmed_at, 555, "#661: the boundary timestamp lands on the new row too");
  eq(row.source_sha, null, "source_sha stays NULL — this is not a real sync watermark");
  eq(
    row.origin,
    "lineage_only",
    "origin names why the row exists, distinct from 'import'/'reimport'/'export'/'reimport_withheld'",
  );
}

console.log("\n[persistMasterLineage: boundary args omitted — both new columns land NULL, not crash]");
{
  const { env, sqlite } = freshEnv();

  await persistMasterLineageForTest(env, "AMO", "tq", SUMMARY, "0ff1ce00");

  const row = readRow(sqlite, "AMO", "tq");
  eq(row.master_lineage_confirmed_edit_id, null, "an omitted boundary edit id is stored as NULL, not 0/undefined");
  eq(row.master_lineage_confirmed_at, null, "an omitted boundary timestamp is stored as NULL, not 0/undefined");
}

console.log(failed === 0 ? "\nAll masterLineagePersist assertions passed." : `\n${failed} assertion(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
