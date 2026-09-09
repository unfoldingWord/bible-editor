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
import { verseVersionFloorSql } from "./verseBridge.ts";

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

function logRow(d, {
  id, kind = "verse", rowKey, book = null, action, createdAt, payload = null, source = null,
  prevVersion = null, newVersion = null,
}) {
  d.prepare(
    `INSERT INTO edit_log (id, kind, row_key, book, action, payload_json, created_at, source, prev_version, new_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, kind, rowKey, book, action, payload, createdAt, source, prevVersion, newVersion);
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
  logRow(d, { id: 3, rowKey: key, book: "ZEC", action: "update", createdAt: 6000, payload: '{"content":"v3"}' }); // post-boundary, but the GLOBAL newest create/update
  logRow(d, { id: 4, kind: "tn", rowKey: "ab3d", book: "ZEC", action: "update", createdAt: 1000 }); // non-verse kind

  // Simulate the far future: EVERY row is past retention.
  sweep(d, 100000);

  assert(
    survivingIds(d).join(",") === "2,3",
    "the ancestor (2) AND the global-newest create/update (3, issue #573 gap 1a, protects latest_source) survive; older history and the tn row are swept",
  );
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
  logRow(d, { id: 3, rowKey: key, book: "LAM", action: "update", createdAt: 7000 }); // at/after watermark, but the GLOBAL newest create/update

  sweep(d, 100000);

  assert(
    survivingIds(d).join(",") === "2,3",
    "the pre-watermark ancestor (2) AND the global-newest create/update (3, gap 1a) survive; older history is swept",
  );
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

console.log("\n[issue #603: two same-second baselines tie on created_at — the higher id survives, insert order (id 10 then id 11)]");
{
  const d = freshDb();
  syncRow(d, { book: "JER", resource: "ust", confirmedAt: 5000, editId: 9 });
  const key = "JER/32/1/UST";
  logRow(d, { id: 9, rowKey: key, book: "JER", action: "update", createdAt: 1000, payload: '{"content":"human"}' });
  logRow(d, { id: 10, rowKey: key, book: "JER", action: "baseline", createdAt: 4000, payload: '{"content":"OLD"}' });
  logRow(d, { id: 11, rowKey: key, book: "JER", action: "baseline", createdAt: 4000, payload: '{"content":"NEW"}' });

  sweep(d, 4500);

  assert(
    survivingIds(d).join(",") === "9,11",
    "on a created_at tie the higher id (11, chronologically later) survives, not the lower id — bare MAX(created_at) beside the ungrouped id is arbitrary on a tie",
  );
}

console.log("\n[issue #603: same tie as above, inserted in reverse order (id 11 then id 10) — must not depend on insert order]");
{
  const d = freshDb();
  syncRow(d, { book: "JER", resource: "ust", confirmedAt: 5000, editId: 9 });
  const key = "JER/32/2/UST";
  logRow(d, { id: 9, rowKey: key, book: "JER", action: "update", createdAt: 1000, payload: '{"content":"human"}' });
  logRow(d, { id: 11, rowKey: key, book: "JER", action: "baseline", createdAt: 4000, payload: '{"content":"NEWER"}' });
  logRow(d, { id: 12, rowKey: key, book: "JER", action: "baseline", createdAt: 4000, payload: '{"content":"OLDER"}' });

  sweep(d, 4500);

  assert(
    survivingIds(d).join(",") === "9,12",
    "the higher id (12) survives regardless of insert order",
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
  logRow(d, { id: 4, rowKey: "HOS/1/1/ULT", book: "HOS", action: "create", createdAt: 500 }); // post-boundary as ancestor, but the GLOBAL newest by id

  sweep(d, 100000);

  assert(
    survivingIds(d).join(",") === "1,2,3,4",
    "each book+resource keeps its own ancestor (1,2,3); id 4 also survives as HOS/1/1/ULT's global-newest create/update (gap 1a)",
  );
}

// bookReimport.ts's human_edit_after_export probe (id boundary variant) —
// mirrors the EXISTS check so the survival claim is proven against what the
// merge actually reads, not against our intuition about it.
function humanEditAfterExport(d, book, chapter, verse, bibleVersion, masterEditId) {
  const row = d
    .prepare(
      `SELECT 1 FROM edit_log
        WHERE kind = 'verse'
          AND row_key = ?1 || '/' || ?3 || '/' || ?4 || '/' || ?2
          AND (book = ?1 OR book IS NULL)
          AND source IS NULL
          AND action <> 'baseline'
          AND id > ?5`,
    )
    .get(book, bibleVersion, chapter, verse, masterEditId);
  return !!row;
}

console.log("\n[issue #573 gap 1b: a post-boundary human edit (source IS NULL) survives a full age-out sweep, so human_edit_after_export still reads true on a stalled-boundary book]");
{
  const d = freshDb();
  syncRow(d, { book: "JON", resource: "ult", confirmedAt: 5000, editId: 3 });
  const key = "JON/1/1/ULT";
  logRow(d, { id: 3, rowKey: key, book: "JON", action: "create", createdAt: 1000, payload: '{"content":"ancestor"}' });
  // A translator edited after the export watermark was stamped. This is
  // exactly the row bookReimport.ts's human_edit_after_export EXISTS check
  // needs to keep finding, or a stalled-boundary book (locked/published,
  // never re-exports) can eventually misread this verse as unedited.
  logRow(d, { id: 5, rowKey: key, book: "JON", action: "update", createdAt: 6000 }); // source column defaults NULL: a human edit

  sweep(d, 100000);

  assert(survivingIds(d).join(",") === "3,5", "ancestor (3) AND the post-boundary human edit (5, gap 1b) both survive");
  assert(
    humanEditAfterExport(d, "JON", "1", "1", "ULT", 3) === true,
    "the merge's own human_edit_after_export probe still reads true after the sweep",
  );
}

console.log("\n[issue #573 gap 1b: an AI-sourced post-boundary row is not shielded by gap 1b — only a genuinely newer human edit is]");
{
  const d = freshDb();
  syncRow(d, { book: "JON", resource: "ust", confirmedAt: 5000, editId: 3 });
  const key = "JON/1/1/UST";
  logRow(d, { id: 3, rowKey: key, book: "JON", action: "create", createdAt: 1000, payload: '{"content":"ancestor"}' });
  logRow(d, { id: 5, rowKey: key, book: "JON", action: "update", createdAt: 6000, source: "ai_pipeline" }); // post-boundary, AI — superseded, not the global newest either
  logRow(d, { id: 6, rowKey: key, book: "JON", action: "update", createdAt: 7000 }); // newest overall AND the first real human edit

  sweep(d, 100000);

  assert(
    survivingIds(d).join(",") === "3,6",
    "the AI-sourced row (5) is swept — it is neither the ancestor, the global newest (6 is), nor a human edit (source IS NULL)",
  );
  assert(
    humanEditAfterExport(d, "JON", "1", "1", "UST", 3) === true,
    "human_edit_after_export still reads true off the surviving human row (6)",
  );
}

console.log("\n[issue #573 gap 2: #548's other candidate-ancestor action classes each get their own newest pre-watermark row shielded]");
{
  const d = freshDb();
  syncRow(d, { book: "NAM", resource: "ult", confirmedAt: 5000, editId: null });
  const key = "NAM/1/1/ULT";
  logRow(d, { id: 1, rowKey: key, book: "NAM", action: "restore_master_verse", createdAt: 1000, payload: '{"content":"old-restore"}', source: "data_repair" });
  logRow(d, { id: 2, rowKey: key, book: "NAM", action: "restore_master_verse", createdAt: 2000, payload: '{"content":"newest-pre-wm-restore"}', source: "data_repair" });
  // Post-watermark and non-NULL source, so gap 1b's human_edit_after_export
  // shield (which fires on ANY non-baseline action with source IS NULL,
  // matching bookReimport.ts's probe exactly) does not also protect this row
  // — isolating what gap 2 alone shields.
  logRow(d, { id: 3, rowKey: key, book: "NAM", action: "restore_master_verse", createdAt: 6000, source: "data_repair" }); // post-watermark: not exempt
  logRow(d, { id: 4, rowKey: key, book: "NAM", action: "heal-replacement-chars", createdAt: 1500, source: "data_repair" }); // a different class: its own newest pre-watermark row
  logRow(d, { id: 5, rowKey: key, book: "NAM", action: "some_unlisted_action", createdAt: 1500, source: "data_repair" }); // not on #548's list: must not be exempted

  sweep(d, 100000);

  assert(
    survivingIds(d).join(",") === "2,4",
    "only the newest pre-watermark row per (verse, action) among #548's listed classes survives — the older same-class row (1), the post-watermark row (3), and the unlisted action (5) are all swept",
  );
}

console.log("\n[issue #603: gap 2 same-second tie within one (row_key, action) — the higher id survives, insert order (id 20 then id 21)]");
{
  const d = freshDb();
  syncRow(d, { book: "NAM", resource: "ult", confirmedAt: 5000, editId: null });
  const key = "NAM/2/2/ULT";
  logRow(d, { id: 20, rowKey: key, book: "NAM", action: "heal-replacement-chars", createdAt: 4000, payload: '{"content":"OLDER"}', source: "data_repair" });
  logRow(d, { id: 21, rowKey: key, book: "NAM", action: "heal-replacement-chars", createdAt: 4000, payload: '{"content":"NEWER"}', source: "data_repair" });

  sweep(d, 4500);

  assert(survivingIds(d).join(",") === "21", "the higher id (21) survives the created_at tie within the same (row_key, action) partition");
}

console.log("\n[issue #603: same gap 2 tie, inserted in reverse order (id 31 then id 30) — must not depend on insert order]");
{
  const d = freshDb();
  syncRow(d, { book: "NAM", resource: "ult", confirmedAt: 5000, editId: null });
  const key = "NAM/2/3/ULT";
  logRow(d, { id: 31, rowKey: key, book: "NAM", action: "heal-replacement-chars", createdAt: 4000, payload: '{"content":"NEWER"}', source: "data_repair" });
  logRow(d, { id: 30, rowKey: key, book: "NAM", action: "heal-replacement-chars", createdAt: 4000, payload: '{"content":"OLDER"}', source: "data_repair" });

  sweep(d, 4500);

  assert(survivingIds(d).join(",") === "31", "the higher id (31) survives regardless of insert order");
}

console.log("\n[a legacy row with book IS NULL is still shielded — the join reads row_key, as the merge does]");
{
  const d = freshDb();
  syncRow(d, { book: "ZEC", resource: "ult", confirmedAt: 5000, editId: 7 });
  logRow(d, { id: 7, rowKey: "ZEC/9/9/ULT", book: null, action: "update", createdAt: 2000, payload: '{"content":"legacy"}' });

  sweep(d, 100000);

  assert(survivingIds(d).join(",") === "7", "NULL-book ancestor survives (merge accepts book IS NULL rows, so the shield must too)");
}

// ── issue #653, branch (6): the tn/tq/twl create shield ─────────────────────
//
// reconstructTsvBases now falls back to a row's newest book-known 'create'
// when its bounded history is empty — the state of every row created after its
// book's export boundary froze. That create is the row's ONLY ancestor, so an
// age-based sweep would silently expire the whole recovery.
function tnRow(d, { id, book = "JER", deletedAt = null }) {
  d.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, deleted_at)
     VALUES (?, ?, 9, 9, '9:9', 'a note', 10, ?)`,
  ).run(id, book, deletedAt);
}

