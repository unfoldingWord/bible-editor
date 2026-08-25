// End-to-end journey for issue #427's option 3 (sweep obsolete tombstones),
// against the REAL production schema (every file in api/migrations, applied
// in order) and the REAL function — mirrors tombstoneReclaim.test.mjs's
// rationale exactly: a test that hand-copies the sweep's SQL proves nothing
// if the real SQL later drifts (e.g. someone drops the `verifiedComplete`
// gate and a truncated-fetch id starts getting hard-deleted, or the grace
// window is quietly removed and a same-run prune gets swept in the same
// breath).
//
// Run from api/ (needs the sqlite flag):
//   node --experimental-sqlite --experimental-strip-types --no-warnings --import ./src/tsResolveHook.mjs src/tombstoneSweep.test.mjs
//
// What this covers:
//   (a) a tombstone whose id no longer appears ANYWHERE in master's file
//       (old enough to clear the grace window) is hard-deleted, and a gated
//       'tombstone_swept' edit_log row lands.
//   (b) a SAME-REFERENCE tombstone (a pending delete master still carries at
//       the same ref) is left untouched — sweep must never touch a row
//       applyTsvRows' own tombstone branch would classify as "pending".
//   (c) a REISSUED tombstone (master carries the id at a DIFFERENT reference)
//       is also left untouched — that's reclaim's job (#427 option 1), not
//       sweep's; the two are mutually exclusive by construction.
//   (d) a tombstone younger than TOMBSTONE_SWEEP_GRACE_SECONDS is left alone
//       even though its id is genuinely absent from master — the grace
//       window protects a same-run prune from being purged immediately.
//   (e) `verifiedComplete: false` sweeps nothing at all, even for an
//       old, genuinely-absent id — an unverified fetch is not proof master
//       dropped it.
//   (f) an empty/garbled incoming file sweeps nothing (defensive floor,
//       mirrors softDeleteRemovedTsvRows).
//   (g) a live (non-tombstoned) row with the same "absent from master" shape
//       is never touched — sweep only ever looks at deleted_at IS NOT NULL
//       rows.
//   (h) multiple obsolete tombstones in one run are all swept, batched.
//
// Issue #604 (tombstone sweep starved on the changed-empty nightly path):
//   (i)-(k) hasDueTombstones — the cheap `LIMIT 1` predicate
//       planAndStageBookResources now consults for a SHA-unchanged/own-publish
//       TSV resource before deciding whether to stage a file purely for the
//       sweep. True only when a tombstone past the grace window exists for
//       that (book, kind); false for none, and false for a fresh one.
//   (l)-(n) runTombstoneSweep — the extracted step-do'd sweep body
//       runChunkedReimport now calls from BOTH its changed-empty early-out
//       and its normal flow, driven directly with a fake WorkflowStep and a
//       Map-backed fake env.BLOBS (no Door43 mock needed): given a
//       `changed:false` entry with an `r2Key` staged purely for the sweep
//       (exactly what planAndStageBookResources's new hasDueTombstones
//       branches produce), the sweep still runs and clears the tombstone —
//       proving the fix's literal claim, that a SHA-matched/own-publish
//       resource is no longer starved.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  sweepObsoleteTombstonesForTest as sweepObsoleteTombstones,
  hasDueTombstonesForTest as hasDueTombstones,
  runTombstoneSweepForTest as runTombstoneSweep,
} from "./bookReimport.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ── Minimal D1 shim over node:sqlite — identical shape to
// tombstoneReclaim.test.mjs / reimportJourney.test.mjs ────────────────────────
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

