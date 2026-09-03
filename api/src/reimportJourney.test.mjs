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
  accountOwnPublishDeclineForTest,
  applyTsvRows,
  clearResolvedMergeNoBaseForTest,
  recordResourceSync,
  recordWithheldSyncIfAbsent,
  retireMergeKeptFlags,
  sweepStaleMergeNoBase,
} from "./bookReimport.ts";
import { contentPatchClearClauses } from "./contentPatchClauses.ts";
import { lintTqRows } from "./lint.ts";
import { shouldRecordResourceSync } from "./reimportSyncGate.ts";

// ── Hermetic clock ─────────────────────────────────────────────────────────
// Every merge_no_base / auto-clear block below seeds its walk windows RELATIVE
// to Date.now() (NOW, MINT_AT, WATERMARK), but the Door43 commit fixtures
// (OURS_AND_AI_PAGE / HUMAN_PAGE) carry ABSOLUTE dates (2026-08-27/28). As the
// real calendar advanced past those dates, the relative walk lower-bound
// (sinceTime) slid past the fixed commit date, so listMasterCommitsSince
// (dcsSources.ts) stopped returning `aaa1`; the sweep's probe then read tip=null
// and flipped its clear/skip decision. The suite passed before 2026-09-03 and
// failed after — date-flaky CI with no code change, red on every branch alike.
//
// Pin the wall clock to a fixed instant in the era these fixtures were authored
// for, so every relative window straddles the fixed commit dates exactly as
// intended, on any calendar day. This runs in the file's own test subprocess
// (run-tests.mjs spawns one node process per file), so it affects nothing else.
// The one block that drives its own two-adjacent-days clock (the rotation test)
// saves and restores Date.now around its override, so it still works — its saved
// baseline is simply this pinned value instead of the wall clock.
const FIXED_NOW_MS = Date.parse("2026-09-01T00:00:00Z");
Date.now = () => FIXED_NOW_MS;

// Snapshot reader that tolerates a missing or garbled snapshot, so ablating the
// snapshot write reports a FAILED ASSERTION instead of crashing the run.
const parseSnap = (s) => {
  try {
    return JSON.parse(s ?? "null") ?? {};
  } catch {
    return {};
  }
};

// #684: displayAuthor wraps every Door43 author name in bidi isolates
// (FSI…PDI) before interpolating it — an RTL name would otherwise reorder the
// date and sha that follow it. Expectations below go through this helper.
const ISO_NAME = (name) => `\u2068${name}\u2069`;

// ── Lineage fixtures (#653) ────────────────────────────────────────────────
// Compacted summaries, exactly the shape compactLineage produces and the shape
// that rides a Workflow step's return value into applyTsvRows.
const AI_ONLY_LINEAGE = {
  mayHoldHumanEdit: false, hasHumanCommit: false, incomplete: false, incompleteReason: "",
  counts: { ours: 2, ai: 3, human: 0 }, humanShas: [], refsComplete: false, humanRefs: [], refsReason: "not_measured",
};
const HUMAN_LINEAGE = {
  mayHoldHumanEdit: true, hasHumanCommit: true, incomplete: false, incompleteReason: "",
  counts: { ours: 1, ai: 1, human: 1 }, humanShas: ["deadbeef"], refsComplete: false, humanRefs: [], refsReason: "too_many_human_commits",
};
const INCOMPLETE_LINEAGE = {
  mayHoldHumanEdit: true, hasHumanCommit: false, incomplete: true, incompleteReason: "page_cap",
  counts: { ours: 1, ai: 1, human: 0 }, humanShas: [], refsComplete: false, humanRefs: [], refsReason: "not_measured",
};

// Commit pages for the auto-clear, in the MasterCommitPage shape
// listMasterCommitsSince returns. Messages/authors are the real production
// shapes classifyMasterCommit was verified against (see masterLineage.ts).
const OURS_AND_AI_PAGE = {
  commits: [
    { sha: "aaa1", message: "bible-editor: 1CH tq → master (#7001)", authorEmail: "someone@example.com", authorName: "Someone", date: "2026-08-28T00:00:00Z" },
    { sha: "aaa2", message: "TQ: 1CH 3 [bp-assistant]", authorEmail: "bot@unfoldingword.org", authorName: "bot", date: "2026-08-27T00:00:00Z" },
  ],
  incomplete: false,
  incompleteReason: "",
};
const HUMAN_PAGE = {
  commits: [
    ...OURS_AND_AI_PAGE.commits,
    { sha: "bbb1", message: "Fixes a typo in 1CH 3:2", authorEmail: "maintainer@example.com", authorName: "Maintainer", date: "2026-08-27T12:00:00Z" },
  ],
  incomplete: false,
  incompleteReason: "",
};

// A Gitea /commits page in the raw wire shape, so the code paths that do their
// OWN fetch (the clear's window extension, its pre-write tip recheck, and the
// sweep, which holds no walk to reuse) are exercised rather than handed a
// pre-built page.
const giteaPage = (commits) => async () => ({
  ok: true,
  headers: { get: (h) => (h.toLowerCase() === "x-hasmore" ? "false" : null) },
  json: async () =>
    commits.map((c) => ({
      sha: c.sha,
      commit: { message: c.message, author: { email: c.authorEmail, name: c.authorName, date: c.date } },
    })),
});
// Every clear that reaches its write now re-reads master's tip first and abandons
// the clear if it moved (Codex P0: the walk's evidence has to still be true when
// the D1 write lands). So a test that expects a SUCCESSFUL clear must serve that
// recheck a tip matching the walk it was given — `aaa1`, the newest commit in
// both fixture pages.
const sameTip = () => giteaPage(OURS_AND_AI_PAGE.commits);
// Runs `fn` with globalThis.fetch stubbed, always restoring it.
const withFetch = async (handler, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
};

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

console.log("\n[issue #610: a sort_order-only divergence on a pristine tq row is a version-neutral reorder]");
{
  const { sqlite, env } = freshEnv();
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ID, BOOK, 5, 4, "5:4", "same question", "same response", 999, 3);
  const master = {
    id: ID,
    idCoerced: false,
    refRaw: "5:4",
    chapter: 5,
    verse: 4,
    occurrence: null,
    tags: null,
    quote: null,
    question: "same question",
    response: "same response",
  };
  const counts = await applyTsvRows(env, BOOK, "tq", [master], null);

  eq(counts.reordered, 1, "counted as a reorder, not a content update");
  eq(counts.updated, 0, "NOT counted as a content update — nothing about the text changed");
  eq(counts.skipped_edited, 0, "and not skipped either — the write landed");

  const stored = sqlite.prepare(`SELECT sort_order, version FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
  eq(stored[0].sort_order, 100, "sort_order adopted master's file order (single-row incoming -> makeVerseSortOrder's first slot)");
  eq(stored[0].version, 3, "version UNCHANGED — a pristine reorder must not cost an open editor's If-Match a 409");

  const logRows = sqlite.prepare(`SELECT COUNT(*) AS n FROM edit_log WHERE kind = 'tq' AND row_key = ?`).all(ID);
  eq(logRows[0].n, 0, "no edit_log row — a reorder is not a translator-visible content change");
}

console.log("\n[issue #610 ablation: a genuine content divergence on the same row still takes master's content AND bumps]");
{
  const { sqlite, env } = freshEnv();
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ID, BOOK, 5, 4, "5:4", "old question", "old response", 999, 3);
  const master = {
    id: ID,
    idCoerced: false,
    refRaw: "5:4",
    chapter: 5,
    verse: 4,
    occurrence: null,
    tags: null,
    quote: null,
    question: "new question",
    response: "new response",
  };
  const counts = await applyTsvRows(env, BOOK, "tq", [master], null);
  eq(counts.updated, 1, "content genuinely differs -> the full update path, not reordered");
  eq(counts.reordered, 0, "not counted as a reorder");
  const stored = sqlite.prepare(`SELECT question, sort_order, version FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
  eq(stored[0].question, "new question", "content adopted from master");
  eq(stored[0].sort_order, 100, "file order adopted too");
  eq(stored[0].version, 4, "version bumped — a genuine content change");
}

console.log("\n[issue #616: buildTsvUpdateStmt clears a stale restored_from_version on the pristine-update path]");
{
  const { sqlite, env } = freshEnv();
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, version, restored_from_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ID, BOOK, 5, 4, "5:4", "old question", "old response", 10, 3, 2);
  const master = {
    id: ID,
    idCoerced: false,
    refRaw: "5:4",
    chapter: 5,
    verse: 4,
    occurrence: null,
    tags: null,
    quote: null,
    question: "new question",
    response: "new response",
  };
  const counts = await applyTsvRows(env, BOOK, "tq", [master], null);
  eq(counts.updated, 1, "pristine content update");
  const stored = sqlite
    .prepare(`SELECT restored_from_version, version FROM tq_rows WHERE book = ? AND id = ?`)
    .all(BOOK, ID);
  eq(stored[0].restored_from_version, null, "the stale 'v2 (restored)' chip is cleared — its words are no longer on screen");
  eq(stored[0].version, 4, "version bumped as normal");
}

console.log("\n[issue #616: buildTsvUpdateStmt clears a stale restored_from_version on the AI-reseed path]");
{
  const { sqlite, env } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 707, 'translator7')`).run();
  sqlite
    .prepare(
      `INSERT INTO tq_rows
         (id, book, chapter, verse, ref_raw, question, response, sort_order, version, updated_by, restored_from_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ID, BOOK, 5, 4, "5:4", "AI question", "AI response", 10, 3, 7, 2);
  sqlite
    .prepare(`INSERT INTO edit_log (kind, row_key, book, action, source) VALUES ('tq', ?, ?, 'update', 'ai_pipeline')`)
    .run(ID, BOOK);
  const master = {
    id: ID,
    idCoerced: false,
    refRaw: "5:4",
    chapter: 5,
    verse: 4,
    occurrence: null,
    tags: null,
    quote: null,
    question: "new master question",
    response: "new master response",
  };
  const counts = await applyTsvRows(env, BOOK, "tq", [master], null);
  eq(counts.reimported_ai, 1, "AI-only row re-seeded from master");
  const stored = sqlite
    .prepare(`SELECT restored_from_version, updated_by, version FROM tq_rows WHERE book = ? AND id = ?`)
    .all(BOOK, ID);
  eq(stored[0].restored_from_version, null, "stale restore marker cleared on the AI-reseed path too");
  eq(stored[0].updated_by, null, "reclaimed to master-owned");
  eq(stored[0].version, 4, "version bumped");
}

