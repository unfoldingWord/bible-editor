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
import {
  EDIT_LOG_SWEEP_SQL,
  EDIT_LOG_RETENTION_SECONDS,
  EDIT_LOG_SWEEP_ALARM_MARGIN_SECONDS,
  toStaleSweepBoundary,
  findStaleSweepBoundaries,
  raiseEditLogSweepBoundaryAlerts,
} from "./editLogSweep.ts";

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

// ---------------------------------------------------------------------------
// Issue #573 part 2: pending-ancestor action classes survive the sweep too.

console.log(
  "\n[issue #573 part 2 ablation: a pending-ancestor action class row survives a full age-out sweep, but a same-shaped row from an action NOT on the list does not]",
);
{
  const d = freshDb();
  syncRow(d, { book: "ZEC", resource: "ult", confirmedAt: 5000, editId: 2 });
  const key = "ZEC/3/4/ULT";
  // The verse's real create/update ancestor (branch 1) — kept regardless, so
  // this test isolates branch 3's own behavior rather than accidentally
  // passing because branch 1 happened to keep something.
  logRow(d, { id: 1, rowKey: key, book: "ZEC", action: "create", createdAt: 500, payload: '{"content":"base"}' });
  // A pending-ancestor class row (docs/sync-attribution-handoff.md), pre-watermark.
  logRow(d, { id: 2, rowKey: key, book: "ZEC", action: "restore_master_verse", createdAt: 1000, payload: '{"content":"restored"}' });
  // Same shape, but an action NOT in the #573 list — must still be swept
  // exactly as before this change (the ablation half: if branch 3's action
  // filter were accidentally removed or widened, this row would wrongly
  // survive too).
  logRow(d, { id: 3, rowKey: key, book: "ZEC", action: "dcs_reimport", createdAt: 1000, payload: '{"content":"not exempt"}' });

  sweep(d, 100000);

  const ids = survivingIds(d);
  assert(ids.includes(2), "the pending-ancestor-class row (restore_master_verse) survives the age-out sweep");
  assert(!ids.includes(3), "a same-shaped row from an action NOT on the #573 list is swept (ablation: proves branch 3 isn't just keeping everything)");
}

console.log(
  "\n[issue #573 part 2: a verse with rows in MULTIPLE pending-ancestor classes keeps one exemplar of EACH class, not just the newest overall]",
);
{
  const d = freshDb();
  syncRow(d, { book: "JON", resource: "ust", confirmedAt: 9000, editId: 1 });
  const key = "JON/2/3/UST";
  logRow(d, { id: 1, rowKey: key, book: "JON", action: "create", createdAt: 100, payload: '{"content":"base"}' });
  // Two different pending classes on the same verse, both pre-watermark.
  // 'heal-replacement-chars' is the NEWER of the two by created_at.
  logRow(d, { id: 2, rowKey: key, book: "JON", action: "normalize-align-order", createdAt: 1000, payload: '{"content":"norm"}' });
  logRow(d, { id: 3, rowKey: key, book: "JON", action: "heal-replacement-chars", createdAt: 2000, payload: '{"content":"heal"}' });
  // An older row of the SAME class as id 3 — must be superseded by id 3
  // within that class (the "newest per class" half of the GROUP BY).
  logRow(d, { id: 4, rowKey: key, book: "JON", action: "heal-replacement-chars", createdAt: 1500, payload: '{"content":"heal-old"}' });

  sweep(d, 100000);

  const ids = survivingIds(d);
  assert(ids.includes(2), "the normalize-align-order exemplar survives even though a newer row exists in a DIFFERENT class");
  assert(ids.includes(3), "the newest heal-replacement-chars row survives");
  assert(!ids.includes(4), "the OLDER heal-replacement-chars row is superseded by the newer one of its own class");
}

console.log("\n[issue #573 part 2: pending-ancestor class rows respect the same watermark/no-watermark boundary as baseline]");
{
  const d = freshDb();
  syncRow(d, { book: "NAM", resource: "ult", confirmedAt: 5000, editId: 1 });
  const key = "NAM/1/1/ULT";
  logRow(d, { id: 1, rowKey: key, book: "NAM", action: "create", createdAt: 100, payload: '{"content":"base"}' });
  logRow(d, { id: 2, rowKey: key, book: "NAM", action: "restore", createdAt: 2000 }); // pre-watermark: exempt
  logRow(d, { id: 3, rowKey: key, book: "NAM", action: "restore", createdAt: 6000 }); // post-watermark: not exempt by branch 3

  sweep(d, 100000);

  const ids = survivingIds(d);
  assert(ids.includes(2), "the pre-watermark 'restore' row survives");
  assert(!ids.includes(3), "the post-watermark 'restore' row is swept (branch 3 only shields pre-watermark rows, same as branch 2)");
}

// ---------------------------------------------------------------------------
// Issue #573 part 1: the stale-boundary alarm.

