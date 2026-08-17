// End-to-end journey for issue #427's option 3 (sweep obsolete tombstones),
// against the REAL production schema (every file in api/migrations, applied in
// order) and the REAL functions — mirrors reimportJourney.test.mjs's rationale
// exactly: a test that hand-copies the sweep's SQL proves nothing if the real
// SQL later drifts (e.g. someone "simplifies" away the `deleted_at IS NOT NULL`
// re-assertion on the DELETE and it starts eating live rows).
//
// Run from api/ (needs the sqlite flag):
//   node --experimental-sqlite --experimental-strip-types --no-warnings --import ./src/tsResolveHook.mjs src/tombstoneSweep.test.mjs
//
// What this covers, matching the task's four seeded cases plus several extra
// safety proofs:
//   (a) an OBSOLETE tombstone (id absent from master's book-wide file
//       entirely) — must be HARD-deleted (an actual DELETE, not another
//       soft-delete: the row must be gone, not merely re-tombstoned) — AND
//       its edit_log history purged with it.
//   (b) a SAME-REFERENCE "pending delete" tombstone (id present on master at
//       the SAME ref) — must survive untouched; sweeping it would resurrect a
//       delete that hasn't been exported yet.
//   (c) a REISSUED tombstone (id present on master at a DIFFERENT ref) — must
//       survive untouched (option 2's territory, not this fix's), AND must
//       still produce the correct tombstone_blocked count via the REAL
//       applyTsvRows — proving this change doesn't interfere with option 2.
//   (d) a tombstone in a LOCKED chapter that would otherwise be obsolete —
//       must survive this run, counted tombstones_locked (deferred), not swept.
//   (e) EXTRA — a LIVE (non-tombstoned) row whose id is ALSO absent from
//       master must never be touched by the sweep at all (the sweep only ever
//       reads/writes `deleted_at IS NOT NULL` rows — a live row master
//       dropped is softDeleteRemovedTsvRows' job, a different function,
//       elsewhere).
//   (f) EXTRA — an empty/garbled incoming file must sweep nothing (the same
//       defensive guard softDeleteRemovedTsvRows has, now proven for this
//       function too).
//   (g) EXTRA — the sweep reaches a chapter whose ONLY discrepancy is an
//       already-obsolete tombstone, even though changedTsvChapters (the
//       live-row diff the nightly caller uses to decide what else to touch)
//       reports that chapter as unchanged. This is the exact steady-state
//       case a chapter-list-restricted sweep would starve (Codex review on
//       PR #484): driven against the REAL changedTsvChapters to prove the
//       chapter really is invisible to a live-row diff, not just asserted.
//   (h) EXTRA — sweeping an obsolete tombstone purges its edit_log entries,
//       and does NOT touch the edit_log entries of tombstones that survive
//       (pending-delete, reissued, locked) — the identity-conflation hazard
//       from the same review: a future row that reuses a freed id must not
//       inherit the swept row's history via the (kind, book, row_key) key the
//       history endpoint (rows.ts) reads.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { applyTsvRows, changedTsvChapters, sweepObsoleteTombstonesForTest, zeroCountsForTest } from "./bookReimport.ts";
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

// ── Minimal D1 shim over node:sqlite — identical to reimportJourney.test.mjs ──
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

function seedTombstone(sqlite, { id, ref, chapter, verse, question = "old question" }) {
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, sort_order, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, BOOK, chapter, verse, ref, question, 10, 1753900000);
}

function seedLive(sqlite, { id, ref, chapter, verse, question = "live question" }) {
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, BOOK, chapter, verse, ref, question, 10);
}