console.log("\n[issue #616 ablation: a version-neutral reorder must NOT clear restored_from_version]");
{
  const { sqlite, env } = freshEnv();
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, version, restored_from_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ID, BOOK, 5, 4, "5:4", "same question", "same response", 999, 3, 2);
  const master = {
    id: ID,
    idCoerced: false,
    refRaw: "5:4",
    chapter: 5,
    verse: 4,
    occurrence: null,
    tags: null,
    quote: null,
    question: "same question",
    response: "same response",
  };
  const counts = await applyTsvRows(env, BOOK, "tq", [master], null);
  eq(counts.reordered, 1, "content-identical reorder");
  const stored = sqlite.prepare(`SELECT restored_from_version FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
  eq(stored[0].restored_from_version, 2, "reorder changes no content, so the chip must stay exactly as it was");
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
  //     (merge_no_base is a live writer; merge_kept is retired but may still sit
  //     on rows until the nightly retire sweep reaches them).
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
  //    app edit wins — and, since 2026-09-02, WITHOUT a review flag: the decision
  //    rested on a complete lineage walk with no Door43 editor's commit, so there
  //    is nothing for a translator to verify. (JER tq 3:6/3:8/3:19 sat under a
  //    "Kept over Door43 — verify" chip for days against bp-assistant's own
  //    evening push; the chip's text said no editor was involved.)
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedContested(sqlite);
    const versionBefore = readRow(sqlite).version;
    const counts = await applyTsvRows(env, BOOK, "tq", [masterRowAt("the AI run's response")], null, {
      confirmedAt: 200, editId: boundary, lineage: AI_ONLY,
    });
    const row = readRow(sqlite);
    eq(row.response, "our response", "the app edit is KEPT — master's AI-authored value never lands");
    eq(counts.merge_kept_ai, 1, "…counted as merge_kept_ai, so the run summary still reports it");
    eq(counts.merge_adopted, 0, "…and never counted as an adoption");
    eq(counts.merge_master_wins, 0, "…and NOT a master-wins flag: keep_ai_master is D1-wins, its own line (#706)");
    eq(counts.merge_refused, 0, "…and never as a refusal, which would freeze the export at 5");
    eq(counts.apply_incomplete, false, "…and does NOT withhold the watermark: the export must publish this");
    eq(row.review_kind, null, "…and the row is NOT flagged: the finding was measured, not inferred");
    eq(row.review_reason, null, "…no reason text either");
    // A kept-alone row makes no write at all — no flag-only write, so no
    // version bump to 409 an open tab (#539).
    eq(row.version, versionBefore, "…and no write happened: the version is untouched");

    // 2. Re-running the same night's shape is equally silent. The condition
    //    recurs every sync until the export publishes the kept value.
    const again = await applyTsvRows(env, BOOK, "tq", [masterRowAt("the AI run's response")], null, {
      confirmedAt: 200, editId: boundary, lineage: AI_ONLY,
    });
    eq(again.merge_kept_ai, 1, "the conflict is still detected on the next run");
    eq(readRow(sqlite).version, versionBefore, "…and still writes nothing");
  }

  // 2b. The MIXED row: master moved a field the translator never touched (question)
  //     AND the contested field (response). The untouched field is adopted — a
  //     real content write, with a version bump and an `update` audit row — while
  //     the contested one is kept, and still no review flag results.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedContested(sqlite);
    const versionBefore = readRow(sqlite).version;
    const counts = await applyTsvRows(
      env,
      BOOK,
      "tq",
      [{ ...masterRowAt("the AI run's response"), question: "master's reworded question" }],
      null,
      { confirmedAt: 200, editId: boundary, lineage: AI_ONLY },
    );
    const row = sqlite
      .prepare(`SELECT question, response, review_kind, version FROM tq_rows WHERE id='ai01'`)
      .all()[0];
    eq(row.response, "our response", "the contested field is kept");
    eq(row.question, "master's reworded question", "…the field only master moved is adopted");
    eq(counts.merge_kept_ai, 1, "…counted as kept");
    eq(counts.merge_adopted, 1, "…and as an adoption");
    eq(row.review_kind, null, "…and still no review flag");
    eq(row.version, versionBefore + 1, "…the adoption is a real write: one version bump");
    const audit = sqlite.prepare(`SELECT action FROM edit_log WHERE row_key = 'ai01' ORDER BY id DESC LIMIT 1`).all()[0];
    eq(audit?.action, "update", "…with an update audit row behind it");
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
    eq(counts.merge_conflicts, 1, "…one merge_conflicts row (the adopting write)");
    eq(counts.merge_master_wins, 1, "…surfaced as a master-wins flag for review (#706)");
    eq(row.review_reason.includes("was merged over your app-side change"), true, "…with the pre-existing wording");
    // #684: HAS_HUMAN is the pre-#684 shape (shas, no identity), so the message
    // is byte-identical to what it was before this shipped.
    eq(row.review_reason.includes("Door43 edits to this file:"), false, "…and, with no identity measured, names nobody");
  }

  // 3b. #684: the same collision with identity in the lineage. Same winner,
  //     same counts, same flag — the message now says who moved the file.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedContested(sqlite);
    const counts = await applyTsvRows(env, BOOK, "tq", [masterRowAt("a maintainer's fix")], null, {
      confirmedAt: 200,
      editId: boundary,
      lineage: {
        ...HAS_HUMAN,
        humanCommits: [{ sha: "b39f0c72aa18", author: "Stephen Wunrow", date: "2026-08-14T09:05:41Z" }],
      },
    });
    const row = readRow(sqlite);
    eq(row.response, "a maintainer's fix", "master still wins — presentation only, no decision moved");
    eq(counts.merge_adopted, 1, "…still counted as an adoption");
    eq(counts.merge_kept_ai, 0, "…and not as a kept AI conflict");
    eq(row.review_kind, "merge_conflict", "…flagged the same way");
    eq(
      row.review_reason.startsWith("A Door43 edit to this row's response was merged over your app-side change."),
      true,
      "…the outcome still leads (the chip clamps to two lines)",
    );
    eq(
      row.review_reason.includes(`Door43 edits to this file: ${ISO_NAME('Stephen Wunrow')} on 2026-08-14 (b39f0c7).`),
      true,
      "…with the who/when appended, scoped to the file because that is what the walk measured",
    );

    // COLD REVIEW F1 at THIS site, which is the one whose dedup guard compares
    // reason text (bookReimport.ts: stripHumanCommitEvidence on both sides).
    // The translator re-edits the row, so tonight's run re-detects the very same
    // both-changed finding — but the window now holds one more human commit, so
    // the clause renders differently. The reason must NOT be rewritten: the
    // finding did not change, and only the identity drifted.
    //
    // ABLATION: replace the guard with the pre-fix `cur.review_reason !== reason`
    // and this assertion fails (the reason is rewritten to name Richard Mahn).
    sqlite.prepare(`UPDATE tq_rows SET response = 'our response', version = 5 WHERE id='ai01'`).run();
    const reasonBefore = readRow(sqlite).review_reason;
    await applyTsvRows(env, BOOK, "tq", [masterRowAt("a maintainer's fix")], null, {
      confirmedAt: 200,
      editId: boundary,
      lineage: {
        ...HAS_HUMAN,
        counts: { ours: 1, ai: 0, human: 2 },
        humanShas: ["c41d0e99aa71", "b39f0c72aa18"],
        humanCommits: [
          { sha: "c41d0e99aa71", author: "Richard Mahn", date: "2026-08-17T11:31:02Z" },
          { sha: "b39f0c72aa18", author: "Stephen Wunrow", date: "2026-08-14T09:05:41Z" },
        ],
      },
    });
    const reRun = readRow(sqlite);
    eq(reRun.response, "a maintainer's fix", "the re-detected conflict still resolves master-wins");
    eq(reRun.review_kind, "merge_conflict", "…still flagged the same way");
    eq(reRun.review_reason, reasonBefore, "…and the reason is NOT rewritten for identity drift alone");
    eq(reRun.review_reason.includes(ISO_NAME("Richard Mahn")), false, "…so no churn from the newly measured commit");
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

  // 7. Issue #607: the per-row narrowing itself, through the REAL call site
  //    (applyTsvRows -> masterMayHoldHumanEditForVerse(cutoff.lineage,
  //    row.chapter, row.verse)) — not just the pure computeTsvMerge decision,
  //    which masterLineage.test.mjs already covers against two real richmahn
  //    tn_JER.tsv commits. This is what proves row.chapter/row.verse are the
  //    values actually threaded through, the same way #557's own per-verse
  //    fix had to be proven at computeVerseMerge's caller, not just at
  //    computeVerseMerge itself.
  {
    const humanTouchedElsewhere = {
      mayHoldHumanEdit: true, hasHumanCommit: true, incomplete: false, incompleteReason: "",
      counts: { ours: 1, ai: 0, human: 1 }, humanShas: ["abc123"],
      // Complete per-ref evidence — but the human commit landed at 5:5, not at
      // this row's own ref (1:2).
      refsComplete: true, humanRefs: ["5:5"],
    };
    const { sqlite, env } = freshEnv();
    const boundary = seedContested(sqlite);
    const counts = await applyTsvRows(env, BOOK, "tq", [masterRowAt("the AI run's response")], null, {
      confirmedAt: 200, editId: boundary, lineage: humanTouchedElsewhere,
    });
    const row = readRow(sqlite);
    eq(
      row.response, "our response",
      "file-level mayHoldHumanEdit=true, but the human commit's own ref evidence never touched THIS row -> kept",
    );
    eq(counts.merge_kept_ai, 1, "…counted as merge_kept_ai, same as the file-level AI_ONLY case");
    eq(counts.merge_adopted, 0, "…never counted as an adoption");
  }
  {
    const humanTouchedThisRow = {
      mayHoldHumanEdit: true, hasHumanCommit: true, incomplete: false, incompleteReason: "",
      counts: { ours: 1, ai: 0, human: 1 }, humanShas: ["abc123"],
      // Same shape, but this time the evidence DOES name this row's own ref.
      refsComplete: true, humanRefs: ["1:2"],
    };
    const { sqlite, env } = freshEnv();
    const boundary = seedContested(sqlite);
    const counts = await applyTsvRows(env, BOOK, "tq", [masterRowAt("a maintainer's fix")], null, {
      confirmedAt: 200, editId: boundary, lineage: humanTouchedThisRow,
    });
    const row = readRow(sqlite);
    eq(row.response, "a maintainer's fix", "…and when the evidence DOES name this row, master still wins there");
    eq(counts.merge_adopted, 1, "…counted as an adoption, same as the file-level HAS_HUMAN case");
    eq(counts.merge_kept_ai, 0, "…and never as a kept AI conflict");
  }

  // 8b. #706: a MIXED run — one master-wins conflict AND one kept-alone row in
  //     the SAME applyTsvRows call, the exact shape that made the "Pull from
  //     Door43" summary undercount. On the TSV side merge_conflicts is bumped
  //     only for the adopting (master-wins) write, while the kept-alone row lands
  //     in merge_kept_ai alone — so the old summary math,
  //     `max(0, merge_conflicts - merge_kept_ai)`, cancelled the real flag to 0.
  //     merge_master_wins counts the flagged row directly and must stay 1.
  {
    const { sqlite, env } = freshEnv();
    sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 7007, 'translator')`).run();
    // Two contested rows: both sides moved `response` on each.
    //  - keep01 @ 1:2 — no human commit at its ref → keep_ai_master (D1 wins, kept alone)
    //  - win01  @ 1:5 — a human commit AT its ref     → adopt_conflict (master wins, flagged)
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, quote, question, response, sort_order, updated_by, version)
         VALUES ('keep01', ?, 1, 2, '1:2', null, 'our question', 'our response A', 10, 7, 3),
                ('win01',  ?, 1, 5, '1:5', null, 'our question', 'our response B', 20, 7, 3)`,
      )
      .run(BOOK, BOOK);
    const e1 = sqlite
      .prepare(`INSERT INTO edit_log (kind, row_key, book, action, payload_json, created_at) VALUES ('tq', 'keep01', ?, 'create', ?, 100)`)
      .run(BOOK, JSON.stringify({ chapter: 1, verse: 2, ref_raw: "1:2", question: "our question", response: "base response A" }));
    const e2 = sqlite
      .prepare(`INSERT INTO edit_log (kind, row_key, book, action, payload_json, created_at) VALUES ('tq', 'win01', ?, 'create', ?, 100)`)
      .run(BOOK, JSON.stringify({ chapter: 1, verse: 5, ref_raw: "1:5", question: "our question", response: "base response B" }));
    const boundary = Math.max(Number(e1.lastInsertRowid), Number(e2.lastInsertRowid));
    const lineage = {
      mayHoldHumanEdit: true, hasHumanCommit: true, incomplete: false, incompleteReason: "",
      counts: { ours: 1, ai: 1, human: 1 }, humanShas: ["abc123"],
      // Complete per-ref evidence naming ONLY win01's ref.
      refsComplete: true, humanRefs: ["1:5"],
    };
    const mkRow = (id, ref, chapter, verse, response) => ({
      id, idCoerced: false, refRaw: ref, chapter, verse,
      occurrence: null, tags: null, quote: null, question: "our question", response,
    });
    const counts = await applyTsvRows(
      env, BOOK, "tq",
      [mkRow("keep01", "1:2", 1, 2, "the AI run's response"), mkRow("win01", "1:5", 1, 5, "a maintainer's fix")],
      null,
      { confirmedAt: 200, editId: boundary, lineage },
    );
    const rows = Object.fromEntries(
      sqlite.prepare(`SELECT id, response, review_kind FROM tq_rows WHERE id IN ('keep01','win01')`).all().map((r) => [r.id, r]),
    );
    eq(rows.keep01.response, "our response A", "the kept-alone row keeps D1's value");
    eq(rows.keep01.review_kind, null, "…with no review flag (keep_ai_master mints none)");
    eq(rows.win01.response, "a maintainer's fix", "the master-wins row adopts Door43's value");
    eq(rows.win01.review_kind, "merge_conflict", "…and IS flagged for review");
    eq(counts.merge_kept_ai, 1, "one kept-alone row");
    eq(counts.merge_conflicts, 1, "one adopting (master-wins) write bumped merge_conflicts");
    eq(counts.merge_adopted, 1, "…and merge_adopted");
    eq(counts.merge_master_wins, 1, "merge_master_wins counts the flagged row directly");
    // The regression itself: the counter the summary now reads does NOT cancel.
    eq(
      Math.max(0, counts.merge_conflicts - counts.merge_kept_ai),
      0,
      "the OLD summary math would have hidden the flag (this is the bug #706 fixes)",
    );
    eq(counts.merge_master_wins, 1, "…while merge_master_wins keeps the flag visible");
  }

  // 9. PR #644 review finding F2: the per-ref evidence is keyed to the ref AS
  //    IT STOOD when the human's own commit touched it — but a LATER bot/AI
  //    commit can move a row's Reference before this run's HEAD parse (the
  //    real, independently-tracked ref_moved phenomenon covered above, issue
  //    #588). Checking only `row`'s CURRENT ref (master's fresh parse) would
  //    miss evidence recorded under the OLD ref and wrongly let master's
  //    later content win a both-changed conflict over a genuine human edit.
  //    The call site now ALSO checks `cur`'s (D1's own last-known) ref,
  //    OR'd in — strictly protective, since OR can only add coverage.
  {
    const humanTouchedOldRef = {
      mayHoldHumanEdit: true, hasHumanCommit: true, incomplete: false, incompleteReason: "",
      counts: { ours: 1, ai: 0, human: 1 }, humanShas: ["def456"],
      // Evidence recorded under the OLD ref (1:2) — where the human's own
      // commit actually landed, before a later commit moved the row.
      refsComplete: true, humanRefs: ["1:2"],
    };
    const { sqlite, env } = freshEnv();
    const boundary = seedContested(sqlite); // D1's cur row: still at chapter=1, verse=2
    // Master's CURRENT HEAD: this same id now sits at 1:9 (moved since the
    // human's commit) and its content changed too.
    const moved = { ...masterRowAt("a maintainer's fix at the new ref"), refRaw: "1:9", verse: 9 };
    const counts = await applyTsvRows(env, BOOK, "tq", [moved], null, {
      confirmedAt: 200, editId: boundary, lineage: humanTouchedOldRef,
    });
    const row = readRow(sqlite);
    eq(
      row.response,
      "a maintainer's fix at the new ref",
      "evidence recorded under the OLD ref still protects the row after a later ref move — the call site also " +
        "checks D1's OWN stored ref (cur.chapter/cur.verse), not just master's current one",
    );
    eq(counts.merge_adopted, 1, "…the content is a normal adoption, not a kept-AI conflict");
    eq(counts.merge_kept_ai, 0, "…never treated as untrusted AI/bot content because the ref moved");
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
    // The denial itself is the one allowed use of the word, in either of the
    // two phrasings this message has had (#653 rewrote the sentence).
    /overwritten|overwrote|overwrites/i.test(
      after1.review_reason.replace("Nothing has been overwritten", "").replace("Nothing was overwritten", ""),
    ),
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

// ── Issue #653: create-as-ancestor, the lineage gate, and the auto-clear ────
//
// The prod shape all three pieces were built for, measured 2026-08-30: 79
// tn/tq/twl rows carried review_kind='merge_no_base' (JER tn 66, AMO tn 8,
// ECC tq 3, AMO tq 2) and every one was a false alarm. bp-assistant pushed AI
// notes to master in the evening, the reimport CREATED them in D1 (a full-
// payload edit_log 'create' whose id sits ABOVE master_confirmed_edit_id,
// because the evening pushes froze own-publish recognition), and a translator
// then edited them in the app. The ancestor was one id above the boundary the
// whole time, and reconstructTsvBases cut hard at `id <= boundaryId`.
//
// Driven through the REAL applyTsvRows and the REAL SQL, because every one of
// these is a storage outcome (a flag written or not written, a snapshot, a
// version bump) that a pure test cannot observe.
console.log("\n[#653: a row created ABOVE the boundary folds its create as the ancestor]");
{
  // Master's row is EXACTLY what the create imported — nobody touched it since.
  // Ours differs (the app edit). Attributed against the create: theirs === base,
  // so master never moved this field and our edit stands. Clean, no flag.
  const { sqlite, env } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 100, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, updated_by)
       VALUES ('ca01', ?, 9, 9, '9:9', 'app question', 'imported response', 2, 1)`,
    )
    .run(BOOK);
  // The create sits ABOVE the boundary (id > editId) — this is the whole bug.
  const boundary = 1000000;
  sqlite
    .prepare(
      `INSERT INTO edit_log (id, kind, row_key, book, action, payload_json, created_at)
       VALUES (?, 'tq', 'ca01', ?, 'create', ?, 500)`,
    )
    .run(
      boundary + 5,
      BOOK,
      JSON.stringify({ ref_raw: "9:9", chapter: 9, verse: 9, question: "imported question", response: "imported response" }),
    );
  const master = () => [{
    id: "ca01", idCoerced: false, refRaw: "9:9", chapter: 9, verse: 9,
    occurrence: null, tags: null, quote: null,
    question: "imported question", response: "imported response",
  }];

  const counts = await applyTsvRows(env, BOOK, "tq", master(), null, { confirmedAt: 200, editId: boundary });
  eq(counts.merge_no_base, 0, "the create IS an ancestor — no keep_no_base at all");
  const row = sqlite.prepare(`SELECT review_kind, version, question FROM tq_rows WHERE id='ca01'`).all()[0];
  eq(row.review_kind, null, "…so no flag is raised");
  eq(row.question, "app question", "…the app edit stands (master never moved this field)");
  eq(row.version, 2, "…and nothing is written, so the version does not move");
}

console.log("\n[#653: the fallback takes the CURRENT life's create, and is not shadowed by another book's]");
{
  // A reclaimed slot: the id was tombstoned and reissued, so edit_log holds two
  // creates for it, both above the boundary (the only case the fallback runs
  // in). Master holds the CURRENT life's content. Fold the dead life's create
  // instead and both sides look moved -> a conflict flag over nothing, and a
  // real risk of adopting master over the translator on a coincidental match.
  {
    const { sqlite, env } = freshEnv();
    sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 100, 'translator')`).run();
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, updated_by)
         VALUES ('rs12', ?, 9, 9, '9:9', 'app question', 'life2 response', 2, 1)`,
      )
      .run(BOOK);
    const boundary = 1000000;
    const ins = sqlite.prepare(
      `INSERT INTO edit_log (id, kind, row_key, book, action, payload_json, created_at) VALUES (?, 'tq', 'rs12', ?, 'create', ?, ?)`,
    );
    ins.run(boundary + 5, BOOK, JSON.stringify({ question: "life1 question", response: "life1 response" }), 500);
    ins.run(boundary + 9, BOOK, JSON.stringify({ question: "life2 question", response: "life2 response" }), 600);

    const counts = await applyTsvRows(
      env, BOOK, "tq",
      [{
        id: "rs12", idCoerced: false, refRaw: "9:9", chapter: 9, verse: 9,
        occurrence: null, tags: null, quote: null, question: "life2 question", response: "life2 response",
      }],
      null, { confirmedAt: 200, editId: boundary },
    );
    eq(counts.merge_conflicts, 0, "the current life's create is the ancestor — no phantom conflict");
    const row = sqlite.prepare(`SELECT review_kind, question FROM tq_rows WHERE id='rs12'`).all()[0];
    eq(row.review_kind, null, "…no flag");
    eq(row.question, "app question", "…and the translator's edit stands");
  }

  // A NULL-book create for the same short id belongs to ANOTHER book (prod
  // holds ~7,689 such rows). Here it is NEWER than this book's own create, so a
  // query that admits it would pick it — and the folds discard book-NULL
  // entries, leaving the row with no ancestor and the very flag the fallback
  // exists to remove.
  {
    const { sqlite, env } = freshEnv();
    sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 100, 'translator')`).run();
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, updated_by)
         VALUES ('sh34', ?, 9, 9, '9:9', 'app question', 'imported response', 2, 1)`,
      )
      .run(BOOK);
    const boundary = 1000000;
    const ins = sqlite.prepare(
      `INSERT INTO edit_log (id, kind, row_key, book, action, payload_json, created_at) VALUES (?, 'tq', 'sh34', ?, 'create', ?, ?)`,
    );
    ins.run(boundary + 5, BOOK, JSON.stringify({ question: "imported question", response: "imported response" }), 500);
    ins.run(boundary + 9, null, JSON.stringify({ question: "another book's question", response: "x" }), 600);

    const counts = await applyTsvRows(
      env, BOOK, "tq",
      [{
        id: "sh34", idCoerced: false, refRaw: "9:9", chapter: 9, verse: 9,
        occurrence: null, tags: null, quote: null, question: "imported question", response: "imported response",
      }],
      null, { confirmedAt: 200, editId: boundary },
    );
    eq(counts.merge_no_base, 0, "this book's own create is found, not shadowed by the foreign one");
    const row = sqlite.prepare(`SELECT review_kind FROM tq_rows WHERE id='sh34'`).all()[0];
    eq(row.review_kind, null, "…so no flag is raised");
  }
}

