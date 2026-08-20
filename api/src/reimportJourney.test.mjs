// End-to-end journey for issue #427's tombstone fix, against the REAL
// production schema (every file in api/migrations, applied in order) and the
// REAL functions — not hand-copied SQL.
//
// Run from api/ (needs the sqlite flag):
//   node --experimental-sqlite --experimental-strip-types --no-warnings src/reimportJourney.test.mjs
//
// WHY THIS EXISTS, and why the earlier test was not enough. tombstoneCollision
// .test.mjs proves SQLite's behavior by re-typing applyTsvRows' two statements
// into the test. That proves nothing if the real SQL later drifts — and the
// single most drift-sensitive line in this whole fix is the `existing` read's
// deliberate ABSENCE of a `deleted_at IS NULL` filter. If someone "tidies" that
// filter in, a tombstoned id stops reaching the tombstone branch, the counters
// silently stop firing, and every test that re-types the SQL still passes.
// So this file drives the real applyTsvRows and the real gate.
//
// What the journey covers:
//   (a) a reissued tombstone is RECLAIMED — master's content lands, deleted_at
//       clears, and the watermark is NOT withheld (issue #427 option 1)
//   (b) a reclaim that cannot WRITE (a protected row) falls back to the
//       pre-option-1 behavior: counted, blocked, and the watermark IS withheld
//       — including that the taint survives the addCounts aggregation step
//   (c) the banner is QUERYABLE from system_alerts, where the UI reads it
//   (d) the HEALTHY path still stamps origin='reimport' — no false withhold

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyTsvRows,
  recordResourceSync,
  recordWithheldSyncIfAbsent,
  zeroCountsForTest,
  addCountsForTest,
  raiseTombstoneBlockAlertForTest,
} from "./bookReimport.ts";
import { shouldRecordResourceSync } from "./reimportSyncGate.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ── Minimal D1 shim over node:sqlite ───────────────────────────────────────
// Mirrors the slice of the D1 API bookReimport.ts uses: prepare().bind().all()
// / .first() / .run(), and batch(). `.run()` returns D1's `{ meta: { changes } }`
// shape, which is the exact signal the conflict counter reads.
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
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(s.run());
      return out;
    },
  };
}

function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  return { sqlite, env: { DB: makeDb(sqlite) } };
}

const BOOK = "1CH";
// The real id from the incident: minted for a 1CH 5:4 question, hand-deleted
// 2026-07-30, then reissued by bp-assistant for 1CH 23:7.
const ID = "hoig";

function seedTombstone(sqlite, { id = ID, ref = "5:4", chapter = 5, verse = 4 } = {}) {
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, BOOK, chapter, verse, ref, "old question", "old response", 10, 1753900000);
}

// A tn tombstone a human had flagged `preserve` on before deleting it.
// buildTsvUpdateStmt's tn pristine predicate re-asserts `preserve = 0`
// regardless of the reclaim's relaxed ownership guard, so this row can never
// be reclaimed out from under a human's protection — the reclaim UPDATE must
// match 0 rows.
function seedProtectedTnTombstone(sqlite, { id = ID, ref = "5:4", chapter = 5, verse = 4 } = {}) {
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, deleted_at, preserve)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, BOOK, chapter, verse, ref, "old note", 10, 1753900000, 1);
}

// Shaped exactly like parseTsvRow's output for a tq row.
function masterRow({ id = ID, ref = "23:7", chapter = 23, verse = 7, idCoerced = false } = {}) {
  return {
    id,
    idCoerced,
    refRaw: ref,
    chapter,
    verse,
    occurrence: null,
    tags: null,
    quote: null,
    question: "new question",
    response: "new response",
  };
}

// Shaped exactly like parseTsvRow's output for a tn row.
function masterTnRow({ id = ID, ref = "23:7", chapter = 23, verse = 7, idCoerced = false } = {}) {
  return {
    id,
    idCoerced,
    refRaw: ref,
    chapter,
    verse,
    occurrence: null,
    tags: null,
    support_reference: null,
    quote: null,
    note: "new note",
  };
}