console.log("\n[#653: a LIVE tn row's newest book-known 'create' survives a full age-out sweep]");
{
  const d = freshDb();
  tnRow(d, { id: "ab12" });
  logRow(d, { id: 1, kind: "tn", rowKey: "ab12", book: "JER", action: "create", createdAt: 1000, payload: '{"note":"life one"}' });
  logRow(d, { id: 2, kind: "tn", rowKey: "ab12", book: "JER", action: "create", createdAt: 2000, payload: '{"note":"life two"}' });
  logRow(d, { id: 3, kind: "tn", rowKey: "ab12", book: "JER", action: "update", createdAt: 3000, payload: '{"note":"an app edit"}' });

  sweep(d, 100000);

  assert(
    survivingIds(d).join(",") === "2",
    "the NEWEST create survives — the same entry the fallback folds (the app edit and the dead life's create age out)",
  );
}

console.log("\n[#653: a book-NULL create is NOT shielded — the fallback refuses it, so sheltering it would buy nothing]");
{
  const d = freshDb();
  tnRow(d, { id: "cd34" });
  logRow(d, { id: 5, kind: "tn", rowKey: "cd34", book: null, action: "create", createdAt: 1000, payload: '{"note":"another book"}' });

  sweep(d, 100000);

  assert(survivingIds(d).length === 0, "an entry the fold discards is not kept alive by this branch");
}