console.log("\n[#653: master AI-edited AFTER the import — a real conflict, resolved D1-wins with a snapshot]");
{
  // Same setup, but master's question moved too (the evening AI push). Both
  // sides changed it: a genuine conflict, which the lineage resolves D1-wins
  // (#540 item 2) because no human commit is behind master's side.
  const { sqlite, env } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 100, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, updated_by)
       VALUES ('ca02', ?, 9, 9, '9:9', 'app question', 'imported response', 2, 1)`,
    )
    .run(BOOK);
  const boundary = 1000000;
  sqlite
    .prepare(
      `INSERT INTO edit_log (id, kind, row_key, book, action, payload_json, created_at)
       VALUES (?, 'tq', 'ca02', ?, 'create', ?, 500)`,
    )
    .run(boundary + 5, BOOK, JSON.stringify({ question: "imported question", response: "imported response" }));

  const counts = await applyTsvRows(
    env, BOOK, "tq",
    [{
      id: "ca02", idCoerced: false, refRaw: "9:9", chapter: 9, verse: 9,
      occurrence: null, tags: null, quote: null,
      question: "ai-rewritten question", response: "imported response",
    }],
    null,
    { confirmedAt: 200, editId: boundary, lineage: AI_ONLY_LINEAGE },
  );
  eq(counts.merge_kept_ai, 1, "both sides moved the question -> keep_ai_master, D1 wins");
  eq(counts.merge_no_base, 0, "…and it is NOT reported as unattributable");
  const row = sqlite.prepare(`SELECT review_kind, question, review_master_json FROM tq_rows WHERE id='ca02'`).all()[0];
  eq(
    row.review_kind,
    null,
    "the row is NOT flagged: keep_ai_master rests on a complete no-human lineage, so there is nothing to verify",
  );
  eq(row.question, "app question", "…the translator's question is kept");
  eq(row.review_master_json, null, "…and no snapshot is written — a kept-alone row makes no write at all");
}

console.log("\n[#653: a create-as-ancestor base may EXONERATE but never CONVICT]");
{
  // THE SHAPE THAT MADE THIS A BLOCKER. The watermark is frozen while our own
  // exports keep landing, so: base = the import (recovered by the fallback),
  // ours = the translator's NEWEST edit, theirs = OUR OWN export of her OLDER
  // edit. All three differ, which reads as a both-changed conflict — and with
  // master allowed to win one (no lineage / an incomplete walk), master-wins
  // would revert her newest edit to our stale render of her older one. On main
  // this population is unconditionally keep_no_base, so the floor keeps it no
  // worse than main.
  const seedProvisional = (sqlite, id) => {
    sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 100, 'translator')`).run();
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, updated_by)
         VALUES (?, ?, 9, 9, '9:9', 'her newest edit', 'imported response', 3, 1)`,
      )
      .run(id, BOOK);
    const boundary = 1000000;
    sqlite
      .prepare(
        `INSERT INTO edit_log (id, kind, row_key, book, action, payload_json, created_at)
         VALUES (?, 'tq', ?, ?, 'create', ?, 500)`,
      )
      .run(boundary + 5, id, BOOK, JSON.stringify({ question: "imported question", response: "imported response" }));
    return boundary;
  };
  const masterStale = (id) => [{
    id, idCoerced: false, refRaw: "9:9", chapter: 9, verse: 9,
    occurrence: null, tags: null, quote: null,
    question: "our stale export of her older edit", response: "imported response",
  }];

  // 1. No lineage — master is allowed to win a conflict. It must NOT.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedProvisional(sqlite, "pv01");
    const counts = await applyTsvRows(env, BOOK, "tq", masterStale("pv01"), null, {
      confirmedAt: 200, editId: boundary,
    });
    const row = sqlite.prepare(`SELECT question, version, review_kind FROM tq_rows WHERE id='pv01'`).all()[0];
    eq(row.question, "her newest edit", "the translator's newest edit is NOT reverted to our stale render");
    eq(counts.merge_conflicts, 0, "…the row is not adopted at all");
    eq(counts.merge_no_base, 1, "…it degrades to keep_no_base, exactly what main does for this population");
    eq(row.review_kind, "merge_no_base", "…and it says so on the row");
  }

  // 2. Same row, but the lineage EXPLICITLY rules out a human behind master.
  //    keep_ai_master is a D1-wins outcome, so it survives the floor — the
  //    translator keeps her text, and with no chip: the outcome was measured.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedProvisional(sqlite, "pv02");
    const counts = await applyTsvRows(env, BOOK, "tq", masterStale("pv02"), null, {
      confirmedAt: 200, editId: boundary, lineage: AI_ONLY_LINEAGE,
    });
    eq(counts.merge_kept_ai, 1, "a D1-wins conflict still fires under a clean lineage");
    const row = sqlite.prepare(`SELECT question, review_kind FROM tq_rows WHERE id='pv02'`).all()[0];
    eq(row.question, "her newest edit", "…her text is kept");
    eq(row.review_kind, null, "…with no review chip — a measured keep asks nothing of her");
  }

  // 3. Master moved a field the translator never touched. Adopting would be
  //    master-wins on a provisional base, and our own render is NOT round-trip
  //    stable (STATE.md), so this is withheld rather than adopted on what may
  //    be a phantom difference.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedProvisional(sqlite, "pv03");
    const counts = await applyTsvRows(
      env, BOOK, "tq",
      [{
        id: "pv03", idCoerced: false, refRaw: "9:9", chapter: 9, verse: 9,
        occurrence: null, tags: null, quote: null,
        question: "imported question", response: "master moved this alone",
      }],
      null, { confirmedAt: 200, editId: boundary },
    );
    eq(counts.merge_adopted, 0, "no adopt on a provisional base");
    eq(counts.merge_no_base, 1, "…it reports as unattributable instead");
    const row = sqlite.prepare(`SELECT response FROM tq_rows WHERE id='pv03'`).all()[0];
    eq(row.response, "imported response", "…and D1 keeps its value");
  }

  // 4. THE HEADLINE WIN is untouched: master still holds exactly what the row
  //    was created with, so the difference is ours and our edit stands clean.
  {
    const { sqlite, env } = freshEnv();
    const boundary = seedProvisional(sqlite, "pv04");
    const counts = await applyTsvRows(
      env, BOOK, "tq",
      [{
        id: "pv04", idCoerced: false, refRaw: "9:9", chapter: 9, verse: 9,
        occurrence: null, tags: null, quote: null,
        question: "imported question", response: "imported response",
      }],
      null, { confirmedAt: 200, editId: boundary },
    );
    eq(counts.merge_no_base, 0, "exoneration still works — this is the whole point of the fallback");
    const row = sqlite.prepare(`SELECT review_kind, version FROM tq_rows WHERE id='pv04'`).all()[0];
    eq(row.review_kind, null, "…no flag");
    eq(row.version, 3, "…and no write");
  }

  // 5. The REFERENCE decision never sees a provisional ancestor. Set up as the
  //    exact shape that WOULD read `ours_moved` from one: the create carries
  //    the reference, D1 has since moved the row, and master still sits where
  //    the create put it. `ours_moved` is the single outcome in this file that
  //    publishes D1's location over master's — its own comment calls it the
  //    only place a mis-attribution costs data — so an ancestor recovered from
  //    the boundary that just failed must not unlock it. With no reference
  //    ancestor the move stays unattributable and HOLDS.
  {
    const { sqlite, env } = freshEnv();
    sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 100, 'translator')`).run();
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, updated_by)
         VALUES ('pv05', ?, 9, 6, '9:6', 'imported question', 'her edit', 3, 1)`,
      )
      .run(BOOK);
    const boundary = 1000000;
    sqlite
      .prepare(
        `INSERT INTO edit_log (id, kind, row_key, book, action, payload_json, created_at)
         VALUES (?, 'tq', 'pv05', ?, 'create', ?, 500)`,
      )
      .run(
        boundary + 5,
        BOOK,
        JSON.stringify({ chapter: 9, verse: 9, ref_raw: "9:9", question: "imported question", response: "imported response" }),
      );
    const counts = await applyTsvRows(
      env, BOOK, "tq",
      [{
        id: "pv05", idCoerced: false, refRaw: "9:9", chapter: 9, verse: 9,
        occurrence: null, tags: null, quote: null,
        question: "imported question", response: "imported response",
      }],
      null, { confirmedAt: 200, editId: boundary },
    );
    eq(counts.ref_moved_ours, 0, "a provisional base never attributes the move to us…");
    eq(counts.ref_moved_unattributable, 1, "…it stays unattributable");
    eq(counts.apply_incomplete, true, "…and holds the resource watermark, the fail-safe direction");
    const row = sqlite.prepare(`SELECT review_kind FROM tq_rows WHERE id='pv05'`).all()[0];
    eq(row.review_kind, "ref_moved", "…and flags the row rather than silently publishing the move");
  }
}

console.log("\n[#653: boundary equality on the warm-up (timestamp) path]");
{
  // With migration 0050 still warming up, `editId` is null and the bounded cut
  // is `created_at < confirmedAt` — so a create AT the confirmedAt second is
  // OUTSIDE the bounded set. The lifecycle test has to make the identical cut,
  // or the row falls between the two and has no ancestor at all. One second,
  // and it decides whether the row is adjudicable.
  const { sqlite, env } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 100, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, updated_by)
       VALUES ('eq01', ?, 9, 9, '9:9', 'her edit', 'imported response', 2, 1)`,
    )
    .run(BOOK);
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, action, payload_json, created_at)
       VALUES ('tq', 'eq01', ?, 'create', ?, 200)`,
    )
    .run(BOOK, JSON.stringify({ question: "imported question", response: "imported response" }));

  const counts = await applyTsvRows(
    env, BOOK, "tq",
    [{
      id: "eq01", idCoerced: false, refRaw: "9:9", chapter: 9, verse: 9,
      occurrence: null, tags: null, quote: null,
      question: "imported question", response: "imported response",
    }],
    null, { confirmedAt: 200, editId: null },
  );
  eq(counts.merge_no_base, 0, "a create at the cutoff second is recovered, not lost between the two cuts");
  const row = sqlite.prepare(`SELECT review_kind, question FROM tq_rows WHERE id='eq01'`).all()[0];
  eq(row.review_kind, null, "…so the row is adjudicable and needs no flag");
  eq(row.question, "her edit", "…and her edit stands");
}

console.log("\n[#653: a RECLAIMED id's old lifecycle never becomes a trusted ancestor]");
{
  // The Codex finding, and a hole `main` already had. (book, id) is reusable —
  // the tombstone machinery reclaims one and logs a SECOND 'create' — so an OLD
  // life's create/update can sit BELOW the boundary while the current life's
  // reclaim-create sits ABOVE it. Keyed on "the bounded set is empty" the row
  // stays on the bounded fold, which folds the DEAD row's payload into a
  // fully-trusted ancestor: obsolete base, translator's value and master all
  // differ, that reads as a both-changed conflict, and master-wins then writes
  // over the translator. The discriminator is lifecycle, not emptiness.
  const boundary = 1000000;
  const seedReclaimed = (sqlite, id, ourQuestion) => {
    sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 100, 'translator')`).run();
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, updated_by)
         VALUES (?, ?, 9, 9, '9:9', ?, 'life2 response', 3, 1)`,
      )
      .run(id, BOOK, ourQuestion);
    const ins = sqlite.prepare(
      `INSERT INTO edit_log (id, kind, row_key, book, action, payload_json, created_at) VALUES (?, 'tq', ?, ?, ?, ?, ?)`,
    );
    // The DEAD life, entirely below the boundary.
    ins.run(boundary - 900, id, BOOK, "create", JSON.stringify({ question: "life1 question", response: "life1 response" }), 100);
    ins.run(boundary - 800, id, BOOK, "update", JSON.stringify({ question: "life1 edited" }), 200);
    // The reclaim: the current life's entry into D1, ABOVE the boundary.
    ins.run(boundary + 40, id, BOOK, "create", JSON.stringify({ question: "life2 question", response: "life2 response" }), 900);
  };

  // 1. All three differ, and master is allowed to win a conflict (no lineage).
  //    The dead life must not authorize an overwrite.
  {
    const { sqlite, env } = freshEnv();
    seedReclaimed(sqlite, "rc01", "her edit on the new life");
    const counts = await applyTsvRows(
      env, BOOK, "tq",
      [{
        id: "rc01", idCoerced: false, refRaw: "9:9", chapter: 9, verse: 9,
        occurrence: null, tags: null, quote: null,
        question: "master's own different text", response: "life2 response",
      }],
      null, { confirmedAt: 200, editId: boundary },
    );
    const row = sqlite.prepare(`SELECT question, response, review_kind FROM tq_rows WHERE id='rc01'`).all()[0];
    eq(row.question, "her edit on the new life", "the dead life's payload does NOT authorize master-wins");
    eq(counts.merge_conflicts, 0, "…nothing is adopted");
    eq(counts.merge_no_base, 1, "…the row degrades to keep_no_base, the exonerate-only floor");
    eq(row.response, "life2 response", "…no content field is rewritten");
    // The only write is the flag itself (no lineage was walked, so the mint
    // stands), which is what the version bump here is.
    eq(row.review_kind, "merge_no_base", "…and the row is flagged rather than silently kept");
  }

  // 2. Master still holds exactly what the CURRENT life was created with, so
  //    the difference is ours and the edit stands clean — the fallback's
  //    headline win, reached through the same lifecycle discriminator.
  {
    const { sqlite, env } = freshEnv();
    seedReclaimed(sqlite, "rc02", "her edit on the new life");
    const counts = await applyTsvRows(
      env, BOOK, "tq",
      [{
        id: "rc02", idCoerced: false, refRaw: "9:9", chapter: 9, verse: 9,
        occurrence: null, tags: null, quote: null,
        question: "life2 question", response: "life2 response",
      }],
      null, { confirmedAt: 200, editId: boundary },
    );
    eq(counts.merge_no_base, 0, "attributed against the CURRENT life's create — a clean keep");
    const row = sqlite.prepare(`SELECT review_kind, question FROM tq_rows WHERE id='rc02'`).all()[0];
    eq(row.review_kind, null, "…no flag");
    eq(row.question, "her edit on the new life", "…and her edit stands");
  }
}

console.log("\n[#653: with NO ancestor at all, the mint is gated on the measured lineage]");
{
  const seed = (sqlite) => {
    sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 100, 'translator')`).run();
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, updated_by)
         VALUES ('nb99', ?, 9, 9, '9:9', 'app question', 'r', 1, 1)`,
      )
      .run(BOOK);
  };
  // No edit_log row of ANY action for this id, so neither the bounded fold nor
  // the create fallback finds anything: base === null, genuinely.
  const master = () => [{
    id: "nb99", idCoerced: false, refRaw: "9:9", chapter: 9, verse: 9,
    occurrence: null, tags: null, quote: null, question: "master question", response: "r",
  }];

  // 1. Complete walk, no human commit -> the flag's own claim is disproved.
  {
    const { sqlite, env } = freshEnv();
    seed(sqlite);
    const counts = await applyTsvRows(env, BOOK, "tq", master(), null, {
      confirmedAt: 200, editId: null, lineage: AI_ONLY_LINEAGE,
    });
    eq(counts.merge_no_base, 1, "the merge outcome is unchanged — still keep_no_base");
    eq(counts.merge_no_base_mint_skipped, 1, "…but the flag is withheld, and the skip is counted");
    const row = sqlite.prepare(`SELECT review_kind, version FROM tq_rows WHERE id='nb99'`).all()[0];
    eq(row.review_kind, null, "…no flag on the row");
    eq(row.version, 1, "…and no version bump for a flag nobody needed");
  }

  // 2. Complete walk that FOUND a human commit -> mint, human-variant message.
  {
    const { sqlite, env } = freshEnv();
    seed(sqlite);
    const counts = await applyTsvRows(env, BOOK, "tq", master(), null, {
      confirmedAt: 200, editId: null, lineage: HUMAN_LINEAGE,
    });
    eq(counts.merge_no_base_mint_skipped, 0, "a human commit in the window is not a skip");
    const row = sqlite.prepare(`SELECT review_kind, review_reason, review_master_json FROM tq_rows WHERE id='nb99'`).all()[0];
    eq(row.review_kind, "merge_no_base", "the flag is raised");
    eq(
      row.review_reason.includes("a Door43 editor changed this file"),
      true,
      "…and states the measured cause: a human commit was found",
    );
    eq(
      row.review_reason.includes("could not be read in full"),
      false,
      "…never the incomplete-history cause, which was not what happened",
    );
    eq(parseSnap(row.review_master_json).question, "master question", "…with Door43's value recorded for comparison");
    eq(
      parseSnap(row.review_master_json)._meta?.flag_since,
      200,
      "…and the watermark this flag's claim is bounded by, which is what the auto-clear must cover",
    );
    // #664 emits everything OUTSIDE _meta as the lint feed's "Door43's row
    // value", so bookkeeping at the top level would render as a Door43 column.
    eq(
      Object.keys(parseSnap(row.review_master_json)).filter((k) => k.startsWith("flag_")),
      [],
      "…kept under _meta, never beside the Door43 fields",
    );
    // Exactly the fields the feed reads for tq (#664's TQ_REVIEW_FIELDS) —
    // no more (tq does not display quote/occurrence) and no less.
    eq(
      Object.keys(parseSnap(row.review_master_json)).filter((k) => k !== "_meta").sort(),
      ["question", "ref_raw", "response", "tags"],
      "…and the snapshot carries exactly the fields the review feed reads for tq",
    );
    // #684 BACKWARD COMPAT, at the real call site. HUMAN_LINEAGE is the
    // PRE-#684 shape — humanShas, no identity — which is exactly what
    // master_lineage_json holds for every pair last walked before this shipped.
    // The message must be the one that shipped before, with nobody named.
    eq(
      row.review_reason.includes("Door43 edits to this file:"),
      false,
      "…and a pre-#684 lineage names nobody: the wording is byte-identical to before #684",
    );
  }

  // 2b. #684: the SAME run, with the identity #684 added to the lineage. Same
  //     decision, same flag, same counts — the reason text now says WHO and
  //     WHEN. The editor report this fixes: "a cryptic message that says
  //     something moved and we don't know what's going on."
  {
    const namedLineage = {
      ...HUMAN_LINEAGE,
      humanCommits: [
        { sha: "7d1c9ab4e05f", author: "justplainjane47", date: "2026-08-15T14:22:07Z" },
      ],
    };
    const { sqlite, env } = freshEnv();
    seed(sqlite);
    const counts = await applyTsvRows(env, BOOK, "tq", master(), null, {
      confirmedAt: 200, editId: null, lineage: namedLineage,
    });
    const row = sqlite.prepare(`SELECT review_kind, review_reason, version FROM tq_rows WHERE id='nb99'`).all()[0];
    // DECISIONS FIRST, and identical to case 2's: this is presentation only.
    eq(counts.merge_no_base, 1, "the merge outcome is unchanged by carrying identity");
    eq(counts.merge_no_base_mint_skipped, 0, "…the mint gate is unchanged");
    eq(row.review_kind, "merge_no_base", "…the same flag is raised");
    eq(row.version, 2, "…with the same single flag write");
    eq(
      row.review_reason.includes("a Door43 editor changed this file"),
      true,
      "…and the measured cause still leads",
    );
    eq(
      row.review_reason.includes(`Door43 edits to this file: ${ISO_NAME('justplainjane47')} on 2026-08-15 (7d1c9ab).`),
      true,
      "…now naming the person, the day and the commit — the ISA 2026-08-15 flags' real cause",
    );
    // Outcome and remedy stay in front of the identity: the cleanup chip clamps
    // to two lines (BookLintIndicator), so the who/when must not displace them.
    eq(
      row.review_reason.startsWith("Nothing was overwritten. Check this row against Door43's version"),
      true,
      "…with the outcome and the remedy still leading the message",
    );
    eq(
      row.review_reason.indexOf("Door43 edits to this file:") > row.review_reason.indexOf("could not tell which side"),
      true,
      "…and the who/when placed last, after the cause",
    );
  }

  // 2c. COLD REVIEW F1, the churn rule: "versions don't bump unless something
  //     actually changed". A standing flag is re-examined every night, and the
  //     identity clause drifts on its own — a new Door43 commit lands, or the
  //     watermark the walk is bounded by advances. That drift must not rewrite
  //     the flag or bump the row's version, because a version bump on a row
  //     nobody touched 409s the outbox op of any tab holding it.
  {
    const { sqlite, env } = freshEnv();
    seed(sqlite);
    const night1 = {
      ...HUMAN_LINEAGE,
      humanCommits: [{ sha: "7d1c9ab4e05f", author: "justplainjane47", date: "2026-08-15T14:22:07Z" }],
    };
    // The next night: one MORE human commit in the window, by someone else, so
    // the clause this run would render is different text for the same finding.
    const night2 = {
      ...HUMAN_LINEAGE,
      counts: { ours: 1, ai: 1, human: 2 },
      humanShas: ["b39f0c72aa18", "7d1c9ab4e05f"],
      humanCommits: [
        { sha: "b39f0c72aa18", author: "Stephen Wunrow", date: "2026-08-16T09:05:41Z" },
        { sha: "7d1c9ab4e05f", author: "justplainjane47", date: "2026-08-15T14:22:07Z" },
      ],
    };
    await applyTsvRows(env, BOOK, "tq", master(), null, { confirmedAt: 200, editId: null, lineage: night1 });
    const after1 = sqlite.prepare(`SELECT review_reason, review_master_json, version FROM tq_rows WHERE id='nb99'`).all()[0];
    eq(after1.version, 2, "night one mints the flag: one version bump");
    eq(after1.review_reason.includes(ISO_NAME("justplainjane47")), true, "…naming the commit it measured");

    await applyTsvRows(env, BOOK, "tq", master(), null, { confirmedAt: 200, editId: null, lineage: night2 });
    const after2 = sqlite.prepare(`SELECT review_reason, review_master_json, version FROM tq_rows WHERE id='nb99'`).all()[0];
    eq(after2.version, 2, "night two, with a DIFFERENT set of commits measured, does not bump the version");
    eq(after2.review_reason, after1.review_reason, "…and does not rewrite the reason");
    eq(after2.review_master_json, after1.review_master_json, "…nor the Door43 snapshot beside it");
    eq(
      after2.review_reason.includes(ISO_NAME("Stephen Wunrow")),
      false,
      "…so the flag keeps the identity measured when the finding was made, and the row is never touched",
    );
  }

  // 3. INCOMPLETE walk -> mint, and the message says so instead of naming an editor.
  {
    const { sqlite, env } = freshEnv();
    seed(sqlite);
    await applyTsvRows(env, BOOK, "tq", master(), null, {
      confirmedAt: 200, editId: null, lineage: INCOMPLETE_LINEAGE,
    });
    const row = sqlite.prepare(`SELECT review_kind, review_reason FROM tq_rows WHERE id='nb99'`).all()[0];
    eq(row.review_kind, "merge_no_base", "an incomplete walk still mints — absent is not 'no human'");
    eq(row.review_reason.includes("could not be read in full"), true, "…and says the history could not be read");
    eq(row.review_reason.includes("a Door43 editor changed this file"), false, "…and claims no editor it never saw");
    eq(row.review_reason.includes("Door43 edits to this file:"), false, "…and names nobody (#684)");
  }

  // 3c. #684: an incomplete walk that DID see human commits, carrying their
  //     identity. Naming them would be the exact mistake this repo has a
  //     standing rule about — the walk has not established that a human moved
  //     this file, so the message stays the could-not-verify one, unchanged.
  {
    const { sqlite, env } = freshEnv();
    seed(sqlite);
    await applyTsvRows(env, BOOK, "tq", master(), null, {
      confirmedAt: 200,
      editId: null,
      lineage: {
        ...INCOMPLETE_LINEAGE,
        hasHumanCommit: true,
        counts: { ours: 1, ai: 1, human: 1 },
        humanShas: ["7d1c9ab4e05f"],
        humanCommits: [{ sha: "7d1c9ab4e05f", author: "justplainjane47", date: "2026-08-15T14:22:07Z" }],
      },
    });
    const row = sqlite.prepare(`SELECT review_kind, review_reason FROM tq_rows WHERE id='nb99'`).all()[0];
    eq(row.review_kind, "merge_no_base", "an incomplete walk still mints");
    eq(row.review_reason.includes("could not be read in full"), true, "…with the could-not-verify wording");
    eq(
      row.review_reason.includes("justplainjane47"),
      false,
      "…and names nobody: an incomplete walk has not established the cause it would be naming",
    );
  }

  // 3b. A human commit the per-ref narrowing places in OTHER verses still
  //     mints. Withholding a warning is the same user-visible act as clearing
  //     one, and the clear refuses to run on narrowed evidence — so the mint
  //     gate reads the same file-level tier, and the two can never disagree
  //     about one row.
  {
    const { sqlite, env } = freshEnv();
    seed(sqlite);
    const counts = await applyTsvRows(env, BOOK, "tq", master(), null, {
      confirmedAt: 200,
      editId: null,
      lineage: { ...HUMAN_LINEAGE, refsComplete: true, humanRefs: ["1:1"], refsReason: "" },
    });
    eq(counts.merge_no_base_mint_skipped, 0, "narrowed evidence does not withhold the flag…");
    const row = sqlite.prepare(`SELECT review_kind FROM tq_rows WHERE id='nb99'`).all()[0];
    eq(row.review_kind, "merge_no_base", "…the row is still flagged on the file-level answer");
  }

  // 3c. A row ALREADY carrying the flag skipped nothing, so it must not be
  //     counted as a withholding every night for the rest of its life.
  {
    const { sqlite, env } = freshEnv();
    seed(sqlite);
    sqlite.prepare(`UPDATE tq_rows SET review_kind='merge_no_base', review_reason='from an earlier run' WHERE id='nb99'`).run();
    const counts = await applyTsvRows(env, BOOK, "tq", master(), null, {
      confirmedAt: 200, editId: null, lineage: AI_ONLY_LINEAGE,
    });
    eq(counts.merge_no_base_mint_skipped, 0, "nothing was skipped — the flag was already there");
    eq(counts.merge_no_base, 1, "…and the outcome is still counted");
  }

  // 4. NO lineage at all (nobody looked) -> mint, exactly as before #653.
  {
    const { sqlite, env } = freshEnv();
    seed(sqlite);
    const counts = await applyTsvRows(env, BOOK, "tq", master(), null, { confirmedAt: 200, editId: null });
    eq(counts.merge_no_base_mint_skipped, 0, "a run that never looked skips nothing");
    const row = sqlite.prepare(`SELECT review_kind FROM tq_rows WHERE id='nb99'`).all()[0];
    eq(row.review_kind, "merge_no_base", "…and mints, which is today's behavior");
  }

  // 5. A content PATCH clears the snapshot along with the flag (#653 piece 4).
  {
    const { sqlite, env } = freshEnv();
    seed(sqlite);
    await applyTsvRows(env, BOOK, "tq", master(), null, { confirmedAt: 200, editId: null, lineage: HUMAN_LINEAGE });
    const before = sqlite.prepare(`SELECT review_master_json FROM tq_rows WHERE id='nb99'`).all()[0];
    eq(before.review_master_json !== null, true, "a snapshot is stored at the mint");
    // The REAL fragment rows.ts builds every versioned content PATCH from.
    sqlite
      .prepare(
        `UPDATE tq_rows SET question = ?1, ${contentPatchClearClauses("tq").join(", ")}, version = version + 1
          WHERE id = 'nb99' AND book = ?2`,
      )
      .run("the translator's next edit", BOOK);
    const after = sqlite.prepare(`SELECT review_kind, review_master_json FROM tq_rows WHERE id='nb99'`).all()[0];
    eq(after.review_kind, null, "the content edit clears the flag");
    eq(after.review_master_json, null, "…and the snapshot with it — a snapshot behind a NULL flag is invisible");
  }
}

console.log("\n[#653 x #664: a flag minted HERE emits real Door43 fields, and no bookkeeping, THERE]");
{
  // The seam between this PR and #664, exercised end to end rather than
  // asserted from either side: the nightly mints the snapshot (this branch
  // writes `_meta` bookkeeping inside the same column), the row is stored, and
  // the lint feed (#664, now on main) emits it as the UI's "Door43's row
  // value". If either side changed its mind about `_meta` the reader would see
  // `flag_since` rendered as a Door43 column that does not exist.
  const { sqlite, env } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 100, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, tags, version, updated_by)
       VALUES ('sx01', ?, 9, 9, '9:9', 'app question', 'r', NULL, 1, 1)`,
    )
    .run(BOOK);
  // No edit_log at all -> genuinely no ancestor -> keep_no_base -> a real mint
  // through the production path, snapshot and all.
  await applyTsvRows(
    env, BOOK, "tq",
    [{
      id: "sx01", idCoerced: false, refRaw: "9:9", chapter: 9, verse: 9,
      occurrence: null, tags: null, quote: null, question: "master question", response: "r",
    }],
    null, { confirmedAt: 200, editId: null, lineage: HUMAN_LINEAGE },
  );

  const stored = sqlite.prepare(`SELECT * FROM tq_rows WHERE id = 'sx01'`).all()[0];
  eq(stored.review_kind, "merge_no_base", "the nightly minted the flag");
  eq(
    typeof parseSnap(stored.review_master_json)._meta?.flag_since,
    "number",
    "…and the stored column DOES carry this branch's bookkeeping",
  );

  // Now through the REAL lint feed, the same call the API route makes.
  const issue = lintTqRows([stored]).find((x) => x.rowId === "sx01");
  eq(issue != null, true, "the lint feed surfaces the flag");
  eq(
    Object.keys(issue.door43).sort(),
    ["question", "ref_raw", "response", "tags"],
    "…and emits exactly the tq review fields as Door43's value",
  );
  eq("_meta" in issue.door43, false, "…with the bookkeeping stripped, never rendered as a Door43 field");
  eq(issue.door43.question, "master question", "…carrying master's real value");
  eq(issue.ours.question, "app question", "…against ours, for the side-by-side");
  eq(issue.dismissible, true, "…and it can be dismissed from the popup");
}

