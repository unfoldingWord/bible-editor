// Regression tests for the two 2026-08-14 prod-audit fixes in
// verseMergeConflicts.ts / verses.ts:
//
//   DEFECT 1 (wrong audience) — the merge-conflict banner alert only ever
//   reached the admin (ALERT_USERNAME); the editors whose work was actually
//   overwritten never learned about it. Fixed by attributing each
//   'adopt_conflict' overwrite to the human who authored the replaced
//   version (via edit_log) and giving them their own system_alerts row.
//
//   DEFECT 2 (self-destructing evidence) — verses.ts's PATCH route used to
//   DELETE the verse_merge_conflicts row the instant a human re-saved the
//   flagged verse, erasing the audit trail (and the overwritten_version
//   recovery pointer) as people fixed their own overwritten work. Fixed by
//   marking resolved_at/resolved_by (migration 0047) instead, and filtering
//   "active" reads on resolved_at IS NULL.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/verseMergeConflicts.test.mjs
//
// Not a test framework; a failed assert exits non-zero. Mirrors
// blankStubTrash.test.mjs's real-SQLite pattern for the parts that are pure
// SQL, and tests the pure grouping logic directly (no D1 needed) — same
// split as chapterLock.test.mjs.

import { DatabaseSync } from "node:sqlite";
import {
  buildEditorLookupQuery,
  EDITOR_LOOKUP_CHUNK,
  editLogKey,
  groupOverwrittenVersesByEditor,
} from "./verseMergeEditorAlerts.ts";
import { RESOLVE_VERSE_MERGE_CONFLICT_SQL } from "./verseMergeConflictResolve.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Part 1: groupOverwrittenVersesByEditor — pure, no D1.
// ─────────────────────────────────────────────────────────────────────────

{
  // Two verses attributed to the same editor combine into one alert.
  const overwritten = [
    { chapter: 1, verse: 2, overwrittenVersion: 3 },
    { chapter: 1, verse: 5, overwrittenVersion: 7 },
  ];
  const usernameByKey = new Map([
    [editLogKey("ZEC", "ult", overwritten[0]), "bethoakes"],
    [editLogKey("ZEC", "ult", overwritten[1]), "bethoakes"],
  ]);
  const grouped = groupOverwrittenVersesByEditor("ZEC", "ult", overwritten, usernameByKey);
  assert(grouped.size === 1, "two verses, one editor -> one alert entry");
  const entry = grouped.get("bethoakes");
  assert(!!entry, "keyed by username");
  assert(entry.refs.length === 2, "both refs collected");
  assert(entry.refs.includes("1:2@v3") && entry.refs.includes("1:5@v7"), "refs carry chapter:verse@version");
  assert(entry.message.includes("ZEC"), "message names the book");
  assert(entry.message.includes("ULT"), "message names the resource, uppercased");
  assert(entry.message.includes("2 verse(s)"), "message states the count");
}

{
  // Two different editors get two separate alert entries, not merged.
  const overwritten = [
    { chapter: 2, verse: 1, overwrittenVersion: 4 },
    { chapter: 3, verse: 9, overwrittenVersion: 2 },
  ];
  const usernameByKey = new Map([
    [editLogKey("HOS", "ust", overwritten[0]), "pjoakes"],
    [editLogKey("HOS", "ust", overwritten[1]), "Carolyn1970"],
  ]);
  const grouped = groupOverwrittenVersesByEditor("HOS", "ust", overwritten, usernameByKey);
  assert(grouped.size === 2, "two editors -> two alert entries");
  assert(grouped.get("pjoakes").refs.length === 1, "pjoakes gets only their own verse");
  assert(grouped.get("Carolyn1970").refs.length === 1, "Carolyn1970 gets only their own verse");
}

{
  // A verse with no matching edit_log user (AI edit, or ancestor aged out of
  // the 180-day sweep) is silently excluded — there is no human to alert.
  const overwritten = [{ chapter: 4, verse: 4, overwrittenVersion: 1 }];
  const grouped = groupOverwrittenVersesByEditor("MIC", "ult", overwritten, new Map());
  assert(grouped.size === 0, "no username found -> no alert entry (not a crash, not a blank-username alert)");
}