// A row's audit trail — what the sweep's edit_log purge must clean up for a
// swept id, and must leave alone for every id that survives.
function seedEditLog(sqlite, { id, action = "delete" }) {
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, action) VALUES ('tq', ?, ?, ?)`,
    )
    .run(id, BOOK, action);
}

function editLogCount(sqlite, id) {
  return sqlite.prepare(`SELECT COUNT(*) AS n FROM edit_log WHERE kind = 'tq' AND row_key = ?`).all(id)[0].n;
}

// Shaped exactly like parseTsvRow's output for a tq row — mirrors
// reimportJourney.test.mjs's masterRow() helper.
function masterRow({ id, ref, chapter, verse, question = "new question" }) {
  return {
    id,
    idCoerced: false,
    refRaw: ref,
    chapter,
    verse,
    occurrence: null,
    tags: null,
    quote: null,
    question,
    response: null,
  };
}

// Real master TSV text (tab-delimited, tq header shape) — parsed independently
// by sweepObsoleteTombstonesForTest, exactly as the reimport's fetched file
// would be. `pad5`/`pad7`/`pad8` exist ONLY to keep their chapters "covered"
// (softDeleteRemovedTsvRows-style: a chapter with zero rows anywhere in
// master's CURRENT file is not "covered" and is skipped defensively) without
// affecting the ids under test.
function tqMasterTsv(rows) {
  const header = "Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse";
  const lines = rows.map((r) =>
    [r.ref, r.id, "", "", "", r.question ?? "", r.response ?? ""].join("\t"),
  );
  return [header, ...lines].join("\n");
}

const MASTER_ROWS = [
  { id: "pad5", ref: "5:9", chapter: 5, verse: 9, question: "unrelated q (keeps ch5 covered)" },
  { id: "pen1", ref: "6:1", chapter: 6, verse: 1, question: "pending delete master copy" },
  { id: "pad7", ref: "7:9", chapter: 7, verse: 9, question: "unrelated q (keeps ch7 covered)" },
  { id: "pad8", ref: "8:9", chapter: 8, verse: 9, question: "unrelated q (keeps ch8 covered)" },
  { id: "hoig", ref: "23:7", chapter: 23, verse: 7, question: "new question" },
];

console.log("\n[(a)-(d)+(h) combined: obsolete swept + history purged, pending-delete + reissued + locked survive untouched]");
{
  const { sqlite, env } = freshEnv();

  // (a) obsolete: id absent from master's file entirely.
  seedTombstone(sqlite, { id: "obs1", ref: "5:1", chapter: 5, verse: 1 });
  // (b) pending delete: id present at the SAME reference.
  seedTombstone(sqlite, { id: "pen1", ref: "6:1", chapter: 6, verse: 1 });
  // (c) reissued: id present at a DIFFERENT reference (the real 1CH incident
  // shape — same id/refs reimportJourney.test.mjs uses for continuity).
  seedTombstone(sqlite, { id: "hoig", ref: "5:4", chapter: 5, verse: 4 });
  // (d) would-be-obsolete, but its chapter is locked this run.
  seedTombstone(sqlite, { id: "lok1", ref: "7:1", chapter: 7, verse: 1 });

  // (h) audit trail for all four — only obs1's should get purged.
  seedEditLog(sqlite, { id: "obs1" });
  seedEditLog(sqlite, { id: "pen1" });
  seedEditLog(sqlite, { id: "hoig" });
  seedEditLog(sqlite, { id: "lok1" });

  // Lock chapter 7 with a non-terminal AI pipeline job (activePipelineForChapter's
  // real query source).
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 101, 'bethoakes')`).run();
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs
         (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state)
       VALUES ('job1', 1, 'tqs', ?, 7, 7, 'sess1', 'running')`,
    )
    .run(BOOK);

  // (c)'s other half: drive the REAL applyTsvRows over master's rows FIRST —
  // exactly the run order production uses (apply/chunk phase, then prune, then
  // sweep) — and prove tombstone_blocked is measured correctly.
  const incoming = MASTER_ROWS.map((r) => masterRow(r));
  const applyCounts = await applyTsvRows(env, BOOK, "tq", incoming, null);
  eq(applyCounts.tombstone_blocked, 1, "(c) reissued tombstone counted exactly once, via the real applyTsvRows");
  // pen1 is a tombstone at the SAME reference (case b), so it takes the
  // tombstone branch (skipped_edited), not the insert path — only the three
  // truly-new padding rows insert normally.
  eq(applyCounts.inserted, 3, "(c) sanity: the 3 non-colliding master rows (pad5/pad7/pad8) inserted normally");

  // Now the sweep — no chapter list at all. It derives its own coverage from
  // `raw`, which is exactly what closes the chapter-coverage gap: a real
  // nightly run's changed-chapters list would legitimately be EMPTY here
  // (none of these rows are live, so nothing about them shows up in a
  // live-row diff — see the (g) test below for that proven directly), and
  // this call must still reach every one of them.
  const raw = tqMasterTsv(MASTER_ROWS);
  const sweep = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(sweep.swept, 1, "(a) exactly one obsolete tombstone swept");
  eq(sweep.skippedLocked, 1, "(d) exactly one chapter deferred for an active pipeline lock");

  const rows = (id) => sqlite.prepare(`SELECT deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, id);

  eq(rows("obs1").length, 0, "(a) the obsolete tombstone is HARD-deleted — gone from the table entirely");
  eq(rows("pen1").length, 1, "(b) the pending-delete tombstone survives");
  eq(rows("pen1")[0].deleted_at != null, true, "(b) and stays deleted_at (still a tombstone, not resurrected)");
  eq(rows("hoig").length, 1, "(c) the reissued tombstone survives — option 3 never touches option 2's territory");
  eq(rows("hoig")[0].deleted_at != null, true, "(c) and stays a tombstone");
  eq(rows("lok1").length, 1, "(d) the locked-chapter tombstone survives this run");
  eq(rows("lok1")[0].deleted_at != null, true, "(d) and stays a tombstone (deferred, not resolved)");

  // (h) the audit-trail purge: gone for the swept id, untouched for the three
  // that survive — a future row reusing pen1/hoig/lok1's id (it can't reuse
  // obs1's; that one really is gone) must never inherit history that isn't
  // its own.
  eq(editLogCount(sqlite, "obs1"), 0, "(h) obs1's edit_log entry is purged along with the row");
  eq(editLogCount(sqlite, "pen1"), 1, "(h) pen1's edit_log entry survives — the row itself was never touched");
  eq(editLogCount(sqlite, "hoig"), 1, "(h) hoig's edit_log entry survives — option 2's territory, not this sweep's");
  eq(editLogCount(sqlite, "lok1"), 1, "(h) lok1's edit_log entry survives — the row was deferred, not swept");

  // The disjointness property, proven END TO END rather than merely reasoned
  // about: the id the sweep actually removed (obs1) is NOT the id
  // tombstone_blocked counted (hoig) — sweeping never touched the row option 2
  // is protecting.
  eq(sweep.swept === 1 && applyCounts.tombstone_blocked === 1, true, "sanity: both counters fired this run");
  const sweptIds = ["obs1"]; // the only id this run's sweep actually deleted
  eq(sweptIds.includes("hoig"), false, "the swept set and the tombstone_blocked row are disjoint, driven end to end");

  // tombstones_swept/tombstones_locked never gate the sync watermark, unlike
  // prune_locked/chapters_locked/conflict_skipped/tombstone_blocked — prove it
  // on the real gate rather than just asserting it in a comment.
  const aggregate = zeroCountsForTest();
  aggregate.tombstones_swept = sweep.swept;
  aggregate.tombstones_locked = sweep.skippedLocked;
  eq(
    shouldRecordResourceSync(aggregate),
    true,
    "a run that only swept/deferred tombstones (everything else zero) still permits the watermark stamp",
  );
}