console.log("\n[#653: the auto-clear retires flags the commit history now disproves]");
{
  // Relative to NOW, not an absolute stamp: the clear refuses to walk a window
  // older than NO_BASE_CLEAR_MAX_WINDOW_SECONDS (30 days), so a hard-coded
  // timestamp would quietly start exercising the stale branch as the calendar
  // moved past it and every case below would pass for the wrong reason.
  const NOW = Math.floor(Date.now() / 1000);
  const MINT_AT = NOW - 3 * 86400;
  const FILE = { repo: "en_tq", path: "tq_1CH.tsv" };
  // FLAG_SINCE is the watermark the flag's claim is bounded by — written into
  // the snapshot at the mint, and the ONLY honest window start (see
  // masterReviewSnapshot). `updated_at` is deliberately seeded LATER than the
  // mint here, the way a reorder drag or a preserve toggle leaves it: those
  // paths move updated_at and leave review_kind standing, so anything keying
  // the window on updated_at would walk a range that starts after the human
  // commit it has to see.
  const FLAG_SINCE = MINT_AT - 7 * 86400;
  // Bookkeeping lives under `_meta` — #664 emits the rest of this object
  // verbatim as the lint feed's "Door43's row value", so a top-level flag_since
  // would render as a Door43 column that does not exist.
  const seedFlagged = (sqlite, n = 2, { snapshot } = {}) => {
    sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 100, 'translator')`).run();
    const snap =
      snapshot === undefined
        ? JSON.stringify({ question: "master q", _meta: { flag_at: MINT_AT, flag_since: FLAG_SINCE } })
        : snapshot;
    for (let i = 0; i < n; i++) {
      sqlite
        .prepare(
          `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, updated_by,
                                updated_at, review_kind, review_reason, review_master_json)
           VALUES (?, ?, 3, ?, ?, 'app question', 'r', 4, 1, ?, 'merge_no_base', 'some earlier reason', ?)`,
        )
        .run(`cl0${i}`, BOOK, i + 1, `3:${i + 1}`, MINT_AT + 5 * 86400, snap);
    }
  };

  // 1. Complete walk, human-free, reaching back past the flag's own window
  //    (walkStart <= flag_since) -> cleared, on the run's own walk, no refetch.
  {
    const { sqlite, env } = freshEnv();
    seedFlagged(sqlite);
    const cleared = await withFetch(sameTip(), () =>
      clearResolvedMergeNoBaseForTest(env, BOOK, "tq", FLAG_SINCE - 10, OURS_AND_AI_PAGE, FILE),
    );
    eq(cleared, 2, "both flags are retired");
    const rows = sqlite.prepare(`SELECT review_kind, review_reason, review_master_json, version FROM tq_rows`).all();
    eq(rows.map((r) => r.review_kind), [null, null], "review_kind cleared");
    eq(rows.map((r) => r.review_reason), [null, null], "…reason too");
    eq(rows.map((r) => r.review_master_json), [null, null], "…and the snapshot, which described the retired flag");
    eq(rows.map((r) => r.version), [4, 4], "…with NO version bump, so an open editor's If-Match still holds");

    // Every incident in this repo is reconstructed from edit_log. A warning
    // that disappears with only a console line behind it cannot be audited six
    // weeks later, so each clear writes its own row WITH its evidence.
    const logs = sqlite.prepare(`SELECT * FROM edit_log WHERE action = 'sync_clear_review' ORDER BY row_key`).all();
    eq(logs.length, 2, "one audit row per cleared flag");
    eq(logs[0].kind, "tq", "…on the row's own kind");
    eq(logs[0].book, BOOK, "…and book");
    const payload = JSON.parse(logs[0].payload_json);
    eq(payload.review_kind, "merge_no_base", "…naming the flag that was cleared");
    eq(payload.evidence.human, 0, "…and the measurement that justified it: zero human commits");
    eq(payload.evidence.window_start, FLAG_SINCE, "…over the window the flag itself was raised about");
    eq(typeof payload.review_master_json, "string", "…keeping the snapshot that is being dropped");
  }

  // 1b. The audit row is PAIRED with its clear (gatedLogEditStmt): a row whose
  //     UPDATE 0-changes must not leave an audit row claiming a clear that
  //     never happened. Simulated by a flag that changes to a stronger one
  //     between the SELECT and the batch — here, seeded that way from the
  //     start, so the id is in the list but the UPDATE cannot match.
  {
    const { sqlite, env } = freshEnv();
    seedFlagged(sqlite, 2);
    const realBatch = env.DB.batch.bind(env.DB);
    let flipped = false;
    env.DB.batch = async (stmts) => {
      if (!flipped) {
        flipped = true;
        sqlite.prepare(`UPDATE tq_rows SET review_kind='merge_conflict' WHERE id='cl00'`).run();
      }
      return realBatch(stmts);
    };
    const cleared = await withFetch(sameTip(), () =>
      clearResolvedMergeNoBaseForTest(env, BOOK, "tq", FLAG_SINCE - 10, OURS_AND_AI_PAGE, FILE),
    );
    eq(cleared, 1, "only the row that actually cleared is counted");
    const logs = sqlite.prepare(`SELECT row_key FROM edit_log WHERE action = 'sync_clear_review'`).all();
    eq(logs.map((l) => l.row_key), ["cl01"], "…and only it gets an audit row — no phantom audit for the lost race");
  }

  // 1c. A backlog larger than CLEAR_PAIR_BATCH (issue #705). Each clear travels
  //     as TWO statements (the UPDATE and its paired audit INSERT), so the slice
  //     must be half of WRITE_BATCH (45), not WRITE_BATCH itself — a 90-row
  //     slice would build a 180-statement batch, over D1's 100-per-batch cap,
  //     which throws and drops the whole slice (the flags stay standing). The
  //     node:sqlite harness does not enforce the cap, so assert the batch size
  //     directly: 60 clears must span >1 batch and no batch may exceed 100.
  {
    const { sqlite, env } = freshEnv();
    seedFlagged(sqlite, 60);
    const realBatch = env.DB.batch.bind(env.DB);
    let maxBatchStmts = 0;
    let batchCount = 0;
    env.DB.batch = async (stmts) => {
      maxBatchStmts = Math.max(maxBatchStmts, stmts.length);
      batchCount++;
      return realBatch(stmts);
    };
    const cleared = await withFetch(sameTip(), () =>
      clearResolvedMergeNoBaseForTest(env, BOOK, "tq", FLAG_SINCE - 10, OURS_AND_AI_PAGE, FILE),
    );
    eq(cleared, 60, "all 60 flags are retired across multiple slices");
    eq(batchCount > 1, true, "…the clear spanned more than one batch");
    eq(maxBatchStmts <= 100, true, "…and no batch exceeded D1's 100-statement cap");
    const standing = sqlite.prepare(`SELECT COUNT(*) AS n FROM tq_rows WHERE review_kind IS NOT NULL`).all()[0];
    eq(standing.n, 0, "no flag is left standing");
    const logs = sqlite.prepare(`SELECT COUNT(*) AS n FROM edit_log WHERE action = 'sync_clear_review'`).all()[0];
    eq(logs.n, 60, "…and every clear wrote its own audit row");
  }

  // 2. A human commit in the same window -> nothing is cleared. This is the
  //    guard that keeps the auto-clear from erasing a real warning.
  {
    const { sqlite, env } = freshEnv();
    seedFlagged(sqlite);
    const cleared = await clearResolvedMergeNoBaseForTest(env, BOOK, "tq", FLAG_SINCE - 10, HUMAN_PAGE, FILE);
    eq(cleared, 0, "a human commit in the window blocks the clear");
    const rows = sqlite.prepare(`SELECT review_kind FROM tq_rows`).all();
    eq(rows.map((r) => r.review_kind), ["merge_no_base", "merge_no_base"], "…the flags stand");
  }

  // 3. An INCOMPLETE walk -> nothing is cleared, whatever it did or did not see.
  {
    const { sqlite, env } = freshEnv();
    seedFlagged(sqlite);
    const cleared = await clearResolvedMergeNoBaseForTest(
      env, BOOK, "tq", FLAG_SINCE - 10,
      { commits: OURS_AND_AI_PAGE.commits, incomplete: true, incompleteReason: "page_cap" },
      FILE,
    );
    eq(cleared, 0, "'we could not read the history' is not 'no human touched it'");
  }

  // 4. The run's own walk starts AFTER the window the flag was raised over, so
  //    it cannot see a human commit sitting between the two. The clear must
  //    extend the walk rather than clear on evidence it does not have — and
  //    when that extended walk cannot be completed, nothing is cleared.
  {
    const { sqlite, env } = freshEnv();
    seedFlagged(sqlite);
    const realFetch = globalThis.fetch;
    let extended = 0;
    globalThis.fetch = async () => {
      extended++;
      throw new Error("network down");
    };
    try {
      const cleared = await clearResolvedMergeNoBaseForTest(env, BOOK, "tq", FLAG_SINCE + 5000, OURS_AND_AI_PAGE, FILE);
      eq(extended > 0, true, "an uncovered window forces a fresh walk instead of reusing the run's");
      eq(cleared, 0, "…and a walk that could not complete clears nothing");
    } finally {
      globalThis.fetch = realFetch;
    }
    const rows = sqlite.prepare(`SELECT review_kind FROM tq_rows`).all();
    eq(rows.map((r) => r.review_kind), ["merge_no_base", "merge_no_base"], "…the flags stand");
  }

  // 4b. THE REASON the window comes from the flag and not from the row: a
  //     reorder drag (rows.ts's non-versioning fast path) moves updated_at and
  //     leaves review_kind standing, so a June flag can carry an August
  //     timestamp. Here the run's walk covers everything since well after
  //     flag_since but well before updated_at — a window derived from
  //     updated_at would call that covered and clear on evidence that never
  //     included the flag's own range.
  {
    const { sqlite, env } = freshEnv();
    seedFlagged(sqlite);
    const realFetch = globalThis.fetch;
    let extended = 0;
    globalThis.fetch = async () => { extended++; throw new Error("network down"); };
    try {
      const cleared = await clearResolvedMergeNoBaseForTest(env, BOOK, "tq", MINT_AT + 86400, OURS_AND_AI_PAGE, FILE);
      eq(extended > 0, true, "a walk starting after flag_since is extended, however recent the row's updated_at");
      eq(cleared, 0, "…and nothing is cleared on the un-extended evidence");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // 4c. A flag carrying NO recorded window — every flag minted before #653,
  //     including the 79 standing in prod — is NOT cleared. Its range is
  //     unknown, and an absent measurement may not be laundered into a clean
  //     one. Those clear by hand instead.
  {
    const { sqlite, env } = freshEnv();
    seedFlagged(sqlite, 2, { snapshot: JSON.stringify({ question: "master q" }) });
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = async () => { called++; throw new Error("should not be called"); };
    try {
      const cleared = await clearResolvedMergeNoBaseForTest(env, BOOK, "tq", FLAG_SINCE - 10, OURS_AND_AI_PAGE, FILE);
      eq(cleared, 0, "a flag with no recorded window is left alone");
      eq(called, 0, "…and no walk is spent on it");
    } finally {
      globalThis.fetch = realFetch;
    }
    const rows = sqlite.prepare(`SELECT review_kind FROM tq_rows`).all();
    eq(rows.map((r) => r.review_kind), ["merge_no_base", "merge_no_base"], "…the flags stand");
  }

  // 4c2. A window-less flag must not RIDE ALONG on a neighbour's window. With
  //      one clearable flag in the same book, the walk happens anyway — and a
  //      legacy flag swept up by it would be cleared on evidence covering a
  //      range that has nothing to do with it.
  {
    const { sqlite, env } = freshEnv();
    seedFlagged(sqlite, 1); // cl00: carries _meta.flag_since
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, updated_by,
                              updated_at, review_kind, review_reason, review_master_json)
         VALUES ('lg01', ?, 3, 9, '3:9', 'app question', 'r', 4, 1, ?, 'merge_no_base', 'raised before #653', '{"question":"master q"}')`,
      )
      .run(BOOK, MINT_AT);
    const cleared = await withFetch(sameTip(), () =>
      clearResolvedMergeNoBaseForTest(env, BOOK, "tq", FLAG_SINCE - 10, OURS_AND_AI_PAGE, FILE),
    );
    eq(cleared, 1, "only the flag that carries its own window is retired");
    const rows = sqlite.prepare(`SELECT id, review_kind FROM tq_rows ORDER BY id`).all();
    eq(rows.map((r) => r.review_kind), [null, "merge_no_base"], "…the legacy flag stands, it did not ride along");
  }

  // 4d. A snapshot whose flag_since is not a usable number is the same absence
  //     — never a Number()-coerced 0, which would read as "walk from the epoch",
  //     the most permissive window there is.
  {
    const { sqlite, env } = freshEnv();
    seedFlagged(sqlite, 1, { snapshot: JSON.stringify({ _meta: { flag_since: null } }) });
    const cleared = await clearResolvedMergeNoBaseForTest(env, BOOK, "tq", FLAG_SINCE - 10, OURS_AND_AI_PAGE, FILE);
    eq(cleared, 0, "an explicit null window is absent, not epoch 0");
  }

  // 4e. A window older than the 30-day bound is not walked at all. flag_since
  //     is frozen while master_confirmed_at advances, so an unclearable flag's
  //     window widens by a day every day — and a widening walk eventually
  //     outgrows the page budget, goes permanently `page_cap`, and pays five
  //     Gitea fetches a night forever for an answer it can never reach.
  {
    const { sqlite, env } = freshEnv();
    seedFlagged(sqlite, 2, {
      snapshot: JSON.stringify({ question: "master q", _meta: { flag_since: NOW - 45 * 86400 } }),
    });
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = async () => { called++; throw new Error("should not be called"); };
    try {
      const cleared = await clearResolvedMergeNoBaseForTest(env, BOOK, "tq", NOW, OURS_AND_AI_PAGE, FILE);
      eq(cleared, 0, "a window past the bound clears nothing");
      eq(called, 0, "…and costs no Gitea fetch — it is left to the dismiss path");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // 4f. A BLOCKED attempt is memoized against master's tip sha, so the same
  //     unanswerable question is not re-bought every night for an unchanged
  //     file. This is the other half of "self-extinguishing".
  {
    const { sqlite, env } = freshEnv();
    seedFlagged(sqlite, 2);
    const first = await clearResolvedMergeNoBaseForTest(env, BOOK, "tq", FLAG_SINCE - 10, HUMAN_PAGE, FILE, "tip1");
    eq(first, 0, "the human commit blocks the clear");
    const memo = sqlite.prepare(`SELECT review_master_json FROM tq_rows ORDER BY id`).all();
    eq(
      memo.map((r) => parseSnap(r.review_master_json)._meta?.clear_blocked_sha),
      ["tip1", "tip1"],
      "…and the blocked attempt is recorded against the sha it was measured at",
    );
    eq(
      memo.map((r) => parseSnap(r.review_master_json).question),
      ["master q", "master q"],
      "…without disturbing the Door43 values the snapshot exists to hold",
    );

    // Same master tip on the next run: nothing walkable, so not one fetch.
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = async () => { called++; throw new Error("should not be called"); };
    try {
      const second = await clearResolvedMergeNoBaseForTest(env, BOOK, "tq", NOW, HUMAN_PAGE, FILE, "tip1");
      eq(second, 0, "still nothing cleared");
      eq(called, 0, "…and the memo means the re-walk is never paid for again");
    } finally {
      globalThis.fetch = realFetch;
    }

    // Master moves: the memo no longer applies and the question is asked again.
    const third = await withFetch(sameTip(), () =>
      clearResolvedMergeNoBaseForTest(env, BOOK, "tq", FLAG_SINCE - 10, OURS_AND_AI_PAGE, FILE, "tip2"),
    );
    eq(third, 2, "a new master tip re-opens the question, and the clean walk clears both");
  }

  // 5. Nothing flagged -> no walk, no write, no cost. This is what makes the
  //    feature self-extinguishing rather than a nightly Gitea walk forever.
  {
    const { sqlite, env } = freshEnv();
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, review_kind)
         VALUES ('ok01', ?, 3, 1, '3:1', 'q', 'r', NULL)`,
      )
      .run(BOOK);
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = async () => { called++; throw new Error("should not be called"); };
    try {
      const cleared = await clearResolvedMergeNoBaseForTest(env, BOOK, "tq", MINT_AT + 5000, OURS_AND_AI_PAGE, FILE);
      eq(cleared, 0, "nothing to clear");
      eq(called, 0, "…and not one Gitea fetch was spent finding that out");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // 6. A STRONGER flag is not collateral damage. The id list is built from a
  //    'merge_no_base' SELECT, so the statement's own re-assertion of that
  //    predicate is a RACE guard (a flag raised between the SELECT and the
  //    batch) and is not reachable from a single-process test — this case pins
  //    the selection instead, which is the half a test CAN observe.
  {
    const { sqlite, env } = freshEnv();
    seedFlagged(sqlite, 2);
    sqlite.prepare(`UPDATE tq_rows SET review_kind = 'merge_conflict' WHERE id = 'cl00'`).run();
    const cleared = await withFetch(sameTip(), () =>
      clearResolvedMergeNoBaseForTest(env, BOOK, "tq", FLAG_SINCE - 10, OURS_AND_AI_PAGE, FILE),
    );
    eq(cleared, 1, "only the merge_no_base row is retired");
    const rows = sqlite.prepare(`SELECT id, review_kind FROM tq_rows ORDER BY id`).all();
    eq(rows.map((r) => r.review_kind), ["merge_conflict", null], "…an unacknowledged merge_conflict stands");
  }
}

console.log("\n[issue #672: a torn row (ref_raw ahead of its own stored chapter/verse) self-heals]");
{
  // The shape rows.ts's cross-chapter REF retype produces: ref_raw already
  // shows the new reference, but chapter/verse are stuck at the pre-edit
  // values (that PATCH path deliberately never writes chapter on a
  // cross-chapter move — see rows.ts). Master has since caught up (the export
  // publishes ref_raw verbatim), so its incoming row is internally consistent
  // at the NEW reference with otherwise-identical content — exactly the
  // post-export state issue #672 describes as "permanent and silent" before
  // this fix, because #657 keyed classifyTsvRefMove on ref_raw alone and
  // ref_raw already agrees on both sides.
  const { sqlite, env } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 7007, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, updated_by, version)
       VALUES ('tn01', ?, 1, 5, '2:3', 'same note', 555, 7, 3)`,
    )
    .run(BOOK);
  const counts = await applyTsvRows(
    env, BOOK, "tn",
    [{ id: "tn01", idCoerced: false, refRaw: "2:3", chapter: 2, verse: 3, occurrence: null, tags: null, quote: null, note: "same note", support_reference: null }],
    null,
  );

  eq(counts.ref_healed, 1, "the torn row's chapter/verse are healed to match its own ref_raw");
  // The row is human-owned (updated_by set — the retype PATCH set it), so it
  // always takes the edited-candidate path, classified off its UNMUTATED
  // stored chapter/verse (never patched in memory ahead of classification).
  // Content otherwise converges with master, so nothing is adopted or
  // flagged — the heal is folded into what would otherwise have been an
  // empty write, so it takes the editedWrites success path rather than the
  // "nothing to write" skip (Codex re-review round 2 on PR #681: an earlier
  // version deferred this case, which the SHA-skip gate could leave torn
  // forever once master stopped moving).
  eq(counts.skipped_edited, 0, "NOT skipped — the heal IS the write, not a reason to skip one");
  eq(counts.skipped_noop, 0, "NOT a no-op either — classification runs off the unmutated, still-torn chapter/verse");

  const stored = sqlite.prepare(`SELECT chapter, verse, ref_raw, sort_order, version,
                                         last_change_action, last_change_source, last_change_actor
                                    FROM tn_rows WHERE id='tn01'`).all()[0];
  eq(stored.chapter, 2, "stored chapter now matches ref_raw's own chapter");
  eq(stored.verse, 3, "stored verse now matches ref_raw's own verse");
  eq(stored.ref_raw, "2:3", "ref_raw itself is untouched — only chapter/verse were corrected");
  eq(stored.sort_order, 555, "the in-app order is preserved, not reverted to master's file order (heal must not fight the reorder-preservation invariant)");
  eq(stored.version, 4, "version bumped by the heal write");
  // #686 provenance: a PURE heal must never read as a Door43 sync — nothing
  // Door43 held produced this correction.
  eq(stored.last_change_action, "ref_heal", "provenance action is the dedicated ref_heal, not sync_merge");
  eq(stored.last_change_source, "system", "…source is system, not dcs_sync");
  eq(stored.last_change_actor, null, "…and no Door43 commit author is credited for it");

  const log = sqlite.prepare(`SELECT action, source, payload_json FROM edit_log WHERE kind='tn' AND row_key='tn01'`).all();
  eq(log.length, 1, "exactly one edit_log entry — the heal, and nothing else (the row otherwise no-ops)");
  eq(log[0].action, "update", "logged as an update");
  const payload = JSON.parse(log[0].payload_json);
  eq(payload.chapter, 2, "…payload records the healed chapter");
  eq(payload.verse, 3, "…and verse");
}