console.log("\n[(a) a reissued tombstone is RECLAIMED — master's content lands]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite);
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow()], null);

  eq(counts.tombstone_reclaimed, 1, "tombstone_reclaimed === 1 (issue #427 option 1)");
  eq(counts.tombstone_blocked, 0, "not blocked — the reclaim wrote successfully");
  eq(counts.skipped_edited, 0, "not skipped either — master's content actually landed");
  eq(counts.inserted, 0, "landed as an UPDATE of the dead slot, not a fresh INSERT");
  eq((counts.blocked_samples ?? []).length, 0, "nothing to report as blocked");

  // Master's row really is in D1 now, at its NEW reference, deleted_at cleared.
  const stored = sqlite
    .prepare(`SELECT chapter, verse, question, deleted_at, version FROM tq_rows WHERE book = ? AND id = ?`)
    .all(BOOK, ID);
  eq(stored.length, 1, "still exactly one row for that (book, id)");
  eq(stored[0].chapter, 23, "the row now reflects master's NEW reference");
  eq(stored[0].question, "new question", "master's text landed");
  eq(stored[0].deleted_at, null, "and it is no longer a tombstone");
  eq(Number(stored[0].version), 2, "version bumped by the reclaim write");

  // Audited under its own action so a future ancestor fold anchors on what D1
  // now actually holds, not the dead row's pre-reclaim history.
  const log = sqlite
    .prepare(`SELECT action FROM edit_log WHERE kind = 'tq' AND row_key = ? ORDER BY id DESC LIMIT 1`)
    .all(ID)[0];
  eq(log?.action, "reclaim", "audited as its own action, distinct from restore/update");

  eq(shouldRecordResourceSync(counts), true, "and the watermark is NOT withheld — nothing was lost");
}

console.log("\n[the same-reference tombstone must NOT count — it is a delete awaiting export]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite, { ref: "5:4", chapter: 5, verse: 4 });
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow({ ref: "5:4", chapter: 5, verse: 4 })], null);
  eq(counts.tombstone_blocked, 0, "same ref → not blocked (the 4 AMO rows in the production sweep)");
  eq(counts.tombstone_reclaimed, 0, "and never even attempted — no reissue to reclaim");
  eq(counts.skipped_edited, 1, "still skipped, which is what preserves the pending deletion");
  eq(shouldRecordResourceSync(counts), true, "and the watermark is NOT withheld for it");
}

console.log("\n[a COERCED id must never be reclaimed or count as blocked — review finding F4]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite, { ref: "5:4", chapter: 5, verse: 4 });
  // coerceRowId hashes a malformed master id into a 96-id space, so landing on
  // an unrelated tombstone at a different reference is an expected collision,
  // not evidence master reissued anything. Reclaiming it would stomp a
  // documented-benign no-op with unrelated content.
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow({ ref: "23:7", idCoerced: true })], null);
  eq(counts.tombstone_blocked, 0, "coerced id + different ref → NOT blocked (documented-benign no-op)");
  eq(counts.tombstone_reclaimed, 0, "and NOT reclaimed either — the reference test is meaningless for a coerced id");
  eq(shouldRecordResourceSync(counts), true, "so a coercion collision cannot withhold the watermark");
}

