// End-to-end journey for issue #427's option-2 instrumentation AND option 1
// (the reclaim it made visible; see api/src/bookReimport.ts's tombstone
// branch and tombstoneReclaim.test.mjs for reclaim's own dedicated coverage),
// against the REAL production schema (every file in api/migrations, applied
// in order) and the REAL functions — not hand-copied SQL.
//
// Run from api/ (needs the sqlite flag):
//   node --experimental-sqlite --experimental-strip-types --no-warnings src/reimportJourney.test.mjs
//
// WHY THIS EXISTS, and why the earlier test was not enough. tombstoneCollision
// .test.mjs proves SQLite's behavior by re-typing applyTsvRows' two statements
// into the test. That proves nothing if the real SQL later drifts — and the
// single most drift-sensitive line in this whole fix is the `existing` read's
// deliberate ABSENCE of a `deleted_at IS NULL` filter. If someone "tidies" that
// filter in, a tombstoned id stops reaching the tombstone branch, the counter
// silently stops firing, and every test that re-types the SQL still passes.
// So this file drives the real applyTsvRows and the real gate.
//
// What the journey covers:
//   (a) a reissued tombstone is now RECLAIMED automatically — the case that
//       used to only produce a `tombstone_blocked` count now lands master's
//       row in the same run (option 1, GitHub issue #427)
//   (a2) a reclaim that LOSES its version-CAS race falls back to
//        tombstone_blocked exactly as before this fix — never a silent drop
//   (b) the watermark is WITHHELD (now driven by the (a2) race, since a clean
//       reclaim no longer needs a withhold), and the withhold is visible in
//       the STORED book_resource_syncs row (not merely in a return value),
//       including that the taint survives the addCounts aggregation step
//   (c) the banner is QUERYABLE from system_alerts, where the UI reads it
//   (d) the HEALTHY path still stamps origin='reimport' — no false withhold
//   (e) a RECOVERED resource's stale reimport_id_blocked alert is actually
//       CLEARED once the sync-success path records a watermark for it, and
//       clearing is scoped to that (book, resource) only — Codex round-3
//       review on PR #506

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyTsvRows,
  recordResourceSync,
  recordWithheldSyncIfAbsent,
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

console.log("\n[(a) a reissued tombstone is now RECLAIMED — real applyTsvRows, issue #427 option 1]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite);
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow()], null);

  // Before option 1 shipped, this exact scenario (a tombstone master's file
  // now carries at a DIFFERENT reference) only counted tombstone_blocked and
  // dropped the row. Now the reimport reclaims the slot in the SAME run.
  eq(counts.tombstone_reclaimed, 1, "tombstone_reclaimed === 1 — issue #427's option 1 running automatically");
  eq(counts.tombstone_blocked, 0, "NOT counted blocked — the reclaim landed, nothing left to withhold for");
  eq(counts.inserted, 0, "not an insert — the existing (book, id) slot was reclaimed in place, not created fresh");
  eq(counts.skipped_edited, 0, "NOT counted skipped_edited — a landed reclaim is neither a skip nor a plain edit");
  eq(counts.conflict_skipped, 0, "NOT counted as a PK conflict: the tombstone branch owns this row");
  eq((counts.blocked_samples ?? []).length, 0, "no blocked sample — nothing was blocked this run");

  // Master's row genuinely lives in D1 now, in the SAME primary-key slot the
  // tombstone used to hold.
  const stored = sqlite
    .prepare(`SELECT chapter, verse, question, deleted_at, updated_by, version FROM tq_rows WHERE book = ? AND id = ?`)
    .all(BOOK, ID);
  eq(stored.length, 1, "still exactly one row for that (book, id)");
  eq(stored[0].chapter, 23, "the row now carries master's chapter — the REISSUED reference, not the tombstone's old one");
  eq(stored[0].verse, 7, "and master's verse");
  eq(stored[0].question, "new question", "and master's content — the reclaim actually landed the row, it did not just report it");
  eq(stored[0].deleted_at, null, "no longer a tombstone");
  eq(stored[0].updated_by, null, "master-owned going forward, same as a fresh insert");
  eq(stored[0].version, 2, "version bumped from the tombstone's stored version — CAS stays live for future writes");

  // THE DRIFT DETECTOR. If anyone adds `deleted_at IS NULL` to applyTsvRows'
  // `existing` read, the tombstone stops being found, this row takes the INSERT
  // path instead, and these assertions flip — which is the whole point.
  eq(
    counts.conflict_skipped + counts.tombstone_blocked + counts.tombstone_reclaimed,
    1,
    "exactly one drop-or-reclaim counted, by exactly one route",
  );
}

// Wrap an env.DB so the FIRST reclaim write this run issues is preceded by an
// out-of-band version bump on the SAME tombstoned row — exactly as a
// concurrent writer (another reimport instance, a hand-edit landing between
// applyTsvRows' initial `existing` read and this batched write) would do. The
// reclaim write is identified by its distinctive SQL shape: `updated_by =
// NULL,` in the SET clause together with `deleted_at IS NOT NULL` in the
// WHERE — only buildTsvUpdateStmt's `reclaim` mode produces that combination
// (resurrect's SET never touches updated_by; reseedAi's WHERE requires
// `deleted_at IS NULL`, the opposite). This drives a REAL, CAS-losing reclaim
// through the real function, instead of hand-asserting what "should" happen
// on a race — see api/src/bookReimport.ts's reclaim batch for the fallback
// this is meant to prove.
function withReclaimRace(env, sqlite, book, id) {
  let fired = false;
  return {
    ...env,
    DB: {
      ...env.DB,
      async batch(stmts) {
        if (
          !fired &&
          stmts.some((s) => s.sql.includes("updated_by = NULL,") && s.sql.includes("deleted_at IS NOT NULL"))
        ) {
          fired = true;
          sqlite.prepare(`UPDATE tq_rows SET version = version + 1 WHERE book = ? AND id = ?`).run(book, id);
        }
        return env.DB.batch(stmts);
      },
    },
  };
}