console.log("\n[issue #672: the heal is independent of the row's content classification]");
{
  // Same tear, but this time content ALSO genuinely diverges from master and
  // there is no watermark (no ancestor) to attribute it. Nothing is adopted
  // (no ancestor to attribute the note difference against), so this is STILL
  // a pure heal write — D1's note stands, only chapter/verse move.
  const { sqlite, env } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 7007, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, updated_by, version)
       VALUES ('tn02', ?, 9, 9, '3:1', 'our note', 7, 5)`,
    )
    .run(BOOK);
  const counts = await applyTsvRows(
    env, BOOK, "tn",
    [{ id: "tn02", idCoerced: false, refRaw: "3:1", chapter: 3, verse: 1, occurrence: null, tags: null, quote: null, note: "their note", support_reference: null }],
    null,
  );

  eq(counts.ref_healed, 1, "still healed — the tear is unconditional, independent of what else diverges");
  eq(counts.skipped_edited, 0, "the heal write lands — nothing left to skip");

  const stored = sqlite.prepare(`SELECT chapter, verse, note, version FROM tn_rows WHERE id='tn02'`).all()[0];
  eq(stored.chapter, 3, "chapter healed to match ref_raw");
  eq(stored.verse, 1, "verse healed to match ref_raw");
  eq(stored.note, "our note", "the human's note is untouched — the heal never touches content, and nothing here adopted master's");
  eq(stored.version, 6, "version bumped exactly once, by the heal");

  const log = sqlite.prepare(`SELECT COUNT(*) AS n FROM edit_log WHERE kind='tn' AND row_key='tn02'`).all()[0];
  eq(log.n, 1, "only the heal's edit_log entry");
}

console.log("\n[issue #672: a torn row that ALSO adopts a genuine master field change heals in the SAME write]");
{
  // The convergence gap Codex re-review round 2 found: an earlier version of
  // this fix deferred the heal whenever the row had something else to write,
  // reasoning it would be revisited later — but a torn+adopting row can only
  // ever reach fate "edited" (never "update"/"update_ai", both of which
  // require isReimportableRow, and a torn row is always human-owned), so a
  // deferred heal had nothing else to land on, and the SHA-skip gate could
  // strand it. This pins the fix: the SAME write both adopts master's tags
  // (tn/tq have no tags UI, so master always wins there) AND heals the tear.
  const { sqlite, env } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 7007, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, tags, updated_by, version)
       VALUES ('tn04', ?, 1, 5, '2:3', 'same note', 'old-tag', 7, 3)`,
    )
    .run(BOOK);
  const counts = await applyTsvRows(
    env, BOOK, "tn",
    [{ id: "tn04", idCoerced: false, refRaw: "2:3", chapter: 2, verse: 3, occurrence: null, tags: "new-tag", quote: null, note: "same note", support_reference: null }],
    null,
  );

  eq(counts.ref_healed, 1, "healed in the same pass as the tags adoption — not deferred");
  eq(counts.merged_fields, 1, "the tags heuristic merge still fires independently");
  eq(counts.skipped_edited, 0, "nothing left to skip — one write did both jobs");

  const stored = sqlite.prepare(`SELECT chapter, verse, tags, version,
                                         last_change_action, last_change_source, last_change_actor
                                    FROM tn_rows WHERE id='tn04'`).all()[0];
  eq(stored.chapter, 2, "chapter healed");
  eq(stored.verse, 3, "verse healed");
  eq(stored.tags, "new-tag", "…and master's tags adopted, in the SAME write");
  eq(stored.version, 4, "exactly one version bump for both changes");
  // A MIXED write (adoption + heal) keeps the sync_merge stamp — the heal
  // rides along as a bonus correction, same as the heuristic tags merge does.
  eq(stored.last_change_action, "sync_merge", "a mixed write is NOT pureHeal — it keeps the sync_merge provenance");
  eq(stored.last_change_source, "dcs_sync", "…dcs_sync source, since master's tags genuinely were adopted");
}