{
  // Same chapter:verse in two different books/resources must not collide —
  // editLogKey must be scoped by book+resource, not just chapter/verse.
  const a = { chapter: 1, verse: 1, overwrittenVersion: 2 };
  const b = { chapter: 1, verse: 1, overwrittenVersion: 2 };
  assert(editLogKey("ZEC", "ult", a) !== editLogKey("HOS", "ult", b), "different book -> different key");
  assert(editLogKey("ZEC", "ult", a) !== editLogKey("ZEC", "ust", b), "different resource -> different key");
}

// ─────────────────────────────────────────────────────────────────────────
// Part 2: the ACTUAL production query (buildEditorLookupQuery, imported
// above — not a hand-duplicated copy, so this can't silently drift from what
// verseMergeConflicts.ts's lookupEditorUsernames really sends to D1), run
// against real SQLite. The concatenated `row_key || ':' || new_version` match
// is a tuple-IN() workaround — if it were done as two separate
// `row_key IN (...)` / `new_version IN (...)` clauses instead, a same-verse
// row at a DIFFERENT version would falsely match. This proves the real query
// doesn't regress to that.
// ─────────────────────────────────────────────────────────────────────────

function setupDb() {
  const d = new DatabaseSync(":memory:");
  d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, dcs_username TEXT)`);
  d.exec(`CREATE TABLE edit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, row_key TEXT, book TEXT,
    user_id INTEGER, prev_version INTEGER, new_version INTEGER, action TEXT
  )`);
  return d;
}

{
  const d = setupDb();
  d.prepare(`INSERT INTO users (id, dcs_username) VALUES (1, 'bethoakes'), (2, 'pjoakes')`).run();
  // Two edit_log rows for the SAME verse at DIFFERENT versions, by DIFFERENT
  // users — the exact shape a cross-product WHERE would confuse.
  d.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, new_version, action) VALUES
       ('verse', 'ZEC/1/2/ULT', 'ZEC', 1, 3, 'update'),
       ('verse', 'ZEC/1/2/ULT', 'ZEC', 2, 4, 'update')`,
  ).run();

  {
    const ref = { chapter: 1, verse: 2, overwrittenVersion: 3 };
    const { sql, keys } = buildEditorLookupQuery("ZEC", "ult", [ref]);
    const rows = d.prepare(sql).all("ZEC", ...keys);
    assert(rows.length === 1, "exact (verse, version) match returns exactly one row");
    assert(rows[0].username === "bethoakes", "matches the author of v3, not the author of v4");
  }
  {
    const ref4 = { chapter: 1, verse: 2, overwrittenVersion: 4 };
    const { sql, keys } = buildEditorLookupQuery("ZEC", "ult", [ref4]);
    const rows4 = d.prepare(sql).all("ZEC", ...keys);
    assert(rows4.length === 1 && rows4[0].username === "pjoakes", "the other version resolves to the other author");
  }
}

{
  // A verse with no user_id (e.g. an import-time row) must not surface as a
  // false match via the JOIN — INNER JOIN on a NULL user_id finds no user row.
  const d = setupDb();
  d.prepare(`INSERT INTO users (id, dcs_username) VALUES (1, 'bethoakes')`).run();
  d.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, new_version, action)
     VALUES ('verse', 'ZEC/1/3/ULT', 'ZEC', NULL, 1, 'create')`,
  ).run();
  const ref = { chapter: 1, verse: 3, overwrittenVersion: 1 };
  const { sql, keys } = buildEditorLookupQuery("ZEC", "ult", [ref]);
  const rows = d.prepare(sql).all("ZEC", ...keys);
  assert(rows.length === 0, "NULL user_id (no human author) -> no editor alert row, not a crash");
}

{
  // Multiple verses in one query (the real batched shape) each resolve to
  // their own correct author, not to each other.
  const d = setupDb();
  d.prepare(`INSERT INTO users (id, dcs_username) VALUES (1, 'bethoakes'), (2, 'Grant_Ailie')`).run();
  d.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, new_version, action) VALUES
       ('verse', 'ZEC/1/2/ULT', 'ZEC', 1, 3, 'update'),
       ('verse', 'ZEC/2/5/ULT', 'ZEC', 2, 6, 'update')`,
  ).run();
  const refs = [
    { chapter: 1, verse: 2, overwrittenVersion: 3 },
    { chapter: 2, verse: 5, overwrittenVersion: 6 },
  ];
  const { sql, keys } = buildEditorLookupQuery("ZEC", "ult", refs);
  const rows = d.prepare(sql).all("ZEC", ...keys);
  const byKey = new Map(rows.map((r) => [r.key, r.username]));
  assert(byKey.get(keys[0]) === "bethoakes", "first verse -> its own author");
  assert(byKey.get(keys[1]) === "Grant_Ailie", "second verse -> its own author");
}