console.log("\n[(b) a reclaim that cannot WRITE falls back to blocked, and the watermark is WITHHELD]");
{
  const { sqlite, env } = freshEnv();
  seedProtectedTnTombstone(sqlite);
  const counts = await applyTsvRows(env, BOOK, "tn", [masterTnRow()], null);

  eq(counts.tombstone_reclaimed, 0, "the reclaim attempt did not land");
  eq(counts.tombstone_blocked, 1, "so it falls back to blocked, exactly like before option 1 shipped");
  eq(counts.skipped_edited, 1, "and skipped_edited too, matching the pre-option-1 shape");
  eq((counts.blocked_samples ?? []).length, 1, "one sample recorded, so the banner can name the row a human must fix");

  const stored = sqlite.prepare(`SELECT chapter, note, deleted_at FROM tn_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
  eq(stored[0].chapter, 5, "the preserved tombstone was never touched");
  eq(stored[0].note, "old note", "master's content never landed — a protected row cannot be reclaimed out from under it");

  // The gate is consulted on the AGGREGATE, not on this raw object — that is the
  // step where an absent counter could be laundered into a present zero. Prove
  // the taint survives it by folding through the real aggregation path.
  const aggregate = zeroCountsForTest();
  addCountsForTest(aggregate, counts);
  eq(aggregate.tombstone_blocked, 1, "the count survives aggregation (addCounts)");
  eq(shouldRecordResourceSync(aggregate), false, "the gate refuses to stamp on the aggregate");

  // Now the real write path the reimport-sync step takes when it withholds.
  await recordWithheldSyncIfAbsent(env, BOOK, "tn");
  const row = sqlite
    .prepare(`SELECT source_sha, origin FROM book_resource_syncs WHERE book = ? AND resource = ?`)
    .all(BOOK, "tn")[0];
  eq(row?.origin, "reimport_withheld", "STORED origin is 'reimport_withheld', NOT 'reimport'");
  eq(
    row?.source_sha,
    "withheld",
    "and the stored sha is the sentinel — a value no real commit sha can equal, so the export's " +
      "freshness gate reports master_ahead instead of the no_watermark/ok it would return for an absent row",
  );
}

console.log("\n[(c) the banner is QUERYABLE where the UI reads it]");
{
  const { sqlite, env } = freshEnv();
  seedProtectedTnTombstone(sqlite);
  const counts = await applyTsvRows(env, BOOK, "tn", [masterTnRow()], null);
  await raiseTombstoneBlockAlertForTest(env, BOOK, "tn", counts);

  const alert = sqlite
    .prepare(`SELECT username, severity, source, message FROM system_alerts WHERE source = ?`)
    .all(`reimport_id_blocked:${BOOK}:tn`)[0];
  eq(alert !== undefined, true, "an alert row exists in system_alerts");
  eq(alert?.severity, "error", "raised at error severity");
  eq(alert?.message.includes("1CH"), true, "names the book");
  eq(alert?.message.includes("hoig"), true, "names the actual blocked row id, so it is actionable");
  eq(
    alert?.message.includes("does NOT clear on its own"),
    true,
    "states the freeze-until-a-human-acts consequence plainly",
  );
  eq(
    alert?.message.includes("re-run the sync"),
    false,
    "and does NOT repeat the export_stale banner's advice, which cannot work here",
  );
}

console.log("\n[(d) the HEALTHY path still stamps — no false withhold]");
{
  const { sqlite, env } = freshEnv();
  // No tombstone at all: master's row is genuinely new.
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow()], null);
  eq(counts.inserted, 1, "the row lands normally");
  eq(counts.tombstone_blocked, 0, "nothing blocked");
  eq(counts.tombstone_reclaimed, 0, "nothing reclaimed — there was no tombstone to reclaim");
  eq(counts.conflict_skipped, 0, "nothing conflicted");
  eq(shouldRecordResourceSync(counts), true, "the gate permits the stamp");

  await recordResourceSync(env, BOOK, "tq", "abc123def456", "reimport");
  const row = sqlite
    .prepare(`SELECT source_sha, origin FROM book_resource_syncs WHERE book = ? AND resource = ?`)
    .all(BOOK, "tq")[0];
  eq(row?.origin, "reimport", "STORED origin is 'reimport' — the book IS certified in sync");
  eq(row?.source_sha, "abc123def456", "with master's real sha, not the sentinel");

  const alerts = sqlite.prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE source LIKE 'reimport_id_blocked:%'`).all()[0];
  eq(Number(alerts.n), 0, "and no banner is raised on a clean run");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll reimportJourney assertions passed.");