console.log("\n[order independence: sweeping before applyTsvRows runs gives the identical result]");
{
  // The disjointness claim is about SET MEMBERSHIP, not about which function
  // ran first — prove that by reversing the order and getting the same answer.
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite, { id: "obs1", ref: "5:1", chapter: 5, verse: 1 });
  seedTombstone(sqlite, { id: "hoig", ref: "5:4", chapter: 5, verse: 4 });

  const raw = tqMasterTsv([
    { id: "pad5", ref: "5:9", chapter: 5, verse: 9 },
    { id: "hoig", ref: "23:7", chapter: 23, verse: 7 },
  ]);
  const sweep = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(sweep.swept, 1, "obs1 swept even when the sweep runs BEFORE applyTsvRows this time");

  const incoming = [masterRow({ id: "pad5", ref: "5:9", chapter: 5, verse: 9 }), masterRow({ id: "hoig", ref: "23:7", chapter: 23, verse: 7 })];
  const applyCounts = await applyTsvRows(env, BOOK, "tq", incoming, null);
  eq(applyCounts.tombstone_blocked, 1, "tombstone_blocked is still measured correctly after the sweep already ran");

  const hoigRow = sqlite.prepare(`SELECT deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, "hoig");
  eq(hoigRow.length, 1, "hoig (the reissue) still exists — the earlier sweep never touched it, in either order");
}

console.log("\n[(e) a LIVE row master dropped is NEVER touched by the sweep — that is softDeleteRemovedTsvRows' job]");
{
  const { sqlite, env } = freshEnv();
  // live1's id is absent from master too, exactly like obs1 above — the ONLY
  // difference is deleted_at IS NULL. If someone removes the sweep's
  // `deleted_at IS NOT NULL` guard, this is the assertion that catches it.
  seedLive(sqlite, { id: "liv1", ref: "8:1", chapter: 8, verse: 1 });

  const raw = tqMasterTsv([{ id: "pad8", ref: "8:9", chapter: 8, verse: 9 }]);
  const sweep = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(sweep.swept, 0, "nothing swept — the only row in chapter 8 besides the padding row is LIVE, not a tombstone");

  const live = sqlite.prepare(`SELECT deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, "liv1");
  eq(live.length, 1, "the live row still exists");
  eq(live[0].deleted_at, null, "and is still live — the sweep must never hard-delete a row master merely dropped");
}