{
  // The bind-parameter budget itself: D1 caps a prepared statement at 100
  // bind vars, and this query binds `book` + one key per ref. At
  // EDITOR_LOOKUP_CHUNK refs (90), total binds must stay comfortably under
  // that cap — this is the guard that lookupEditorUsernames's chunking loop
  // exists to enforce (a "1CH-scale" run has hit 174 verses in one night in
  // this codebase's own history, well past the un-chunked limit).
  const refs = Array.from({ length: EDITOR_LOOKUP_CHUNK }, (_, i) => ({
    chapter: 1,
    verse: i + 1,
    overwrittenVersion: 1,
  }));
  const { keys } = buildEditorLookupQuery("ZEC", "ult", refs);
  assert(keys.length === EDITOR_LOOKUP_CHUNK, "one key per ref");
  assert(1 + keys.length <= 100, "book + one chunk of keys stays under D1's 100 bind-variable cap");
}

// ─────────────────────────────────────────────────────────────────────────
// Part 3: verses.ts's PATCH route resolve-not-delete clause, against real
// SQLite. Uses the ACTUAL production SQL text (RESOLVE_VERSE_MERGE_CONFLICT_SQL,
// imported above from verseMergeConflictResolve.ts — the same pure-module
// split blankStub.ts uses for blankStubTrash.test.mjs) so this can't silently
// drift from what verses.ts really runs.
// ─────────────────────────────────────────────────────────────────────────

function verseDb() {
  const d = new DatabaseSync(":memory:");
  d.exec(`CREATE TABLE verse_merge_conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, book TEXT, resource TEXT, chapter INTEGER,
    verse INTEGER, action TEXT, reason TEXT, overwritten_version INTEGER, alignment TEXT,
    detected_at INTEGER, resolved_at INTEGER, resolved_by INTEGER
  )`);
  d.exec(`CREATE TABLE verses (
    book TEXT, chapter INTEGER, verse INTEGER, bible_version TEXT, version INTEGER,
    content_json TEXT, plain_text TEXT, updated_at INTEGER, updated_by INTEGER
  )`);
  return d;
}

// Runs the verses UPDATE first (so changes() reflects it), then the REAL
// resolve-clause SQL gated on `changes() > 0 AND resolved_at IS NULL`. The
// real batch has an edit_log INSERT in between (also gated on
// `changes() > 0` from the verses UPDATE) that this omits — safe to omit
// because that INSERT's own row count exactly mirrors the verses UPDATE's
// (`SELECT ... WHERE changes() > 0`, 0-or-1 either way), so `changes()` as
// seen by the resolve statement is identical whether or not the INSERT ran.
function saveVerse(d, { book, resource, chapter, verse, matchVersion, userId, now }) {
  const verseRes = d
    .prepare(
      `UPDATE verses SET version = version + 1, updated_at = ?1, updated_by = ?2
        WHERE book = ?3 AND chapter = ?4 AND verse = ?5 AND bible_version = ?6 AND version = ?7`,
    )
    .run(now, userId, book, chapter, verse, resource.toUpperCase(), matchVersion);
  const resolveRes = d
    .prepare(RESOLVE_VERSE_MERGE_CONFLICT_SQL)
    .run(now, userId, book, resource, chapter, verse);
  return { verseChanged: verseRes.changes, conflictResolved: resolveRes.changes };
}

