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
// safety proofs. IMPORTANT (Codex third re-review on PR #484): the sweep is
// now a TWO-PHASE confirmation — an id is never hard-deleted on the FIRST run
// that observes it as obsolete, only marked (edit_log, action=
// SWEEP_CANDIDATE_ACTION). It is hard-deleted only on a LATER, independent
// run that observes it as obsolete AGAIN. So most cases below drive
// sweepObsoleteTombstonesForTest TWICE over the SAME `raw` to reach the
// confirmed/swept state, and separately assert the intermediate
// "marked but not yet deleted" state after just the first call — that
// intermediate state IS the safety property under test, not an
// implementation detail to skip past.
//   (a) an OBSOLETE tombstone (id absent from master's book-wide file
//       entirely) — the FIRST run marks it pending and changes nothing else;
//       only the SECOND, independent run HARD-deletes it (an actual DELETE,
//       not another soft-delete: the row must be gone, not merely
//       re-tombstoned) — AND purges its edit_log history (original entry PLUS
//       the marker) with it.
//   (b) a SAME-REFERENCE "pending delete" tombstone (id present on master at
//       the SAME ref) — must survive untouched, on every run; sweeping it
//       would resurrect a delete that hasn't been exported yet.
//   (c) a REISSUED tombstone (id present on master at a DIFFERENT ref) — must
//       survive untouched (option 2's territory, not this fix's), AND must
//       still produce the correct tombstone_blocked count via the REAL
//       applyTsvRows — proving this change doesn't interfere with option 2.
//   (d) a tombstone in a LOCKED chapter that would otherwise be obsolete —
//       must survive every run (its lock never lifts here), counted
//       tombstones_locked (deferred), not swept, and never even reaches the
//       two-phase marker check (filtered out by the lock first).
//   (e) EXTRA — a LIVE (non-tombstoned) row whose id is ALSO absent from
//       master must never be touched by the sweep at all (the sweep only ever
//       reads/writes `deleted_at IS NOT NULL` rows — a live row master
//       dropped is softDeleteRemovedTsvRows' job, a different function,
//       elsewhere).
//   (f) EXTRA — an empty/garbled incoming file must sweep nothing (the same
//       defensive guard softDeleteRemovedTsvRows has, now proven for this
//       function too).
//   (g) EXTRA — the sweep reaches (across two runs) a chapter whose ONLY
//       discrepancy is an already-obsolete tombstone, even though
//       changedTsvChapters (the live-row diff the nightly caller uses to
//       decide what else to touch) reports that chapter as unchanged. This is
//       the exact steady-state case a chapter-list-restricted sweep would
//       starve (Codex review on PR #484): driven against the REAL
//       changedTsvChapters to prove the chapter really is invisible to a
//       live-row diff, not just asserted.
//   (h) EXTRA — sweeping a CONFIRMED obsolete tombstone purges its edit_log
//       entries (original + marker), and does NOT touch the edit_log entries
//       of tombstones that survive (pending-delete, reissued, locked) — the
//       identity-conflation hazard from an earlier review round: a future row
//       that reuses a freed id must not inherit the swept row's history via
//       the (kind, book, row_key) key the history endpoint (rows.ts) reads.
//   (i) EXTRA — more targets than one WRITE_BATCH/2-sized chunk (Codex
//       re-review on PR #484) are all swept + purged, not just the first
//       chunk — proven across both the marking round and the confirming round.
//   (j) EXTRA — a chapter master removed ENTIRELY (zero rows left anywhere in
//       the incoming file) still gets its tombstone swept, across two runs
//       (Codex second re-review on PR #484): chapter coverage is read from
//       D1's stored tombstones, not from the incoming file's own chapter set.
//   (k) EXTRA — a thrown env.DB.batch() during the CONFIRMING run's
//       hard-delete sets applyIncomplete: true so the watermark gets withheld
//       and the resource is retried, instead of a failed chunk's tombstones
//       being silently certified as swept (Codex second re-review on PR
//       #484).
//   (l) EXTRA (Codex third re-review on PR #484) — a thrown env.DB.batch()
//       during the FIRST-SIGHTING run's marker insert is non-fatal: nothing
//       destructive was attempted, applyIncomplete stays false, and the id is
//       simply re-observed (and successfully marked) on the next run.
//   (m) EXTRA (Codex third re-review on PR #484) — a marker younger than
//       SWEEP_CANDIDATE_MIN_AGE_SECONDS does NOT confirm, even though it
//       already exists: both call sites run inside a Workflow step.do with
//       retries, and a same-step retry re-calling this function within
//       seconds must not be mistaken for a genuinely later, independent run.

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