console.log("\n[issue #672: an untorn row (ref_raw already agrees with its own chapter/verse) is left alone]");
{
  const { sqlite, env } = freshEnv();
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version)
       VALUES ('tq01', ?, 3, 1, '3:1', 'q', 'r', 3)`,
    )
    .run(BOOK);
  const counts = await applyTsvRows(
    env, BOOK, "tq",
    [{ id: "tq01", idCoerced: false, refRaw: "3:1", chapter: 3, verse: 1, occurrence: null, tags: null, quote: null, question: "q", response: "r" }],
    null,
  );
  eq(counts.ref_healed, 0, "nothing to heal — chapter/verse already match ref_raw");
  const stored = sqlite.prepare(`SELECT version FROM tq_rows WHERE id='tq01'`).all()[0];
  eq(stored.version, 3, "no spurious version bump");
}

// Wrap env.DB so the FIRST batch matching a PURE heal write's distinctive SQL
// shape (chapter/verse as the first two SET columns, nothing else) is
// preceded by an out-of-band write on the SAME row — exactly as a concurrent
// PATCH landing between applyTsvRows' initial `existing` read and this
// batched write would do. Same pattern as withReclaimRace above; drives a
// REAL CAS loss through the real function rather than hand-asserting what
// "should" happen.
function withHealRace(env, sqlite, table, id) {
  let fired = false;
  return {
    ...env,
    DB: {
      ...env.DB,
      async batch(stmts) {
        if (!fired && stmts.some((s) => s.sql.includes("chapter = ?1, verse = ?2, version = version + 1"))) {
          fired = true;
          sqlite
            .prepare(`UPDATE ${table} SET note = 'concurrent edit', version = version + 1 WHERE id = ?`)
            .run(id);
        }
        return env.DB.batch(stmts);
      },
    },
  };
}

console.log("\n[issue #672 (Codex review on PR #681): a concurrent PATCH landing before the heal batch is never clobbered]");
{
  // The exact hazard round 1 flagged: an EARLIER version of this fix
  // detected the tear up front and optimistically bumped an in-memory
  // `cur.version`, so if the heal's own write then lost its CAS to a
  // concurrent PATCH, a LATER write derived from that same stale `cur` could
  // coincidentally CAS-match the version the concurrent PATCH had advanced
  // to, silently overwriting it. This row has nothing else to write (content
  // already converged), so the fixed design's only write IS the heal itself
  // — proving the concurrent PATCH's content survives a lost heal CAS untouched.
  const { sqlite, env } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 7007, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, updated_by, version)
       VALUES ('tn03', ?, 1, 5, '2:3', 'original note', 7, 3)`,
    )
    .run(BOOK);
  const raced = withHealRace(env, sqlite, "tn_rows", "tn03");
  const counts = await applyTsvRows(
    raced, BOOK, "tn",
    [{ id: "tn03", idCoerced: false, refRaw: "2:3", chapter: 2, verse: 3, occurrence: null, tags: null, quote: null, note: "original note", support_reference: null }],
    null,
  );

  eq(counts.ref_healed, 0, "the heal LOST its version-CAS to the concurrent PATCH — must not count as healed");
  // Round 2 (Codex re-review): a lost heal must withhold the watermark, or a
  // book+resource whose master file stops moving could go permanently
  // un-retried by the SHA-skip gate — the same convergence hazard as
  // deferring, just reached through a lost race instead of a design choice.
  eq(counts.apply_incomplete, true, "a lost heal CAS withholds the watermark so tomorrow's run retries it");
  const stored = sqlite.prepare(`SELECT chapter, verse, note, version FROM tn_rows WHERE id='tn03'`).all()[0];
  eq(stored.chapter, 1, "chapter is STILL torn — the heal did not land this run (self-heals next run instead)");
  eq(stored.verse, 5, "verse is still torn too");
  eq(stored.note, "concurrent edit", "…and — the whole point — the concurrent PATCH's content survives, untouched by a phantom heal write");
  eq(stored.version, 4, "version reflects ONLY the concurrent PATCH's own bump, never a heal write layered on top of it");
}

console.log("\n[issue #672: a torn PROTECTED tn row is left torn, never healed, never withholds the watermark]");
{
  // Protection (trashed/preserve/hint) is baked into buildTsvEditedWriteStmt's
  // WHERE — a heal attempted there would 0-change EVERY run, not a transient
  // race, and (per the apply_incomplete handling above) would withhold this
  // resource's export watermark forever over a correction that can never
  // land. So the heal is skipped outright for a protected row instead.
  const { sqlite, env } = freshEnv();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 7007, 'translator')`).run();
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, updated_by, version, preserve)
       VALUES ('tn05', ?, 1, 5, '2:3', 'same note', 7, 3, 1)`,
    )
    .run(BOOK);
  const counts = await applyTsvRows(
    env, BOOK, "tn",
    [{ id: "tn05", idCoerced: false, refRaw: "2:3", chapter: 2, verse: 3, occurrence: null, tags: null, quote: null, note: "same note", support_reference: null }],
    null,
  );
  eq(counts.ref_healed, 0, "a protected row is never healed — the WHERE predicate would 0-change it every run");
  eq(counts.apply_incomplete, false, "…and this is a standing block, not a race, so it must NOT withhold the watermark");
  eq(counts.skipped_edited, 1, "falls through to the ordinary skipped_edited a protected row always takes");
  const stored = sqlite.prepare(`SELECT chapter, verse FROM tn_rows WHERE id='tn05'`).all()[0];
  eq(stored.chapter, 1, "left exactly as torn as before — no partial correction attempted");
  eq(stored.verse, 5, "…same for verse");
}

