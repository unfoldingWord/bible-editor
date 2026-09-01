// Regression test for issue #587: `allowLocked` + a dry run (dryDcs / no
// DCS_SERVICE_TOKEN) must not write `twl_rows.sort_order` to D1 for a frozen
// book — "frozen" has to mean no D1 write, not just no Door43 push (see the
// comment above the book-lock gate in exportWorkflow.ts's exportOne). Before
// the fix, `applyTwlSortOrderUpdates` ran unconditionally once `allowLocked`
// bypassed the lock gate, so a dry run silently mutated a locked book's
// stored sort order with nothing reaching Door43 to review.
//
// exportOne itself can't be imported: exportWorkflow.ts pulls in
// `cloudflare:workers` (WorkflowEntrypoint), which doesn't exist outside the
// Workers runtime. Per the convention lockOverrideAlert.test.mjs and
// tombstoneCollision.test.mjs establish for this exact problem, the small
// gating decision is re-typed verbatim (mirrors exportOne, exportWorkflow.ts
// ~line 597-610) while the actual D1 write goes through the REAL, directly
// importable `applyTwlSortOrderUpdates` (twlSortOrderApply.ts) — so the
// D1-mutation half of this test is not hand-copied SQL.
//
// Run from api/ (needs the sqlite flag):
//   node --experimental-sqlite --experimental-strip-types --no-warnings src/exportLockDryRun.test.mjs

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

// Minimal D1 shim over node:sqlite — same shape reimportJourney.test.mjs
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
  return sqlite.prepare(`SELECT sort_order, version FROM twl_rows WHERE book = ? AND id = ?`).all(book, id)[0];
}

// Re-types exportOne's gate verbatim (exportWorkflow.ts ~line 597-610): the
// decision of whether to persist computed sort-order updates to D1 at all.
async function maybeApplyTwlSortOrder(db, book, updates, dcsAllowed) {
  if (updates.length === 0) return;
  if (dcsAllowed) {
    await applyTwlSortOrderUpdates(db, book, updates);
  }
  // else: dry run — discarded, matching exportOne's console.log-only branch.
}

const BOOK = "REV";
const updates = [
  { id: "aaaa", sort_order: 5 },
  { id: "bbbb", sort_order: 6 },
];

console.log("\n[issue #587 success check: allowLocked + dry run leaves twl_rows.sort_order unchanged]");
{
  const sqlite = freshDb();
  seed(sqlite, [
    { id: "aaaa", book: BOOK, sort_order: 1 },
    { id: "bbbb", book: BOOK, sort_order: 2 },
  ]);
  const db = makeDb(sqlite);

  await maybeApplyTwlSortOrder(db, BOOK, updates, /* dcsAllowed */ false);

  eq(readRow(sqlite, BOOK, "aaaa"), { sort_order: 1, version: 1 }, "dry run: row aaaa's sort_order is untouched");
  eq(readRow(sqlite, BOOK, "bbbb"), { sort_order: 2, version: 1 }, "dry run: row bbbb's sort_order is untouched");
}

console.log("\n[a non-dry allowLocked run keeps today's behavior: sort_order IS written, version untouched (#687)]");
{
  const sqlite = freshDb();
  seed(sqlite, [
    { id: "aaaa", book: BOOK, sort_order: 1 },
    { id: "bbbb", book: BOOK, sort_order: 2 },
  ]);
  const db = makeDb(sqlite);

  await maybeApplyTwlSortOrder(db, BOOK, updates, /* dcsAllowed */ true);

  // #687: a pure reorder is positional metadata, not content — it must not
  // bump version (which would have no edit_log row to explain it) and must
  // match rows.ts's in-app reorder fast path, which likewise leaves version
  // alone.
  eq(
    readRow(sqlite, BOOK, "aaaa"),
    { sort_order: 5, version: 1 },
    "live run: row aaaa's sort_order is written, version unchanged",
  );
  eq(
    readRow(sqlite, BOOK, "bbbb"),
    { sort_order: 6, version: 1 },
    "live run: row bbbb's sort_order is written, version unchanged",
  );
}

console.log("\n[canary: reverting exportOne's gate (calling applyTwlSortOrderUpdates unconditionally) fails the dry-run case]");
{
  const sqlite = freshDb();
  seed(sqlite, [{ id: "aaaa", book: BOOK, sort_order: 1 }]);
  const db = makeDb(sqlite);
  // The pre-#587 behavior: no gate at all.
  await applyTwlSortOrderUpdates(db, BOOK, [{ id: "aaaa", sort_order: 5 }]);
  const row = readRow(sqlite, BOOK, "aaaa");
  eq(
    row.sort_order === 5,
    true,
    "sanity: an ungated call DOES write on a dry run — proves the gate above is what protects it, not the D1 layer",
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll exportLockDryRun assertions passed.");