// Pre-seeds a two-phase confirmation marker directly (bypassing the sweep's
// own marker-insert path) — simulates "this id was already marked as a
// candidate by an earlier, independent run". Must match bookReimport.ts's
// SWEEP_CANDIDATE_ACTION literal exactly, or these tests silently stop
// exercising the CONFIRMED branch and pass for the wrong reason.
// Inserted with an explicitly OLD created_at (well past
// SWEEP_CANDIDATE_MIN_AGE_SECONDS=300 in bookReimport.ts) so it reads as "an
// earlier, independent run" immediately, without a test needing to wait.
function seedSweepMarker(sqlite, id) {
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, action, source, created_at) VALUES ('tq', ?, ?, 'sweep_candidate', 'dcs_reimport', ?)`,
    )
    .run(id, BOOK, Math.floor(Date.now() / 1000) - 400);
}

// Simulates "time passed" for a marker the SWEEP ITSELF just inserted (the
// (a)/(g)/(i)/(j)-style two-call tests) — backdates it past
// SWEEP_CANDIDATE_MIN_AGE_SECONDS so the very next call sees it as
// confirmable, without a real 5-minute wait. Only touches markers, never a
// row's own audit entries (WHERE action = 'sweep_candidate').
function ageOutMarkers(sqlite, ...ids) {
  const placeholders = ids.map(() => "?").join(", ");
  sqlite
    .prepare(
      `UPDATE edit_log SET created_at = created_at - 400 WHERE kind = 'tq' AND action = 'sweep_candidate' AND row_key IN (${placeholders})`,
    )
    .run(...ids);
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

  // No chapter list at all. It derives its own coverage from `raw`, which is
  // exactly what closes the chapter-coverage gap: a real nightly run's
  // changed-chapters list would legitimately be EMPTY here (none of these
  // rows are live, so nothing about them shows up in a live-row diff — see
  // the (g) test below for that proven directly), and this call must still
  // reach every one of them.
  const raw = tqMasterTsv(MASTER_ROWS);
  const rows = (id) => sqlite.prepare(`SELECT deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, id);

  // FIRST run: obs1 is seen obsolete for the first time. Two-phase
  // confirmation means it is only MARKED, not deleted — this intermediate
  // state is the safety property under test.
  const sweep1 = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(sweep1.swept, 0, "(a) FIRST sighting of an obsolete id: nothing hard-deleted yet");
  eq(sweep1.pending, 1, "(a) obs1 marked pending on first sighting");
  eq(sweep1.skippedLocked, 1, "(d) exactly one chapter deferred for an active pipeline lock");

  eq(rows("obs1").length, 1, "(a) obs1 still exists after only one sighting — not yet confirmed");
  eq(rows("obs1")[0].deleted_at != null, true, "(a) and is still a tombstone");
  eq(
    editLogCount(sqlite, "obs1"),
    2,
    "(a) obs1 now carries its original edit_log entry PLUS the new sweep_candidate marker",
  );
  eq(rows("pen1").length, 1, "(b) the pending-delete tombstone survives the first run");
  eq(rows("hoig").length, 1, "(c) the reissued tombstone survives the first run");
  eq(rows("lok1").length, 1, "(d) the locked-chapter tombstone survives the first run");

  // Simulates the passage of time between two real nightly runs — a marker
  // only counts as "an earlier, independent run" once it clears
  // SWEEP_CANDIDATE_MIN_AGE_SECONDS (see bookReimport.ts), so back-to-back
  // test calls need this to reach the CONFIRMED branch at all.
  ageOutMarkers(sqlite, "obs1");

  // SECOND run, same `raw`: obs1 is seen obsolete AGAIN — its marker from run
  // 1 already existed BEFORE this call, so it is now CONFIRMED and hard-deleted.
  const sweep2 = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(sweep2.swept, 1, "(a) SECOND, independent sighting: NOW hard-deleted");
  eq(sweep2.pending, 0, "(a) nothing NEW marked this run — obs1 already had a marker, nothing else is obsolete-eligible");
  eq(sweep2.skippedLocked, 1, "(d) chapter 7 is still locked on the second run too");

  eq(rows("obs1").length, 0, "(a) the obsolete tombstone is NOW HARD-deleted — gone from the table entirely");
  eq(rows("pen1").length, 1, "(b) the pending-delete tombstone survives");
  eq(rows("pen1")[0].deleted_at != null, true, "(b) and stays deleted_at (still a tombstone, not resurrected)");
  eq(rows("hoig").length, 1, "(c) the reissued tombstone survives — option 3 never touches option 2's territory");
  eq(rows("hoig")[0].deleted_at != null, true, "(c) and stays a tombstone");
  eq(rows("lok1").length, 1, "(d) the locked-chapter tombstone survives this run");
  eq(rows("lok1")[0].deleted_at != null, true, "(d) and stays a tombstone (deferred, not resolved)");

  // (h) the audit-trail purge: gone for the CONFIRMED-and-swept id (both its
  // original entry and its marker), untouched for the three that survive — a
  // future row reusing pen1/hoig/lok1's id (it can't reuse obs1's; that one
  // really is gone) must never inherit history that isn't its own.
  eq(editLogCount(sqlite, "obs1"), 0, "(h) obs1's edit_log entries (original + marker) are purged along with the row");
  eq(editLogCount(sqlite, "pen1"), 1, "(h) pen1's edit_log entry survives — the row itself was never touched");
  eq(editLogCount(sqlite, "hoig"), 1, "(h) hoig's edit_log entry survives — option 2's territory, not this sweep's");
  eq(editLogCount(sqlite, "lok1"), 1, "(h) lok1's edit_log entry survives — the row was deferred, not swept");

  // The disjointness property, proven END TO END rather than merely reasoned
  // about: the id the sweep actually removed (obs1) is NOT the id
  // tombstone_blocked counted (hoig) — sweeping never touched the row option 2
  // is protecting.
  eq(sweep2.swept === 1 && applyCounts.tombstone_blocked === 1, true, "sanity: both counters fired across this run");
  const sweptIds = ["obs1"]; // the only id this run's sweep actually deleted
  eq(sweptIds.includes("hoig"), false, "the swept set and the tombstone_blocked row are disjoint, driven end to end");

  // tombstones_swept never gates the sync watermark on its own — prove it on
  // the real gate rather than just asserting it in a comment.
  const sweptOnly = zeroCountsForTest();
  sweptOnly.tombstones_swept = sweep2.swept;
  eq(
    shouldRecordResourceSync(sweptOnly),
    true,
    "a run that only swept tombstones (tombstones_locked zero, everything else zero) still permits the watermark stamp",
  );
  // tombstones_locked DOES gate (Codex review on PR #484: it's the only
  // mechanism guaranteeing the deferred chapter gets retried, since the outer
  // SHA gate can otherwise skip an unchanged file forever) — this run really
  // did defer chapter 7's sweep (sweep2.skippedLocked === 1 from (d) above),
  // so the watermark must be withheld even though nothing else in the run failed.
  const withLocked = zeroCountsForTest();
  withLocked.tombstones_swept = sweep2.swept;
  withLocked.tombstones_locked = sweep2.skippedLocked;
  eq(sweep2.skippedLocked, 1, "sanity: this run really did defer a chapter's sweep");
  eq(
    shouldRecordResourceSync(withLocked),
    false,
    "a run whose sweep deferred a locked chapter withholds the watermark, even with everything else clean",
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
  // Two independent sweeps (the two-phase confirmation gate) BEFORE applyTsvRows
  // even runs this time — proving order independence holds for the whole
  // confirm-then-apply sequence, not just a single sweep call.
  const sweepA = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(sweepA.pending, 1, "first sighting marks obs1 pending, before applyTsvRows has run at all");
  ageOutMarkers(sqlite, "obs1");
  const sweepB = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(sweepB.swept, 1, "obs1 confirmed and swept even when both sweeps run BEFORE applyTsvRows this time");

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
  eq(
    sweepEmpty,
    { swept: 0, skippedLocked: 0, pending: 0, applyIncomplete: false },
    "an empty file sweeps nothing at all",
  );

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
  // restriction at all — it derives coverage straight from D1's stored
  // tombstones. Two independent runs for the two-phase confirmation gate.
  const sweepG1 = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(sweepG1.pending, 1, "(g) obs9 marked pending on first sighting, even though its chapter never appeared in the live-row diff");
  ageOutMarkers(sqlite, "obs9");
  const sweepG2 = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(sweepG2.swept, 1, "(g) obs9 confirmed and swept on the second, independent sighting");

  const obs9 = sqlite.prepare(`SELECT deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, "obs9");
  eq(obs9.length, 0, "(g) and it is genuinely gone, not merely re-tombstoned");
}

console.log(
  "\n[(i) REGRESSION (Codex re-review on PR #484): more targets than one batch chunk are all swept + purged]",
);
{
  // sweepObsoleteTombstones batches DELETE row + DELETE edit_log as
  // interleaved pairs in chunks of WRITE_BATCH/2 (45) targets per
  // env.DB.batch() call. Seed more than one chunk's worth to prove the
  // multi-chunk loop actually runs to completion and every chunk's targets
  // land, not just the first.
  const { sqlite, env } = freshEnv();
  const N = 50; // > 45 (WRITE_BATCH / 2) — forces a second batch() call.
  const ids = Array.from({ length: N }, (_, i) => `t${String(i).padStart(3, "0")}`); // t000..t049, valid 4-char ids
  for (const id of ids) {
    seedTombstone(sqlite, { id, ref: "10:1", chapter: 10, verse: 1 });
    seedEditLog(sqlite, { id });
  }
  // A live row in an UNRELATED chapter — just enough to make `incomingIds`
  // non-empty and clear the empty/garbled-file guard. Chapter coverage no
  // longer needs a padding row in chapter 10 itself (see (j) below).
  seedLive(sqlite, { id: "pad0", ref: "99:9", chapter: 99, verse: 9 });

  const raw = tqMasterTsv([{ id: "pad0", ref: "99:9", chapter: 99, verse: 9 }]);

  // FIRST run: all 50 are first-sighting — marked pending (one INSERT batch
  // chunk; 50 < WRITE_BATCH), nothing deleted yet.
  const sweepI1 = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(sweepI1.pending, N, `(i) all ${N} marked pending on first sighting`);
  eq(sweepI1.swept, 0, "(i) nothing hard-deleted on the first sighting");
  ageOutMarkers(sqlite, ...ids);

  // SECOND run: all 50 already have a marker from run 1, so all 50 are now
  // CONFIRMED — this is what actually exercises the multi-chunk delete loop
  // (50 pairs > 45-pair PAIR_BATCH, so it takes 2 env.DB.batch() calls).
  const sweep = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(sweep.swept, N, `(i) all ${N} obsolete tombstones swept across multiple batch() chunks, not just the first 45`);

  const remaining = sqlite.prepare(`SELECT COUNT(*) AS n FROM tq_rows WHERE book = ? AND id LIKE 't0%'`).all(BOOK)[0].n;
  eq(remaining, 0, "(i) every one of the 50 rows is genuinely gone from the table");

  const remainingLogs = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM edit_log WHERE kind = 'tq' AND row_key LIKE 't0%'`)
    .all()[0].n;
  eq(remainingLogs, 0, "(i) and every one of their edit_log entries was purged along with them");
}