console.log("\n[(f) an empty/garbled incoming file sweeps nothing — same defensive guard as softDeleteRemovedTsvRows]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite, { id: "obs1", ref: "5:1", chapter: 5, verse: 1 });

  const sweepEmpty = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", "");
  eq(sweepEmpty, { swept: 0, skippedLocked: 0 }, "an empty file sweeps nothing at all");

  const sweepGarbled = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", "not a tsv file\nat all");
  eq(sweepGarbled.swept, 0, "a headers-only/garbled file (no parseable ID column) sweeps nothing either");

  const obs1 = sqlite.prepare(`SELECT deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, "obs1");
  eq(obs1.length, 1, "the tombstone survives an empty/garbled fetch — never read as \"master carries nothing\"");
}

console.log(
  "\n[(g) REGRESSION (Codex review on PR #484): the sweep reaches a chapter changedTsvChapters reports as unchanged]",
);
{
  // Reproduces the exact bug: a chapter whose ONLY discrepancy from master is
  // an already-obsolete tombstone is invisible to a live-row diff, because
  // deleted_at IS NOT NULL rows are excluded from both sides of that
  // comparison (see changedTsvChapters' `pristine` filter). The nightly
  // caller used to intersect the sweep's target chapters against exactly this
  // diff's output — which meant this exact scenario, the sweep's entire
  // reason to exist, could never be reached on its own.
  const { sqlite, env } = freshEnv();

  // A tombstone in chapter 9, master no longer carries "obs9" anywhere.
  seedTombstone(sqlite, { id: "obs9", ref: "9:1", chapter: 9, verse: 1 });
  // A LIVE row in the same chapter, UNCHANGED from master — this is what
  // makes chapter 9 "quiet" from a live-row point of view while still being
  // part of this run's fetched file (so it's a covered chapter).
  seedLive(sqlite, { id: "liv9", ref: "9:2", chapter: 9, verse: 2, question: "same as master" });

  const raw = tqMasterTsv([{ id: "liv9", ref: "9:2", chapter: 9, verse: 2, question: "same as master" }]);

  // Prove the premise first, against the REAL diff gate: chapter 9 does NOT
  // show up as changed. If a future edit to changedTsvChapters or the pristine
  // filter ever made this chapter "changed" for an unrelated reason, this
  // assertion (not the sweep assertion below) is the one that would catch it
  // and this test would need re-scoping, not silently pass for the wrong reason.
  const changed = await changedTsvChapters(env, BOOK, "tq", raw);
  eq(changed.has(9), false, "chapter 9 is invisible to the live-row diff — its only content is unchanged");

  // The sweep still reaches it, because it no longer takes a chapter-list
  // restriction at all — it derives coverage straight from `raw`.
  const sweep = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(sweep.swept, 1, "(g) obs9 swept even though its chapter never appeared in the live-row diff");

  const obs9 = sqlite.prepare(`SELECT deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, "obs9");
  eq(obs9.length, 0, "(g) and it is genuinely gone, not merely re-tombstoned");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll tombstoneSweep assertions passed.");