console.log("\n[#653: a DELETED tn row's create ages out normally — nothing will ever merge it again]");
{
  const d = freshDb();
  tnRow(d, { id: "ef56", deletedAt: 900 });
  logRow(d, { id: 6, kind: "tn", rowKey: "ef56", book: "JER", action: "create", createdAt: 1000, payload: '{"note":"gone"}' });

  sweep(d, 100000);

  assert(survivingIds(d).length === 0, "the shield is scoped to rows still live in their table");
}

console.log("\n[#653: tq and twl get the same shield, and one kind's row does not shield another's id]");
{
  const d = freshDb();
  d.prepare(
    `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order)
     VALUES ('gh78', 'JER', 9, 9, '9:9', 'q', 'r', 10)`,
  ).run();
  logRow(d, { id: 7, kind: "tq", rowKey: "gh78", book: "JER", action: "create", createdAt: 1000, payload: '{"question":"q"}' });
  // Same id, different kind, and NO twl row exists for it.
  logRow(d, { id: 8, kind: "twl", rowKey: "gh78", book: "JER", action: "create", createdAt: 1000, payload: '{"tw_link":"x"}' });

  sweep(d, 100000);

  assert(survivingIds(d).join(",") === "7", "the tq row's create survives; the twl entry with no live row does not");
}

