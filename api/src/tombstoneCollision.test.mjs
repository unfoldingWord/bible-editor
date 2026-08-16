// Integration test: the two DATABASE-level claims behind issue #427's option-2
// instrumentation, run against REAL SQLite rather than asserted from reading.
// The pure discriminator (isReissuedTombstone) and the watermark gate
// (shouldRecordResourceSync) are unit-tested in reimportClassify.test.mjs and
// reimportSyncGate.test.mjs; those tests cannot see how D1 actually behaves, and
// both of the following were load-bearing enough to be worth proving.
//
// Run from api/ (needs the sqlite flag):
//   node --experimental-sqlite --experimental-strip-types --no-warnings src/tombstoneCollision.test.mjs
//
// CLAIM 1 — a soft-deleted row still holds its (book, id) PRIMARY KEY, so the
//   reimport's per-row `INSERT ... ON CONFLICT(id, book) DO NOTHING` writes ZERO
//   rows for a master row bearing that id. That zero is the signal the new
//   `conflict_skipped` counter reads (tryInsertTsvRow returns
//   `(r.meta.changes ?? 0) > 0`), and the drop it represents is silent: no
//   throw, no constraint error, nothing in the result.
//
// CLAIM 2 — and the correction to the issue's own diagnosis: in practice a
//   tombstoned id NEVER REACHES that insert. applyTsvRows classifies rows off
//   one batched read whose WHERE clause is `book = ? AND id IN (...)` with NO
//   `deleted_at IS NULL` filter, so the tombstone comes back, `cur` is truthy,
//   and the row is routed to the tombstone branch — where before this change it
//   was counted as an ordinary `skipped_edited` and lost among thousands of
//   legitimate ones. Anyone "fixing the ON CONFLICT insert" alone would ship a
//   change that could not have caught the 1CH 23 tQ incident.
//
// Both queries below are copied from bookReimport.ts (applyTsvRows' `existing`
// read and tryInsertTsvRow's tq INSERT) with the named ?N params rewritten to
// anonymous ? in the same order, which is the same convention
// tsvMergeIntegration.test.mjs uses.

import { DatabaseSync } from "node:sqlite";
import { isReissuedTombstone } from "./reimportClassify.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const db = new DatabaseSync(":memory:");
// Shape mirrors api/migrations' tq_rows for the columns this path touches. The
// PRIMARY KEY is the whole point: (book, id), book-wide and never released.
db.exec(`
  CREATE TABLE tq_rows (
    id TEXT NOT NULL,
    book TEXT NOT NULL,
    chapter INTEGER NOT NULL,
    verse INTEGER NOT NULL,
    -- NOT NULL, matching every real migration (0001_init.sql,
    -- 0015_composite_row_id.sql). A looser test schema would let the tests
    -- assert states the production schema forbids.
    ref_raw TEXT NOT NULL,
    tags TEXT,
    quote TEXT,
    occurrence INTEGER,
    question TEXT,
    response TEXT,
    sort_order INTEGER,
    version INTEGER NOT NULL DEFAULT 1,
    updated_by INTEGER,
    deleted_at INTEGER,
    PRIMARY KEY (book, id)
  );
`);

const BOOK = "1CH";
// The real id from the incident: minted for a 1CH 5:4 question, hand-deleted
// 2026-07-30, then reissued by bp-assistant for 1CH 23:7.
const ID = "hoig";

// Seed the tombstone: the ORIGINAL row at 5:4, soft-deleted (row stays).
db.prepare(
  `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, deleted_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(ID, BOOK, 5, 4, "5:4", "old question", "old response", 10, 1753900000);

console.log("\n[CLAIM 1: ON CONFLICT DO NOTHING silently writes zero rows]");

// tryInsertTsvRow's tq statement, verbatim apart from param style. This is
// master's NEW row for 1CH 23:7, which happens to carry the tombstoned id.
const insert = db.prepare(
  `INSERT INTO tq_rows
     (id, book, chapter, verse, ref_raw, tags, quote, occurrence, question, response, sort_order)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id, book) DO NOTHING`,
);
let threw = null;
let changes = null;
try {
  changes = Number(insert.run(ID, BOOK, 23, 7, "23:7", null, null, null, "new question", "new response", 20).changes);
} catch (e) {
  threw = e instanceof Error ? e.message : String(e);
}
eq(threw, null, "the colliding insert does NOT throw — the drop is silent, which is why it needed a counter");
eq(changes, 0, "the colliding insert writes 0 rows (this is the meta.changes signal conflict_skipped reads)");

// And the data really is gone: the tombstone is untouched and master's row is
// nowhere in the table.
const stored = db.prepare(`SELECT chapter, verse, question, deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
eq(stored.length, 1, "still exactly one row for that (book, id)");
eq(stored[0].chapter, 5, "the surviving row is the old 5:4 tombstone, not master's 23:7 row");
eq(stored[0].question, "old question", "master's question text never landed");
eq(stored[0].deleted_at != null, true, "and it is still soft-deleted, so it will not export either");

