// End-to-end journey for issue #427's option 1 (reclaim a reissued
// tombstone's slot), against the REAL production schema (every file in
// api/migrations, applied in order) and the REAL functions — mirrors
// tombstoneSweep.test.mjs's rationale exactly: a test that hand-copies the
// reclaim's SQL proves nothing if the real SQL later drifts (e.g. someone
// "simplifies" the reclaim guard back to matching the resurrect guard and it
// silently stops firing for a trashed/preserve/hint-flagged tombstone, or
// someone drops the version-CAS re-assertion and a lost race starts
// clobbering a concurrent write instead of falling back safely).
//
// Run from api/ (needs the sqlite flag):
//   node --experimental-sqlite --experimental-strip-types --no-warnings --import ./src/tsResolveHook.mjs src/tombstoneReclaim.test.mjs
//
// What this covers, matching the task's required scenarios:
//   (a) a REISSUED tombstone (master carries the id at a DIFFERENT reference)
//       → reclaimed: ref/chapter/verse/content become master's, deleted_at
//       cleared, updated_by cleared, version bumped, an edit_log "create" row
//       is written; tombstone_blocked is NOT incremented; tombstone_reclaimed
//       IS.
//   (b) a SAME-REFERENCE tombstone (a delete pending export) → untouched,
//       exactly today's behavior — not reclaimed, not counted blocked.
//   (c) a COERCED id colliding with an unrelated tombstone at a different ref
//       → untouched (the documented-benign coercion no-op), not reclaimed,
//       not counted blocked.
//   (d) LOST-CAS fallback: a concurrent writer touches the tombstoned row
//       between applyTsvRows' read and the reclaim batch → falls back to
//       tombstone_blocked, never a silent drop.
//   (e) DISJOINTNESS with the pristine-resurrect path: a row eligible for
//       BOTH resurrect (pristine + last delete was a reimport prune) and
//       reclaim (master reissued the id) takes resurrect, never reclaim — and
//       a row eligible for reclaim but NOT resurrect (ordinary human delete)
//       takes reclaim, never resurrect.
//   (f) the reclaim guard deliberately does NOT re-assert trashed_at/
//       preserve/hint the way resurrect does — a tn tombstone with those
//       flags SET still reclaims (they describe the OLD row's protection
//       state, not master's new one), which resurrect would have refused —
//       AND the write explicitly CLEARS all three, so they don't silently
//       carry over onto master's unrelated new content.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { applyTsvRows } from "./bookReimport.ts";
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

// ── Minimal D1 shim over node:sqlite — identical shape to
// tombstoneSweep.test.mjs / reimportJourney.test.mjs ────────────────────────
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

// Wrap an env.DB so the FIRST reclaim write this run issues is preceded by an
// out-of-band version bump on the SAME tombstoned row — simulating a
// concurrent writer (another reimport instance, a hand-edit) landing between
// applyTsvRows' initial `existing` read and this batched write. Identified by
// the reclaim mode's distinctive SQL shape: `updated_by = NULL,` in the SET
// clause together with `deleted_at IS NOT NULL` in the WHERE — only
// buildTsvUpdateStmt's `reclaim` mode produces that combination (resurrect's
// SET never touches updated_by; reseedAi's WHERE requires `deleted_at IS
// NULL`, the opposite).
function withReclaimRace(env, sqlite, table, book, id) {
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
          sqlite.prepare(`UPDATE ${table} SET version = version + 1 WHERE book = ? AND id = ?`).run(book, id);
        }
        return env.DB.batch(stmts);
      },
    },
  };
}

const BOOK = "1CH";
// The real id from the incident: minted for a 1CH 5:4 question, hand-deleted
// 2026-07-30, then reissued by bp-assistant for 1CH 23:7.
const ID = "hoig";

function seedTqTombstone(sqlite, { id = ID, ref = "5:4", chapter = 5, verse = 4, updatedBy = null } = {}) {
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, deleted_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, BOOK, chapter, verse, ref, "old question", "old response", 10, 1753900000, updatedBy);
}

