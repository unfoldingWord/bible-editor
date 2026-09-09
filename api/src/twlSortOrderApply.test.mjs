// Regression test for issue #687: a pure TWL sort-order reorder must not bump
// `version` (there would be nothing in edit_log to explain the bump — the
// invariant is version increments iff content actually changed, and every
// increment has an edit_log row). applyTwlSortOrderUpdates is called from
// BOTH the nightly export and the reimport canonical post-pass to write
// computed sort_order — this must match rows.ts's in-app reorder fast path,
// which sets sort_order + updated_at only. Before this fix it also did
// `version = version + 1`, so the two paths disagreed and a twl row's version
// could advance with no edit_log row explaining it.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/twlSortOrderApply.test.mjs

import { DatabaseSync } from "node:sqlite";
import { applyTwlSortOrderUpdates } from "./twlSortOrderApply.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Minimal D1 shim over node:sqlite — same shape exportLockDryRun.test.mjs
// uses. applyTwlSortOrderUpdates only needs .prepare().bind() and .batch().
function makeDb(sqlite) {
  const mk = (sql, args) => ({
    sql,
    args,
    bind: (...a) => mk(sql, a),
    run() {
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(s.run());
      return out;
    },
  };
}

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE twl_rows (
      id TEXT NOT NULL,
      book TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL DEFAULT 0,
      last_change_action TEXT,
      last_change_source TEXT,
      last_change_actor TEXT,
      PRIMARY KEY (book, id)
    );
  `);
  return sqlite;
}

function seed(sqlite, rows) {
  const stmt = sqlite.prepare(
    `INSERT INTO twl_rows (id, book, sort_order, version, updated_at) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const r of rows) stmt.run(r.id, r.book, r.sort_order, r.version ?? 1, r.updated_at ?? 0);
}

function readRow(sqlite, book, id) {
  return sqlite
    .prepare(
      `SELECT sort_order, version, updated_at, last_change_action, last_change_source, last_change_actor FROM twl_rows WHERE book = ? AND id = ?`,
    )
    .all(book, id)[0];
}

// #686: provenance is a REQUIRED parameter (no default) — any test call must
// state one explicitly, same as every real caller.
const PROVENANCE = { action: "sync_reorder", source: "dcs_sync", actor: "Door43 sync (unmeasured)" };

const BOOK = "REV";

console.log("\n[issue #687: applyTwlSortOrderUpdates leaves version unchanged, writes sort_order + updated_at]");
{
  const sqlite = freshDb();
  seed(sqlite, [
    { id: "aaaa", book: BOOK, sort_order: 1, version: 3, updated_at: 100 },
    { id: "bbbb", book: BOOK, sort_order: 2, version: 7, updated_at: 100 },
  ]);
  const db = makeDb(sqlite);

  await applyTwlSortOrderUpdates(
    db,
    BOOK,
    [
      { id: "aaaa", sort_order: 5 },
      { id: "bbbb", sort_order: 6 },
    ],
    PROVENANCE,
  );

  const aaaa = readRow(sqlite, BOOK, "aaaa");
  const bbbb = readRow(sqlite, BOOK, "bbbb");
  eq(aaaa.sort_order, 5, "aaaa: sort_order written");
  eq(aaaa.version, 3, "aaaa: version unchanged (was 3)");
  eq(aaaa.updated_at > 100, true, "aaaa: updated_at advanced");
  eq(aaaa.last_change_action, PROVENANCE.action, "aaaa: last_change_action stamped");
  eq(aaaa.last_change_source, PROVENANCE.source, "aaaa: last_change_source stamped");
  eq(aaaa.last_change_actor, PROVENANCE.actor, "aaaa: last_change_actor stamped");
  eq(bbbb.sort_order, 6, "bbbb: sort_order written");
  eq(bbbb.version, 7, "bbbb: version unchanged (was 7)");
  eq(bbbb.updated_at > 100, true, "bbbb: updated_at advanced");
}

console.log("\n[a row not in the updates list is untouched]");
{
  const sqlite = freshDb();
  seed(sqlite, [{ id: "cccc", book: BOOK, sort_order: 9, version: 1, updated_at: 42 }]);
  const db = makeDb(sqlite);

  await applyTwlSortOrderUpdates(db, BOOK, [{ id: "aaaa", sort_order: 5 }], PROVENANCE);

  const cccc = readRow(sqlite, BOOK, "cccc");
  eq(
    cccc,
    {
      sort_order: 9,
      version: 1,
      updated_at: 42,
      last_change_action: null,
      last_change_source: null,
      last_change_actor: null,
    },
    "cccc: untouched (not in the update batch)",
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll twlSortOrderApply assertions passed.");