// ── issue #727/#728 (PR #731 review), branches (7) and (8) ──────────────────
//
// The reimport now reads 'bridge'/'split' rows (latest_source, base_payload,
// the structure planner's structural_edit_id, the start_before ancestor
// fallback) and 'delete' rows (verseVersionFloorSql's version floor, the
// absorbed verse's master_moved_under_local_bridge ancestor). Each probe below
// copies the SQL shape from bookReimport.ts / verseBridge.ts so survival is
// proven against what production reads.

// bookReimport.ts's latest_source sub-select (applyVerseRows and the
// single-verse path share this exact action list).
function latestSource(d, book, chapter, verse, bibleVersion) {
  const row = d
    .prepare(
      `SELECT source FROM edit_log
        WHERE kind = 'verse'
          AND row_key = ?1 || '/' || ?3 || '/' || ?4 || '/' || ?2
          AND (book = ?1 OR book IS NULL)
          AND action IN ('create', 'update', 'bridge', 'split')
        ORDER BY id DESC LIMIT 1`,
    )
    .get(book, bibleVersion, chapter, verse);
  return row === undefined ? "NO_ROW" : row.source;
}

// bookReimport.ts's structural_edit_id sub-select — the planner's LOCAL vs
// EXPORTED evidence for a bridge's start key.
function structuralEditId(d, book, chapter, verse, bibleVersion) {
  const row = d
    .prepare(
      `SELECT id FROM edit_log
        WHERE kind = 'verse'
          AND row_key = ?1 || '/' || ?3 || '/' || ?4 || '/' || ?2
          AND (book = ?1 OR book IS NULL)
          AND action IN ('bridge', 'split')
        ORDER BY id DESC LIMIT 1`,
    )
    .get(book, bibleVersion, chapter, verse);
  return row ? row.id : null;
}