// Shaped exactly like parseTsvRow's output for a tq row.
function tqMasterRow({ id = ID, ref = "23:7", chapter = 23, verse = 7, idCoerced = false } = {}) {
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

console.log("\n[(a) a reissued tombstone is RECLAIMED — content, flags, edit_log all correct]");
{
  const { sqlite, env } = freshEnv();
  seedTqTombstone(sqlite);
  // edit_log.user_id has a FOREIGN KEY on users(id) — seed a real user so this
  // test can also prove the reclaim's edit_log row carries the right actor.
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (42, 4242, 'benjamin')`).run();
  const counts = await applyTsvRows(env, BOOK, "tq", [tqMasterRow()], 42);

  eq(counts.tombstone_reclaimed, 1, "tombstone_reclaimed === 1");
  eq(counts.tombstone_blocked, 0, "NOT counted blocked — the reclaim landed");
  eq(counts.skipped_edited, 0, "NOT counted skipped_edited — a landed reclaim is neither");

  const stored = sqlite
    .prepare(
      `SELECT chapter, verse, ref_raw, question, response, deleted_at, updated_by, version
         FROM tq_rows WHERE book = ? AND id = ?`,
    )
    .all(BOOK, ID);
  eq(stored.length, 1, "still exactly one row for that (book, id)");
  eq(stored[0].chapter, 23, "chapter is master's, the reissued reference");
  eq(stored[0].verse, 7, "verse is master's");
  eq(stored[0].ref_raw, "23:7", "ref_raw is master's");
  eq(stored[0].question, "new question", "content is master's");
  eq(stored[0].response, "new response", "and every content column, not just the note-shaped one");
  eq(stored[0].deleted_at, null, "no longer a tombstone");
  eq(stored[0].updated_by, null, "master-owned going forward — updated_by is reset even though the OLD row had none set");
  eq(stored[0].version, 2, "version bumped from the tombstone's version (1)");

  const log = sqlite
    .prepare(`SELECT action, user_id, prev_version, new_version, source FROM edit_log WHERE kind = 'tq' AND row_key = ? AND book = ?`)
    .all(ID, BOOK);
  eq(log.length, 1, "exactly one edit_log row written for the reclaim");
  eq(log[0].action, "create", "audited as 'create' — from this slot's new life, master's row IS a fresh row");
  eq(log[0].user_id, 42, "the actor is recorded, same as any other reimport write");
  eq(log[0].prev_version, 1, "prev_version is the tombstone's version");
  eq(log[0].new_version, 2, "new_version matches the write");
  eq(log[0].source, "dcs_reimport", "sourced as a reimport action, like every other write in this file");
}

console.log("\n[(b) a same-reference tombstone (pending delete) is untouched]");
{
  const { sqlite, env } = freshEnv();
  seedTqTombstone(sqlite, { ref: "5:4", chapter: 5, verse: 4 });
  const counts = await applyTsvRows(env, BOOK, "tq", [tqMasterRow({ ref: "5:4", chapter: 5, verse: 4 })], null);

  eq(counts.tombstone_reclaimed, 0, "not reclaimed — reapplying master's copy would resurrect a pending delete");
  eq(counts.tombstone_blocked, 0, "not counted blocked either — this is the healthy, expected skip");
  eq(counts.skipped_edited, 1, "counted skipped_edited, exactly as before this fix");

  const stored = sqlite.prepare(`SELECT chapter, deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
  eq(stored[0].chapter, 5, "row untouched — still at the original reference");
  eq(stored[0].deleted_at != null, true, "still a tombstone");
}

console.log("\n[(c) a coerced id colliding with an unrelated tombstone is untouched]");
{
  const { sqlite, env } = freshEnv();
  seedTqTombstone(sqlite, { ref: "5:4", chapter: 5, verse: 4 });
  // coerceRowId hashes a malformed master id into a 96-id space, so landing on
  // an unrelated tombstone at a different reference is an expected collision,
  // not evidence master reissued anything.
  const counts = await applyTsvRows(env, BOOK, "tq", [tqMasterRow({ ref: "23:7", idCoerced: true })], null);

  eq(counts.tombstone_reclaimed, 0, "not reclaimed — a coerced id's collision is documented-benign, not a reissue");
  eq(counts.tombstone_blocked, 0, "not counted blocked either");
  eq(shouldRecordResourceSync(counts), true, "so a coercion collision cannot withhold the watermark");

  const stored = sqlite.prepare(`SELECT chapter, question, deleted_at FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
  eq(stored[0].chapter, 5, "the unrelated tombstone is completely untouched");
  eq(stored[0].question, "old question", "content untouched");
}

console.log("\n[(d) a reclaim that LOSES its version-CAS race falls back to tombstone_blocked]");
{
  const { sqlite, env } = freshEnv();
  seedTqTombstone(sqlite);
  const raced = withReclaimRace(env, sqlite, "tq_rows", BOOK, ID);
  const counts = await applyTsvRows(raced, BOOK, "tq", [tqMasterRow()], null);

  eq(counts.tombstone_reclaimed, 0, "the reclaim did NOT land — the race won");
  eq(counts.tombstone_blocked, 1, "falls back to tombstone_blocked — never a silent drop, exactly the pre-reclaim safety net");
  eq(
    (counts.blocked_samples ?? [])[0]?.includes(ID),
    true,
    "the sample still names the row, so the fallback is exactly as actionable as before this fix",
  );
  eq(shouldRecordResourceSync(counts), false, "and the watermark is withheld, so the export doesn't revert master over this");

  // Nothing was clobbered: the row the race left behind is untouched by the
  // losing reclaim write (still the OLD content, just at the race's bumped
  // version).
  const stored = sqlite.prepare(`SELECT chapter, question, deleted_at, version FROM tq_rows WHERE book = ? AND id = ?`).all(BOOK, ID);
  eq(stored[0].chapter, 5, "content untouched by the losing write");
  eq(stored[0].question, "old question", "a lost CAS never partially applies");
  eq(stored[0].deleted_at != null, true, "still a tombstone");
  eq(stored[0].version, 2, "version reflects the race's bump, not the reclaim's failed write");

  // No edit_log row for a write that never landed.
  const log = sqlite.prepare(`SELECT COUNT(*) AS n FROM edit_log WHERE kind = 'tq' AND row_key = ? AND book = ?`).all(ID, BOOK);
  eq(Number(log[0].n), 0, "no edit_log row is written for a lost-CAS reclaim attempt");
}

console.log("\n[(e) disjointness: resurrect-eligible wins over reclaim-eligible when a row is BOTH]");
{
  const { sqlite, env } = freshEnv();
  seedTqTombstone(sqlite);
  // Make the tombstone's last delete a REIMPORT prune (the resurrect
  // eligibility signal) — isPristineTombstone is already true for this row
  // (updated_by IS NULL, tq has no trashed_at/preserve/hint), so this is the
  // ONLY thing standing between "resurrect-eligible" and "reclaim-eligible"
  // for an otherwise-identical row.
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
       VALUES ('tq', ?, ?, NULL, 1, 1, 'delete', '{}', 'dcs_reimport')`,
    )
    .run(ID, BOOK);

  // Master's row is at a DIFFERENT reference (23:7) — satisfies
  // isReissuedTombstone too. If reclaim ran here instead of resurrect, the
  // audit action would be "create" instead of "restore", and this test would
  // catch it.
  const counts = await applyTsvRows(env, BOOK, "tq", [tqMasterRow()], null);

  eq(counts.resurrected, 1, "resurrect wins — pristine + last-delete-was-reimport is checked FIRST");
  eq(counts.tombstone_reclaimed, 0, "reclaim never even considered for this row");
  eq(counts.tombstone_blocked, 0, "not blocked either — the row was handled, just via the other path");

  const log = sqlite
    .prepare(`SELECT action FROM edit_log WHERE kind = 'tq' AND row_key = ? AND book = ? ORDER BY id DESC LIMIT 1`)
    .all(ID, BOOK);
  eq(log[0].action, "restore", "audited as 'restore' (resurrect's label), NOT 'create' (reclaim's label)");
}

console.log("\n[(e2) the converse: an ordinary human-deleted reissued tombstone takes reclaim, never resurrect]");
{
  const { sqlite, env } = freshEnv();
  seedTqTombstone(sqlite);
  // An ordinary human delete, NOT a reimport prune — lastTsvDeleteWasReimport
  // returns false (no matching edit_log row at all here), so this row is
  // NOT resurrect-eligible even though it IS pristine.
  const counts = await applyTsvRows(env, BOOK, "tq", [tqMasterRow()], null);

  eq(counts.resurrected, 0, "resurrect does not fire — the delete was not a reimport prune");
  eq(counts.tombstone_reclaimed, 1, "reclaim fires instead — master reissued the id");

  const log = sqlite
    .prepare(`SELECT action FROM edit_log WHERE kind = 'tq' AND row_key = ? AND book = ? ORDER BY id DESC LIMIT 1`)
    .all(ID, BOOK);
  eq(log[0].action, "create", "audited as 'create' (reclaim's label)");
}

console.log("\n[(f) reclaim IGNORES the trashed_at/preserve/hint GUARD, and also CLEARS all three on write]");
{
  const { sqlite, env } = freshEnv();
  // A tn tombstone with EVERY human-owned protection flag set. isPristineTombstone
  // for tn checks trashed_at/preserve/hint too, so this row would NOT be
  // resurrect-eligible even if its last delete were a reimport prune — and the
  // ordinary pristine-UPDATE / reseedAi guards also require trashed_at IS NULL
  // AND preserve = 0 AND hint = 0. Reclaim is the one write mode that neither
  // gates on those columns NOR leaves their old values sitting on master's new
  // content — see buildTsvUpdateStmt's `clearProtections`. Those flags
  // describe the OLD row's protection state, and carrying them forward would
  // silently apply a human's "preserve"/"hint" decision to content they never
  // made that decision about.
  // updated_by has a FOREIGN KEY on users(id) — seed the row it points at.
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (7, 707, 'translator7')`).run();
  sqlite
    .prepare(
      `INSERT INTO tn_rows
         (id, book, chapter, verse, ref_raw, note, sort_order, deleted_at, updated_by, trashed_at, preserve, hint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ID, BOOK, 5, 4, "5:4", "old note", 10, 1753900000, 7, 1753900000, 1, 1);

  const masterTn = {
    id: ID,
    idCoerced: false,
    refRaw: "23:7",
    chapter: 23,
    verse: 7,
    occurrence: null,
    tags: null,
    support_reference: null,
    quote: null,
    note: "new note",
  };
  const counts = await applyTsvRows(env, BOOK, "tn", [masterTn], null);

  eq(counts.tombstone_reclaimed, 1, "reclaimed despite trashed_at/preserve/hint all being set on the OLD row");
  eq(counts.tombstone_blocked, 0, "not blocked");

  const stored = sqlite
    .prepare(`SELECT chapter, note, deleted_at, updated_by, trashed_at, preserve, hint, version FROM tn_rows WHERE book = ? AND id = ?`)
    .all(BOOK, ID);
  eq(stored[0].chapter, 23, "master's chapter landed");
  eq(stored[0].note, "new note", "master's note landed");
  eq(stored[0].deleted_at, null, "no longer a tombstone");
  eq(stored[0].updated_by, null, "master-owned, even though the OLD row had updated_by = 7");
  eq(stored[0].version, 2, "version bumped");
  // Master's fresh content starts with a clean slate, the same as a brand-new
  // INSERT would (tryInsertTsvRow never sets these three either — they default
  // to NULL/0/0 from the schema) — NOT whatever the tombstoned row happened to
  // hold.
  eq(stored[0].trashed_at, null, "trashed_at is CLEARED by reclaim — the old row's trash-queue state does not survive");
  eq(stored[0].preserve, 0, "preserve is CLEARED — the old row's AI-sweep protection does not apply to new content");
  eq(stored[0].hint, 0, "hint is CLEARED — the old row's AI-hint-stub flag does not apply to new content");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll tombstoneReclaim assertions passed.");