// Map-backed fake R2 binding — good enough for runTombstoneSweep, which only
// ever calls .get()/.put() (via readStaged) on it. Not network, just a KV
// shim, same rationale the issue's own testing guidance gives.
function makeBlobs() {
  const store = new Map();
  return {
    async get(key) {
      const v = store.get(key);
      return v === undefined ? null : { text: async () => v };
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

// Fake WorkflowStep — none of this needs retries in a test, so `.do` just
// runs the callback immediately. Accepts both the 2-arg (`name, fn`) and
// 3-arg (`name, opts, fn`) call shapes runChunkedReimport uses elsewhere,
// even though runTombstoneSweep itself only ever calls the 2-arg form.
function makeStep() {
  return {
    async do(_name, optsOrFn, maybeFn) {
      const run = typeof optsOrFn === "function" ? optsOrFn : maybeFn;
      return run();
    },
  };
}

function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  return { sqlite, env: { DB: makeDb(sqlite), BLOBS: makeBlobs() } };
}

const BOOK = "1CH";
const ID = "hoig";
const NOW = Math.floor(Date.now() / 1000);
const GRACE = 7 * 24 * 60 * 60;
const OLD = NOW - GRACE - 3600; // clears the grace window
const FRESH = NOW - 3600; // one hour old — well inside the grace window

function seedTqTombstone(sqlite, { id = ID, ref = "5:4", chapter = 5, verse = 4, deletedAt = OLD, version = 1 } = {}) {
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, deleted_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, BOOK, chapter, verse, ref, "old question", "old response", 10, deletedAt, version);
}

function seedLiveTqRow(sqlite, { id, ref, chapter, verse } = {}) {
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, deleted_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
    )
    .run(id, BOOK, chapter, verse, ref, "live question", "live response", 20);
}

// Minimal valid tq TSV body — just needs to be parseable and carry (or omit)
// the ids under test. Reference/Book/Chapter/Verse columns mirror the real
// tq_ULT.tsv shape closely enough for parseTsv/parseTsvRow.
function tqTsv(rows) {
  const header = "Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse";
  const lines = rows.map(
    (r) => `${r.chapter}:${r.verse}\t${r.id}\t\t\t1\t${r.question ?? "new question"}\t${r.response ?? "new response"}`,
  );
  return [header, ...lines].join("\n");
}

console.log("\n[(a) an old tombstone absent from master entirely is swept and audited]");
{
  const { sqlite, env } = freshEnv();
  seedTqTombstone(sqlite);
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 101, 'someone')`).run();
  // Master's file no longer mentions ID at all — carries an unrelated row.
  const raw = tqTsv([{ id: "zzzz", chapter: 9, verse: 9 }]);
  const res = await sweepObsoleteTombstones(env, BOOK, "tq", raw, true);

  eq(res.swept, 1, "swept === 1");
  const stored = sqlite.prepare(`SELECT * FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
  eq(stored.length, 0, "the row is gone — hard-deleted, not merely re-tombstoned");

  const log = sqlite
    .prepare(`SELECT action, row_key, book, prev_version, new_version, source FROM edit_log WHERE kind = 'tq' AND row_key = ?`)
    .all(ID);
  eq(log.length, 1, "exactly one edit_log row written for the sweep");
  eq(log[0].action, "tombstone_swept", "audited under its own action, distinct from 'delete'/'create'/'update'/'restore'");
  eq(log[0].book, BOOK, "book is recorded");
  eq(log[0].prev_version, 1, "prev_version carries the tombstone's last known version");
  eq(log[0].new_version, null, "new_version is null — there is no living version after a sweep");
  eq(log[0].source, "dcs_reimport", "sourced as a reimport action, like every other write in this file");
}