console.log(
  "\n[(j) REGRESSION (Codex second re-review on PR #484): a chapter master removed ENTIRELY still gets swept]",
);
{
  // The bug: an earlier version derived chapter coverage from the INCOMING
  // file's own rows. If master drops a chapter completely — zero rows left
  // anywhere in the file — that chapter has no representation there either,
  // so a tombstone sitting in it was permanently unreachable. Prove the fix
  // by seeding a tombstone in chapter 12 and an incoming file that mentions
  // chapter 12 NOWHERE AT ALL (only an unrelated chapter, to keep
  // `incomingIds` non-empty).
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite, { id: "gon1", ref: "12:1", chapter: 12, verse: 1 });

  const raw = tqMasterTsv([{ id: "pad0", ref: "1:1", chapter: 1, verse: 1 }]);
  // Prove the premise: chapter 12 has zero rows in the incoming file at all —
  // no Reference column value starts with "12:".
  const refs = raw.split("\n").slice(1).map((line) => line.split("\t")[0]);
  eq(refs.some((ref) => ref.startsWith("12:")), false, "(j) chapter 12 appears nowhere in the incoming file");

  const sweepJ1 = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(sweepJ1.pending, 1, "(j) gon1 marked pending on first sighting, even though chapter 12 has no rows anywhere in the incoming file");
  ageOutMarkers(sqlite, "gon1");
  const sweep = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(sweep.swept, 1, "(j) gon1 confirmed and swept on the second, independent sighting");

  const gon1 = sqlite.prepare(`SELECT deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, "gon1");
  eq(gon1.length, 0, "(j) and it is genuinely gone");
}

console.log(
  "\n[(k) REGRESSION (Codex second re-review on PR #484): a thrown CONFIRMING-run batch sets applyIncomplete]",
);
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite, { id: "boom", ref: "13:1", chapter: 13, verse: 1 });
  // Pre-seed the marker directly — simulates "boom was already independently
  // confirmed obsolete by an earlier run", so THIS call goes straight to
  // Phase 2 (the hard-delete batch), which is the one under test here.
  seedSweepMarker(sqlite, "boom");

  // Force env.DB.batch() to throw, simulating a D1 batch failure mid-sweep —
  // the same shape as any other correctness-bearing write throw in this file
  // (TSV three-way merge, verse master-adoption).
  const realBatch = env.DB.batch.bind(env.DB);
  let batchCalls = 0;
  env.DB.batch = async (stmts) => {
    batchCalls++;
    throw new Error("simulated D1 batch failure");
  };

  const raw = tqMasterTsv([{ id: "pad0", ref: "1:1", chapter: 1, verse: 1 }]);
  const sweep = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(batchCalls, 1, "(k) sanity: the sweep's Phase 2 batch() call actually ran (and threw)");
  eq(sweep.swept, 0, "(k) nothing counted as swept when the batch threw");
  eq(sweep.pending, 0, "(k) nothing counted as newly pending — boom was already confirmed, not first-seen");
  eq(sweep.applyIncomplete, true, "(k) applyIncomplete is set so the caller withholds the watermark and retries");

  // The row is untouched — the batch threw before (or during) its D1 round
  // trip, so nothing committed.
  env.DB.batch = realBatch;
  const boom = sqlite.prepare(`SELECT deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, "boom");
  eq(boom.length, 1, "(k) the tombstone is untouched — the failed batch changed nothing");
  eq(boom[0].deleted_at != null, true, "(k) and is still a tombstone, not half-deleted");
  eq(editLogCount(sqlite, "boom"), 1, "(k) the pre-existing marker survives too — the failed batch touched neither");
}