// bookReimport.ts's base_payload sub-select (id boundary variant) with the
// #727 action list — the union of content-bearing ancestor candidates.
function mergeAncestorPayload727(d, book, chapter, verse, bibleVersion, masterEditId) {
  const row = d
    .prepare(
      `SELECT payload_json FROM edit_log
        WHERE kind = 'verse'
          AND row_key = ?1 || '/' || ?3 || '/' || ?4 || '/' || ?2
          AND (book = ?1 OR book IS NULL)
          AND action IN ('create', 'update', 'bridge', 'split')
          AND id <= ?5
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(book, bibleVersion, chapter, verse, masterEditId);
  return row ? row.payload_json : null;
}

// The LITERAL floor expression the reimport's floor-0 INSERT and the split
// route evaluate (verseBridge.ts) — the version a recreated verse is minted at.
function recreatedVersion(d, book, chapter, verse, bibleVersion) {
  const expr = verseVersionFloorSql({
    book: `'${book}'`, chapter: `${chapter}`, verse: `${verse}`, bibleVersion: `'${bibleVersion}'`, floor: "0",
  });
  return d.prepare(`SELECT ${expr} AS v`).get().v;
}

// bookReimport.ts's absorbed-verse ancestor read (newest 'delete' per key).
function newestDeletePayload(d, book, rowKey) {
  const row = d
    .prepare(
      `SELECT payload_json FROM edit_log
        WHERE kind = 'verse' AND action = 'delete' AND (book = ?1 OR book IS NULL) AND row_key = ?2
        ORDER BY id DESC LIMIT 1`,
    )
    .get(book, rowKey);
  return row ? row.payload_json : null;
}

console.log("\n[#731 review: AI 'update' then human 'bridge', both exported and aged out — the bridge survives, so latest_source stays human]");
{
  const d = freshDb();
  // Export ran AFTER the bridge: both rows are under the id boundary, so
  // branch (4)'s post-boundary human-edit shield cannot rescue the bridge.
  syncRow(d, { book: "ZEC", resource: "ult", confirmedAt: 5000, editId: 5 });
  const key = "ZEC/7/3/ULT";
  logRow(d, { id: 1, rowKey: key, book: "ZEC", action: "update", createdAt: 1000, source: "ai_pipeline", prevVersion: 1, newVersion: 2, payload: '{"content":"ai draft"}' });
  logRow(d, { id: 2, rowKey: key, book: "ZEC", action: "bridge", createdAt: 2000, prevVersion: 2, newVersion: 3, payload: '{"content":"bridged","verse_end":4,"start_before":"ai draft"}' }); // source NULL: a human

  sweep(d, 100000);

  assert(
    survivingIds(d).join(",") === "1,2",
    "the human bridge (2) survives beside the global-newest create/update (1) — pre-fix only 1 survived",
  );
  assert(
    latestSource(d, "ZEC", "7", "3", "ULT") === null,
    "latest_source reads the bridge's NULL source (human), not the AI row's 'ai_pipeline'",
  );
  assert(
    mergeAncestorPayload727(d, "ZEC", "7", "3", "ULT", 5) === '{"content":"bridged","verse_end":4,"start_before":"ai draft"}',
    "base_payload still recovers the bridge row as the under-boundary ancestor",
  );
}

console.log("\n[#731 review: same shape with a human 'split' over an AI 'update']");
{
  const d = freshDb();
  syncRow(d, { book: "ZEC", resource: "ust", confirmedAt: 5000, editId: 5 });
  const key = "ZEC/7/3/UST";
  logRow(d, { id: 1, rowKey: key, book: "ZEC", action: "update", createdAt: 1000, source: "ai_pipeline", prevVersion: 3, newVersion: 4, payload: '{"content":"ai bridged"}' });
  logRow(d, { id: 2, rowKey: key, book: "ZEC", action: "split", createdAt: 2000, prevVersion: 4, newVersion: 5, payload: '{"content":"start only","verse_end":null}' });

  sweep(d, 100000);

  assert(survivingIds(d).join(",") === "1,2", "the human split (2) survives — pre-fix only 1 survived");
  assert(latestSource(d, "ZEC", "7", "3", "UST") === null, "latest_source reads the split's NULL source (human)");
  assert(structuralEditId(d, "ZEC", "7", "3", "UST") === 2, "structural_edit_id still resolves to the split row");
}

console.log("\n[#731 review: a LOCAL bridge followed by a local content edit on a stalled boundary keeps its 'bridge' row, so the planner still reads the structure as local]");
{
  const d = freshDb();
  // Boundary stamped at id 1; the bridge and a later text fix both land above
  // it and the book never re-exports (locked/published), so both age out.
  // Branch (4) keeps only the NEWEST post-boundary human row — the 'update' —
  // and pre-fix the bridge beneath it was swept, leaving structural_edit_id
  // NULL: the planner would classify the translator's bridge as EXPORTED and
  // adopt master's un-bridged shape over it.
  syncRow(d, { book: "JON", resource: "ult", confirmedAt: 5000, editId: 1 });
  const key = "JON/2/1/ULT";
  logRow(d, { id: 1, rowKey: key, book: "JON", action: "create", createdAt: 1000, prevVersion: null, newVersion: 1, payload: '{"content":"ancestor"}' });
  logRow(d, { id: 2, rowKey: key, book: "JON", action: "bridge", createdAt: 6000, prevVersion: 1, newVersion: 2, payload: '{"content":"bridged","verse_end":2}' });
  logRow(d, { id: 3, rowKey: key, book: "JON", action: "update", createdAt: 7000, prevVersion: 2, newVersion: 3, payload: '{"content":"bridged, fixed"}' });

  sweep(d, 100000);

  assert(survivingIds(d).join(",") === "1,2,3", "ancestor (1), the bridge (2, branch 7) and the newest human edit (3) all survive — pre-fix 2 was swept");
  assert(structuralEditId(d, "JON", "2", "1", "ULT") === 2, "structural_edit_id still resolves to the bridge row above the boundary");
}

console.log("\n[#727: an imported-then-bridged verse's only row is its 'delete' — it survives, so the version floor still mints above the deleted version]");
{
  const d = freshDb();
  // Bootstrap import writes no edit_log rows; the bridge route's audit for the
  // absorbed verse is 'delete' with prev_version = the deleted version and
  // new_version NULL (verses.ts). Export ran after the bridge, so the row is
  // under the boundary: no other branch shields it.
  syncRow(d, { book: "ZEC", resource: "ult", confirmedAt: 5000, editId: 5 });
  const key = "ZEC/8/2/ULT";
  logRow(d, { id: 3, rowKey: key, book: "ZEC", action: "delete", createdAt: 2000, prevVersion: 1, newVersion: null, payload: '{"content":"absorbed text","absorbed_into":1}' });

  sweep(d, 100000);

  assert(survivingIds(d).join(",") === "3", "the delete row survives — pre-fix it was swept");
  assert(
    recreatedVersion(d, "ZEC", 8, 2, "ULT") === 2,
    "verseVersionFloorSql still mints the recreated verse at deleted+1 = 2 (a swept row collapses this to 1, re-minting the deleted version)",
  );
  assert(
    newestDeletePayload(d, "ZEC", key) === '{"content":"absorbed text","absorbed_into":1}',
    "master_moved_under_local_bridge still finds the absorbed verse's ancestor payload",
  );
}

console.log("\n[#727: step 7s's reimport-sourced 'delete' on a never-exported book survives too, and only the NEWEST delete per key is kept]");
{
  const d = freshDb();
  // No watermark at all — the floor is a CAS invariant regardless of export
  // state, so branch (8) deliberately has no watermark join.
  syncRow(d, { book: "ECC", resource: "ult", confirmedAt: null, editId: null });
  const key = "ECC/3/5/ULT";
  logRow(d, { id: 2, rowKey: key, book: "ECC", action: "delete", createdAt: 1000, prevVersion: 1, newVersion: null, payload: '{"content":"first life"}' });
  logRow(d, { id: 4, rowKey: key, book: "ECC", action: "delete", createdAt: 3000, source: "dcs_reimport", prevVersion: 3, newVersion: null, payload: '{"content":"second life","absorbed_into":4}' });

  sweep(d, 100000);

  assert(survivingIds(d).join(",") === "4", "only the newest delete (4) survives; the older delete (2) ages out — pre-fix both were swept");
  assert(recreatedVersion(d, "ECC", 3, 5, "ULT") === 4, "the floor mints the recreated verse at 3+1 = 4 off the surviving delete's prev_version");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall editLogSweep tests passed");