// Minimal D1 shim over node:sqlite — same shape as applyVerseRows.test.mjs's
// makeDb (prepare().bind().all()/.run(), and batch()), reused here so
// findStaleSweepBoundaries / raiseEditLogSweepBoundaryAlerts can run against
// this file's own freshDb() without a second, drifting copy of the schema
// setup.
function makeD1(sqlite) {
  const mk = (sql, args) => ({
    sql,
    args,
    bind: (...a) => mk(sql, a),
    all() {
      return { results: sqlite.prepare(sql).all(...args), success: true };
    },
    run() {
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
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

function alertRows(sqlite, source) {
  return sqlite
    .prepare(`SELECT username, severity, source, message, dismissed_at FROM system_alerts WHERE source LIKE ? ORDER BY source`)
    .all(source);
}

console.log("\n[toStaleSweepBoundary: day math]");
{
  const now = 1_000_000;
  const s = toStaleSweepBoundary({ book: "ZEC", resource: "ult", master_confirmed_at: now - EDIT_LOG_RETENTION_SECONDS + 5 * 86400 }, now);
  assert(s.daysRemaining === 5, `boundary 5 days from the retention cutoff reports 5 days remaining (got ${s.daysRemaining})`);
  const past = toStaleSweepBoundary({ book: "ZEC", resource: "ult", master_confirmed_at: now - EDIT_LOG_RETENTION_SECONDS - 100 }, now);
  assert(past.daysRemaining === 0, "a boundary already past the retention window clamps to 0, never negative");
}

console.log("\n[findStaleSweepBoundaries: a fresh watermark produces no alarm; a watermark older than the threshold does]");
{
  const d = freshDb();
  const env = { DB: makeD1(d) };
  const now = 20_000_000;
  syncRow(d, { book: "ZEC", resource: "ult", confirmedAt: now - 10 * 86400, editId: 1 });
  syncRow(d, { book: "JER", resource: "ust", confirmedAt: now - (EDIT_LOG_RETENTION_SECONDS - EDIT_LOG_SWEEP_ALARM_MARGIN_SECONDS + 86400), editId: 1 });
  syncRow(d, { book: "ECC", resource: "ult", confirmedAt: null, editId: null });
  syncRow(d, { book: "ZEC", resource: "tn", confirmedAt: now - EDIT_LOG_RETENTION_SECONDS * 2, editId: null });

  const stale = await findStaleSweepBoundaries(env, now);

  assert(stale.length === 1, `exactly one stale boundary found (got ${stale.length})`);
  assert(stale[0]?.book === "JER" && stale[0]?.resource === "ust", "the stale boundary is JER ust");
  assert(stale[0]?.daysRemaining < EDIT_LOG_SWEEP_ALARM_MARGIN_SECONDS / 86400, "the stale boundary reports less than the full margin's worth of days remaining");
}

console.log("\n[raiseEditLogSweepBoundaryAlerts: writes a warning naming the book+resource and runway, dismissing it and re-running doesn't duplicate it, and a healed boundary clears its alert]");
{
  const d = freshDb();
  const env = { DB: makeD1(d) };
  const now = 20_000_000;
  const staleAt = now - (EDIT_LOG_RETENTION_SECONDS - EDIT_LOG_SWEEP_ALARM_MARGIN_SECONDS + 2 * 86400);
  syncRow(d, { book: "JER", resource: "ust", confirmedAt: staleAt, editId: 1 });

  await raiseEditLogSweepBoundaryAlerts(env, now);

  let rows = alertRows(d, "edit_log_sweep_boundary_stale:%");
  assert(rows.length === 1, `exactly one alert row written (got ${rows.length})`);
  assert(rows[0]?.severity === "warning", "severity is 'warning', not 'error' — nothing has been lost yet");
  assert(rows[0]?.source === "edit_log_sweep_boundary_stale:JER:ust", "source names the specific book+resource");
  assert(rows[0]?.message.includes("JER") && rows[0]?.message.includes("UST"), "message names the specific book+resource");
  assert(/\d+ day\(s\) of runway/.test(rows[0]?.message ?? ""), "message states roughly how many days of runway remain");

  // Re-running with nothing changed must not create a second row for the
  // same still-undismissed alert.
  await raiseEditLogSweepBoundaryAlerts(env, now);
  rows = alertRows(d, "edit_log_sweep_boundary_stale:%");
  assert(rows.length === 1, "re-running with an unchanged stale boundary does not duplicate the alert");

  // Dismiss it, then re-run with the SAME still-stale boundary: the
  // dismissed row must survive as a historical record and must NOT be
  // resurrected as a fresh undismissed row.
  d.prepare(`UPDATE system_alerts SET dismissed_at = ?1 WHERE source = 'edit_log_sweep_boundary_stale:JER:ust'`).run(now);
  await raiseEditLogSweepBoundaryAlerts(env, now);
  rows = alertRows(d, "edit_log_sweep_boundary_stale:%");
  assert(rows.length === 1, "still exactly one row after dismiss+re-run (no duplicate created)");
  assert(rows[0]?.dismissed_at != null, "the dismissed alert is left dismissed rather than being resurrected while the SAME condition persists");

  // Heal the boundary (a fresh export re-confirms it) and re-run: any
  // lingering UNDISMISSED alert for a now-healthy boundary must clear. Reset
  // dismissed_at first so we're testing the "healed" clear path specifically,
  // not the dismissal-survives path just proven above.
  d.prepare(`UPDATE system_alerts SET dismissed_at = NULL WHERE source = 'edit_log_sweep_boundary_stale:JER:ust'`).run();
  d.prepare(`UPDATE book_resource_syncs SET master_confirmed_at = ?1 WHERE book = 'JER' AND resource = 'ust'`).run(now - 86400);
  await raiseEditLogSweepBoundaryAlerts(env, now);
  rows = alertRows(d, "edit_log_sweep_boundary_stale:%");
  assert(rows.length === 0, "an undismissed alert for a boundary that healed is cleared, not left stale forever");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall editLogSweep tests passed");