console.log("\n[#683: the sweep reaches books no run visits, and pre-#653 flags get a derived window]");
{
  // Same relative-to-NOW discipline as the #653 block: the 30-day bound must be
  // exercised on purpose, never drifted into by the calendar.
  const NOW = Math.floor(Date.now() / 1000);
  const MINT_AT = NOW - 5 * 86400;
  // The watermark the mint run's OWN lineage walk was bounded by, persisted in
  // book_resource_syncs.master_lineage_confirmed_at — what a post-#653 mint
  // would have written into the snapshot as flag_since.
  const WATERMARK = MINT_AT - 6 * 86400;
  const FILE = { repo: "en_tq", path: "tq_1CH.tsv" };

  // A pre-#653 flag: review_master_json NULL, because migration 0057's column
  // did not exist when it was minted. `updated_at` is seeded LATER than the
  // mint on purpose — that is what a reorder drag or a preserve toggle leaves
  // behind (rows.ts:815 / :1244 / :1317), and it is why the derivation may not
  // key on it.
  const seedLegacy = (sqlite, ids, book = BOOK) => {
    for (const id of ids) {
      sqlite
        .prepare(
          `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, updated_at,
                                review_kind, review_reason, review_master_json)
           VALUES (?, ?, 3, 1, '3:1', 'app question', 'r', 4, ?, 'merge_no_base', 'raised before #653', NULL)`,
        )
        .run(id, book, MINT_AT + 3 * 86400);
    }
  };
  // The mint's own edit_log row — the immutable mint time the derivation is
  // proved against. Shape and payload match logEditStmt's (bookReimport.ts:2668):
  // action 'update', payload = the merge write object verbatim.
  const seedMintLog = (sqlite, ids, at = MINT_AT, book = BOOK) => {
    for (const id of ids) {
      sqlite
        .prepare(
          `INSERT INTO edit_log (kind, row_key, book, action, payload_json, created_at)
           VALUES ('tq', ?, ?, 'update', ?, ?)`,
        )
        .run(id, book, JSON.stringify({ review_kind: "merge_no_base", review_reason: "raised before #653" }), at);
    }
  };
  // The mint run's own persisted lineage. `confirmedAt: null` is the REAL prod
  // shape for the backlog (migration 0058 postdates those flags, and their pairs
  // were never revisited to fill it), which is what tier 2 exists for.
  const CLEAN_VERDICT = { incomplete: false, hasHumanCommit: false, mayHoldHumanEdit: false };
  const seedLineage = (
    sqlite,
    { confirmedAt = WATERMARK, computedAt = MINT_AT - 60, sha = "tipA", book = BOOK, verdict = CLEAN_VERDICT } = {},
  ) => {
    sqlite
      .prepare(
        `INSERT INTO book_resource_syncs (book, resource, source_sha, origin, master_lineage_confirmed_at,
                                          master_lineage_computed_at, master_lineage_sha, master_lineage_json)
         VALUES (?, 'tq', 'sha0', 'reimport', ?, ?, ?, ?)`,
      )
      .run(book, confirmedAt, computedAt, sha, verdict === null ? null : JSON.stringify(verdict));
  };

  // (a) THE STRUCTURAL BUG. The clear lives inside loadMasterLineage, which the
  //     nightly reaches only for a (book, resource) whose master file moved — so
  //     AMO and ECC, quiet since the runs that flagged them, were never revisited
  //     and their flags could not heal. The sweep finds them by asking which
  //     books still carry a flag, and clears on its own walk.
  {
    const { sqlite, env } = freshEnv();
    seedLegacy(sqlite, ["sw00", "sw01"]);
    seedMintLog(sqlite, ["sw00", "sw01"]);
    seedLineage(sqlite);
    const realFetch = globalThis.fetch;
    globalThis.fetch = giteaPage(OURS_AND_AI_PAGE.commits);
    let result;
    try {
      result = await sweepStaleMergeNoBase(env);
    } finally {
      globalThis.fetch = realFetch;
    }
    eq(result.cleared, 2, "a flagged book the run never visited is swept and cleared");
    eq(result.swept, 1, "…one (book, kind) pair held flags");
    const rows = sqlite.prepare(`SELECT review_kind, review_reason, version FROM tq_rows ORDER BY id`).all();
    eq(rows.map((r) => r.review_kind), [null, null], "…the flags are retired");
    eq(rows.map((r) => r.version), [4, 4], "…with no version bump, so an open editor's If-Match still holds");
    const logs = sqlite.prepare(`SELECT * FROM edit_log WHERE action = 'sync_clear_review' ORDER BY row_key`).all();
    eq(logs.length, 2, "one audit row per cleared flag, exactly as the visited path writes");
    const payload = JSON.parse(logs[0].payload_json);
    eq(payload.evidence.window_start, WATERMARK, "…over the mint run's own watermark, not the row's updated_at");
    eq(payload.evidence.human, 0, "…with the measurement that justified it");
    eq(payload.evidence.derived_windows, 2, "…and the audit says the window was derived, not carried by the flag");
    eq(payload.evidence.window_tier, "confirmed_at", "…naming which evidence tier supplied that window");
  }

  // (a2) TIER 2, and the shape the prod backlog is ACTUALLY in: measured
  //      read-only on 2026-09-01, all three stuck pairs (AMO tn, AMO tq, ECC tq)
  //      have master_lineage_confirmed_at NULL — migration 0058 added that
  //      column after they were flagged, and it only fills on a later visit,
  //      which is exactly what never happened. So tier 1 can never arrive for
  //      them. Tier 2 walks from master_lineage_computed_at instead, admitted by
  //      the mint run's own clean verdict covering everything older than it.
  {
    const { sqlite, env } = freshEnv();
    seedLegacy(sqlite, ["sw00"]);
    seedMintLog(sqlite, ["sw00"]);
    seedLineage(sqlite, { confirmedAt: null });
    const realFetch = globalThis.fetch;
    globalThis.fetch = giteaPage(OURS_AND_AI_PAGE.commits);
    let result;
    try {
      result = await sweepStaleMergeNoBase(env);
    } finally {
      globalThis.fetch = realFetch;
    }
    eq(result.cleared, 1, "a pre-0058 pair with no recorded watermark still clears on its own clean verdict");
    const payload = JSON.parse(
      sqlite.prepare(`SELECT payload_json FROM edit_log WHERE action = 'sync_clear_review'`).all()[0].payload_json,
    );
    eq(payload.evidence.window_tier, "computed_at_clean", "…and the audit names the weaker tier it rested on");
    eq(
      payload.evidence.window_start,
      MINT_AT - 60 - 86400,
      "…walking from a day BEFORE that verdict's stamp, so the seam between its fetch and its persist is covered",
    );
    eq(payload.evidence.window_tier, "computed_at_clean", "…and the tier is recorded per row");
  }

  // (a3) Tier 2 refuses every verdict that is not clean on all three axes. An
  //      incomplete walk, a human commit found, and "nobody looked"
  //      (mayHoldHumanEdit true) each leave the older half of the flag's range
  //      unmeasured — and the stored verdict is the ONLY thing covering that
  //      half, so a defect there is not recoverable by the fresh walk. A
  //      verdict missing a field, or absent entirely, is the same absence: never
  //      `!undefined` read as "measured false".
  for (const [label, verdict] of [
    ["a human commit was found", { incomplete: false, hasHumanCommit: true, mayHoldHumanEdit: true }],
    ["the walk was incomplete", { incomplete: true, hasHumanCommit: false, mayHoldHumanEdit: true }],
    ["nobody could rule a human out", { incomplete: false, hasHumanCommit: false, mayHoldHumanEdit: true }],
    ["a field is missing from the verdict", { incomplete: false, hasHumanCommit: false }],
    ["there is no stored verdict at all", null],
  ]) {
    const { sqlite, env } = freshEnv();
    seedLegacy(sqlite, ["sw00"]);
    seedMintLog(sqlite, ["sw00"]);
    seedLineage(sqlite, { confirmedAt: null, verdict });
    const realFetch = globalThis.fetch;
    let called = 0;
    // A walk that WOULD succeed, so an ablated verdict check shows up as a
    // false clear rather than as a wasted fetch.
    globalThis.fetch = async (...a) => { called++; return giteaPage(OURS_AND_AI_PAGE.commits)(...a); };
    try {
      const result = await sweepStaleMergeNoBase(env);
      eq(result.cleared, 0, `tier 2 refuses a verdict where ${label}`);
      eq(called, 0, `…and spends no walk on it (${label})`);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // (a4) Tier 2 is still bound by the SAME inequality as tier 1: a lineage
  //      computed after the mint is not the mint run's measurement, so its
  //      verdict says nothing about the flag's own range however clean it is.
  {
    const { sqlite, env } = freshEnv();
    seedLegacy(sqlite, ["sw00"]);
    seedMintLog(sqlite, ["sw00"]);
    seedLineage(sqlite, { confirmedAt: null, computedAt: MINT_AT + 60 });
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = async (...a) => { called++; return giteaPage(OURS_AND_AI_PAGE.commits)(...a); };
    try {
      const result = await sweepStaleMergeNoBase(env);
      eq(result.cleared, 0, "a clean verdict computed AFTER the mint cannot supply the window either");
      eq(called, 0, "…and costs no Gitea fetch");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // (b) The derivation in isolation: a NULL-review_master_json flag inside the
  //     30-day bound clears on a complete, human-free walk.
  {
    const { sqlite, env } = freshEnv();
    seedLegacy(sqlite, ["sw00", "sw01"]);
    seedMintLog(sqlite, ["sw00", "sw01"]);
    const cleared = await withFetch(sameTip(), () =>
      clearResolvedMergeNoBaseForTest(
        env, BOOK, "tq", WATERMARK - 10, OURS_AND_AI_PAGE, FILE, "tipA",
        { windowStart: WATERMARK, computedAt: MINT_AT - 60, tier: "confirmed_at" },
      ),
    );
    eq(cleared, 2, "a pre-#653 flag with a derived window clears on complete human=0 evidence");
  }

  // (b2) …and WITHOUT a fallback it still does not, so the visited path's
  //      behavior is unchanged: only the sweep may derive a window.
  {
    const { sqlite, env } = freshEnv();
    seedLegacy(sqlite, ["sw00"]);
    seedMintLog(sqlite, ["sw00"]);
    const cleared = await withFetch(sameTip(), () =>
      clearResolvedMergeNoBaseForTest(env, BOOK, "tq", WATERMARK - 10, OURS_AND_AI_PAGE, FILE, "tipA"),
    );
    eq(cleared, 0, "no fallback offered means no window — #665's behavior, untouched");
  }

  // (c) THE INEQUALITY THE DERIVATION RESTS ON. A lineage computed AFTER the
  //     mint is not the mint's evidence: the watermark may have advanced past
  //     the flag's own, so a walk from it can miss the very commit the flag is
  //     about. Refused, and not one fetch spent on it.
  {
    const { sqlite, env } = freshEnv();
    seedLegacy(sqlite, ["sw00"]);
    seedMintLog(sqlite, ["sw00"]);
    seedLineage(sqlite, { computedAt: MINT_AT + 60 });
    const realFetch = globalThis.fetch;
    let called = 0;
    // A walk that WOULD succeed, so ablating the inequality shows up as a false
    // clear rather than merely as a wasted fetch.
    globalThis.fetch = async (...a) => { called++; return giteaPage(OURS_AND_AI_PAGE.commits)(...a); };
    try {
      const result = await sweepStaleMergeNoBase(env);
      eq(result.cleared, 0, "a lineage newer than the mint cannot supply the mint's window");
      eq(called, 0, "…and costs no Gitea fetch");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // (c2) No mint log — a lost log batch, or a mint older than edit_log's
  //      180-day retention — means no immutable mint time, so nothing can be
  //      proved and the flag keeps the dismiss path.
  {
    const { sqlite, env } = freshEnv();
    seedLegacy(sqlite, ["sw00"]);
    seedLineage(sqlite);
    const realFetch = globalThis.fetch;
    let called = 0;
    // Likewise a succeeding walk: without the mint record the flag must stand
    // even when the history is clean, because its range is unknown.
    globalThis.fetch = async (...a) => { called++; return giteaPage(OURS_AND_AI_PAGE.commits)(...a); };
    try {
      const result = await sweepStaleMergeNoBase(env);
      eq(result.cleared, 0, "no mint record means no window, exactly as before");
      eq(called, 0, "…and no walk is spent on it");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // (d) A human commit in the derived window blocks the clear, and the blocked
  //     attempt is MEMOIZED — on a row that has no snapshot to annotate, so the
  //     memo container is synthesized. Without that, the sweep would re-buy this
  //     same answer every night for exactly the flags it exists to serve.
  {
    const { sqlite, env } = freshEnv();
    seedLegacy(sqlite, ["sw00", "sw01"]);
    seedMintLog(sqlite, ["sw00", "sw01"]);
    seedLineage(sqlite);
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = async (...a) => { called++; return giteaPage(HUMAN_PAGE.commits)(...a); };
    try {
      const first = await sweepStaleMergeNoBase(env);
      eq(first.cleared, 0, "a human commit in the derived window blocks the clear");
      eq(called > 0, true, "…the walk was actually paid for once");
      const memo = sqlite.prepare(`SELECT review_master_json FROM tq_rows ORDER BY id`).all();
      eq(
        memo.map((r) => parseSnap(r.review_master_json)._meta?.clear_blocked_sha),
        ["aaa1", "aaa1"],
        "…recorded against the tip the sweep PROBED, not the pair's frozen stored sha",
      );
      eq(
        memo.map((r) => Object.keys(parseSnap(r.review_master_json)).filter((k) => k !== "_meta").length),
        [0, 0],
        "…which invents no Door43 field values, because none were ever captured",
      );
      called = 0;
      const second = await sweepStaleMergeNoBase(env);
      eq(second.cleared, 0, "the next night still clears nothing");
      eq(called, 1, "…and costs ONE probe instead of the walk — the memo answered from master's unchanged tip");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // (d3) THE MEMO MUST SELF-INVALIDATE (Codex F3). Night one is blocked and
  //      memoizes. Night two, master has MOVED — so the memo is about a tip that
  //      no longer exists and must not suppress the re-walk. This is the case a
  //      stored-sha memo key gets wrong: an unvisited pair never refreshes
  //      master_lineage_sha, so the key would still match and the pair would
  //      stay skipped forever, however much Door43 changed.
  {
    const { sqlite, env } = freshEnv();
    seedLegacy(sqlite, ["sw00"]);
    seedMintLog(sqlite, ["sw00"]);
    seedLineage(sqlite);
    // Night one: a human commit in the window blocks it, memo keyed to aaa1.
    await withFetch(giteaPage(HUMAN_PAGE.commits), () => sweepStaleMergeNoBase(env));
    eq(
      parseSnap(sqlite.prepare(`SELECT review_master_json FROM tq_rows`).all()[0].review_master_json)._meta
        ?.clear_blocked_sha,
      "aaa1",
      "night one memoizes against the tip it probed",
    );
    // Night two: master's tip is new9 and the history is now clean.
    const movedOn = [
      { sha: "new9", message: "bible-editor: 1CH tq → master (#7002)", authorEmail: "someone@example.com", authorName: "Someone", date: "2026-08-31T00:00:00Z" },
      ...OURS_AND_AI_PAGE.commits,
    ];
    const second = await withFetch(giteaPage(movedOn), () => sweepStaleMergeNoBase(env));
    eq(second.cleared, 1, "a moved master tip re-opens the question instead of being skipped by a stale memo");
  }

  // (d2) An INCOMPLETE walk clears nothing either — "we could not read the
  //      history" is not "no human touched it" — and memoizes the same way.
  {
    const { sqlite, env } = freshEnv();
    seedLegacy(sqlite, ["sw00"]);
    seedMintLog(sqlite, ["sw00"]);
    seedLineage(sqlite);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("network down"); };
    try {
      const result = await sweepStaleMergeNoBase(env);
      eq(result.cleared, 0, "an incomplete walk clears no derived-window flag");
    } finally {
      globalThis.fetch = realFetch;
    }
    const row = sqlite.prepare(`SELECT review_kind, review_master_json FROM tq_rows`).all()[0];
    eq(row.review_kind, "merge_no_base", "…the flag stands");
    eq(
      parseSnap(row.review_master_json)._meta?.clear_blocked_sha ?? null,
      null,
      "…and nothing is memoized, because a night that could not read master's tip has no key to memoize against",
    );
  }

  // (e) The 30-day bound applies to a derived window exactly as it does to a
  //     recorded one: measured on the watermark, because that is the far end of
  //     the range a walk would have to cover.
  {
    const { sqlite, env } = freshEnv();
    seedLegacy(sqlite, ["sw00"]);
    seedMintLog(sqlite, ["sw00"]);
    seedLineage(sqlite, { confirmedAt: NOW - 45 * 86400 });
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = async () => { called++; throw new Error("should not be called"); };
    try {
      const result = await sweepStaleMergeNoBase(env);
      eq(result.cleared, 0, "a pre-#653 flag whose window is past the bound is skipped");
      eq(called, 0, "…and costs no Gitea fetch — it is left to the dismiss path");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // (f) THE BUDGET CAP. The nightly has already died once on Cloudflare's
  //     subrequest limit, so one sweep hands at most NO_BASE_SWEEP_MAX_PAIRS
  //     (10) pairs to the clear however many books hold flags. Every book here
  //     is walkable, so the number of pairs that reached a walk is exactly the
  //     number of first-page fetches.
  {
    const { sqlite, env } = freshEnv();
    const books = ["1CH", "2CH", "AMO", "DAN", "ECC", "EZK", "HAB", "HOS", "ISA", "JER", "JOB", "JOL", "JON", "LAM", "MIC"];
    for (const b of books) {
      seedLegacy(sqlite, [`sw_${b}`], b);
      seedMintLog(sqlite, [`sw_${b}`], MINT_AT, b);
      seedLineage(sqlite, { book: b });
    }
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = async () => { called++; throw new Error("network down"); };
    try {
      const result = await sweepStaleMergeNoBase(env);
      eq(result.pairs, 15, "every flagged pair is found…");
      eq(result.swept, 10, "…but only the night's ration is handed to the clear");
      eq(called, 20, "…so the Gitea budget is bounded too: one tip probe plus one walk per rationed pair");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // (f2) THE ROTATION GUARANTEE, not just the cap. The offset advances by a
  //      whole CAP per day, so two consecutive nights cover every one of 15
  //      flagged pairs. Advancing by ONE pair per day (the first version) leaves
  //      the pair just past the cap waiting ~N-CAP nights — long enough to age
  //      past the 30-day walk bound before anything ever examines it. Driven by
  //      stubbing Date.now to two adjacent days, which is the only way to
  //      observe a per-day rotation inside one test run.
  {
    const books = ["1CH", "2CH", "AMO", "DAN", "ECC", "EZK", "HAB", "HOS", "ISA", "JER", "JOB", "JOL", "JON", "LAM", "MIC"];
    const day = Math.floor(Date.now() / 1000 / 86400);
    const touched = new Set();
    for (const d of [day, day + 1]) {
      const { sqlite, env } = freshEnv();
      for (const b of books) {
        seedLegacy(sqlite, [`sw_${b}`], b);
        seedMintLog(sqlite, [`sw_${b}`], MINT_AT, b);
        seedLineage(sqlite, { book: b });
      }
      const realNow = Date.now;
      // Mid-day on day `d`, so every seeded window stays inside the 30-day bound.
      Date.now = () => (d * 86400 + 3600) * 1000;
      try {
        // The URL names the file, which names the book — the observation channel
        // for "which pairs did this night actually examine".
        const result = await withFetch(
          async (url) => {
            const m = /tq_([A-Z0-9]+)\.tsv/.exec(String(url));
            if (m) touched.add(m[1]);
            throw new Error("network down");
          },
          () => sweepStaleMergeNoBase(env),
        );
        eq(result.swept, 10, `night ${d === day ? "one" : "two"} hands the clear exactly one ration`);
      } finally {
        Date.now = realNow;
      }
    }
    eq(
      [...touched].sort(),
      [...books].sort(),
      "…and two consecutive nights between them examine every flagged pair, so none can age out unexamined",
    );
  }

  // (g) THE WALK'S EVIDENCE MUST STILL HOLD AT THE WRITE (Codex P0). A human
  //     pushes to Door43 after the walk and before the D1 batch. Nothing in D1
  //     changed, so the UPDATE's own `review_kind = 'merge_no_base'` re-assertion
  //     cannot catch it, and the flag is not re-minted in the meantime (the mint
  //     is guarded on review_kind == null and this row still carries one) — so a
  //     stale clear would erase the only warning covering that edit, and the next
  //     export would write over it. The pre-write tip recheck is what stops that.
  {
    const { sqlite, env } = freshEnv();
    seedLegacy(sqlite, ["sw00", "sw01"]);
    seedMintLog(sqlite, ["sw00", "sw01"]);
    const moved = [
      { sha: "zzz9", message: "Fixes a typo in 1CH 3:2", authorEmail: "maintainer@example.com", authorName: "Maintainer", date: "2026-08-30T00:00:00Z" },
      ...OURS_AND_AI_PAGE.commits,
    ];
    const cleared = await withFetch(giteaPage(moved), () =>
      clearResolvedMergeNoBaseForTest(
        env, BOOK, "tq", WATERMARK - 10, OURS_AND_AI_PAGE, FILE, "tipA",
        { windowStart: WATERMARK, computedAt: MINT_AT - 60, tier: "confirmed_at" },
      ),
    );
    eq(cleared, 0, "master moving between the walk and the write abandons the clear");
    const rows = sqlite.prepare(`SELECT review_kind, review_master_json FROM tq_rows ORDER BY id`).all();
    eq(rows.map((r) => r.review_kind), ["merge_no_base", "merge_no_base"], "…the flags stand");
    eq(
      rows.map((r) => parseSnap(r.review_master_json)._meta?.clear_blocked_sha ?? null),
      [null, null],
      "…and nothing is memoized: a tip that just moved is the opposite of 'the answer cannot have changed'",
    );
  }

  // (g2) An unreadable recheck fails the same way. "We could not confirm master
  //      is where the walk left it" is not "it is" — the same fail-safe the
  //      incomplete-walk branch already applies.
  {
    const { sqlite, env } = freshEnv();
    seedLegacy(sqlite, ["sw00"]);
    seedMintLog(sqlite, ["sw00"]);
    const cleared = await withFetch(async () => { throw new Error("network down"); }, () =>
      clearResolvedMergeNoBaseForTest(
        env, BOOK, "tq", WATERMARK - 10, OURS_AND_AI_PAGE, FILE, "tipA",
        { windowStart: WATERMARK, computedAt: MINT_AT - 60, tier: "confirmed_at" },
      ),
    );
    eq(cleared, 0, "a tip that cannot be re-read abandons the clear");
    eq(
      sqlite.prepare(`SELECT review_kind FROM tq_rows`).all()[0].review_kind,
      "merge_no_base",
      "…the flag stands",
    );
  }

  // (g3) The unreadable-recheck branch carries its own weight only when the
  //      walk's tip is ITSELF null — a legitimate "nothing has touched this file
  //      since the window" walk. Then a failed recheck also reads as null, the
  //      tips compare equal, and without this branch the clear would proceed on
  //      a recheck that never happened. (When the walk has a tip, the moved-tip
  //      comparison already catches a failed recheck, so this case is what makes
  //      the guard non-redundant.)
  {
    const { sqlite, env } = freshEnv();
    seedLegacy(sqlite, ["sw00"]);
    seedMintLog(sqlite, ["sw00"]);
    const emptyWalk = { commits: [], incomplete: false, incompleteReason: "" };
    const cleared = await withFetch(async () => { throw new Error("network down"); }, () =>
      clearResolvedMergeNoBaseForTest(
        env, BOOK, "tq", WATERMARK - 10, emptyWalk, FILE, "tipA",
        { windowStart: WATERMARK, computedAt: MINT_AT - 60, tier: "confirmed_at" },
      ),
    );
    eq(cleared, 0, "a tipless walk plus an unreadable recheck clears nothing — absence of evidence is not evidence");
    eq(
      sqlite.prepare(`SELECT review_kind FROM tq_rows`).all()[0].review_kind,
      "merge_no_base",
      "…the flag stands",
    );
  }

  // (h) EQUALITY IS A REFUSAL (Codex P1). Both stamps are unix seconds, so
  //     computed_at == mint_at is equally consistent with the mint run's own
  //     walk and with a LATER run that re-walked inside that same second — and
  //     only the second reading is unsafe. Refused in both tiers. The measured
  //     backlog clears the strict bar with 2-12 seconds of margin, so this costs
  //     nothing real.
  for (const [label, lineage] of [
    ["tier 1", { computedAt: MINT_AT }],
    ["tier 2", { confirmedAt: null, computedAt: MINT_AT }],
  ]) {
    const { sqlite, env } = freshEnv();
    seedLegacy(sqlite, ["sw00"]);
    seedMintLog(sqlite, ["sw00"], MINT_AT);
    seedLineage(sqlite, lineage);
    const result = await withFetch(sameTip(), () => sweepStaleMergeNoBase(env));
    eq(result.cleared, 0, `a lineage computed in the SAME SECOND as the mint is ambiguous, so ${label} refuses it`);
  }

  // (i2) A MIXED PAIR, which is what makes the audit's tier field per-row
  //      (Codex F5). One flag carries its own recorded window, one is pre-#653
  //      and gets a derived one; they clear in the same batch on the same walk.
  //      A single shared `window_tier` would tell a future incident reader that
  //      the row with a real snapshot rested on a derivation it never used, and
  //      `derived_windows` would over-count the same way.
  {
    const { sqlite, env } = freshEnv();
    // Its own window, in the snapshot, exactly as a post-#653 mint writes it.
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, updated_at,
                              review_kind, review_reason, review_master_json)
         VALUES ('own0', ?, 3, 4, '3:4', 'app question', 'r', 4, ?, 'merge_no_base', 'raised after #653', ?)`,
      )
      .run(BOOK, MINT_AT, JSON.stringify({ question: "master q", _meta: { flag_at: MINT_AT, flag_since: WATERMARK } }));
    seedLegacy(sqlite, ["zz01"]); // pre-#653: no snapshot at all
    seedMintLog(sqlite, ["zz01"]);
    seedLineage(sqlite, { confirmedAt: null }); // tier 2, the real prod shape
    const result = await withFetch(sameTip(), () => sweepStaleMergeNoBase(env));
    eq(result.cleared, 2, "both flags clear on the one walk");
    const logs = sqlite
      .prepare(`SELECT row_key, payload_json FROM edit_log WHERE action = 'sync_clear_review' ORDER BY row_key`)
      .all();
    eq(
      logs.map((l) => JSON.parse(l.payload_json).evidence.window_tier),
      ["flag_since", "computed_at_clean"],
      "…and each audit row names the evidence THAT row's window actually came from",
    );
    eq(
      JSON.parse(logs[0].payload_json).evidence.derived_windows,
      1,
      "…with derived_windows counting only the row that needed a derivation",
    );
  }

  // (i3) `derived_windows` counts derivations USED, not derivations attempted
  //      (Codex F5). Two pre-#653 flags in one pair: one already memoized
  //      against the tip this run probes, so it is skipped before any walk; the
  //      other clears. Counting in the first pass — before the staleness and
  //      memo filters — would report two derivations where one row was never
  //      examined at all.
  {
    const { sqlite, env } = freshEnv();
    seedLegacy(sqlite, ["mm00", "mm01"]);
    seedMintLog(sqlite, ["mm00", "mm01"]);
    seedLineage(sqlite, { confirmedAt: null });
    // mm00 already carries a memo for aaa1, the tip the probe will return.
    sqlite
      .prepare(`UPDATE tq_rows SET review_master_json = ? WHERE id = 'mm00'`)
      .run(JSON.stringify({ _meta: { clear_blocked_sha: "aaa1" } }));
    const result = await withFetch(sameTip(), () => sweepStaleMergeNoBase(env));
    eq(result.cleared, 1, "the memoized flag is skipped; the other clears");
    const logs = sqlite
      .prepare(`SELECT row_key, payload_json FROM edit_log WHERE action = 'sync_clear_review'`)
      .all();
    eq(logs.map((l) => l.row_key), ["mm01"], "…and only the cleared row gets an audit row");
    eq(
      JSON.parse(logs[0].payload_json).evidence.derived_windows,
      1,
      "…with derived_windows counting the one derivation that was actually used",
    );
  }

  // (j) D1's BOUND-PARAM CAP on the mint lookup (Codex F2). The statement binds
  //     kind + book + one param per id, so a chunk of 100 ids is 102 params —
  //     over D1's limit of 100. In prod that throws, mintTimesFromEditLog
  //     returns an empty map, and the pair silently loses its derivation
  //     entirely. node:sqlite's own limit is ~32k, so the throw cannot be
  //     reproduced here; the bound-param COUNT is asserted instead, which is the
  //     property that has to hold. A book with more flags than one chunk also
  //     pins that chunking works at all.
  {
    const { sqlite, env } = freshEnv();
    const ids = Array.from({ length: 105 }, (_, i) => `bp${String(i).padStart(3, "0")}`);
    seedLegacy(sqlite, ids);
    seedMintLog(sqlite, ids);
    seedLineage(sqlite);
    const bindCounts = [];
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql) => {
      const st = realPrepare(sql);
      if (sql.includes("MIN(created_at)")) {
        const realBind = st.bind.bind(st);
        st.bind = (...a) => {
          bindCounts.push(a.length);
          return realBind(...a);
        };
      }
      return st;
    };
    const result = await withFetch(sameTip(), () => sweepStaleMergeNoBase(env));
    eq(result.cleared, 105, "a book with more flags than one chunk still clears every one of them");
    eq(bindCounts.length, 2, "…the mint lookup is chunked rather than issued as one huge statement");
    eq(
      bindCounts.every((n) => n <= 100),
      true,
      `…and no chunk exceeds D1's 100-bound-param cap (largest was ${Math.max(...bindCounts)})`,
    );
  }

  // (i) Nothing flagged anywhere -> three indexed reads and no walk. The steady
  //     state this is designed for.
  {
    const { sqlite, env } = freshEnv();
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, review_kind)
         VALUES ('ok01', ?, 3, 1, '3:1', 'q', 'r', NULL)`,
      )
      .run(BOOK);
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = async () => { called++; throw new Error("should not be called"); };
    try {
      const result = await sweepStaleMergeNoBase(env);
      eq(result, { pairs: 0, swept: 0, cleared: 0 }, "no flags anywhere means nothing to sweep");
      eq(called, 0, "…and not one Gitea fetch was spent finding that out");
    } finally {
      globalThis.fetch = realFetch;
    }
  }
}

console.log("\n[own-publish decline accounting: measured at the merge commit, real SQL, mocked Gitea]");
{
  // PROD SHAPE (JER tq, 2026-09-01/02): our nightly push merges at ~05:40Z, the
  // bp-assistant bot pushes a chapter on top in the evening, and the next
  // morning's byte comparison declines. The blind counter had reached 3 and raised
  // the "cannot tell them apart" banner. Here the same night is measured.
  const READ_AT = Date.parse("2026-09-01T05:31:00Z") / 1000;
  const PUSHED = "ba421e896eab0000000000000000000000000000";
  const OUR_MERGE = { sha: "22d652732b18", message: "bible-editor: JER tq → master (#859)", authorEmail: "b@x", authorName: "Benjamin Wright", date: "2026-09-01T05:38:03Z" };
  const BOT_PUSH = { sha: "863fbfa65119", message: "TQ: JER 10 [ju..7@api.bp-assistant]", authorEmail: "bot@bp-assistant", authorName: "BW Bot", date: "2026-09-01T23:49:46Z" };
  const FILE = { repo: "en_tq", path: `tq_${BOOK}.tsv` };
  const SOURCE = `own_publish_inert:${BOOK}:tq`;
  // The export's own record of the push: pushed_blob_sha/read_at and the PR it
  // opened for that render (pushed_pr_number, 0061), all on the sync row.
  const seedSync = (sqlite, declines, { prNumber = 859, prReadAt = READ_AT } = {}) => {
    sqlite
      .prepare(
        `INSERT INTO book_resource_syncs (book, resource, source_sha, origin, pushed_blob_sha, pushed_read_at, own_publish_declines, pushed_pr_number, pushed_pr_read_at)
         VALUES (?, 'tq', 'sha0', 'reimport', ?, ?, ?, ?, ?)`,
      )
      .run(BOOK, PUSHED, READ_AT, declines, prNumber, prNumber == null ? null : prReadAt);
    return { sourceSha: "sha0", syncedAt: null, pushedBlobSha: PUSHED, pushedReadAt: READ_AT, pushedEditId: null, declines };
  };
  const seedBanner = (sqlite) =>
    sqlite
      .prepare(`INSERT INTO system_alerts (username, severity, source, message) VALUES ('deferredreward', 'warning', ?, 'old blind banner')`)
      .run(SOURCE);
  const readState = (sqlite) => ({
    declines: sqlite.prepare(`SELECT own_publish_declines AS d FROM book_resource_syncs WHERE book = ? AND resource = 'tq'`).get(BOOK).d,
    banners: sqlite.prepare(`SELECT message FROM system_alerts WHERE source = ? AND dismissed_at IS NULL`).all(SOURCE),
  });
  // A Gitea that serves the commit walk AND the merge commit's tree, counting each.
  const gitea = (commits, blobAtMerge) => {
    const calls = { commits: 0, trees: 0 };
    const fetchImpl = async (url) => {
      if (String(url).includes("/git/trees/")) {
        calls.trees++;
        return { ok: true, json: async () => ({ sha: OUR_MERGE.sha, truncated: false, tree: [{ path: FILE.path, type: "blob", sha: blobAtMerge }] }) };
      }
      calls.commits++;
      return giteaPage(commits)();
    };
    return { calls, fetchImpl };
  };
  const withGitea = async (g, fn) => {
    const real = globalThis.fetch;
    globalThis.fetch = g.fetchImpl;
    try {
      return await fn();
    } finally {
      globalThis.fetch = real;
    }
  };

  // (a) THE JER NIGHT, measured: the merge holds our exact bytes → preserved. The
  //     blind-era counter (3) resets and the standing banner comes down.
  {
    const { sqlite, env } = freshEnv();
    const sync = seedSync(sqlite, 3);
    seedBanner(sqlite);
    const g = gitea([BOT_PUSH, OUR_MERGE], PUSHED);
    await withGitea(g, () => accountOwnPublishDeclineForTest(env, BOOK, "tq", FILE, null, sync));
    const s = readState(sqlite);
    eq(s.declines, 0, "merge blob == pushed blob resets the counter (the bot's push explains tonight's mismatch)");
    eq(s.banners.length, 0, "…and the standing banner comes down");
    eq(g.calls.commits, 1, "with no lineage walk to reuse, one commit walk from pushed_read_at was fetched");
    eq(g.calls.trees, 1, "…and one tree read at the merge commit");
  }

  // (b) The same night with the lineage walk handed in: no second commit fetch.
  {
    const { sqlite, env } = freshEnv();
    const sync = seedSync(sqlite, 2);
    const g = gitea([BOT_PUSH, OUR_MERGE], PUSHED);
    const walked = { commits: [BOT_PUSH, OUR_MERGE], incomplete: false, incompleteReason: "" };
    await withGitea(g, () => accountOwnPublishDeclineForTest(env, BOOK, "tq", FILE, walked, sync));
    eq(readState(sqlite).declines, 0, "a reused walk reaches the same verdict");
    eq(g.calls.commits, 0, "…without a second commit fetch");
    eq(g.calls.trees, 1, "…paying only the tree read");
  }

  // (c) A REWRITE, under the bot's push: the merge commit holds other bytes. The
  //     counter climbs, and on crossing the threshold the banner names the measurement.
  {
    const { sqlite, env } = freshEnv();
    const sync = seedSync(sqlite, 2);
    const g = gitea([BOT_PUSH, OUR_MERGE], "0000deadbeef00000000000000000000deadbeef");
    await withGitea(g, () => accountOwnPublishDeclineForTest(env, BOOK, "tq", FILE, null, sync));
    const s = readState(sqlite);
    eq(s.declines, 3, "merge blob != pushed blob counts as a measured rewrite even with a bot push on top");
    eq(s.banners.length, 1, "…and crossing the threshold raises the banner");
    eq(s.banners[0].message.includes("holds blob 0000deadbeef"), true, "…which states the blob the merge holds");
    eq(s.banners[0].message.includes("we pushed blob ba421e896eab"), true, "…and the blob we pushed");
    eq(s.banners[0].message.includes("22d652732b18"), true, "…and the merge commit");
    eq(s.banners[0].message.includes("cannot tell them apart"), false, "…and never the old two-explanations text");

    // The SAME merge measured again — a retried step tonight, or a later night
    // with no new push — adds nothing (0061's own_publish_rewrite_sha).
    const sync2 = { ...sync, declines: 3 };
    await withGitea(gitea([BOT_PUSH, OUR_MERGE], "0000deadbeef00000000000000000000deadbeef"), () =>
      accountOwnPublishDeclineForTest(env, BOOK, "tq", FILE, null, sync2),
    );
    eq(readState(sqlite).declines, 3, "re-measuring the same rewritten merge does not count it twice");

    // A NEW export (#861) whose merge is also rewritten: counts, banner NOT re-raised.
    sqlite
      .prepare(
        `UPDATE book_resource_syncs SET pushed_pr_number = 861, pushed_read_at = ?1, pushed_pr_read_at = ?1
          WHERE book = ?2 AND resource = 'tq'`,
      )
      .run(READ_AT + 86000, BOOK);
    const MERGE_861 = { ...OUR_MERGE, sha: "5555aaaa6666", message: "bible-editor: JER tq → master (#861)", date: "2026-09-02T05:40:00Z" };
    await withGitea(gitea([MERGE_861, BOT_PUSH, OUR_MERGE], "1111deadbeef00000000000000000000deadbeef"), () =>
      accountOwnPublishDeclineForTest(env, BOOK, "tq", FILE, null, { ...sync, pushedReadAt: READ_AT + 86000, declines: 3 }),
    );
    const s2 = readState(sqlite);
    eq(s2.declines, 4, "a further rewritten merge (a different commit) keeps counting");
    eq(s2.banners.length, 1, "…without a second banner (raise on the crossing only)");
  }

  // (e) Two overlapping exports (Codex finding on PR #704): export A (#859) merged
  //     after export B's render was read, and B (#864) is still pending. By PR
  //     number this is pending — A's blob is never compared against B's push.
  {
    const { sqlite, env } = freshEnv();
    const sync = seedSync(sqlite, 2, { prNumber: 864 });
    const g = gitea([BOT_PUSH, OUR_MERGE], "0000deadbeef00000000000000000000deadbeef");
    await withGitea(g, () => accountOwnPublishDeclineForTest(env, BOOK, "tq", FILE, null, sync));
    eq(readState(sqlite).declines, 2, "another export's merge is not measured as ours → counter unchanged");
    eq(g.calls.trees, 0, "…and no tree read is spent on it");
  }

  // (f) The push has no PR on record (creation failed, or it predates 0061): nothing to look for.
  {
    const { sqlite, env } = freshEnv();
    const sync = seedSync(sqlite, 2, { prNumber: null });
    const g = gitea([BOT_PUSH, OUR_MERGE], "0000deadbeef00000000000000000000deadbeef");
    await withGitea(g, () => accountOwnPublishDeclineForTest(env, BOOK, "tq", FILE, null, sync));
    eq(readState(sqlite).declines, 2, "no PR recorded for this push → nothing to measure, counter unchanged");
    eq(g.calls.trees, 0, "…and no tree read is spent on it");
  }

  // (g) A STALE PR on the row (Codex verify, round 2): a newer render advanced
  //     pushed_read_at/pushed_blob_sha, its PR is not stamped yet (or never will
  //     be), and pushed_pr_number still names the PREVIOUS render's PR (#859),
  //     whose merge IS on master. Comparing that merge's blob against the new
  //     push would be a false rewrite; the read-time mismatch says "no PR for
  //     this render" instead.
  {
    const { sqlite, env } = freshEnv();
    const sync = seedSync(sqlite, 2, { prNumber: 859, prReadAt: READ_AT - 86400 });
    const g = gitea([BOT_PUSH, OUR_MERGE], "0000deadbeef00000000000000000000deadbeef");
    await withGitea(g, () => accountOwnPublishDeclineForTest(env, BOOK, "tq", FILE, null, sync));
    eq(readState(sqlite).declines, 2, "a PR stamped for an earlier render is not this push's PR → counter unchanged");
    eq(g.calls.trees, 0, "…and its merge's blob is never read");
  }

  // (h) The render moved between the comparison and the accounting (an export
  //     landed mid-run): the decline was about a render no longer on the row.
  {
    const { sqlite, env } = freshEnv();
    const sync = seedSync(sqlite, 2);
    sqlite
      .prepare(`UPDATE book_resource_syncs SET pushed_blob_sha = 'newer000', pushed_read_at = ? WHERE book = ? AND resource = 'tq'`)
      .run(READ_AT + 600, BOOK);
    const g = gitea([BOT_PUSH, OUR_MERGE], "0000deadbeef00000000000000000000deadbeef");
    await withGitea(g, () => accountOwnPublishDeclineForTest(env, BOOK, "tq", FILE, null, sync));
    eq(readState(sqlite).declines, 2, "a render that moved during the run is not attributed → counter unchanged");
    eq(g.calls.commits + g.calls.trees, 0, "…and nothing is fetched for it");
  }

  // (d) Unmeasured nights leave the counter alone, in both directions.
  {
    const { sqlite, env } = freshEnv();
    const sync = seedSync(sqlite, 2);
    seedBanner(sqlite);
    // Tonight's branch (#859) has not merged: only an earlier export's merge (#854) is on master.
    const older = { ...OUR_MERGE, sha: "0abeb26ff896", message: "bible-editor: JER tq → master (#854)", date: "2026-08-31T05:36:55Z" };
    const g1 = gitea([older], PUSHED);
    await withGitea(g1, () => accountOwnPublishDeclineForTest(env, BOOK, "tq", FILE, null, sync));
    eq(readState(sqlite).declines, 2, "merge pending → counter unchanged");
    eq(g1.calls.trees, 0, "…and no tree read is spent on it");
    eq(readState(sqlite).banners.length, 1, "…and a standing banner is left standing");
    // The merge is there but the tree read fails.
    const g2 = { calls: { commits: 0, trees: 0 }, fetchImpl: async (url) => (String(url).includes("/git/trees/") ? { ok: false, json: async () => ({}) } : giteaPage([BOT_PUSH, OUR_MERGE])()) };
    await withGitea(g2, () => accountOwnPublishDeclineForTest(env, BOOK, "tq", FILE, null, sync));
    eq(readState(sqlite).declines, 2, "a failed tree read → counter unchanged");
    // No read time recorded on the row (half-written render): nothing can be placed.
    sqlite.prepare(`UPDATE book_resource_syncs SET pushed_read_at = NULL WHERE book = ? AND resource = 'tq'`).run(BOOK);
    await withGitea(gitea([BOT_PUSH, OUR_MERGE], PUSHED), () =>
      accountOwnPublishDeclineForTest(env, BOOK, "tq", FILE, null, { ...sync, pushedReadAt: null }),
    );
    eq(readState(sqlite).declines, 2, "no pushed_read_at → counter unchanged");
  }
}
console.log("\n[merge_kept retire: standing flags come down, D1-only, and nothing else is touched]");
{
  // PROD SHAPE: JER tq 3:6 / 3:8 / 3:19, flagged merge_kept on 2026-08-29 against
  // bp-assistant's own evening push — the flag kind is retired (see the
  // keep_ai_master branch), and every standing one was minted on the very
  // measurement that retired it, so the sweep needs no Door43 walk to justify
  // the clear. Sibling kinds and tombstones must come through untouched.
  const { sqlite, env } = freshEnv();
  const seed = (id, kind, reason, deletedAt = null) =>
    sqlite
      .prepare(
        `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version,
                              review_kind, review_reason, review_master_json, updated_at, deleted_at)
         VALUES (?, ?, 3, 6, '3:6', 'q', 'r', 4, ?, ?, ?, 1000, ?)`,
      )
      .run(id, BOOK, kind, reason, kind ? JSON.stringify({ ref_raw: "3:6", response: "Door43's AI response" }) : null, deletedAt);
  seed("mk01", "merge_kept", "Your response was kept over Door43's, and the next export…");
  seed("mk02", "merge_kept", "Your question was kept over Door43's, and the next export…");
  seed("mk99", "merge_kept", "kept, on a tombstone", 999);
  seed("mc01", "merge_conflict", "A Door43 edit to this row's response was merged over your app-side change.");
  seed("nb01", "merge_no_base", "Nothing was overwritten. Check this row against Door43's version…");
  seed("ok01", null, null);

  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches++;
    throw new Error("the retire must not walk Door43");
  };
  let result;
  try {
    result = await retireMergeKeptFlags(env);
  } finally {
    globalThis.fetch = realFetch;
  }
  eq(result.flagged, 2, "the two live merge_kept rows are found (the tombstone is not)");
  eq(result.cleared, 2, "…and both are retired");
  eq(fetches, 0, "…without a single Gitea fetch: the mint was the measurement");

  const byId = Object.fromEntries(
    sqlite
      .prepare(
        `SELECT id, review_kind, review_reason, review_master_json, version, updated_at,
                last_change_action, last_change_source, last_change_actor FROM tq_rows`,
      )
      .all()
      .map((r) => [r.id, r]),
  );
  eq(byId.mk01.review_kind, null, "mk01's flag is gone");
  eq(
    [byId.mk01.last_change_action, byId.mk01.last_change_source, byId.mk01.last_change_actor],
    ["review_clear", "system", "nightly merge_kept flag retirement"],
    "…stamped as unattended housekeeping, not as a Door43 sync (Door43 had no part in it)",
  );
  eq(byId.ok01.last_change_source, null, "…and an untouched row's provenance is untouched");
  eq(byId.mk01.review_reason, null, "…reason too");
  eq(byId.mk01.review_master_json, null, "…and its snapshot");
  eq(byId.mk02.review_kind, null, "mk02's flag is gone");
  eq([byId.mk01.version, byId.mk02.version], [4, 4], "…with no version bump, so an open editor's If-Match still holds");
  eq(byId.mk01.updated_at > 1000, true, "…updated_at moves, like every other flag clear");
  eq(byId.mk99.review_kind, "merge_kept", "a tombstoned row is never touched");
  eq(byId.mc01.review_kind, "merge_conflict", "a master-wins flag (a Door43 human may be behind it) stays");
  eq(byId.nb01.review_kind, "merge_no_base", "an unattributable flag stays for its own clear");
  eq(byId.ok01.updated_at, 1000, "an unflagged row is not written at all");

  const logs = sqlite
    .prepare(`SELECT row_key, payload_json FROM edit_log WHERE action = 'sync_clear_review' ORDER BY row_key`)
    .all();
  eq(logs.map((l) => l.row_key), ["mk01", "mk02"], "one audit row per retired flag");
  const payload = JSON.parse(logs[0].payload_json);
  eq(payload.review_kind, "merge_kept", "…naming the kind that was retired");
  eq(JSON.parse(payload.review_master_json).response, "Door43's AI response", "…and carrying the snapshot the flag was about");
  eq(payload.evidence.retired_kind, true, "…marked as a kind retirement, not a lineage-justified clear");

  // Idempotent: the next night finds nothing and writes nothing.
  const again = await retireMergeKeptFlags(env);
  eq(again.flagged, 0, "a second pass finds no standing merge_kept flag");
  eq(again.cleared, 0, "…and clears nothing");
  eq(
    sqlite.prepare(`SELECT COUNT(*) AS n FROM edit_log WHERE action = 'sync_clear_review'`).all()[0].n,
    2,
    "…and adds no audit rows",
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll reimportJourney assertions passed.");