console.log(
  "\n[(l) REGRESSION (Codex third re-review on PR #484): a thrown FIRST-SIGHTING marker batch is non-fatal]",
);
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite, { id: "boom2", ref: "14:1", chapter: 14, verse: 1 });
  // No pre-seeded marker this time — boom2 is genuinely first-seen, so this
  // call's only batch write is the MARKER INSERT, not a hard-delete.

  const realBatch = env.DB.batch.bind(env.DB);
  let batchCalls = 0;
  env.DB.batch = async (stmts) => {
    batchCalls++;
    throw new Error("simulated D1 batch failure");
  };

  const raw = tqMasterTsv([{ id: "pad0", ref: "1:1", chapter: 1, verse: 1 }]);
  const sweep = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(batchCalls, 1, "(l) sanity: the sweep's marker-insert batch() call actually ran (and threw)");
  eq(sweep.pending, 0, "(l) nothing counted as marked — the insert batch threw");
  eq(sweep.swept, 0, "(l) nothing swept either — this id never reached Phase 2 at all");
  eq(
    sweep.applyIncomplete,
    false,
    "(l) applyIncomplete stays FALSE — nothing destructive was attempted, so there is no watermark consequence",
  );

  // Nothing committed: no marker, row untouched.
  env.DB.batch = realBatch;
  eq(editLogCount(sqlite, "boom2"), 0, "(l) no marker was written — the failed insert left no trace");
  const boom2 = sqlite.prepare(`SELECT deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, "boom2");
  eq(boom2.length, 1, "(l) the tombstone is untouched");
  eq(boom2[0].deleted_at != null, true, "(l) and is still a tombstone");

  // A later, clean run successfully marks it — proving the failure was
  // transient and self-healing, not a permanent block.
  const sweepRetry = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(sweepRetry.pending, 1, "(l) a later clean run successfully marks boom2 — the earlier failure didn't poison anything");
}

console.log(
  "\n[(m) REGRESSION (Codex third re-review on PR #484): a too-young marker does NOT confirm — the step.do-retry-collapse guard]",
);
{
  // Both call sites run sweepObsoleteTombstones inside a Workflow step.do
  // with retries (reimport-fetch-${book}: limit 2, ~10-30s backoff). If that
  // step throws AFTER this function already committed a marker for one
  // resource (e.g. a later resource's R2 write fails), the WHOLE step
  // retries — calling this function again for the SAME resource within
  // seconds. Without an age check, that second call would read the marker it
  // JUST inserted as "an earlier, independent run" and hard-delete
  // immediately — collapsing two attempts of ONE logical run into exactly
  // the single-observation deletion the two-phase gate exists to prevent.
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite, { id: "retry1", ref: "15:1", chapter: 15, verse: 1 });
  const raw = tqMasterTsv([{ id: "pad0", ref: "1:1", chapter: 1, verse: 1 }]);

  const first = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(first.pending, 1, "(m) first call marks retry1 pending");

  // Immediately again, NO time simulated to pass — the shape of a same-step
  // retry, not a genuinely later run.
  const immediateRetry = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(immediateRetry.swept, 0, "(m) an immediate re-call does NOT confirm — the marker is too young to count as independent");
  // A duplicate marker gets inserted (the existing one doesn't count as
  // "already marked" yet, so it still looks first-seen) — harmless: Phase 2's
  // purge deletes every edit_log entry for the row_key regardless of count,
  // and confirmation only ever needs ONE marker old enough, not exactly one.
  eq(immediateRetry.pending, 1, "(m) a duplicate marker is inserted since the existing one isn't old enough to count yet");

  const stillTombstoned = sqlite.prepare(`SELECT deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, "retry1");
  eq(stillTombstoned.length, 1, "(m) retry1 survives the immediate re-call completely untouched");
  eq(stillTombstoned[0].deleted_at != null, true, "(m) and is still a tombstone");

  // Once real time (simulated here) actually passes, the SAME marker now
  // counts, and the very next call confirms it — proving the guard delays
  // rather than permanently blocks.
  ageOutMarkers(sqlite, "retry1");
  const laterRun = await sweepObsoleteTombstonesForTest(env, BOOK, "tq", raw);
  eq(laterRun.swept, 1, "(m) once the marker is old enough, a genuinely later run confirms and sweeps it");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll tombstoneSweep assertions passed.");