console.log("\n[(a2) a reclaim that LOSES its version-CAS race falls back to tombstone_blocked, never a silent drop]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite);
  const raced = withReclaimRace(env, sqlite, BOOK, ID);
  const counts = await applyTsvRows(raced, BOOK, "tq", [masterRow()], null);

  eq(counts.tombstone_reclaimed, 0, "the reclaim did NOT land — the race won");
  eq(counts.tombstone_blocked, 1, "falls back to tombstone_blocked — exactly as if reclaim had never been attempted");
  eq(
    (counts.blocked_samples ?? [])[0]?.includes(ID),
    true,
    "the sample still names the row, so the fallback is exactly as actionable as the pre-reclaim behavior",
  );

  // And nothing was clobbered: the row that won the race is untouched by this
  // run's reclaim attempt (still the OLD tombstone content, just at the newer
  // version the race stamped).
  const stored = sqlite.prepare(`SELECT chapter, question, deleted_at, version FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
  eq(stored[0].chapter, 5, "the row the race left behind is untouched by the losing reclaim write");
  eq(stored[0].question, "old question", "content untouched — a lost CAS never partially applies");
  eq(stored[0].deleted_at != null, true, "still a tombstone — the race bumped version, not deleted_at");
  eq(stored[0].version, 2, "version reflects the race's bump, not the reclaim's (failed) write");
}

console.log("\n[the same-reference tombstone must NOT count — it is a delete awaiting export]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite, { ref: "5:4", chapter: 5, verse: 4 });
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow({ ref: "5:4", chapter: 5, verse: 4 })], null);
  eq(counts.tombstone_blocked, 0, "same ref → not blocked (the 4 AMO rows in the production sweep)");
  eq(counts.skipped_edited, 1, "still skipped, which is what preserves the pending deletion");
  eq(shouldRecordResourceSync(counts), true, "and the watermark is NOT withheld for it");
}

console.log("\n[a COERCED id must never count as blocked — review finding F4]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite, { ref: "5:4", chapter: 5, verse: 4 });
  // coerceRowId hashes a malformed master id into a 96-id space, so landing on
  // an unrelated tombstone at a different reference is an expected collision,
  // not evidence master reissued anything. Counting it would freeze the export.
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow({ ref: "23:7", idCoerced: true })], null);
  eq(counts.tombstone_blocked, 0, "coerced id + different ref → NOT blocked (documented-benign no-op)");
  eq(shouldRecordResourceSync(counts), true, "so a coercion collision cannot withhold the watermark");
}

console.log("\n[(b) the watermark is WITHHELD, and the STORED row proves it]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite);
  // Force the lost-CAS fallback (see (a2) above) so this run still produces a
  // real tombstone_blocked count to withhold on — the ordinary reissue case in
  // (a) now reclaims and no longer needs (or triggers) a withhold at all.
  const raced = withReclaimRace(env, sqlite, BOOK, ID);
  const counts = await applyTsvRows(raced, BOOK, "tq", [masterRow()], null);

  // The gate is consulted on the AGGREGATE, not on this raw object — that is the
  // step where an absent counter could be laundered into a present zero. Prove
  // the taint survives it by folding through the real aggregation path.
  const { zeroCountsForTest, addCountsForTest } = await import("./bookReimport.ts").then((m) => ({
    zeroCountsForTest: m.zeroCountsForTest,
    addCountsForTest: m.addCountsForTest,
  }));
  const aggregate = zeroCountsForTest();
  addCountsForTest(aggregate, counts);
  eq(aggregate.tombstone_blocked, 1, "the count survives aggregation (addCounts)");
  eq(shouldRecordResourceSync(aggregate), false, "the gate refuses to stamp on the aggregate");

  // Now the real write path the reimport-sync step takes when it withholds.
  await recordWithheldSyncIfAbsent(env, BOOK, "tq");
  const row = sqlite
    .prepare(`SELECT source_sha, origin FROM book_resource_syncs WHERE book = ? AND resource = ?`)
    .all(BOOK, "tq")[0];
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
  seedTombstone(sqlite);
  const raced = withReclaimRace(env, sqlite, BOOK, ID);
  const counts = await applyTsvRows(raced, BOOK, "tq", [masterRow()], null);
  const { raiseTombstoneBlockAlertForTest } = await import("./bookReimport.ts");
  await raiseTombstoneBlockAlertForTest(env, BOOK, "tq", counts);

  const alert = sqlite
    .prepare(`SELECT username, severity, source, message FROM system_alerts WHERE source = ?`)
    .all(`reimport_id_blocked:${BOOK}:tq`)[0];
  eq(alert !== undefined, true, "an alert row exists in system_alerts");
  eq(alert?.severity, "error", "raised at error severity");
  eq(alert?.message.includes("1CH"), true, "names the book");
  eq(alert?.message.includes("hoig"), true, "names the actual blocked row id, so it is actionable");
  // Since option 1 shipped, a `tombstone_blocked` count means the reclaim
  // LOST its version-CAS race (this scenario), not a permanent freeze — the
  // message now says so, instead of the pre-fix "does NOT clear on its own"
  // framing, which no longer describes this case honestly.
  eq(
    alert?.message.includes("should resolve automatically"),
    true,
    "states the expected-to-self-heal-on-retry consequence, not a permanent freeze",
  );
  eq(
    alert?.message.includes("does NOT clear on its own"),
    false,
    "the pre-reclaim 'does NOT clear on its own' framing no longer applies to a pure reclaim-race block",
  );
  eq(
    alert?.message.includes("re-run the sync"),
    false,
    "and does NOT repeat the export_stale banner's advice, which cannot work here",
  );
}

console.log("\n[(f) issue #473 option A: idBlockedOverride force-releases the withhold]");
{
  const { sqlite, env } = freshEnv();
  seedTombstone(sqlite);
  const raced = withReclaimRace(env, sqlite, BOOK, ID);
  const counts = await applyTsvRows(raced, BOOK, "tq", [masterRow()], null);
  eq(counts.tombstone_blocked, 1, "sanity: this run genuinely blocked a row, same setup as (b)/(c)");

  // The override is scoped to the conflict_skipped/tombstone_blocked half
  // only — with no other withhold reason active, the aggregate now stamps.
  const { zeroCountsForTest, addCountsForTest } = await import("./bookReimport.ts");
  const aggregate = zeroCountsForTest();
  addCountsForTest(aggregate, counts);
  eq(shouldRecordResourceSync(aggregate), false, "sanity: withheld without the override, exactly like (b)");
  eq(shouldRecordResourceSync(aggregate, true), true, "idBlockedOverride true → the aggregate now stamps");

  // The real write path runChunkedReimport's override branch takes: record the
  // watermark, THEN raise the distinct "force-released" alert (never the
  // ordinary "still withheld" one, and never clearTombstoneBlockAlert, which
  // would silently delete this alert since both share the same source).
  await recordResourceSync(env, BOOK, "tq", "abc123def456", "reimport");
  const { raiseTombstoneBlockAlertForTest } = await import("./bookReimport.ts");
  await raiseTombstoneBlockAlertForTest(env, BOOK, "tq", aggregate, true);

  const syncRow = sqlite
    .prepare(`SELECT origin FROM book_resource_syncs WHERE book = ? AND resource = ?`)
    .all(BOOK, "tq")[0];
  eq(syncRow?.origin, "reimport", "the watermark WAS recorded — the override actually let the sync through");

  const alert = sqlite
    .prepare(`SELECT username, severity, source, message FROM system_alerts WHERE source = ? AND dismissed_at IS NULL`)
    .all(`reimport_id_blocked:${BOOK}:tq`)[0];
  eq(alert !== undefined, true, "the override still leaves a durable alert row behind");
  eq(alert?.severity, "warning", "raised at warning severity, not the ordinary withhold's error");
  eq(alert?.message.includes("force-released"), true, "names the override explicitly");
  eq(alert?.message.includes("allowIdBlocked"), true, "names the param a human would recognize");
  eq(
    alert?.message.includes("will NOT export to Door43 until this is cleared"),
    false,
    "must NOT reuse the ordinary withhold's wording — that promise is false once the override went through",
  );
  eq(
    alert?.message.includes("WILL delete them from master"),
    true,
    "states the actual consequence — Door43 loses the still-missing row(s) on this export",
  );
  eq(alert?.message.includes("hoig"), true, "still names the actual affected row id");
}

console.log("\n[(d) the HEALTHY path still stamps — no false withhold]");
{
  const { sqlite, env } = freshEnv();
  // No tombstone at all: master's row is genuinely new.
  const counts = await applyTsvRows(env, BOOK, "tq", [masterRow()], null);
  eq(counts.inserted, 1, "the row lands normally");
  eq(counts.tombstone_blocked, 0, "nothing blocked");
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

// ── Reference-move attribution, at the CALLER (issue #540 item 3) ───────────
// classifyTsvRefMove/foldTsvRefBase are unit-tested, but every consequence that
// matters lives in applyTsvRows: whether apply_incomplete is set (which withholds
// the resource watermark and blocks the nightly export), whether the row is
// flagged, and whether a stale flag is cleared. This drives the REAL applyTsvRows
// over real SQLite, which is the only place those can be observed.
console.log("\n[reference-move attribution at the caller]");
{
  // An edited tq row that the APP moved 1:2 -> 1:6 after the watermark, while
  // master still sits at the ancestor. The livelock case.
  const seedUser = (sqlite) =>
    sqlite
      .prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 7007, 'translator')`)
      .run();
  const seedMoved = (sqlite, { reviewKind = null } = {}) => {
    seedUser(sqlite);
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, updated_by, version, review_kind, review_reason)
         VALUES ('mv01', ?, 1, 6, '1:6', 'our question', 'our response', 10, 7, 3, ?, ?)`,
      )
      .run(BOOK, reviewKind, reviewKind ? "some earlier reason" : null);
    // Ancestor: the row at 1:2, logged before the boundary.
    const e = sqlite
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, action, payload_json, created_at)
         VALUES ('tq', 'mv01', ?, 'create', ?, 100)`,
      )
      .run(BOOK, JSON.stringify({ chapter: 1, verse: 2, ref_raw: "1:2", question: "our question", response: "our response" }));
    return Number(e.lastInsertRowid);
  };
  const masterAt = (ref, chapter, verse, extra = {}) => ({
    id: "mv01", idCoerced: false, refRaw: ref, chapter, verse,
    occurrence: null, tags: null, quote: null,
    question: "our question", response: "our response", ...extra,
  });

  // 1. Pure app-side move: no hold, no flag. This is the whole point.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedMoved(sqlite);
    const counts = await applyTsvRows(env, BOOK, "tq", [masterAt("1:2", 1, 2)], null, {
      confirmedAt: 200, editId: boundary,
    });
    eq(counts.ref_moved_ours, 1, "app-side move is attributed to us");
    eq(counts.apply_incomplete, false, "…and does NOT withhold the resource watermark (the livelock kill)");
    const row = sqlite.prepare(`SELECT review_kind, version FROM tq_rows WHERE id='mv01'`).all()[0];
    eq(row.review_kind, null, "…and raises no flag");
    eq(row.version, 3, "…and writes nothing, so the version does not move");
  }

  // 2. Same move, but a previous run left the mis-attributed flag. Cleared, once.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedMoved(sqlite, { reviewKind: "ref_moved" });
    const counts = await applyTsvRows(env, BOOK, "tq", [masterAt("1:2", 1, 2)], null, {
      confirmedAt: 200, editId: boundary,
    });
    eq(counts.apply_incomplete, false, "clearing a stale flag does not withhold the watermark");
    const row = sqlite.prepare(`SELECT review_kind, review_reason FROM tq_rows WHERE id='mv01'`).all()[0];
    eq(row.review_kind, null, "the stale ref_moved flag is cleared");
    eq(row.review_reason, null, "…reason too");
  }

  // 3. A merge_conflict flag is NOT collateral damage of that clear.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedMoved(sqlite, { reviewKind: "merge_conflict" });
    await applyTsvRows(env, BOOK, "tq", [masterAt("1:2", 1, 2)], null, { confirmedAt: 200, editId: boundary });
    const row = sqlite.prepare(`SELECT review_kind FROM tq_rows WHERE id='mv01'`).all()[0];
    eq(row.review_kind, "merge_conflict", "an unacknowledged merge_conflict survives an ours_moved run");
  }

  // 4. Master moved instead: the old behavior, hold + flag, must be intact.
  {
    const { sqlite, env } = freshEnv();
    // D1 back at the ancestor, master re-anchored.
    sqlite.prepare(`UPDATE tq_rows SET chapter=1, verse=2, ref_raw='1:2' WHERE id='mv01'`).run();
    const boundary = seedMoved(sqlite);
    sqlite.prepare(`UPDATE tq_rows SET chapter=1, verse=2, ref_raw='1:2' WHERE id='mv01'`).run();
    const counts = await applyTsvRows(env, BOOK, "tq", [masterAt("1:9", 1, 9)], null, {
      confirmedAt: 200, editId: boundary,
    });
    eq(counts.ref_moved_theirs, 1, "a master-side move is attributed to Door43");
    eq(counts.apply_incomplete, true, "…and still withholds the resource watermark");
    const row = sqlite.prepare(`SELECT review_kind, review_reason FROM tq_rows WHERE id='mv01'`).all()[0];
    eq(row.review_kind, "ref_moved", "…and flags the row");
    eq(row.review_reason.includes("A Door43 editor moved this row"), true, "…naming Door43, which the ancestor proves");
    eq(row.review_reason.includes("export stays on hold"), true, "…and saying what actually releases the hold");
  }

  // 5. No ancestor at all: holds, and must NOT name Door43.
  {
    const { sqlite, env } = freshEnv();
    seedUser(sqlite);
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, updated_by, version)
         VALUES ('mv02', ?, 1, 6, '1:6', 'q', 'r', 10, 7, 3)`,
      )
      .run(BOOK);
    const counts = await applyTsvRows(
      env, BOOK, "tq",
      [{ id: "mv02", idCoerced: false, refRaw: "1:2", chapter: 1, verse: 2, occurrence: null, tags: null, quote: null, question: "q", response: "r" }],
      null, { confirmedAt: 200, editId: 999999 },
    );
    eq(counts.ref_moved_unattributable, 1, "no ancestor -> unattributable");
    eq(counts.apply_incomplete, true, "…still holds (fail safe)");
    const row = sqlite.prepare(`SELECT review_reason FROM tq_rows WHERE id='mv02'`).all()[0];
    eq(row.review_reason.includes("Door43 editor moved"), false, "…and never claims a Door43 editor moved it");
    eq(row.review_reason.includes("no edit history survives"), true, "…it states the measured cause");
  }

  // 6. A second nightly over an UNCHANGED ref_moved row must not re-bump the
  //    version (#567). flagRefMoved's dedup guard compares cur.review_reason
  //    to the reason it is about to write and no-ops when they already match —
  //    which only works if the `existing` SELECT actually fetches review_reason.
  //    Runs the real master-side-move case (case 4) twice over the same D1
  //    state and checks the row is byte-for-byte unchanged after the repeat.
  {
    const { sqlite, env } = freshEnv();
    sqlite.prepare(`UPDATE tq_rows SET chapter=1, verse=2, ref_raw='1:2' WHERE id='mv01'`).run();
    const boundary = seedMoved(sqlite);
    sqlite.prepare(`UPDATE tq_rows SET chapter=1, verse=2, ref_raw='1:2' WHERE id='mv01'`).run();
    const opts = { confirmedAt: 200, editId: boundary };
    const first = await applyTsvRows(env, BOOK, "tq", [masterAt("1:9", 1, 9)], null, opts);
    eq(first.ref_moved_theirs, 1, "first nightly flags the master-side move");
    const afterFirst = sqlite.prepare(`SELECT version, review_kind, review_reason FROM tq_rows WHERE id='mv01'`).all()[0];
    eq(afterFirst.review_kind, "ref_moved", "…row is flagged");

    const second = await applyTsvRows(env, BOOK, "tq", [masterAt("1:9", 1, 9)], null, opts);
    eq(second.ref_moved_theirs, 1, "second nightly still classifies the row as theirs_moved");
    const afterSecond = sqlite.prepare(`SELECT version, review_kind, review_reason FROM tq_rows WHERE id='mv01'`).all()[0];
    eq(afterSecond.version, afterFirst.version, "…but an unchanged reason does not re-bump the version (#567)");
    eq(afterSecond.review_reason, afterFirst.review_reason, "…the reason text itself is unchanged");
  }

  // 7. The references AGREE again, and a flag from an earlier run is still on
  //    the row (issue #588). Before the fix nothing cleared it: the only clear
  //    lived in the ours_moved branch, so a resolved reference kept its cleanup
  //    chip forever with nothing left to decide. Observed on AMO tq 3:14.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedMoved(sqlite, { reviewKind: "ref_moved" });
    // Master now sits where D1 does — the translator moved it in-app to match.
    const counts = await applyTsvRows(env, BOOK, "tq", [masterAt("1:6", 1, 6)], null, {
      confirmedAt: 200, editId: boundary,
    });
    eq(counts.apply_incomplete, false, "an agreed reference does not withhold the watermark");
    eq(counts.ref_moved_theirs, 0, "…and is not counted as a move at all");
    const row = sqlite.prepare(`SELECT review_kind, review_reason, version, question FROM tq_rows WHERE id='mv01'`).all()[0];
    eq(row.review_kind, null, "the resolved ref_moved flag is cleared");
    eq(row.review_reason, null, "…reason too");
    eq(row.question, "our question", "…and no content field is touched");
    eq(row.version, 4, "…at the cost of exactly one version bump");

    // Once, not nightly: the second run finds no flag and writes nothing.
    await applyTsvRows(env, BOOK, "tq", [masterAt("1:6", 1, 6)], null, { confirmedAt: 200, editId: boundary });
    const after = sqlite.prepare(`SELECT version FROM tq_rows WHERE id='mv01'`).all()[0];
    eq(after.version, 4, "…and the next nightly does not re-bump it");
  }

  // 7b. The SHAPE THE BUG WAS REPORTED IN: the reference is reconciled and
  //     nothing else diverges either, so the row is a plain no-op and never
  //     reaches the edited-candidate resolution above. The first cut of this fix
  //     cleared the flag only there, which left the chip standing for every
  //     tn/twl row (their stored sort_order forces `noop`) and for any tq row
  //     whose sort_order already matched file order. Found by cold review.
  {
    const { sqlite, env } = freshEnv();
    seedMoved(sqlite, { reviewKind: "ref_moved" });
    // 100 == the first row's file-order sort_order (makeVerseSortOrder is a
    // per-verse ordinal x100), so content AND order match: noop.
    sqlite.prepare(`UPDATE tq_rows SET sort_order = 100 WHERE id='mv01'`).run();
    const counts = await applyTsvRows(env, BOOK, "tq", [masterAt("1:6", 1, 6)], null, {
      confirmedAt: 200, editId: 1,
    });
    eq(counts.skipped_noop, 1, "the resolved row classifies as a no-op…");
    eq(counts.ref_moved_resolved, 1, "…and its stale flag is still cleared (#588)");
    const row = sqlite.prepare(`SELECT review_kind, review_reason, version, question FROM tq_rows WHERE id='mv01'`).all()[0];
    eq(row.review_kind, null, "flag gone");
    eq(row.review_reason, null, "…reason too");
    eq(row.version, 3, "…with NO version bump, so an open editor's If-Match still holds");
    eq(row.question, "our question", "…and no content touched");

    const second = await applyTsvRows(env, BOOK, "tq", [masterAt("1:6", 1, 6)], null, { confirmedAt: 200, editId: 1 });
    eq(second.ref_moved_resolved, 0, "…and there is nothing left to clear next night");
  }

  // 7c. Same, for tn — where a stored sort_order makes `noop` unconditional, so
  //     before the no-op clear NO tn row could ever shed a resolved flag.
  {
    const { sqlite, env } = freshEnv();
    sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 7007, 'translator')`).run();
    sqlite
      .prepare(
        `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, updated_by, version, review_kind, review_reason)
         VALUES ('tn01', ?, 1, 6, '1:6', 'our note', 42, 7, 3, 'ref_moved', 'some earlier reason')`,
      )
      .run(BOOK);
    const counts = await applyTsvRows(
      env, BOOK, "tn",
      [{ id: "tn01", idCoerced: false, refRaw: "1:6", chapter: 1, verse: 6, occurrence: null, tags: null, quote: null, note: "our note", support_reference: null }],
      null, { confirmedAt: 200, editId: 1 },
    );
    eq(counts.ref_moved_resolved, 1, "a tn row sheds its resolved flag despite the preserved local order");
    const row = sqlite.prepare(`SELECT review_kind, sort_order, version FROM tn_rows WHERE id='tn01'`).all()[0];
    eq(row.review_kind, null, "flag gone");
    eq(row.sort_order, 42, "…and the in-app reorder is NOT reverted (the HOS 11 bug stays fixed)");
    eq(row.version, 3, "…no version bump");
  }

  // 7d. The no-op clear is guarded the same way: a merge_conflict on an
  //     otherwise-identical row is not collateral damage.
  {
    const { sqlite, env } = freshEnv();
    seedMoved(sqlite, { reviewKind: "merge_conflict" });
    sqlite.prepare(`UPDATE tq_rows SET sort_order = 100 WHERE id='mv01'`).run();
    const counts = await applyTsvRows(env, BOOK, "tq", [masterAt("1:6", 1, 6)], null, { confirmedAt: 200, editId: 1 });
    eq(counts.ref_moved_resolved, 0, "nothing is counted as resolved");
    const row = sqlite.prepare(`SELECT review_kind FROM tq_rows WHERE id='mv01'`).all()[0];
    eq(row.review_kind, "merge_conflict", "a merge_conflict survives the no-op path");
  }

  // 7e. Every OTHER review_kind this codebase writes survives too — the guard is
  //     an equality on 'ref_moved', and a widened guard would silently drop these
  //     (merge_kept and merge_no_base are both live writers).
  for (const kept of ["merge_kept", "merge_no_base"]) {
    const { sqlite, env } = freshEnv();
    seedMoved(sqlite, { reviewKind: kept });
    sqlite.prepare(`UPDATE tq_rows SET sort_order = 100 WHERE id='mv01'`).run();
    await applyTsvRows(env, BOOK, "tq", [masterAt("1:6", 1, 6)], null, { confirmedAt: 200, editId: 1 });
    const row = sqlite.prepare(`SELECT review_kind FROM tq_rows WHERE id='mv01'`).all()[0];
    eq(row.review_kind, kept, `a ${kept} flag survives the no-op path`);
  }

  // 7f. The clear is book-scoped. A same-id flagged row in ANOTHER book must not
  //     be caught by it — row ids are only unique per book, so dropping `book`
  //     from the statement's WHERE would silently clear flags across the canon.
  {
    const { sqlite, env } = freshEnv();
    seedMoved(sqlite, { reviewKind: "ref_moved" });
    sqlite.prepare(`UPDATE tq_rows SET sort_order = 100 WHERE id='mv01'`).run();
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, updated_by, version, review_kind, review_reason)
         VALUES ('mv01', 'HOS', 1, 6, '1:6', 'other book', 'other book', 100, 7, 3, 'ref_moved', 'their reason')`,
      )
      .run();
    const counts = await applyTsvRows(env, BOOK, "tq", [masterAt("1:6", 1, 6)], null, { confirmedAt: 200, editId: 1 });
    eq(counts.ref_moved_resolved, 1, "exactly one row is cleared…");
    const other = sqlite.prepare(`SELECT review_kind FROM tq_rows WHERE id='mv01' AND book='HOS'`).all()[0];
    eq(other.review_kind, "ref_moved", "…and the same id in another book keeps its flag");
  }

  // 7g. A PROTECTED tn row (preserve/hint/trashed) whose reference agrees while
  //     its note diverges. It never reaches the no-op path, and the first cut of
  //     the edited-path clear excluded protected rows outright — so the chip was
  //     permanent on exactly the rows nobody will edit again (PR #589 review).
  //     The clear now keys on measured agreement, and routes through the
  //     version-neutral statement because buildTsvEditedWriteStmt's WHERE
  //     re-asserts preserve = 0 and would 0-change.
  for (const [col, val] of [["preserve", 1], ["hint", 1], ["trashed_at", 1700000000]]) {
    const { sqlite, env } = freshEnv();
    sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 7007, 'translator')`).run();
    sqlite
      .prepare(
        `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, updated_by, version, review_kind, review_reason, ${col})
         VALUES ('tnp1', ?, 1, 6, '1:6', 'our note', 42, 7, 3, 'ref_moved', 'some earlier reason', ?)`,
      )
      .run(BOOK, val);
    const counts = await applyTsvRows(
      env, BOOK, "tn",
      // Same reference, DIFFERENT note -> classified "edited", not a no-op.
      [{ id: "tnp1", idCoerced: false, refRaw: "1:6", chapter: 1, verse: 6, occurrence: null, tags: null, quote: null, note: "master note", support_reference: null }],
      null, { confirmedAt: 200, editId: 1 },
    );
    eq(counts.ref_moved_resolved, 1, `a ${col} row sheds its resolved flag`);
    const row = sqlite.prepare(`SELECT review_kind, review_reason, note, version FROM tn_rows WHERE id='tnp1'`).all()[0];
    eq(row.review_kind, null, "flag gone");
    eq(row.review_reason, null, "…reason too");
    eq(row.note, "our note", "…and the protected note is NOT overwritten from master");
    eq(row.version, 3, "…no version bump");
  }

  // 7h. Same protected row, but the references still DIFFER: the flag must stay.
  //     classifyTsvRefMove answers "none" for a protected row by policy without
  //     comparing anything, so a clear keyed on that would wrongly fire here.
  {
    const { sqlite, env } = freshEnv();
    sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 7007, 'translator')`).run();
    sqlite
      .prepare(
        `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, updated_by, version, review_kind, review_reason, preserve)
         VALUES ('tnp2', ?, 1, 6, '1:6', 'our note', 42, 7, 3, 'ref_moved', 'some earlier reason', 1)`,
      )
      .run(BOOK);
    const counts = await applyTsvRows(
      env, BOOK, "tn",
      [{ id: "tnp2", idCoerced: false, refRaw: "1:9", chapter: 1, verse: 9, occurrence: null, tags: null, quote: null, note: "our note", support_reference: null }],
      null, { confirmedAt: 200, editId: 1 },
    );
    eq(counts.ref_moved_resolved, 0, "a still-divergent reference clears nothing…");
    const row = sqlite.prepare(`SELECT review_kind FROM tn_rows WHERE id='tnp2'`).all()[0];
    eq(row.review_kind, "ref_moved", "…and the protected row keeps its flag");
  }

  // 8. That clear must not become a way to lose an unacknowledged content
  //    conflict, which says something the reference never did.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedMoved(sqlite, { reviewKind: "merge_conflict" });
    await applyTsvRows(env, BOOK, "tq", [masterAt("1:6", 1, 6)], null, { confirmedAt: 200, editId: boundary });
    const row = sqlite.prepare(`SELECT review_kind FROM tq_rows WHERE id='mv01'`).all()[0];
    eq(row.review_kind, "merge_conflict", "a merge_conflict survives an agreed-reference run");
  }
}

// ── AI-vs-human conflict policy at the caller (#540 item 2) ─────────────────
// The pure computeTsvMerge decision is covered in tsvMerge.test.mjs. What is
// NOT — and where every defect in the last change of this shape lived — is the
// caller: whether a keep_ai_master row is actually written, flagged, counted,
// and, critically, whether it withholds the resource watermark. It must not:
// the export is how the kept human edit reaches Door43.
console.log("\n[AI-vs-human conflict policy at the caller]");
{
  const seedContested = (sqlite) => {
    sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 7007, 'translator')`).run();
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, quote, question, response, sort_order, updated_by, version)
         VALUES ('ai01', ?, 1, 2, '1:2', null, 'our question', 'our response', 10, 7, 3)`,
      )
      .run(BOOK);
    // The ancestor: what D1 held when the export last published this row.
    const e = sqlite
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, action, payload_json, created_at)
         VALUES ('tq', 'ai01', ?, 'create', ?, 100)`,
      )
      .run(
        BOOK,
        JSON.stringify({ chapter: 1, verse: 2, ref_raw: "1:2", question: "our question", response: "base response" }),
      );
    return Number(e.lastInsertRowid);
  };
  // Master's row: the response moved on that side too, so BOTH sides moved it.
  const masterRowAt = (response) => ({
    id: "ai01", idCoerced: false, refRaw: "1:2", chapter: 1, verse: 2,
    occurrence: null, tags: null, quote: null, question: "our question", response,
  });
  const AI_ONLY = {
    mayHoldHumanEdit: false, hasHumanCommit: false, incomplete: false, incompleteReason: "",
    counts: { ours: 1, ai: 1, human: 0 }, humanShas: [],
  };
  const HAS_HUMAN = {
    mayHoldHumanEdit: true, hasHumanCommit: true, incomplete: false, incompleteReason: "",
    counts: { ours: 1, ai: 0, human: 1 }, humanShas: ["abc123"],
  };
  const readRow = (sqlite) =>
    sqlite.prepare(`SELECT response, review_kind, review_reason, version FROM tq_rows WHERE id='ai01'`).all()[0];

  // 1. The AMO 4:2 shape. Only our export and the pipeline moved master, so the
  //    app edit wins — and it is still flagged, because a human should look.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedContested(sqlite);
    const counts = await applyTsvRows(env, BOOK, "tq", [masterRowAt("the AI run's response")], null, {
      confirmedAt: 200, editId: boundary, lineage: AI_ONLY,
    });
    const row = readRow(sqlite);
    eq(row.response, "our response", "the app edit is KEPT — master's AI-authored value never lands");
    eq(counts.merge_kept_ai, 1, "…counted as merge_kept_ai");
    eq(counts.merge_adopted, 0, "…and never counted as an adoption");
    eq(counts.merge_refused, 0, "…and never as a refusal, which would freeze the export at 5");
    eq(counts.apply_incomplete, false, "…and does NOT withhold the watermark: the export must publish this");
    // A DISTINCT review_kind, not just distinct prose: the cleanup chip titles
    // itself from this column, and "Merged Door43 edit" over a kept row is the
    // reverse of what happened.
    eq(row.review_kind, "merge_kept", "…the row is flagged for review, as a KEPT row");
    eq(
      row.review_reason.startsWith("Your response was kept over Door43's"),
      true,
      "…the reason leads with the outcome (the chip clamps to two lines)",
    );
    eq(
      row.review_reason.includes("no commit from a Door43 editor's own account was found"),
      true,
      "…and states the measured cause, not an inferred one",
    );
    eq(
      row.review_reason.includes("was merged over your app-side change"),
      false,
      "…never the opposite claim, that Door43's edit won",
    );
    eq(
      row.review_reason.includes("will be published to Door43"),
      false,
      "…and never promises a publish this per-row code cannot schedule",
    );
    eq(row.version, 4, "…the flag write bumps the version once");

    // 2. Re-running the same night's shape must not churn the version. The
    //    condition recurs every sync until a human resolves it, and a flag-only
    //    write is still a write (#539).
    const again = await applyTsvRows(env, BOOK, "tq", [masterRowAt("the AI run's response")], null, {
      confirmedAt: 200, editId: boundary, lineage: AI_ONLY,
    });
    eq(again.merge_kept_ai, 1, "the conflict is still detected on the next run");
    eq(readRow(sqlite).version, 4, "…but an unchanged flag is not re-written");
  }

  // 3. A human commit on master since the ancestor: unchanged behaviour, master
  //    still wins. This is the half of the policy that must NOT move.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedContested(sqlite);
    const counts = await applyTsvRows(env, BOOK, "tq", [masterRowAt("a maintainer's fix")], null, {
      confirmedAt: 200, editId: boundary, lineage: HAS_HUMAN,
    });
    const row = readRow(sqlite);
    eq(row.response, "a maintainer's fix", "a human-authored master edit still wins the collision");
    eq(counts.merge_adopted, 1, "…counted as an adoption");
    eq(counts.merge_kept_ai, 0, "…and not as a kept AI conflict");
    eq(row.review_reason.includes("was merged over your app-side change"), true, "…with the pre-existing wording");
  }

  // 4. No lineage at all — the field an in-flight Workflow's memoized plan does
  //    not carry. Must read as "a human may have", i.e. today's behaviour.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedContested(sqlite);
    const counts = await applyTsvRows(env, BOOK, "tq", [masterRowAt("a maintainer's fix")], null, {
      confirmedAt: 200, editId: boundary,
    });
    eq(readRow(sqlite).response, "a maintainer's fix", "an absent lineage keeps master-wins, not D1-wins");
    eq(counts.merge_kept_ai, 0, "…and never reports a kept AI conflict it did not measure");
  }

  // 5. A row that ALSO moved reference keeps the reference-move flag. That flag
  //    is the only thing telling the translator why the whole book+resource has
  //    stopped exporting, and a kept-conflict message replacing it would both
  //    destroy that and describe an export that is not going to run.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedContested(sqlite);
    const moved = { ...masterRowAt("the AI run's response"), refRaw: "1:9", verse: 9 };
    const counts = await applyTsvRows(env, BOOK, "tq", [moved], null, {
      confirmedAt: 200, editId: boundary, lineage: AI_ONLY,
    });
    const row = readRow(sqlite);
    eq(counts.apply_incomplete, true, "a master-side reference move still withholds the watermark");
    eq(row.review_kind, "ref_moved", "…and the row keeps the reference-move flag, not the kept-conflict one");
    eq(
      row.review_reason.includes("kept over Door43's"),
      false,
      "…so the hold's explanation is not overwritten by a publish the hold prevents",
    );
  }

  // 6. An INCOMPLETE walk that happened to see no human commit is not the same
  //    claim as a complete one that found none — and only the complete one may
  //    flip the outcome.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedContested(sqlite);
    const counts = await applyTsvRows(env, BOOK, "tq", [masterRowAt("a maintainer's fix")], null, {
      confirmedAt: 200,
      editId: boundary,
      lineage: {
        mayHoldHumanEdit: true, hasHumanCommit: false, incomplete: true, incompleteReason: "page_cap",
        counts: { ours: 0, ai: 3, human: 0 }, humanShas: [],
      },
    });
    eq(readRow(sqlite).response, "a maintainer's fix", "an incomplete walk protects master exactly like a human commit");
    eq(counts.merge_kept_ai, 0, "…and does not report a kept AI conflict");
  }
}