console.log("\n[CLAIM 2: the tombstone is found by the classify read, so the insert is never reached]");

// applyTsvRows' `existing` read, verbatim apart from param style and dropping
// the latest_source correlated subquery (edit_log is not modeled here; it does
// not affect which ROWS come back). The absence of `deleted_at IS NULL` is the
// whole point of this assertion.
const existing = db
  .prepare(
    `SELECT id, ref_raw, chapter, verse, tags, quote, occurrence, question, response, sort_order,
            version, updated_by, deleted_at
       FROM tq_rows WHERE book = ? AND id IN (?)`,
  )
  .all(BOOK, ID);
eq(existing.length, 1, "the classify read RETURNS the tombstone (no deleted_at IS NULL filter)");
eq(
  existing[0].deleted_at != null,
  true,
  "so `cur` is truthy and `cur.deleted_at != null` routes the row to the tombstone branch, not the insert",
);

console.log("\n[the two branches compose: the drop is real and is now counted]");

// Reproduce the tombstone branch's decision over the real rows, the way
// applyTsvRows now does it.
const cur = existing[0];
const masterRow = { refRaw: "23:7", chapter: 23, verse: 7 };
eq(
  isReissuedTombstone(
    { refRaw: cur.ref_raw, chapter: Number(cur.chapter), verse: Number(cur.verse) },
    masterRow,
  ),
  true,
  "tombstone at 5:4 vs master at 23:7 → tombstone_blocked (the 1CH 23 tQ drop, now measured)",
);

// The delete-pending-export case must stay uncounted, or every unexported
// deletion would withhold its book's watermark nightly. This is the 4 AMO rows.
db.prepare(
  `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, sort_order, deleted_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run("amo1", "AMO", 1, 2, "1:2", "pending delete", 30, 1754000000);
const pending = db
  .prepare(`SELECT ref_raw, chapter, verse FROM tq_rows WHERE book = ? AND id = ?`)
  .all("AMO", "amo1")[0];
eq(
  isReissuedTombstone(
    { refRaw: pending.ref_raw, chapter: Number(pending.chapter), verse: Number(pending.verse) },
    { refRaw: "1:2", chapter: 1, verse: 2 },
  ),
  false,
  "tombstone and master row at the SAME ref → NOT counted (a delete awaiting export; skipping it is correct)",
);

console.log("\n[the OTHER way ON CONFLICT fires: a duplicate id in master's own file]");

// Review finding: applyTsvRows reads `existing` ONCE, before the loop, and never
// updates it after a successful insert. So if master's TSV carries the same id
// twice, the second occurrence still misses `existing`, reaches the insert, and
// is refused with 0 changes — identical to a tombstone collision from the
// insert's point of view. That must NOT be counted as conflict_skipped:
// conflict_skipped withholds the watermark, and a duplicate id on master never
// clears by itself, so mislabelling it would freeze the book's export forever
// over a condition the old code treated as harmless. This repo has shipped
// duplicated master rows before (the ISA 48 delete+dup repair). applyTsvRows now
// tracks ids inserted this pass and classifies the second one skipped_dup BEFORE
// reaching the insert; this proves the underlying DB behavior that makes the
// guard necessary.
const DUP = "dup1";
const first = Number(insert.run(DUP, BOOK, 2, 1, "2:1", null, null, null, "first", null, 40).changes);
const second = Number(insert.run(DUP, BOOK, 9, 9, "9:9", null, null, null, "second", null, 41).changes);
eq(first, 1, "first occurrence of a duplicated master id inserts normally");
eq(
  second,
  0,
  "second occurrence writes 0 changes — INDISTINGUISHABLE from a tombstone collision at the insert, hence the pre-insert guard",
);
// And note it is NOT a tombstone at all: the blocking row is live.
const dupRow = db.prepare(`SELECT deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, DUP)[0];
eq(dupRow.deleted_at, null, "the row holding the slot here is LIVE, not a tombstone — a different cause entirely");

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll tombstoneCollision assertions passed.");