console.log("\n[(b) a same-reference tombstone (pending delete) is left untouched]");
{
  const { sqlite, env } = freshEnv();
  seedTqTombstone(sqlite, { ref: "5:4", chapter: 5, verse: 4 });
  // Master STILL carries the id, at the SAME reference — a delete pending
  // export, exactly the case applyTsvRows' tombstone branch deliberately
  // leaves dead. Sweep must not touch it either.
  const raw = tqTsv([{ id: ID, chapter: 5, verse: 4 }]);
  const res = await sweepObsoleteTombstones(env, BOOK, "tq", raw, true);

  eq(res.swept, 0, "nothing swept — master still carries this id");
  const stored = sqlite.prepare(`SELECT deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
  eq(stored.length, 1, "row still present");
  eq(stored[0].deleted_at != null, true, "still a tombstone, untouched");
}

console.log("\n[(c) a REISSUED tombstone (master carries the id at a different reference) is left untouched — reclaim's job, not sweep's]");
{
  const { sqlite, env } = freshEnv();
  seedTqTombstone(sqlite, { ref: "5:4", chapter: 5, verse: 4 });
  const raw = tqTsv([{ id: ID, chapter: 23, verse: 7 }]);
  const res = await sweepObsoleteTombstones(env, BOOK, "tq", raw, true);

  eq(res.swept, 0, "nothing swept — the id is present in master's file, just at a different reference");
  const stored = sqlite.prepare(`SELECT deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
  eq(stored.length, 1, "row still present, unclaimed by sweep");
  eq(stored[0].deleted_at != null, true, "still a tombstone");
}

console.log("\n[(d) a tombstone younger than the grace window is left alone even though master has fully dropped it]");
{
  const { sqlite, env } = freshEnv();
  seedTqTombstone(sqlite, { deletedAt: FRESH });
  const raw = tqTsv([{ id: "zzzz", chapter: 9, verse: 9 }]);
  const res = await sweepObsoleteTombstones(env, BOOK, "tq", raw, true);

  eq(res.swept, 0, "not swept yet — inside the grace window");
  const stored = sqlite.prepare(`SELECT deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
  eq(stored.length, 1, "row still present");
}

console.log("\n[(e) verifiedComplete: false sweeps nothing, even for an old, genuinely-absent id]");
{
  const { sqlite, env } = freshEnv();
  seedTqTombstone(sqlite);
  const raw = tqTsv([{ id: "zzzz", chapter: 9, verse: 9 }]);
  const res = await sweepObsoleteTombstones(env, BOOK, "tq", raw, false);

  eq(res.swept, 0, "an unverified fetch is not proof master dropped the id");
  const stored = sqlite.prepare(`SELECT deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
  eq(stored.length, 1, "row still present");
}

console.log("\n[(f) an empty/garbled incoming file sweeps nothing]");
{
  const { sqlite, env } = freshEnv();
  seedTqTombstone(sqlite);
  const res = await sweepObsoleteTombstones(env, BOOK, "tq", "", true);

  eq(res.swept, 0, "an empty file must never be read as 'master dropped everything'");
  const stored = sqlite.prepare(`SELECT deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
  eq(stored.length, 1, "row still present");
}

console.log("\n[(g) a LIVE row is never touched, even if its id would otherwise look 'absent from master']");
{
  const { sqlite, env } = freshEnv();
  seedLiveTqRow(sqlite, { id: ID, ref: "5:4", chapter: 5, verse: 4 });
  const raw = tqTsv([{ id: "zzzz", chapter: 9, verse: 9 }]);
  const res = await sweepObsoleteTombstones(env, BOOK, "tq", raw, true);

  eq(res.swept, 0, "sweep only ever looks at deleted_at IS NOT NULL rows");
  const stored = sqlite.prepare(`SELECT deleted_at, question FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
  eq(stored.length, 1, "live row untouched");
  eq(stored[0].deleted_at, null, "still live");
  eq(stored[0].question, "live question", "content untouched");
}

console.log("\n[(h) multiple obsolete tombstones in one run are all swept]");
{
  const { sqlite, env } = freshEnv();
  const IDS = ["aaaa", "bbbb", "cccc"];
  for (const id of IDS) seedTqTombstone(sqlite, { id, ref: "5:4", chapter: 5, verse: 4 });
  const raw = tqTsv([{ id: "zzzz", chapter: 9, verse: 9 }]);
  const res = await sweepObsoleteTombstones(env, BOOK, "tq", raw, true);

  eq(res.swept, 3, "all three obsolete tombstones swept in one run");
  for (const id of IDS) {
    const stored = sqlite.prepare(`SELECT * FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, id);
    eq(stored.length, 0, `${id} is gone`);
  }
  const logs = sqlite
    .prepare(`SELECT COUNT(*) AS n FROM edit_log WHERE kind = 'tq' AND book = ? AND action = 'tombstone_swept'`)
    .all(BOOK);
  eq(Number(logs[0].n), 3, "one audit row per swept tombstone");
}

console.log("\n[(i) hasDueTombstones: true when a due (past-grace) tombstone exists for that (book, kind)]");
{
  const { sqlite, env } = freshEnv();
  seedTqTombstone(sqlite); // default deletedAt: OLD, clears the grace window
  const due = await hasDueTombstones(env, BOOK, "tq");
  eq(due, true, "an old tombstone for this (book, kind) is reported due");
}

console.log("\n[(j) hasDueTombstones: false when there is no tombstone at all for that (book, kind)]");
{
  const { env } = freshEnv();
  const due = await hasDueTombstones(env, BOOK, "tq");
  eq(due, false, "nothing to sweep — no row, due or otherwise");
}

console.log("\n[(k) hasDueTombstones: false when the only tombstone is fresh (inside the grace window)]");
{
  const { sqlite, env } = freshEnv();
  seedTqTombstone(sqlite, { deletedAt: FRESH });
  const due = await hasDueTombstones(env, BOOK, "tq");
  eq(due, false, "a tombstone inside its grace window is not yet due, regardless of master's content");
}

console.log(
  "\n[(l) runTombstoneSweep: a changed:false entry staged only for the sweep (SHA-matched/own-publish-but-due shape) still gets its tombstone swept]",
);
{
  // This is the shape planAndStageBookResources' new hasDueTombstones
  // branches produce (issue #604): `changed: false` (nothing to reimport —
  // the SHA matched, or it was our own publish) but `r2Key` set because a
  // tombstone was due and the file was staged purely so this sweep could run.
  // Before the fix, runChunkedReimport's `changed`-filtered iteration made
  // this entry — and the tombstone behind it — permanently invisible.
  const { sqlite, env } = freshEnv();
  seedTqTombstone(sqlite);
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 101, 'someone')`).run();
  const raw = tqTsv([{ id: "zzzz", chapter: 9, verse: 9 }]); // master no longer carries ID
  const r2Key = `reimport-stage/test-instance/${BOOK}/tq`;
  await env.BLOBS.put(r2Key, raw);
  const step = makeStep();

  const candidates = [
    { resource: "tq", changed: false, masterSha: "deadbeef", r2Key, verifiedComplete: true },
  ];
  await runTombstoneSweep(env, step, BOOK, candidates);

  const stored = sqlite.prepare(`SELECT * FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
  eq(stored.length, 0, "the tombstone is gone — swept even though the entry was changed:false");
  const log = sqlite
    .prepare(`SELECT action FROM edit_log WHERE kind = 'tq' AND row_key = ? AND book = ?`)
    .all(ID, BOOK);
  eq(log.length, 1, "audited exactly once");
  eq(log[0].action, "tombstone_swept", "under the sweep's own action");
}

console.log(
  "\n[(m) runTombstoneSweep: an entry with no r2Key (no file staged this run) is skipped, not an error]",
);
{
  const { sqlite, env } = freshEnv();
  seedTqTombstone(sqlite);
  const step = makeStep();

  const candidates = [
    { resource: "tq", changed: false, masterSha: "deadbeef", r2Key: null, verifiedComplete: false },
  ];
  await runTombstoneSweep(env, step, BOOK, candidates);

  const stored = sqlite.prepare(`SELECT * FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
  eq(stored.length, 1, "left untouched — nothing was staged to sweep against");
}

console.log(
  "\n[(n) runTombstoneSweep: multiple candidates across kinds are each swept independently in one call]",
);
{
  const { sqlite, env } = freshEnv();
  seedTqTombstone(sqlite, { id: "aaaa" });
  seedTqTombstone(sqlite, { id: "bbbb" });
  const raw = tqTsv([{ id: "zzzz", chapter: 9, verse: 9 }]);
  const r2Key = `reimport-stage/test-instance/${BOOK}/tq`;
  await env.BLOBS.put(r2Key, raw);
  const step = makeStep();

  const candidates = [
    { resource: "tq", changed: false, masterSha: "deadbeef", r2Key, verifiedComplete: true },
  ];
  await runTombstoneSweep(env, step, BOOK, candidates);

  for (const id of ["aaaa", "bbbb"]) {
    const stored = sqlite.prepare(`SELECT * FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, id);
    eq(stored.length, 0, `${id} swept — one staged file, both its obsolete tombstones cleared`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll tombstoneSweep assertions passed.");