// ── merge_no_base_refs folds through the REAL addCounts (issue #537) ─────────
// The banner's ref list is a capped diagnostic sample merged across Workflow
// chunks. Everything that makes it safe lives in addCounts — the cap, and
// tolerating a chunk memoized before the field existed — and none of it was
// covered, so a dropped `break` or a missing `??` would have gone red nowhere.
// Folds through the same real aliases the blocked_samples case above uses,
// rather than re-implementing the aggregation.
{
  const { zeroCountsForTest, addCountsForTest } = await import("./bookReimport.ts").then((m) => ({
    zeroCountsForTest: m.zeroCountsForTest,
    addCountsForTest: m.addCountsForTest,
  }));

  // Two chunks' worth of refs merge and accumulate.
  const agg = zeroCountsForTest();
  const chunkA = zeroCountsForTest();
  chunkA.merge_no_base = 2;
  chunkA.merge_no_base_refs = ["40:5", "40:6"];
  const chunkB = zeroCountsForTest();
  chunkB.merge_no_base = 1;
  chunkB.merge_no_base_refs = ["42:2"];
  addCountsForTest(agg, chunkA);
  addCountsForTest(agg, chunkB);
  eq(agg.merge_no_base, 3, "counts sum across chunks");
  eq((agg.merge_no_base_refs ?? []).join(","), "40:5,40:6,42:2", "refs concatenate in chunk order");

  // A chunk memoized before the field existed carries a count and NO refs. It
  // must fold without throwing and without poisoning the count — the banner
  // then reports a count larger than the sample, which buildNoBaseSentence
  // renders as "+N more".
  const legacy = zeroCountsForTest();
  legacy.merge_no_base = 5;
  delete legacy.merge_no_base_refs;
  addCountsForTest(agg, legacy);
  eq(agg.merge_no_base, 8, "a pre-field chunk still contributes its count");
  eq((agg.merge_no_base_refs ?? []).length, 3, "…and contributes no refs, rather than undefined-poisoning the list");

  // The cap holds under a flood, and the aggregate never exceeds it.
  const flood = zeroCountsForTest();
  flood.merge_no_base = 500;
  flood.merge_no_base_refs = Array.from({ length: 500 }, (_, i) => `9:${i}`);
  const capped = zeroCountsForTest();
  addCountsForTest(capped, flood);
  const cap = (await import("./verseMergeEditorAlerts.ts")).NO_BASE_REF_DISPLAY;
  eq((capped.merge_no_base_refs ?? []).length, cap, "addCounts enforces the ref cap");
  eq(capped.merge_no_base, 500, "…while the authoritative count is uncapped");

  // A fresh zeroCounts must not alias another accumulator's array.
  const one = zeroCountsForTest();
  const two = zeroCountsForTest();
  one.merge_no_base_refs.push("1:1");
  eq((two.merge_no_base_refs ?? []).length, 0, "zeroCounts allocates a fresh refs array per call (no aliasing)");
}