{
  const d = verseDb();
  d.prepare(
    `INSERT INTO verses (book, chapter, verse, bible_version, version) VALUES ('ZEC', 1, 2, 'ULT', 3)`,
  ).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
     VALUES ('ZEC', 'ult', 1, 2, 'adopt_conflict', 'both_changed', 2, 100)`,
  ).run();

  const result = saveVerse(d, { book: "ZEC", resource: "ult", chapter: 1, verse: 2, matchVersion: 3, userId: 30, now: 200 });
  assert(result.verseChanged === 1 && result.conflictResolved === 1, "matching-version save resolves the conflict");

  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book = 'ZEC' AND chapter = 1 AND verse = 2`).get();
  assert(!!row, "the row still EXISTS — not deleted (the defect this fixes)");
  assert(row.resolved_at === 200, "resolved_at stamped with the save time");
  assert(row.resolved_by === 30, "resolved_by stamped with the saving user");
  assert(row.overwritten_version === 2, "overwritten_version recovery pointer is preserved, not erased");

  const activeCount = d
    .prepare(`SELECT COUNT(*) c FROM verse_merge_conflicts WHERE book = 'ZEC' AND resolved_at IS NULL`)
    .get().c;
  assert(activeCount === 0, "resolved row no longer counts as an ACTIVE conflict");
}

{
  // Version mismatch (the save loses the CAS race / a stale client) must not
  // resolve the conflict — see the comment in verses.ts about why this is
  // NOT equivalent to testing verses.version = newVersion.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verses (book, chapter, verse, bible_version, version) VALUES ('ZEC', 1, 2, 'ULT', 5)`,
  ).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
     VALUES ('ZEC', 'ult', 1, 2, 'adopt_conflict', 'both_changed', 4, 100)`,
  ).run();

  const result = saveVerse(d, { book: "ZEC", resource: "ult", chapter: 1, verse: 2, matchVersion: 3, userId: 30, now: 200 });
  assert(result.verseChanged === 0, "stale If-Match: the verse UPDATE itself changes nothing");
  assert(result.conflictResolved === 0, "…so the conflict is NOT resolved on a save that never landed");

  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book = 'ZEC' AND chapter = 1 AND verse = 2`).get();
  assert(row.resolved_at === null, "conflict remains unresolved");
}

{
  // A second save after the conflict is already resolved must not reassign
  // resolved_by to a different (later) user.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verses (book, chapter, verse, bible_version, version) VALUES ('ZEC', 1, 2, 'ULT', 3)`,
  ).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
     VALUES ('ZEC', 'ult', 1, 2, 'adopt_conflict', 'both_changed', 2, 100)`,
  ).run();

  saveVerse(d, { book: "ZEC", resource: "ult", chapter: 1, verse: 2, matchVersion: 3, userId: 30, now: 200 });
  const second = saveVerse(d, { book: "ZEC", resource: "ult", chapter: 1, verse: 2, matchVersion: 4, userId: 45, now: 300 });
  assert(second.verseChanged === 1, "second save lands (version now 4)");
  assert(second.conflictResolved === 0, "already-resolved row is not touched again");

  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book = 'ZEC' AND chapter = 1 AND verse = 2`).get();
  assert(row.resolved_at === 200 && row.resolved_by === 30, "first resolver's stamp is preserved, not overwritten");
}

{
  // deleteLostAdoptionConflicts stays a real DELETE — nothing was overwritten
  // for a CAS write that never landed, so there is nothing to mark resolved.
  // This just documents the boundary: the resolve-not-delete fix is scoped
  // to the human re-save path only.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
     VALUES ('ZEC', 'ult', 1, 2, 'adopt_conflict', 'both_changed', 2, 100)`,
  ).run();
  d.prepare(
    `DELETE FROM verse_merge_conflicts
      WHERE book = 'ZEC' AND resource = 'ult' AND chapter = 1 AND verse = 2
        AND action IN ('adopt', 'adopt_conflict')`,
  ).run();
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book = 'ZEC' AND chapter = 1 AND verse = 2`).get();
  assert(!row, "lost-adoption cleanup still deletes — that path never overwrote anything to resolve");
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("\nAll verseMergeConflicts tests passed");
}
