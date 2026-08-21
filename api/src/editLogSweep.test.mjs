// Regression tests for the edit_log retention sweep's merge-ancestor
// exemption (issue #537).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/editLogSweep.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors blankStubTrash.test.mjs.
//
// The hazard: the three-way verse merge reconstructs its ancestor from
// edit_log (newest 'create'/'update' at/before the book+resource's
// master-confirmed boundary). The old sweep —
// `DELETE FROM edit_log WHERE created_at < cutoff` — would eventually delete
// the last pre-watermark row for a verse, making it PERMANENTLY
// unadjudicable. These tests run the LITERAL production SQL
// (EDIT_LOG_SWEEP_SQL) against real SQLite, then prove the ancestor the merge
// would pick is still there — asserting the string would prove nothing about
// what SQLite does with it.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EDIT_LOG_SWEEP_SQL } from "./editLogSweep.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Real schema, real migrations — same pattern as applyVerseRows.test.mjs, so
// the tested table shapes cannot drift from production's.
function freshDb() {
  const d = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    d.exec(readFileSync(join(dir, f), "utf8"));
  }
  return d;
}

function logRow(d, { id, kind = "verse", rowKey, book = null, action, createdAt, payload = null }) {
  d.prepare(
    `INSERT INTO edit_log (id, kind, row_key, book, action, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, kind, rowKey, book, action, payload, createdAt);
}

function syncRow(d, { book, resource, confirmedAt = null, editId = null }) {
  d.prepare(
    `INSERT INTO book_resource_syncs (book, resource, origin, master_confirmed_at, master_confirmed_edit_id)
     VALUES (?, ?, 'import', ?, ?)`,
  ).run(book, resource, confirmedAt, editId);
}

function sweep(d, cutoff) {
  d.prepare(EDIT_LOG_SWEEP_SQL).run(cutoff);
}

function survivingIds(d) {
  return d.prepare(`SELECT id FROM edit_log ORDER BY id`).all().map((r) => r.id);
}

// The merge's own ancestor lookup — mirrors bookReimport.ts's base_payload
// sub-select (id boundary variant) so the survival claim is proven against
// what the merge actually reads, not against our intuition about it.
// chapter/verse are passed as STRINGS: node:sqlite binds JS numbers as REAL
// (`1` concatenates as "1.0"), a harness quirk production doesn't have —
// there the concatenation reads the verses table's own INTEGER columns.
function mergeAncestorPayload(d, book, chapter, verse, bibleVersion, masterEditId) {
  const row = d
    .prepare(
      `SELECT payload_json FROM edit_log
        WHERE kind = 'verse'
          AND row_key = ?1 || '/' || ?3 || '/' || ?4 || '/' || ?2
          AND (book = ?1 OR book IS NULL)
          AND action IN ('create', 'update')
          AND id <= ?5
        ORDER BY id DESC LIMIT 1`,
    )
    .get(book, bibleVersion, chapter, verse, masterEditId);
  return row ? row.payload_json : null;
}

console.log("\n[a verse edited before the watermark keeps its merge ancestor across a full age-out sweep]");
{
  const d = freshDb();
  // Watermark: master was confirmed at t=5000, precise boundary = edit id 2.
  syncRow(d, { book: "ZEC", resource: "ult", confirmedAt: 5000, editId: 2 });
  const key = "ZEC/1/5/ULT";
  logRow(d, { id: 1, rowKey: key, book: "ZEC", action: "create", createdAt: 1000, payload: '{"content":"v1"}' });
  logRow(d, { id: 2, rowKey: key, book: "ZEC", action: "update", createdAt: 2000, payload: '{"content":"v2"}' }); // the ancestor
  logRow(d, { id: 3, rowKey: key, book: "ZEC", action: "update", createdAt: 6000, payload: '{"content":"v3"}' }); // post-boundary
  logRow(d, { id: 4, kind: "tn", rowKey: "ab3d", book: "ZEC", action: "update", createdAt: 1000 }); // non-verse kind

  // Simulate the far future: EVERY row is past retention.
  sweep(d, 100000);

  assert(survivingIds(d).join(",") === "2", "only the newest pre-boundary create/update survives (older history, post-boundary rows, tn rows all swept)");
  assert(
    mergeAncestorPayload(d, "ZEC", "1", "5", "ULT", 2) === '{"content":"v2"}',
    "the merge's own base_payload lookup still recovers the ancestor after the sweep",
  );
}

console.log("\n[0050 warm-up: with master_confirmed_edit_id NULL, the exemption cuts on the timestamp watermark]");
{
  const d = freshDb();
  syncRow(d, { book: "LAM", resource: "ult", confirmedAt: 5000, editId: null });
  const key = "LAM/3/22/ULT";
  logRow(d, { id: 1, rowKey: key, book: "LAM", action: "create", createdAt: 1000 });
  logRow(d, { id: 2, rowKey: key, book: "LAM", action: "update", createdAt: 2000, payload: '{"content":"pre"}' });
  logRow(d, { id: 3, rowKey: key, book: "LAM", action: "update", createdAt: 7000 }); // at/after watermark

  sweep(d, 100000);

  assert(survivingIds(d).join(",") === "2", "newest create/update with created_at < master_confirmed_at survives; the rest is swept");
}

console.log("\n[the newest pre-watermark 'baseline' survives by content time, not id — back-dating is the whole point]");
{
  const d = freshDb();
  syncRow(d, { book: "JER", resource: "ust", confirmedAt: 5000, editId: 9 });
  const key = "JER/31/33/UST";
  logRow(d, { id: 9, rowKey: key, book: "JER", action: "update", createdAt: 1000, payload: '{"content":"human"}' });
  // pipelineImport back-dates baseline created_at to the content's own
  // timestamp, so a HIGHER id can carry OLDER content time. The newest
  // pre-watermark baseline by created_at is id 10; an id-ordered rule would
  // wrongly keep id 11 instead.
  logRow(d, { id: 10, rowKey: key, book: "JER", action: "baseline", createdAt: 1500, payload: '{"content":"pre-ai-new"}' });
  logRow(d, { id: 11, rowKey: key, book: "JER", action: "baseline", createdAt: 500, payload: '{"content":"pre-ai-old"}' });
  logRow(d, { id: 12, rowKey: key, book: "JER", action: "baseline", createdAt: 6000, payload: '{"content":"post-wm"}' }); // post-watermark

  sweep(d, 100000);

  assert(
    survivingIds(d).join(",") === "9,10",
    "survivors are the create/update ancestor AND the newest pre-watermark baseline by created_at (ids 9,10) — not the higher-id baseline",
  );
}

console.log("\n[no watermark → no shield: behavior is unchanged from the plain age sweep]");
{
  const d = freshDb();
  // One book with a NULL watermark row, one with no row at all: neither may
  // shield anything, and the NULL row must not poison the NOT IN (i.e. the
  // delete must still happen).
  syncRow(d, { book: "ECC", resource: "ult", confirmedAt: null, editId: null });
  logRow(d, { id: 1, rowKey: "ECC/1/2/ULT", book: "ECC", action: "update", createdAt: 1000 });
  logRow(d, { id: 2, rowKey: "HOS/1/2/ULT", book: "HOS", action: "update", createdAt: 1000 });

  sweep(d, 100000);

  assert(survivingIds(d).length === 0, "all old rows deleted when no watermark exists (NULL watermark row does not NULL-poison the NOT IN)");
}

console.log("\n[rows younger than the cutoff are never candidates, exempt or not]");
{
  const d = freshDb();
  syncRow(d, { book: "ZEC", resource: "ult", confirmedAt: 5000, editId: 2 });
  const key = "ZEC/2/8/ULT";
  logRow(d, { id: 1, rowKey: key, book: "ZEC", action: "create", createdAt: 1000 });
  logRow(d, { id: 2, rowKey: key, book: "ZEC", action: "update", createdAt: 2000 });

  // Cutoff between the two rows: only id 1 is old enough to be a candidate.
  // The true ancestor (id 2) is young, so id 1 is the newest pre-boundary row
  // AMONG CANDIDATES and is overkept — the documented harmless direction
  // (the merge still reads id 2; id 1 is reclaimed once id 2 ages past the
  // cutoff, as the first test proves).
  sweep(d, 1500);

  assert(survivingIds(d).join(",") === "1,2", "young ancestor untouched; the older candidate is overkept rather than risk the base");
}

console.log("\n[P1.3 same-second edit: the id boundary exempts a row whose created_at is AT/after the watermark]");
{
  const d = freshDb();
  // The exact precision case migration 0050 exists for: an edit committed in
  // the same second as the export's D1 read has created_at == watermark but
  // id <= master_confirmed_edit_id — the merge counts it as the ancestor, so
  // the shield must too.
  syncRow(d, { book: "ZEC", resource: "ult", confirmedAt: 5000, editId: 2 });
  const key = "ZEC/4/6/ULT";
  logRow(d, { id: 1, rowKey: key, book: "ZEC", action: "create", createdAt: 1000 });
  logRow(d, { id: 2, rowKey: key, book: "ZEC", action: "update", createdAt: 5000, payload: '{"content":"same-second"}' });

  sweep(d, 100000);

  assert(survivingIds(d).join(",") === "2", "the same-second row under the id boundary survives; the id arm ignores created_at, as the merge does");
}

console.log("\n[a row whose book column contradicts its row_key is not exempted over the row the merge would read]");
{
  const d = freshDb();
  // The merge's sub-select requires (book = ?1 OR book IS NULL). A corrupt or
  // hand-repaired row whose book column disagrees with its row_key is one the
  // merge SKIPS — exempting it while deleting the lower-id row the merge
  // actually reads would lose the base.
  syncRow(d, { book: "ZEC", resource: "ult", confirmedAt: 5000, editId: 10 });
  const key = "ZEC/5/9/ULT";
  logRow(d, { id: 1, rowKey: key, book: "ZEC", action: "update", createdAt: 1000, payload: '{"content":"real base"}' });
  logRow(d, { id: 2, rowKey: key, book: "HOS", action: "update", createdAt: 2000, payload: '{"content":"mismatched"}' });

  sweep(d, 100000);

  const ids = survivingIds(d);
  assert(ids.includes(1), "the row the merge would pick (book matches) survives");
  assert(
    mergeAncestorPayload(d, "ZEC", "5", "9", "ULT", 10) === '{"content":"real base"}',
    "…and the merge's own lookup still recovers it",
  );
}

console.log("\n[two books and both resources coexist without cross-shielding or cross-deleting]");
{
  const d = freshDb();
  syncRow(d, { book: "ZEC", resource: "ult", confirmedAt: 5000, editId: 1 });
  syncRow(d, { book: "ZEC", resource: "ust", confirmedAt: 5000, editId: 2 });
  syncRow(d, { book: "HOS", resource: "ult", confirmedAt: 5000, editId: 3 });
  logRow(d, { id: 1, rowKey: "ZEC/1/1/ULT", book: "ZEC", action: "update", createdAt: 1000 });
  logRow(d, { id: 2, rowKey: "ZEC/1/1/UST", book: "ZEC", action: "update", createdAt: 1000 });
  logRow(d, { id: 3, rowKey: "HOS/1/1/ULT", book: "HOS", action: "update", createdAt: 1000 });
  logRow(d, { id: 4, rowKey: "HOS/1/1/ULT", book: "HOS", action: "create", createdAt: 500 }); // superseded by id 3

  sweep(d, 100000);

  assert(survivingIds(d).join(",") === "1,2,3", "each book+resource keeps exactly its own ancestor; the superseded row is swept");
}

console.log("\n[a legacy row with book IS NULL is still shielded — the join reads row_key, as the merge does]");
{
  const d = freshDb();
  syncRow(d, { book: "ZEC", resource: "ult", confirmedAt: 5000, editId: 7 });
  logRow(d, { id: 7, rowKey: "ZEC/9/9/ULT", book: null, action: "update", createdAt: 2000, payload: '{"content":"legacy"}' });

  sweep(d, 100000);

  assert(survivingIds(d).join(",") === "7", "NULL-book ancestor survives (merge accepts book IS NULL rows, so the shield must too)");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall editLogSweep tests passed");