console.log("\n[(e) a RECOVERED resource clears its stale reimport_id_blocked alert — Codex round-3 review on PR #506]");
{
  // The alert's own message promises the reclaim-race half "usually resolves
  // automatically" (see (c) above) — but until clearTombstoneBlockAlert
  // existed, nothing ever actually deleted it once the resource recovered:
  // raiseTombstoneBlockAlert only runs while STILL withheld, so a resolved
  // alert sat active in the banner forever, falsely claiming the resource was
  // still out of sync.
  const { sqlite, env } = freshEnv();
  const { raiseTombstoneBlockAlertForTest, clearTombstoneBlockAlertForTest } = await import("./bookReimport.ts");

  // Simulate last night: a reclaim lost its version-CAS race and raised the
  // banner, exactly like (c) above.
  seedTombstone(sqlite);
  const raced = withReclaimRace(env, sqlite, BOOK, ID);
  const staleCounts = await applyTsvRows(raced, BOOK, "tq", [masterRow()], null);
  await raiseTombstoneBlockAlertForTest(env, BOOK, "tq", staleCounts);
  const before = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE source = ? AND dismissed_at IS NULL`)
    .all(`reimport_id_blocked:${BOOK}:tq`)[0];
  eq(Number(before.n), 1, "sanity: the stale alert exists before recovery");

  // Also raise one for a DIFFERENT book/resource — clearing must be scoped,
  // never a blanket wipe of every open reimport_id_blocked alert.
  await raiseTombstoneBlockAlertForTest(env, "AMO", "tn", staleCounts);

  // Tonight: the race resolved (the tombstoned row is no longer contested),
  // so the resource syncs cleanly this run. Exercise exactly the two calls
  // runChunkedReimport's sync-success branch makes, in the same order:
  // recordResourceSync (the watermark stamp), then clearTombstoneBlockAlert.
  await recordResourceSync(env, BOOK, "tq", "def456abc789", "reimport");
  await clearTombstoneBlockAlertForTest(env, BOOK, "tq");

  const after = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE source = ? AND dismissed_at IS NULL`)
    .all(`reimport_id_blocked:${BOOK}:tq`)[0];
  eq(Number(after.n), 0, "the recovered resource's alert is cleared");

  const otherStillOpen = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE source = ? AND dismissed_at IS NULL`)
    .all(`reimport_id_blocked:AMO:tn`)[0];
  eq(Number(otherStillOpen.n), 1, "a DIFFERENT (book, resource)'s alert is untouched — clearing is scoped, not a blanket wipe");

}

console.log("\n[merge_no_base_editor_refs folds through the REAL addCounts (issue #544)]");
// Same shape as merge_no_base_refs above (a diagnostic list merged across
// Workflow chunks under its own cap), but this one FEEDS the editor fan-out -
// a truncation here silently drops a translator's verse from their own alert,
// not just from an admin-facing sample - so it gets the identical coverage.
{
  const { zeroCountsForTest, addCountsForTest, NO_BASE_EDITOR_REF_CAP } = await import("./bookReimport.ts").then(
    (m) => ({
      zeroCountsForTest: m.zeroCountsForTest,
      addCountsForTest: m.addCountsForTest,
      NO_BASE_EDITOR_REF_CAP: m.NO_BASE_EDITOR_REF_CAP,
    }),
  );

  // Two chunks' worth of refs merge and accumulate, each carrying a version.
  const agg = zeroCountsForTest();
  const chunkA = zeroCountsForTest();
  chunkA.merge_no_base_editor_refs = [
    { chapter: 40, verse: 5, version: 3 },
    { chapter: 40, verse: 6, version: 1 },
  ];
  const chunkB = zeroCountsForTest();
  chunkB.merge_no_base_editor_refs = [{ chapter: 42, verse: 2, version: 9 }];
  addCountsForTest(agg, chunkA);
  addCountsForTest(agg, chunkB);
  eq(
    (agg.merge_no_base_editor_refs ?? []).map((r) => `${r.chapter}:${r.verse}@${r.version}`).join(","),
    "40:5@3,40:6@1,42:2@9",
    "editor refs concatenate in chunk order, each carrying its own version",
  );

  // A chunk memoized before the field existed carries no editor refs. Folding
  // it must not throw and must not poison the running list.
  const legacy = zeroCountsForTest();
  legacy.merge_no_base = 5;
  delete legacy.merge_no_base_editor_refs;
  addCountsForTest(agg, legacy);
  eq((agg.merge_no_base_editor_refs ?? []).length, 3, "a pre-field chunk contributes no editor refs, silently");

  // The cap holds under a flood — unlike the display sample this list is
  // meant to carry EVERY affected verse, so the cap only guards the
  // pathological case, but it must still hold.
  const flood = zeroCountsForTest();
  flood.merge_no_base_editor_refs = Array.from({ length: NO_BASE_EDITOR_REF_CAP + 50 }, (_, i) => ({
    chapter: 9,
    verse: i,
    version: 1,
  }));
  const capped = zeroCountsForTest();
  addCountsForTest(capped, flood);
  eq((capped.merge_no_base_editor_refs ?? []).length, NO_BASE_EDITOR_REF_CAP, "addCounts enforces the editor-ref cap");

  // A fresh zeroCounts must not alias another accumulator's array.
  const one = zeroCountsForTest();
  const two = zeroCountsForTest();
  one.merge_no_base_editor_refs.push({ chapter: 1, verse: 1, version: 1 });
  eq(
    (two.merge_no_base_editor_refs ?? []).length,
    0,
    "zeroCounts allocates a fresh editor-refs array per call (no aliasing)",
  );
}

// keep_no_base TSV row gets review_kind='merge_no_base', guarded so a
// re-run of an unchanged sync never re-bumps the row's version (#539).
// Unlike the verse side, a keep_no_base tn/tq/twl row had NO surface at all —
// merge_no_base is a shared counter with no banner for TSV, and this table has
// no verse_merge_conflicts-style audit row. The fix flags the row itself, the
// same cleanup-chip mechanism (lint.ts) every other TSV merge outcome already
// uses — but a flag write bumps `version`, so it must be guarded on the
// existing review_kind exactly like the ref_moved write above it, or a nightly
// re-run of an unchanged book would bump every affected row's version forever
// (issue #539's version-inflation constraint).
console.log("\n[keep_no_base tn/tq/twl row: review_kind flag set once, guarded against re-bump]");
{
  const { sqlite, env } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 100, 'translator-tq')`).run();
  const NB_ID = "msnb";
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`,
    )
    .run(NB_ID, BOOK, 9, 9, "9:9", "app question", "app response");
  // Deliberately NO edit_log row for this id at all — foldTsvBase then returns
  // null (no content-bearing history to fold), so computeTsvMerge sees
  // base === null and, since `question` differs, returns keep_no_base.
  const cutoff = { confirmedAt: Math.floor(Date.now() / 1000), editId: null };
  const incoming = () => [
    {
      id: NB_ID,
      idCoerced: false,
      refRaw: "9:9",
      chapter: 9,
      verse: 9,
      occurrence: null,
      tags: null,
      quote: null,
      question: "master question", // differs from D1's "app question" -> anyDiff
      response: "app response", // unchanged -> converged on this field
    },
  ];

  const counts1 = await applyTsvRows(env, BOOK, "tq", incoming(), null, cutoff);
  eq(counts1.merge_no_base, 1, "first run: counted as keep_no_base (no ancestor recoverable)");

  const after1 = sqlite.prepare("SELECT version, review_kind, review_reason, question FROM tq_rows WHERE id = ?").all(NB_ID)[0];
  eq(after1.review_kind, "merge_no_base", "the row is flagged for the cleanup chip (lint.ts)");
  eq(typeof after1.review_reason === "string" && after1.review_reason.length > 0, true, "a human-readable reason is stored");
  eq(
    /overwritten|overwrote|overwrites/i.test(after1.review_reason.replace("Nothing has been overwritten", "")),
    false,
    "the stored reason never claims an overwrite HAPPENED, aside from explicitly denying one",
  );
  eq(after1.version, 2, "flagging the row for the first time bumps its version once");
  eq(after1.question, "app question", "content is untouched — keep_no_base keeps D1, adopts nothing");

  // Re-run with the SAME incoming master row and the SAME cutoff — nothing
  // about this row's situation has changed, so the guard (cur.review_kind !==
  // 'merge_no_base') must skip re-setting the field this time.
  const counts2 = await applyTsvRows(env, BOOK, "tq", incoming(), null, cutoff);
  eq(counts2.merge_no_base, 1, "second run: still classified keep_no_base (still reported, not hidden)");
  eq(counts2.skipped_edited, 1, "…but nothing was WRITTEN this time — the flag was already set");

  const after2 = sqlite.prepare("SELECT version, review_kind FROM tq_rows WHERE id = ?").all(NB_ID)[0];
  eq(after2.version, 2, "NO further version bump on an unchanged re-run — the version-inflation guard (#539) holds");
  eq(after2.review_kind, "merge_no_base", "the flag is still set");
}

// ── Issue #539: the dsj8 apostrophe row cycled through a simulated nightly ──
//
// THE MECHANISM. The export renders a tn Note through normalizeNoteText, whose
// educateQuotes curls every straight apostrophe — so master permanently holds
// "prophet’s" for a D1 note that says "prophet's". The three-way merge's
// ancestor is folded from raw edit_log payloads, which keep it straight. Read
// naively, that says "Door43 changed this note" on every run forever: master
// wins, the note is rewritten, the version climbs, and the translator's next
// fix restarts the cycle (AMO tn 3:10, id dsj8, v5→v8 in three days).
//
// WHICH LAYER HOLDS IT, stated plainly because it decides what this test is
// worth. The write-suppression guard added for #539 is NOT what makes this
// pass: computeTsvMerge's compare lens (tsvMerge.ts, EXPORT_NORMALIZED_FIELDS,
// PR #541) already runs normalizeNoteText over BOTH sides for note/question/
// response, so the two sides converge at the ATTRIBUTION step and no field is
// ever adopted. The #539 write guard is a backstop one layer later. This test
// is therefore a characterization of the whole path — it fails if either layer
// regresses — and its value is that it drives the REAL applyTsvRows end to
// end, which no unit test of either layer does.
//
// It is deliberately not vacuous: skipped_noop is asserted to be 0, proving
// the row really did reach the merge with differing RAW bytes rather than
// being waved through by the cheap signature comparison upstream.
console.log("\n[a dsj8-style apostrophe row survives a simulated nightly with no version change (issue #539)]");
{
  const TN_ID = "dsj8";
  const STRAIGHT = "The prophet's message to the exiles.";
  const CURLED = "The prophet’s message to the exiles.";

  const seed = (sqlite) => {
    sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 7007, 'translator')`).run();
    sqlite
      .prepare(
        `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, updated_by, version)
         VALUES (?, ?, 3, 10, '3:10', ?, 10, 7, 5)`,
      )
      .run(TN_ID, BOOK, STRAIGHT);
    // The ancestor the fold reconstructs: the human's own edit, straight
    // apostrophe, logged before the watermark boundary.
    const e = sqlite
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, action, payload_json, created_at)
         VALUES ('tn', ?, ?, 'update', ?, 100)`,
      )
      .run(TN_ID, BOOK, JSON.stringify({ note: STRAIGHT }));
    return Number(e.lastInsertRowid);
  };
  // Master as the export left it: identical except for the curled apostrophe.
  const masterTn = (note) => ({
    id: TN_ID,
    idCoerced: false,
    refRaw: "3:10",
    chapter: 3,
    verse: 10,
    occurrence: null,
    tags: null,
    support_reference: null,
    quote: null,
    note,
  });

  {
    const { sqlite, env } = freshEnv();
    const boundary = seed(sqlite);
    const opts = { confirmedAt: 200, editId: boundary };

    const first = await applyTsvRows(env, BOOK, "tn", [masterTn(CURLED)], null, opts);
    eq(first.skipped_noop, 0, "the row DID reach the merge — its raw bytes differ from master's");
    eq(first.merge_adopted, 0, "…and master's curled apostrophe is not adopted over D1's straight one");
    eq(first.merged_fields, 0, "…nor pulled in by the ancestor-free field merge");
    eq(first.apply_incomplete, false, "…and the resource watermark is not withheld");
    eq(
      sqlite.prepare(`SELECT version, note FROM tn_rows WHERE id = ?`).all(TN_ID)[0],
      { version: 5, note: STRAIGHT },
      "night 1: no version change and the note is untouched",
    );

    // A second identical night, because the reported failure was that this
    // repeated every night rather than settling after one.
    const second = await applyTsvRows(env, BOOK, "tn", [masterTn(CURLED)], null, opts);
    eq(second.merge_adopted, 0, "night 2: still not adopted");
    eq(
      sqlite.prepare(`SELECT version FROM tn_rows WHERE id = ?`).all(TN_ID)[0].version,
      5,
      "night 2: still no version change — the cycle does not restart",
    );
    eq(
      sqlite.prepare(`SELECT COUNT(*) AS n FROM edit_log WHERE kind = 'tn' AND row_key = ?`).all(TN_ID)[0].n,
      1,
      "and no audit rows beyond the seeded ancestor — nothing was written on either night",
    );
  }

  // The control. A guard that suppressed the apostrophe case by suppressing
  // ALL adoption would pass everything above, so prove a genuine Door43 edit
  // to the same row still lands and still bumps.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seed(sqlite);
    const counts = await applyTsvRows(
      env,
      BOOK,
      "tn",
      [masterTn("A maintainer rewrote this note entirely.")],
      null,
      { confirmedAt: 200, editId: boundary },
    );
    eq(counts.merge_adopted, 1, "a real out-of-band Door43 edit IS adopted");
    eq(
      sqlite.prepare(`SELECT version, note FROM tn_rows WHERE id = ?`).all(TN_ID)[0],
      { version: 6, note: "A maintainer rewrote this note entirely." },
      "…and it bumps the version and lands the text",
    );
  }
}

// Issue #539 item 4: a merge write that moves CONTENT must clear the row's
// restored_from_version, or the "current: v{N} (restored)" chip keeps naming a
// version whose text is no longer what the row holds. Asserted through the real
// write, because the column is only reachable via buildTsvEditedWriteStmt's SET.
console.log("\n[a content-moving merge write clears the stale restore marker (issue #539 item 4)]");
{
  const TN_ID = "rst1";
  const { sqlite, env } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 7007, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, updated_by, version, restored_from_version)
       VALUES (?, ?, 4, 2, '4:2', 'our note', 10, 7, 5, 3)`,
    )
    .run(TN_ID, BOOK);
  const e = sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, action, payload_json, created_at)
       VALUES ('tn', ?, ?, 'update', ?, 100)`,
    )
    .run(TN_ID, BOOK, JSON.stringify({ note: "our note" }));

  const counts = await applyTsvRows(
    env,
    BOOK,
    "tn",
    [
      {
        id: TN_ID, idCoerced: false, refRaw: "4:2", chapter: 4, verse: 2,
        occurrence: null, tags: null, support_reference: null, quote: null,
        note: "Door43's corrected note",
      },
    ],
    null,
    { confirmedAt: 200, editId: Number(e.lastInsertRowid) },
  );

  eq(counts.merge_adopted, 1, "master's correction is adopted");
  const after = sqlite.prepare(`SELECT note, version, restored_from_version FROM tn_rows WHERE id = ?`).all(TN_ID)[0];
  eq(after.note, "Door43's corrected note", "the note moved");
  eq(after.version, 6, "…the version bumped");
  eq(after.restored_from_version, null, "…and the stale restore marker was cleared with it");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll reimportJourney assertions passed.");
