// Regression tests for the 2026-08-14 prod-audit fixes in
// verseMergeConflicts.ts / verses.ts, plus the follow-on fixes from the
// independent six-angle review of the first version of this PR:
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
//   marking resolved_at/resolved_by (migration 0049) instead, and filtering
//   "active" reads on resolved_at IS NULL.
//
//   REVIEW FIX 1 (re-detection invisibility, six-angle review) — the upsert
//   never reset resolved_at/resolved_by, so a verse that was resolved and
//   then genuinely conflicted AGAIN stayed invisible to every "active"
//   reader forever.
//
//   REVIEW FIX 3 (lost-adoption cleanup destroying audit rows, six-angle
//   review) — deleteLostAdoptionConflicts used to hard-delete
//   unconditionally; scoped so it can't destroy a row's prior (possibly
//   resolved) history just because a LATER, separate attempt on the same
//   verse lost its CAS race.
//
//   REVIEW FIX 6 (dismissal stickiness, six-angle review) — the alert was
//   unconditionally deleted-then-reinserted every run, so a dismissed alert
//   reappeared the very next run even with nothing new to report.
//
//   CODEX FIX (second-opinion review, supersedes the FIRST version of FIX 1
//   above) — that first version cleared resolved_at/resolved_by EAGERLY in
//   the speculative upsert, before the master-adoption CAS write even ran.
//   Codex found the real bug: if a verse carried an OLD, human-resolved
//   conflict, and this run's speculative adopt_conflict upsert cleared
//   resolved_at, but the CAS then LOST its race (nothing was actually
//   overwritten), the row was left FALSELY reactivated — an active alert for
//   an overwrite that never happened, with the original resolution's audit
//   trail destroyed. Fixed with two-phase reactivation: the speculative
//   upsert (UPSERT_VERSE_MERGE_CONFLICT_SQL) never touches
//   resolved_at/resolved_by at all; only confirmAdoptedConflicts
//   (CONFIRM_ADOPTED_CONFLICT_SQL), called AFTER the CAS batch confirms which
//   adoptions actually landed, clears them. A new last_recorded_at column
//   (separate from detected_at, which keeps its original "age of the
//   unresolved streak" meaning) lets deleteLostAdoptionConflicts recognize
//   "this row was touched by THIS run's speculative write" without needing
//   detected_at to double as that signal.
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
  alertMessageCarriesNoBaseWarning,
  buildEditorLookupQuery,
  buildGroupedRefsClause,
  buildMergeConflictGuidance,
  buildNoBaseSentence,
  EDITOR_LOOKUP_CHUNK,
  editLogKey,
  groupNoBaseVersesByEditor,
  groupOverwrittenVersesByEditor,
  MERGE_CONFLICT_REFS_DISPLAY,
  NO_BASE_REF_DISPLAY,
  planSystemAlertWrites,
} from "./verseMergeEditorAlerts.ts";
import {
  CONFIRM_ADOPTED_CONFLICT_SQL,
  DELETE_LOST_ADOPTION_CONFLICT_SQL,
  RESOLVE_VERSE_MERGE_CONFLICT_SQL,
  CLEAR_CONFLICT_ONLY_ALERTS_BY_SOURCE_SQL,
  CLEAR_CONFLICT_ONLY_ALERTS_BY_USER_SQL,
  SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL,
  UPSERT_VERSE_MERGE_CONFLICT_SQL,
  VERSE_PATCH_UPDATE_SQL,
} from "./verseMergeConflictSql.ts";

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
  // REVIEW FIX 4: this fires from both the 05:30 UTC cron AND the
  // user-triggered POST /:book/reimport route — "nightly" overclaims the
  // trigger on the latter, the same overclaim the admin message's own
  // "FIX I" already corrected.
  assert(!entry.message.includes("nightly"), "does not overclaim a nightly-only trigger");
  assert(entry.message.includes("Door43's sync"), "says \"sync\", not \"nightly sync\"");
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
  // Issue #633: name what differs. Wording-only must still offer text recovery;
  // alignment-only must NOT claim the words were replaced or tell them to re-save.
  const wordingOnly = [{ chapter: 40, verse: 5, overwrittenVersion: 8, reason: "both_changed_wording" }];
  const alignmentOnly = [{ chapter: 41, verse: 6, overwrittenVersion: 5, reason: "both_changed_alignment" }];
  const both = [{ chapter: 40, verse: 10, overwrittenVersion: 6, reason: "both_changed" }];
  const keyW = editLogKey("JER", "ult", wordingOnly[0]);
  const keyA = editLogKey("JER", "ult", alignmentOnly[0]);
  const keyB = editLogKey("JER", "ult", both[0]);
  const users = new Map([
    [keyW, "translator"],
    [keyA, "translator"],
    [keyB, "translator"],
  ]);

  const wMsg = groupOverwrittenVersesByEditor("JER", "ult", wordingOnly, users).get("translator").message;
  assert(wMsg.includes("The wording changed."), "wording-only names wording");
  assert(wMsg.includes("replaced text is still recoverable"), "wording-only still points at text recovery");
  assert(!wMsg.includes("re-save"), "overwrite alert never tells the editor to re-save");

  const aMsg = groupOverwrittenVersesByEditor("JER", "ult", alignmentOnly, users).get("translator").message;
  assert(aMsg.includes("The alignment changed (the wording did not)."), "alignment-only names alignment");
  assert(aMsg.includes("previous alignment is still recoverable"), "alignment-only recovers alignment, not 'replaced text'");
  assert(!aMsg.includes("replaced text"), "alignment-only must not claim the words were replaced");
  assert(!aMsg.includes("re-save"), "alignment-only never tells the editor to re-save");

  const bMsg = groupOverwrittenVersesByEditor("JER", "ult", both, users).get("translator").message;
  assert(bMsg.includes("The wording and the alignment changed."), "both-axes names both");
}

{
  // Issue #633 admin guidance: same wording vs alignment distinction.
  const w = buildMergeConflictGuidance([{ action: "adopt_conflict", reason: "both_changed_wording" }]);
  assert(w.includes("The wording changed."), "admin wording-only names wording");
  assert(w.includes("replaced text is still"), "admin wording-only keeps text recovery");

  const a = buildMergeConflictGuidance([{ action: "adopt_conflict", reason: "both_changed_alignment" }]);
  assert(a.includes("The alignment changed (the wording did not)."), "admin alignment-only names alignment");
  assert(a.includes("previous alignment is still"), "admin alignment-only recovers alignment");
  assert(!a.includes("replaced text"), "admin alignment-only must not claim replaced text");

  // adopt_no_visible_change is not alertable — if it somehow reached guidance
  // it is not an adopt_conflict, so it must not count as an overwrite.
  const silent = buildMergeConflictGuidance([{ action: "adopt_no_visible_change", reason: "both_changed_no_visible" }]);
  assert(!silent.includes("took Door43's version"), "no-visible-change action is not an overwrite sentence");
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
// Part 1b: groupNoBaseVersesByEditor (issue #544) — pure, no D1. The
// keep_no_base analogue of groupOverwrittenVersesByEditor above: NOTHING was
// overwritten, so the message must never claim otherwise, and the refs carry
// no "@vN" (there is no replaced version to point a reader at).
// ─────────────────────────────────────────────────────────────────────────

{
  // Two verses attributed to the same editor combine into one alert, keyed
  // off their CURRENT version (not an overwrittenVersion — nothing was
  // overwritten).
  const noBase = [
    { chapter: 1, verse: 2, version: 3 },
    { chapter: 1, verse: 5, version: 7 },
  ];
  const usernameByKey = new Map([
    [editLogKey("ZEC", "ult", { chapter: 1, verse: 2, overwrittenVersion: 3 }), "bethoakes"],
    [editLogKey("ZEC", "ult", { chapter: 1, verse: 5, overwrittenVersion: 7 }), "bethoakes"],
  ]);
  const grouped = groupNoBaseVersesByEditor("ZEC", "ult", noBase, usernameByKey);
  assert(grouped.size === 1, "two verses, one editor -> one alert entry");
  const entry = grouped.get("bethoakes");
  assert(!!entry, "keyed by username");
  assert(entry.refs.length === 2, "both refs collected");
  assert(entry.refs.includes("1:2") && entry.refs.includes("1:5"), "refs carry bare chapter:verse");
  assert(!entry.refs.some((r) => r.includes("@v")), "…and never an '@vN' suffix — nothing was overwritten");
  assert(entry.message.includes("ZEC"), "message names the book");
  assert(entry.message.includes("ULT"), "message names the resource, uppercased");
  assert(entry.message.includes("2 verse(s)"), "message states the count");
  assert(!/overwr(itten|ote|ites)/i.test(entry.message.replace("Nothing has been overwritten", "")),
    "message never claims an overwrite happened, aside from explicitly denying one");
  assert(entry.message.includes("Nothing has been overwritten"), "message explicitly denies an overwrite");
  assert(!entry.message.includes("nightly"), "does not overclaim a nightly-only trigger");
  assert(entry.message.includes("Door43's sync"), 'says "sync", not "nightly sync"');
}

{
  // Two different editors get two separate alert entries, not merged.
  const noBase = [
    { chapter: 2, verse: 1, version: 4 },
    { chapter: 3, verse: 9, version: 2 },
  ];
  const usernameByKey = new Map([
    [editLogKey("HOS", "ust", { chapter: 2, verse: 1, overwrittenVersion: 4 }), "pjoakes"],
    [editLogKey("HOS", "ust", { chapter: 3, verse: 9, overwrittenVersion: 2 }), "Carolyn1970"],
  ]);
  const grouped = groupNoBaseVersesByEditor("HOS", "ust", noBase, usernameByKey);
  assert(grouped.size === 2, "two editors -> two alert entries");
  assert(grouped.get("pjoakes").refs.length === 1, "pjoakes gets only their own verse");
  assert(grouped.get("Carolyn1970").refs.length === 1, "Carolyn1970 gets only their own verse");
}

{
  // No matching edit_log user (an AI edit, or the ancestor aged out) -> no
  // alert entry, the same silent-exclusion behavior as the overwritten case.
  const noBase = [{ chapter: 4, verse: 4, version: 1 }];
  const grouped = groupNoBaseVersesByEditor("MIC", "ult", noBase, new Map());
  assert(grouped.size === 0, "no username found -> no alert entry");
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
    detected_at INTEGER, resolved_at INTEGER, resolved_by INTEGER, last_recorded_at INTEGER
  )`);
  // Required for UPSERT_VERSE_MERGE_CONFLICT_SQL's `ON CONFLICT (book,
  // resource, chapter, verse)` clause to have anything to conflict against —
  // mirrors migration 0044's real verse_merge_conflicts_unique index.
  d.exec(
    `CREATE UNIQUE INDEX verse_merge_conflicts_unique ON verse_merge_conflicts (book, resource, chapter, verse)`,
  );
  d.exec(`CREATE TABLE verses (
    book TEXT, chapter INTEGER, verse INTEGER, bible_version TEXT, version INTEGER,
    content_json TEXT, plain_text TEXT, updated_at INTEGER, updated_by INTEGER,
    last_change_action TEXT, last_change_source TEXT, last_change_actor TEXT
  )`);
  // Migration 0023's real schema, for the #626 resolved-banner-clear tests below.
  d.exec(`CREATE TABLE system_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, severity TEXT NOT NULL,
    source TEXT NOT NULL, message TEXT NOT NULL, link_url TEXT,
    created_at INTEGER, dismissed_at INTEGER
  )`);
  return d;
}

// Replicates clearResolvedConflictBannerIfLast's exact decision (verses.ts's
// PATCH route, issue #626) against real SQLite, using the ACTUAL
// SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL text so this can't silently drift
// from what that function really queries. The DELETE mirrors
// the ACTUAL CLEAR_CONFLICT_ONLY_ALERTS_BY_* text — source-wide when every
// undismissed row is conflict-only, per-username when a keep_no_base message
// must stay (PR #631 review P1).
function clearResolvedBanner(d, book, resource, raceHook) {
  const active = d.prepare(SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL).all(book, resource);
  if (active.length > 0) return { cleared: false, preservedNoBase: false };
  const source = `verse_merge_conflict:${book}:${resource}`;
  const alerts = d
    .prepare(`SELECT username, message FROM system_alerts WHERE source = ? AND dismissed_at IS NULL`)
    .all(source);
  const toClear = alerts.filter((a) => !alertMessageCarriesNoBaseWarning(a.message));
  if (toClear.length === 0) {
    // Nothing undismissed to delete (only-dismissed history, or every
    // remaining row carries keep_no_base). The former is vacuously "cleared";
    // the latter is an intentional preserve.
    return { cleared: alerts.length === 0, preservedNoBase: alerts.length > 0 };
  }
  // `raceHook` lets a test simulate a reimport landing in the gap between the
  // decision above and the DELETE below (PR #631 Codex review) — the exact
  // window the NOT EXISTS inside both statements exists to close.
  if (raceHook) raceHook(d);
  let changes = 0;
  if (toClear.length === alerts.length) {
    changes = d.prepare(CLEAR_CONFLICT_ONLY_ALERTS_BY_SOURCE_SQL).run(source, book, resource).changes;
  } else {
    const del = d.prepare(CLEAR_CONFLICT_ONLY_ALERTS_BY_USER_SQL);
    for (const a of toClear) changes += del.run(a.username, source, book, resource).changes;
  }
  return { cleared: changes > 0, preservedNoBase: toClear.length < alerts.length };
}

// Runs the REAL verses.ts PATCH-route UPDATE (VERSE_PATCH_UPDATE_SQL) first
// (so changes() reflects it), then the REAL resolve-clause SQL gated on
// `changes() > 0 AND resolved_at IS NULL`. The real batch has an edit_log
// INSERT in between (also gated on `changes() > 0` from the verses UPDATE)
// that this omits — safe to omit because that INSERT's own row count exactly
// mirrors the verses UPDATE's (`SELECT ... WHERE changes() > 0`, 0-or-1
// either way), so `changes()` as seen by the resolve statement is identical
// whether or not the INSERT ran.
function saveVerse(d, { book, resource, chapter, verse, matchVersion, userId, now, contentJson = "{}" }) {
  const verseRes = d
    .prepare(VERSE_PATCH_UPDATE_SQL)
    .run(contentJson, null, now, userId, "update", "user", "test-actor", book, chapter, verse, resource.toUpperCase(), matchVersion);
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

// ─────────────────────────────────────────────────────────────────────────
// Part 3b: clearResolvedConflictBannerIfLast (issue #626). The banner alert
// used to be frozen at whatever the last sync run wrote, even after a human
// resolved every conflict it named — nothing rewrote it until the next
// reimport. verses.ts's PATCH route now calls this after a save resolves a
// conflict row, to clear the (book, resource) banner immediately when that
// was the LAST active alertable conflict outstanding.
// ─────────────────────────────────────────────────────────────────────────

{
  // The measured case from the issue: JER ULT had 3 active conflicts; a
  // human resolves the only source_attr_ambiguous one; two both_changed_ai_master
  // rows remain. The banner must NOT be cleared — a partially-stale banner
  // (still correctly naming the two survivors, if stale on the exact count)
  // beats fabricating a fresh count from a fragment.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at)
     VALUES ('JER', 'ult', 42, 6, 'keep_ai_master', 'both_changed_ai_master', NULL, 100, NULL)`,
  ).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at)
     VALUES ('JER', 'ult', 42, 11, 'keep_ai_master', 'both_changed_ai_master', NULL, 100, NULL)`,
  ).run();
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('deferredreward', 'warning', 'verse_merge_conflict:JER:ult', 'Sync flagged 3 verse(s)...')`,
  ).run();

  const cleared = clearResolvedBanner(d, "JER", "ult");
  assert(!cleared.cleared, "two conflicts still outstanding -> banner is left alone, not cleared");
  const alert = d.prepare(`SELECT * FROM system_alerts WHERE source = 'verse_merge_conflict:JER:ult'`).get();
  assert(!!alert, "the (stale but not wrong-count) banner row still exists");
}

{
  // The success case: the one remaining conflict for (book, resource) gets
  // resolved. The banner — both the admin's row and an editor's fan-out row,
  // same source — disappears immediately, not on the next sync.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at)
     VALUES ('JER', 'ult', 41, 8, 'source_attr_divergent', 'source_attr_ambiguous', NULL, 100, 12345)`,
  ).run();
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('deferredreward', 'warning', 'verse_merge_conflict:JER:ult', 'Sync flagged 1 verse(s)...')`,
  ).run();
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('bethoakes', 'warning', 'verse_merge_conflict:JER:ult', 'Your edit at JER 41:8 was overwritten...')`,
  ).run();

  const cleared = clearResolvedBanner(d, "JER", "ult");
  assert(cleared.cleared, "the last active conflict just resolved -> banner is cleared");
  const remaining = d.prepare(`SELECT * FROM system_alerts WHERE source = 'verse_merge_conflict:JER:ult'`).all();
  assert(remaining.length === 0, "cleared by SOURCE — both the admin's row and the editor's fan-out row are gone");
}

{
  // PR #631 Codex review: the "is this the last one?" decision and the DELETE
  // are separate round-trips. A reimport landing in that gap records a fresh
  // conflict and raises its banner — and the now-stale clear used to delete
  // that brand-new warning, leaving a real divergence unannounced until the
  // next sync. The NOT EXISTS inside the DELETE must make the clear a no-op.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at)
     VALUES ('JER', 'ult', 41, 8, 'source_attr_divergent', 'source_attr_ambiguous', NULL, 100, 12345)`,
  ).run();
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('deferredreward', 'warning', 'verse_merge_conflict:JER:ult', 'Sync flagged 1 verse(s)...')`,
  ).run();

  const cleared = clearResolvedBanner(d, "JER", "ult", (db) => {
    // The interleaved reimport: a new conflict row, then its refreshed banner.
    db.prepare(
      `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at)
       VALUES ('JER', 'ult', 43, 2, 'adopt_conflict', 'both_changed', 7, 200, NULL)`,
    ).run();
    db.prepare(`DELETE FROM system_alerts WHERE source = 'verse_merge_conflict:JER:ult' AND dismissed_at IS NULL`).run();
    db.prepare(
      `INSERT INTO system_alerts (username, severity, source, message)
       VALUES ('deferredreward', 'warning', 'verse_merge_conflict:JER:ult', 'Sync flagged 1 verse(s) in JER ULT... Refs: 43:2.')`,
    ).run();
  });

  assert(!cleared.cleared, "a conflict recorded mid-flight makes the stale clear a no-op");
  const alert = d.prepare(`SELECT * FROM system_alerts WHERE source = 'verse_merge_conflict:JER:ult'`).get();
  assert(!!alert, "the reimport's fresh banner survives the racing clear");
  assert(alert.message.includes("43:2"), "…and it is the NEW banner, naming the newly-flagged verse");
}

{
  // A dismissed banner row must be left alone even when every conflict for
  // that (book, resource) resolves — the same invariant
  // clearUndismissedAlertsStmt documents for every other clear in this file.
  const d = verseDb();
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message, dismissed_at)
     VALUES ('deferredreward', 'warning', 'verse_merge_conflict:JER:ult', 'Sync flagged 1 verse(s)...', 999)`,
  ).run();

  const cleared = clearResolvedBanner(d, "JER", "ult");
  assert(cleared.cleared, "zero active conflicts -> the clear still runs");
  const alert = d.prepare(`SELECT * FROM system_alerts WHERE source = 'verse_merge_conflict:JER:ult'`).get();
  assert(!!alert && alert.dismissed_at === 999, "…but a DISMISSED row is never touched — it stays as history");
}

{
  // A banner for a DIFFERENT (book, resource) sharing no active conflicts
  // must not be collaterally cleared just because JER ULT's own resolve ran
  // through this same call.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at)
     VALUES ('EZK', 'ust', 26, 17, 'source_attr_divergent', 'source_attr_ambiguous', NULL, 100, NULL)`,
  ).run();
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('deferredreward', 'warning', 'verse_merge_conflict:EZK:ust', 'Sync flagged 1 verse(s)...')`,
  ).run();
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('deferredreward', 'warning', 'verse_merge_conflict:JER:ult', 'stale JER banner, nothing active')`,
  ).run();

  const cleared = clearResolvedBanner(d, "JER", "ult");
  assert(cleared.cleared, "JER ult has zero active conflicts -> its own banner clears");
  const ezkAlert = d.prepare(`SELECT * FROM system_alerts WHERE source = 'verse_merge_conflict:EZK:ust'`).get();
  assert(!!ezkAlert, "EZK ust's own still-active banner is untouched by JER ult's clear");
}

{
  // PR #631 review P1: keep_no_base warnings ride in the banner message via
  // noBaseCount at raise time and have NO verse_merge_conflicts row. Resolving
  // the last ordinary conflict must NOT erase an alert that still warns about
  // unresolved no-ancestor verses.
  const d = verseDb();
  const adminMsg =
    `Sync flagged 1 verse(s) in JER ULT for review (1 source_attr_ambiguous). Refs: 41:8. ` +
    buildNoBaseSentence(2, ["42:2", "42:3"]);
  const editorOverwrite = "Your edit at JER 41:8 was overwritten by Door43's sync...";
  const editorNoBase = groupNoBaseVersesByEditor(
    "JER",
    "ult",
    [{ chapter: 42, verse: 2, version: 5 }],
    new Map([[editLogKey("JER", "ult", { chapter: 42, verse: 2, overwrittenVersion: 5 }), "bethoakes"]]),
  ).get("bethoakes").message;

  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('deferredreward', 'warning', 'verse_merge_conflict:JER:ult', ?)`,
  ).run(adminMsg);
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('grant', 'warning', 'verse_merge_conflict:JER:ult', ?)`,
  ).run(editorOverwrite);
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('bethoakes', 'warning', 'verse_merge_conflict:JER:ult', ?)`,
  ).run(editorNoBase);

  assert(alertMessageCarriesNoBaseWarning(adminMsg), "admin mixed message carries the no-base fingerprint");
  assert(alertMessageCarriesNoBaseWarning(editorNoBase), "editor no-base fan-out carries its fingerprint");
  assert(!alertMessageCarriesNoBaseWarning(editorOverwrite), "overwrite-only fan-out does not");

  const result = clearResolvedBanner(d, "JER", "ult");
  assert(result.cleared && result.preservedNoBase, "cleared conflict-only rows but preserved keep_no_base carriers");

  const remaining = d
    .prepare(`SELECT username, message FROM system_alerts WHERE source = 'verse_merge_conflict:JER:ult' ORDER BY username`)
    .all();
  assert(remaining.length === 2, "admin + bethoakes kept; grant's overwrite-only alert dropped");
  assert(
    remaining.map((r) => r.username).join(",") === "bethoakes,deferredreward",
    "preserved usernames are the keep_no_base carriers",
  );
  assert(
    remaining.every((r) => alertMessageCarriesNoBaseWarning(r.message)),
    "every surviving alert still carries the outstanding no-base condition",
  );
}

{
  // Pure keep_no_base banner (zero adjudicated conflicts at raise time): zero
  // active table rows must leave it untouched — there was never a conflict row
  // to resolve, and clearing would drop the only warning that exists.
  const d = verseDb();
  const msg = `Sync flagged 0 verse(s) in EZK UST for adjudicated review. ${buildNoBaseSentence(3, ["21:9"])}`;
  d.prepare(
    `INSERT INTO system_alerts (username, severity, source, message)
     VALUES ('deferredreward', 'warning', 'verse_merge_conflict:EZK:ust', ?)`,
  ).run(msg);

  const result = clearResolvedBanner(d, "EZK", "ust");
  assert(!result.cleared && result.preservedNoBase, "pure keep_no_base banner is not cleared");
  const alert = d.prepare(`SELECT * FROM system_alerts WHERE source = 'verse_merge_conflict:EZK:ust'`).get();
  assert(!!alert, "…the row is still there");
}

// ─────────────────────────────────────────────────────────────────────────
// Part 4: TWO-PHASE REACTIVATION (Codex second-opinion review fix). The
// speculative upsert (UPSERT_VERSE_MERGE_CONFLICT_SQL, step 6b — runs BEFORE
// the master-adoption CAS batch) must NEVER touch resolved_at/resolved_by.
// Only confirmAdoptedConflicts (CONFIRM_ADOPTED_CONFLICT_SQL), called AFTER
// the CAS batch confirms which adoptions actually landed, may clear them.
// This is what makes a lost CAS race safe: nothing was cleared speculatively,
// so there is nothing to undo.
// ─────────────────────────────────────────────────────────────────────────

function upsertConflict(
  d,
  { book, resource, chapter, verse, action, reason, overwrittenVersion, now, bibleVersion = null, observedVersion = null },
) {
  return d
    .prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL)
    .run(book, resource, chapter, verse, action, reason, overwrittenVersion, null, now, bibleVersion, observedVersion);
}

function confirmAdopted(d, { book, resource, chapter, verse }) {
  return d.prepare(CONFIRM_ADOPTED_CONFLICT_SQL).run(book, resource, chapter, verse);
}

{
  // *** THE EXACT CODEX SCENARIO — CAS LOSES ***
  // A verse has an OLD, human-resolved conflict (real audit history: a real
  // resolved_by and overwritten_version). A later sync computes a fresh
  // adopt_conflict and step 6b's speculative upsert runs — but the
  // adoption's CAS write then LOSES its race (a human saved first; nothing
  // was actually overwritten). The row must end up STILL RESOLVED, with its
  // ORIGINAL resolved_at/resolved_by intact, and NOT active.
  const d = verseDb();
  upsertConflict(d, {
    book: "ZEC", resource: "ult", chapter: 6, verse: 1,
    action: "adopt_conflict", reason: "both_changed", overwrittenVersion: 2, now: 100,
  });
  d.prepare(RESOLVE_VERSE_MERGE_CONFLICT_SQL).run(150, 30, "ZEC", "ult", 6, 1);
  {
    const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='ZEC' AND chapter=6 AND verse=1`).get();
    assert(row.resolved_at === 150 && row.resolved_by === 30, "sanity: resolved before tonight's re-detection");
  }

  // Tonight: step 6b's speculative upsert runs BEFORE the CAS attempt.
  const tonight = 5000;
  upsertConflict(d, {
    book: "ZEC", resource: "ult", chapter: 6, verse: 1,
    action: "adopt_conflict", reason: "both_changed", overwrittenVersion: 9, now: tonight,
  });
  {
    // Immediately after the SPECULATIVE upsert — before we know whether the
    // CAS will land — resolved_at/resolved_by must be COMPLETELY UNCHANGED.
    // This is the core two-phase guarantee: the speculative step never
    // clears them, so there is nothing to falsely reactivate.
    const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='ZEC' AND chapter=6 AND verse=1`).get();
    assert(row.resolved_at === 150 && row.resolved_by === 30, "speculative upsert alone does NOT touch resolved_at/resolved_by");
  }

  // Tonight's CAS attempt LOSES its race (a human saved first).
  d.prepare(DELETE_LOST_ADOPTION_CONFLICT_SQL).run("ZEC", "ult", 6, 1, tonight);

  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='ZEC' AND chapter=6 AND verse=1`).get();
  assert(!!row, "row SURVIVES a lost CAS on a previously-resolved verse");
  assert(row.resolved_at === 150, "ORIGINAL resolved_at is intact — not cleared, not re-stamped");
  assert(row.resolved_by === 30, "ORIGINAL resolved_by is intact — the true resolver, not lost");
  const activeCount = d
    .prepare(`SELECT COUNT(*) c FROM verse_merge_conflicts WHERE book='ZEC' AND resolved_at IS NULL`)
    .get().c;
  assert(activeCount === 0, "row does NOT show as an active conflict — no false alert for an overwrite that never happened");
}

{
  // *** THE SIBLING SCENARIO — CAS WINS ***
  // Same starting state (a resolved conflict with real history), but this
  // time the adoption's CAS write actually LANDS. The row must become
  // genuinely active — this is the re-detection-visibility guarantee from
  // the six-angle review, now delivered via the CONFIRMING phase instead of
  // the unsafe eager clear.
  const d = verseDb();
  upsertConflict(d, {
    book: "ZEC", resource: "ult", chapter: 6, verse: 2,
    action: "adopt_conflict", reason: "both_changed", overwrittenVersion: 2, now: 100,
  });
  d.prepare(RESOLVE_VERSE_MERGE_CONFLICT_SQL).run(150, 30, "ZEC", "ult", 6, 2);

  const tonight = 5000;
  upsertConflict(d, {
    book: "ZEC", resource: "ult", chapter: 6, verse: 2,
    action: "adopt_conflict", reason: "both_changed", overwrittenVersion: 9, now: tonight,
  });
  {
    const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='ZEC' AND chapter=6 AND verse=2`).get();
    assert(row.resolved_at === 150, "still dormant immediately after the speculative upsert, CAS not yet attempted");
  }

  // Tonight's CAS attempt LANDS — confirmAdoptedConflicts is called for
  // exactly this ref (bookReimport.ts's landedAdoptions).
  confirmAdopted(d, { book: "ZEC", resource: "ult", chapter: 6, verse: 2 });

  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='ZEC' AND chapter=6 AND verse=2`).get();
  assert(row.resolved_at === null, "CONFIRMED landed adoption -> resolved_at cleared, genuinely active");
  assert(row.resolved_by === null, "resolved_by cleared alongside resolved_at");
  const activeCount = d
    .prepare(`SELECT COUNT(*) c FROM verse_merge_conflicts WHERE book='ZEC' AND chapter=6 AND verse=2 AND resolved_at IS NULL`)
    .get().c;
  assert(activeCount === 1, "now visible to the same query the banner and GET route use");

  // Documented, deliberately NOT fixed here (unchanged from the six-angle
  // review): the pre-existing "keep the EARLIEST pointer" COALESCE means
  // overwritten_version still shows the OLD (v2) pointer, not tonight's real
  // v9 overwrite. Pinned so a future change to the CASE logic is deliberate.
  assert(row.overwritten_version === 2, "documented limitation: overwritten_version still shows the OLD pointer (v2), not v9");
}

{
  // A verse that was NEVER resolved just continues normally — resolved_at
  // stays NULL throughout (the common, everyday case). The speculative
  // upsert never touches resolved_at at all, so there's nothing to reset.
  const d = verseDb();
  upsertConflict(d, {
    book: "HOS", resource: "ust", chapter: 2, verse: 1,
    action: "keep_alignment_refused", reason: "alignment_shrink", overwrittenVersion: null, now: 100,
  });
  upsertConflict(d, {
    book: "HOS", resource: "ust", chapter: 2, verse: 1,
    action: "keep_alignment_refused", reason: "alignment_shrink", overwrittenVersion: null, now: 200,
  });
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='HOS' AND chapter=2 AND verse=1`).get();
  assert(row.resolved_at === null, "never-resolved row: stays active, untouched");
  assert(row.detected_at === 100, "detected_at preserved across a still-unresolved re-detection (its ORIGINAL, unchanged meaning)");
  assert(row.last_recorded_at === 200, "last_recorded_at DOES refresh on every upsert — that's its whole job");
}

// ─────────────────────────────────────────────────────────────────────────
// Part 5: lost-adoption cleanup must not destroy a row's prior history just
// because a LATER, unrelated CAS attempt on the same verse lost its race.
// DELETE_LOST_ADOPTION_CONFLICT_SQL is scoped to
// `last_recorded_at = ?5 AND resolved_at IS NULL` for exactly this reason —
// see verseMergeConflictSql.ts's doc comment for why last_recorded_at (not
// detected_at) is the right signal for "touched by this run".
// ─────────────────────────────────────────────────────────────────────────

{
  // Case A (the case this cleanup exists for): a BRAND NEW row this run,
  // whose speculative adopt attempt then loses its CAS race. last_recorded_at
  // was set to THIS run's `now` on insert, so it matches and is deleted —
  // identical to the pre-review-round behavior for a genuinely fresh row.
  const d = verseDb();
  const now = 9999;
  upsertConflict(d, {
    book: "ZEC", resource: "ult", chapter: 5, verse: 5,
    action: "adopt_conflict", reason: "both_changed", overwrittenVersion: 3, now,
  });
  d.prepare(DELETE_LOST_ADOPTION_CONFLICT_SQL).run("ZEC", "ult", 5, 5, now);
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='ZEC' AND chapter=5 AND verse=5`).get();
  assert(!row, "brand-new-this-run speculative row: still deleted when its CAS is lost (matches original behavior)");
}

{
  // Case B: a row still-active (never resolved) from a prior night, re-hit
  // by a fresh event this run whose CAS attempt loses. This row was NEVER
  // specially protected (only a RESOLVED row's resolved_at IS NULL exclusion
  // protects it) — it is still deleted, matching this cleanup's original,
  // pre-review behavior for the never-resolved case. (The resolved case is
  // covered exhaustively in Part 4 above.)
  const d = verseDb();
  upsertConflict(d, {
    book: "MIC", resource: "ult", chapter: 1, verse: 1,
    action: "adopt_conflict", reason: "both_changed", overwrittenVersion: 4, now: 100,
  });
  const tonight = 5000;
  upsertConflict(d, {
    book: "MIC", resource: "ult", chapter: 1, verse: 1,
    action: "adopt_conflict", reason: "both_changed", overwrittenVersion: 4, now: tonight,
  });
  d.prepare(DELETE_LOST_ADOPTION_CONFLICT_SQL).run("MIC", "ult", 1, 1, tonight);
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='MIC' AND chapter=1 AND verse=1`).get();
  assert(!row, "never-resolved row re-touched this run: still deleted on a lost CAS, unregressed from original behavior");
}

{
  // Case C: the resolved-row protection from Part 4, restated here to
  // confirm it holds via the DELETE statement directly (not just via the
  // full upsert-then-delete sequence already exercised above): a resolved
  // row's resolved_at IS NULL exclusion means the delete never matches it,
  // regardless of last_recorded_at.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by, last_recorded_at)
     VALUES ('ZEC', 'ult', 7, 7, 'adopt_conflict', 'both_changed', 2, 50, 150, 30, 5000)`,
  ).run();
  d.prepare(DELETE_LOST_ADOPTION_CONFLICT_SQL).run("ZEC", "ult", 7, 7, 5000);
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='ZEC' AND chapter=7 AND verse=7`).get();
  assert(!!row && row.resolved_at === 150, "a resolved row is excluded from the delete purely by resolved_at IS NULL, even with a matching last_recorded_at");
}

// ─────────────────────────────────────────────────────────────────────────
// Part 6: REVIEW FIX 6 — dismissal stickiness. planSystemAlertWrites is
// pure, no D1 needed.
// ─────────────────────────────────────────────────────────────────────────

{
  // Nothing existed before: everything in `desired` must be inserted.
  const desired = new Map([["deferredreward", "admin message"], ["bethoakes", "editor message"]]);
  const { toDelete, toInsert } = planSystemAlertWrites(new Map(), desired);
  assert(toDelete.length === 0, "nothing to delete on a clean slate");
  assert(toInsert.length === 2, "both desired alerts get inserted");
}

{
  // The exact bug: a dismissed alert with IDENTICAL content must NOT
  // reappear just because this run re-derived the same conclusion again.
  const existing = new Map([["deferredreward", { message: "same message", dismissedAt: 12345 }]]);
  const desired = new Map([["deferredreward", "same message"]]);
  const { toDelete, toInsert } = planSystemAlertWrites(existing, desired);
  assert(toInsert.length === 0, "sticky: identical dismissed content is not resurrected");
  assert(toDelete.length === 0, "a dismissed row is never deleted either (stays as history)");
}

{
  // Content genuinely CHANGED since the dismissal (e.g. more verses now
  // affected) — this is new information the user hasn't seen, so it must
  // surface again despite the earlier dismissal.
  const existing = new Map([["deferredreward", { message: "1 verse affected", dismissedAt: 12345 }]]);
  const desired = new Map([["deferredreward", "3 verses affected"]]);
  const { toDelete, toInsert } = planSystemAlertWrites(existing, desired);
  assert(toInsert.length === 1 && toInsert[0].message === "3 verses affected", "changed content re-surfaces");
  assert(toDelete.length === 0, "the OLD dismissed row is left alone, not deleted (it's history, not being replaced)");
}

{
  // An UNDISMISSED alert with identical content: no-op, avoid pointless
  // churn (no fresh created_at, no wasted write).
  const existing = new Map([["deferredreward", { message: "same message", dismissedAt: null }]]);
  const desired = new Map([["deferredreward", "same message"]]);
  const { toDelete, toInsert } = planSystemAlertWrites(existing, desired);
  assert(toDelete.length === 0 && toInsert.length === 0, "identical undismissed content: touch nothing");
}

{
  // An UNDISMISSED alert whose content changed: replace it (delete then
  // insert) — this is the ordinary "conditions changed" refresh path.
  const existing = new Map([["deferredreward", { message: "1 verse affected", dismissedAt: null }]]);
  const desired = new Map([["deferredreward", "2 verses affected"]]);
  const { toDelete, toInsert } = planSystemAlertWrites(existing, desired);
  assert(toDelete.length === 1 && toDelete[0] === "deferredreward", "stale undismissed content is cleared");
  assert(toInsert.length === 1 && toInsert[0].message === "2 verses affected", "fresh content is inserted");
}

{
  // A username no longer in `desired` at all (their conflicts all resolved
  // or converged) with an UNDISMISSED row: must be cleared, not left stale.
  const existing = new Map([["bethoakes", { message: "old message", dismissedAt: null }]]);
  const { toDelete, toInsert } = planSystemAlertWrites(existing, new Map());
  assert(toDelete.length === 1 && toDelete[0] === "bethoakes", "stale undismissed alert for a resolved user is cleared");
  assert(toInsert.length === 0, "nothing to insert — they have no active conflicts anymore");
}

{
  // Same, but the row was already DISMISSED: leave it as historical record,
  // don't touch it either way.
  const existing = new Map([["bethoakes", { message: "old message", dismissedAt: 999 }]]);
  const { toDelete, toInsert } = planSystemAlertWrites(existing, new Map());
  assert(toDelete.length === 0, "a dismissed, now-irrelevant alert is left alone as history");
  assert(toInsert.length === 0, "nothing to insert for a dismissed, now-irrelevant alert");
}

// ─────────────────────────────────────────────────────────────────────────
// Part 7: 'source_attr_divergent' — surfacing the un-adopted master
// original-language source fix on an edited verse (the EZK 40
// repeated-architecture-terms case). The reconcile can't place master's
// curated x-content/x-lemma/x-morph fix when the same source word repeats, so
// it keeps D1 and (this change) records a keep-D1 conflict for review instead
// of only a counter + log line. Nothing was overwritten, so it must behave
// like keep_alignment_refused: NULL recovery pointer, surfaced in the banner,
// classified as "kept D1" (never "took Door43's version"), cleared on re-save.
// ─────────────────────────────────────────────────────────────────────────

{
  // The UPSERT stores a keep-D1 divergence with a NULL recovery pointer even
  // if a null overwrittenVersion is bound — and the CASE forces NULL for this
  // action, so a verse that carried an OLD adopt_conflict pointer can never
  // report a stale @v recovery pointer once it becomes source_attr_divergent.
  const d = verseDb();
  d.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "EZK", "ult", 40, 21, "source_attr_divergent", "source_attr_ambiguous", null, null, 1000, null, null,
  );
  let row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='EZK' AND chapter=40 AND verse=21`).get();
  assert(row.action === "source_attr_divergent" && row.overwritten_version === null,
    "source_attr_divergent stored with a NULL overwritten_version (nothing was replaced)");

  // Re-upsert the SAME verse as if it had earlier been an adopt_conflict with a
  // real pointer, then diverge again: the pointer must be forced back to NULL.
  const d2 = verseDb();
  d2.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "EZK", "ult", 40, 21, "adopt_conflict", "both_changed", 7, null, 1000, null, null,
  );
  d2.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "EZK", "ult", 40, 21, "source_attr_divergent", "source_attr_ambiguous", null, null, 2000, null, null,
  );
  row = d2.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='EZK' AND chapter=40 AND verse=21`).get();
  assert(row.action === "source_attr_divergent" && row.overwritten_version === null,
    "a verse that becomes source_attr_divergent drops any prior overwritten_version pointer (never misdirects a reviewer)");
}

{
  // The banner's active-conflict filter (the REAL production constant) surfaces
  // a source_attr_divergent row, EXCLUDES a clean 'adopt' (audit-only), and
  // EXCLUDES a resolved row.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
     VALUES ('EZK','ult',40,21,'source_attr_divergent','source_attr_ambiguous',NULL,100)`,
  ).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
     VALUES ('EZK','ult',40,22,'adopt','master_unchanged',5,100)`,
  ).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by)
     VALUES ('EZK','ult',40,23,'source_attr_divergent','source_attr_ambiguous',NULL,100,150,30)`,
  ).run();
  const rows = d.prepare(SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL).all("EZK", "ult");
  assert(rows.length === 1, "banner filter returns exactly the one active, alertable row");
  assert(rows[0].verse === 21 && rows[0].action === "source_attr_divergent",
    "…which is the unresolved source_attr_divergent row (not the audit-only 'adopt', not the resolved one)");

  // #540 item 2. A keep_ai_master row is alertable too — it is the one outcome
  // whose whole purpose is to be looked at before the export publishes it.
  // Missing from this filter, the policy would fire silently.
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
     VALUES ('EZK','ult',40,24,'keep_ai_master','both_changed_ai_master',NULL,100)`,
  ).run();
  const withAi = d.prepare(SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL).all("EZK", "ult");
  assert(withAi.some((r) => r.verse === 24 && r.action === "keep_ai_master"),
    "the banner filter surfaces a keep_ai_master row");

  // Issue #633: adopt_no_visible_change is audit-only, same as clean adopt —
  // wording + alignment groups matched, so it must never reach the banner.
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
     VALUES ('EZK','ult',40,25,'adopt_no_visible_change','both_changed_no_visible',8,100)`,
  ).run();
  const withSilent = d.prepare(SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL).all("EZK", "ult");
  assert(!withSilent.some((r) => r.verse === 25),
    "adopt_no_visible_change is excluded from the banner filter (audit only)");
  assert(withSilent.some((r) => r.verse === 24),
    "…without dropping other alertable rows");
}

{
  // #540 item 2, the two upsert rules a keep_ai_master row shares with the other
  // kept-D1 outcomes: it never carries an overwritten_version pointer (nothing
  // was overwritten, so the pointer would misdirect a reviewer), and
  // re-detecting it REACTIVATES a row a human resolved without fixing the
  // underlying disagreement — the condition is still live, and unlike an
  // adoption there is no CAS that could lose its race and falsely reactivate.
  const d = verseDb();
  d.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "AMO", "ult", 4, 2, "adopt_conflict", "both_changed", 9, null, 1000,
  );
  d.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "AMO", "ult", 4, 2, "keep_ai_master", "both_changed_ai_master", null, null, 2000,
  );
  let row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='AMO' AND chapter=4 AND verse=2`).get();
  assert(row.action === "keep_ai_master" && row.overwritten_version === null,
    "a verse that becomes keep_ai_master drops any prior overwritten_version pointer");

  d.prepare(`UPDATE verse_merge_conflicts SET resolved_at=1500, resolved_by=30 WHERE book='AMO'`).run();
  d.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "AMO", "ult", 4, 2, "keep_ai_master", "both_changed_ai_master", null, null, 3000,
  );
  row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='AMO' AND chapter=4 AND verse=2`).get();
  assert(row.resolved_at === null && row.resolved_by === null,
    "re-detecting keep_ai_master reactivates a row resolved while the disagreement persists");

  // But a later clean 'adopt' DOES take it out of the banner — the opposite of
  // adopt_conflict's anti-downgrade rule, and deliberately so: nothing was
  // overwritten, so there is nothing to recover, and master's value having been
  // adopted since means the disagreement resolved. Left sticky, the banner would
  // keep claiming the editor's version was kept and is about to be published,
  // about a verse that has since taken master's.
  d.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "AMO", "ult", 4, 2, "adopt", "master_only", 11, null, 4000,
  );
  row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='AMO' AND chapter=4 AND verse=2`).get();
  assert(row.action === "adopt",
    "a later clean 'adopt' retires a keep_ai_master row from the banner");

  // …while adopt_conflict's own anti-downgrade is untouched by that.
  const d2 = verseDb();
  d2.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "AMO", "ult", 5, 1, "adopt_conflict", "both_changed", 4, null, 1000,
  );
  d2.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "AMO", "ult", 5, 1, "adopt", "master_only", 6, null, 2000,
  );
  assert(
    d2.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='AMO' AND chapter=5`).get().action === "adopt_conflict",
    "an adopt_conflict is still protected from a later routine adoption",
  );
}

{
  // Re-saving the flagged verse resolves it, via the SAME action-agnostic
  // RESOLVE SQL every other conflict uses — no special path needed.
  const d = verseDb();
  d.prepare(`INSERT INTO verses (book, chapter, verse, bible_version, version) VALUES ('EZK', 40, 21, 'ULT', 4)`).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at)
     VALUES ('EZK','ult',40,21,'source_attr_divergent','source_attr_ambiguous',NULL,100)`,
  ).run();
  const res = saveVerse(d, { book: "EZK", resource: "ult", chapter: 40, verse: 21, matchVersion: 4, userId: 30, now: 200 });
  assert(res.verseChanged === 1 && res.conflictResolved === 1, "saving the verse resolves the source_attr_divergent flag");
  const active = d
    .prepare(`SELECT COUNT(*) c FROM verse_merge_conflicts WHERE book='EZK' AND resolved_at IS NULL`)
    .get().c;
  assert(active === 0, "no active conflict remains after the human re-saves");
}

{
  // REACTIVATION: a source_attr_divergent flag that a human resolved with an
  // UNRELATED save, while the divergence PERSISTS, must re-surface on the next
  // night's re-detection (this action has no CAS race, so reactivating in the
  // speculative upsert is safe — unlike adoptions). Without this it would go
  // silent forever and the export would keep reverting master's source fix.
  const d = verseDb();
  // Night 1: flagged, then resolved by an unrelated save.
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by, last_recorded_at)
     VALUES ('EZK','ult',40,21,'source_attr_divergent','source_attr_ambiguous',NULL,100,150,30,100)`,
  ).run();
  // Night 2: re-detected (divergence still present) → speculative re-upsert.
  d.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "EZK", "ult", 40, 21, "source_attr_divergent", "source_attr_ambiguous", null, null, 2000, null, null,
  );
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='EZK' AND chapter=40 AND verse=21`).get();
  assert(row.resolved_at === null && row.resolved_by === null,
    "re-detecting a resolved source_attr_divergent reactivates it (no CAS race → safe to clear in the upsert)");
  assert(row.detected_at === 100, "detected_at (age of the streak) is preserved across reactivation");

  // CONTROL: the carve-out is scoped — a re-upserted ADOPTION must NOT be
  // reactivated by the speculative upsert (the two-phase invariant stands).
  const d2 = verseDb();
  d2.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by, last_recorded_at)
     VALUES ('EZK','ult',40,22,'adopt_conflict','both_changed',7,100,150,30,100)`,
  ).run();
  d2.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "EZK", "ult", 40, 22, "adopt_conflict", "both_changed", 7, null, 2000, null, null,
  );
  const row2 = d2.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='EZK' AND chapter=40 AND verse=22`).get();
  assert(row2.resolved_at === 150 && row2.resolved_by === 30,
    "an adoption's speculative re-upsert still leaves resolved_at/resolved_by untouched (carve-out does not leak)");
}

{
  // REACTIVATION (issue #457): 'keep_alignment_refused' shares the same
  // no-CAS-race safety as 'source_attr_divergent', so it gets the same
  // carve-out — a refusal a human resolved with an UNRELATED save, while the
  // alignment conflict PERSISTS, must re-surface on the next night's
  // re-detection instead of going silent forever.
  const d = verseDb();
  // Night 1: flagged, then resolved by an unrelated save.
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by, last_recorded_at)
     VALUES ('EZK','ult',40,21,'keep_alignment_refused','alignment_loss',NULL,100,150,30,100)`,
  ).run();
  // Night 2: re-detected (refusal still holds) → speculative re-upsert.
  d.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "EZK", "ult", 40, 21, "keep_alignment_refused", "alignment_loss", null, null, 2000, null, null,
  );
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='EZK' AND chapter=40 AND verse=21`).get();
  assert(row.resolved_at === null && row.resolved_by === null,
    "re-detecting a resolved keep_alignment_refused reactivates it (no CAS race → safe to clear in the upsert)");
  assert(row.detected_at === 100, "detected_at (age of the streak) is preserved across reactivation");

  // CONTROL: an adoption re-upserted alongside is still untouched — the
  // widened carve-out must not leak into 'adopt' / 'adopt_conflict'.
  const d2 = verseDb();
  d2.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by, last_recorded_at)
     VALUES ('EZK','ult',40,22,'adopt_conflict','both_changed',7,100,150,30,100)`,
  ).run();
  d2.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).run(
    "EZK", "ult", 40, 22, "adopt_conflict", "both_changed", 7, null, 2000, null, null,
  );
  const row2 = d2.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='EZK' AND chapter=40 AND verse=22`).get();
  assert(row2.resolved_at === 150 && row2.resolved_by === 30,
    "an adoption's speculative re-upsert still leaves resolved_at/resolved_by untouched (widened carve-out does not leak)");
}

// ─────────────────────────────────────────────────────────────────────────
// Part 8 (issue #507): VERSION GUARD on the reactivation carve-out. The
// speculative upsert's detection was read EARLIER in the same
// applyVerseRows call (bookReimport.ts's `ex.version`) than the moment this
// statement executes. If a human saves the verse AND resolves the conflict
// row in that window, the detection is stale — reactivating would destroy a
// fresh, legitimate resolution and raise a false alert for a condition that
// may already be gone. The guard: only reactivate when the verse's CURRENT
// version (read live, at upsert time) still matches the version the
// detection was read at.
// ─────────────────────────────────────────────────────────────────────────

{
  // *** THE EXACT #507 SCENARIO ***: a human saves a fix (bumping the verse's
  // version) AND resolves the conflict row, in the window between the
  // detection read and the speculative upsert. The upsert's observedVersion
  // (the STALE version from the detection read) no longer matches the verse's
  // CURRENT version — reactivation must be withheld, preserving the fresh
  // resolution's audit trail intact.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verses (book, chapter, verse, bible_version, version) VALUES ('EZK', 40, 21, 'ULT', 5)`,
  ).run();
  // A human resolves the conflict (their save bumped the verse to version 5).
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by, last_recorded_at)
     VALUES ('EZK','ult',40,21,'source_attr_divergent','source_attr_ambiguous',NULL,100,150,30,100)`,
  ).run();
  // Tonight's sync re-detects the SAME condition, but its detection read
  // happened BEFORE the human's save landed — it observed version 4, not the
  // verse's current version (5).
  upsertConflict(d, {
    book: "EZK", resource: "ult", chapter: 40, verse: 21,
    action: "source_attr_divergent", reason: "source_attr_ambiguous", overwrittenVersion: null,
    now: 2000, bibleVersion: "ULT", observedVersion: 4,
  });
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='EZK' AND chapter=40 AND verse=21`).get();
  assert(row.resolved_at === 150 && row.resolved_by === 30,
    "stale detection (observedVersion != current verses.version) does NOT reactivate — the fresh resolution survives");
}

{
  // CONTROL: same shape, but NOTHING raced — the detection's observedVersion
  // matches the verse's current version (no save happened in the window).
  // Reactivation must proceed normally, exactly as the pre-#507 behavior did.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verses (book, chapter, verse, bible_version, version) VALUES ('EZK', 40, 21, 'ULT', 4)`,
  ).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by, last_recorded_at)
     VALUES ('EZK','ult',40,21,'source_attr_divergent','source_attr_ambiguous',NULL,100,150,30,100)`,
  ).run();
  upsertConflict(d, {
    book: "EZK", resource: "ult", chapter: 40, verse: 21,
    action: "source_attr_divergent", reason: "source_attr_ambiguous", overwrittenVersion: null,
    now: 2000, bibleVersion: "ULT", observedVersion: 4,
  });
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='EZK' AND chapter=40 AND verse=21`).get();
  assert(row.resolved_at === null && row.resolved_by === null,
    "matching observedVersion (no race) reactivates normally, unregressed from the pre-#507 behavior");
}

{
  // Same race scenario, for 'keep_alignment_refused' — the other action the
  // carve-out (and therefore the version guard) applies to.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verses (book, chapter, verse, bible_version, version) VALUES ('EZK', 41, 3, 'UST', 9)`,
  ).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by, last_recorded_at)
     VALUES ('EZK','ust',41,3,'keep_alignment_refused','alignment_shrink',NULL,100,150,30,100)`,
  ).run();
  upsertConflict(d, {
    book: "EZK", resource: "ust", chapter: 41, verse: 3,
    action: "keep_alignment_refused", reason: "alignment_shrink", overwrittenVersion: null,
    now: 2000, bibleVersion: "UST", observedVersion: 8,
  });
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='EZK' AND chapter=41 AND verse=3`).get();
  assert(row.resolved_at === 150 && row.resolved_by === 30,
    "keep_alignment_refused: stale detection also withholds reactivation, preserving the fresh resolution");
}

{
  // Same race scenario, for 'keep_ai_master' (#540 item 2) — the third action
  // the reactivation carve-out (and therefore the version guard) applies to.
  // Same no-CAS-race shape as the other two, so it must get the same protection.
  const d = verseDb();
  d.prepare(
    `INSERT INTO verses (book, chapter, verse, bible_version, version) VALUES ('AMO', 4, 2, 'ULT', 6)`,
  ).run();
  d.prepare(
    `INSERT INTO verse_merge_conflicts (book, resource, chapter, verse, action, reason, overwritten_version, detected_at, resolved_at, resolved_by, last_recorded_at)
     VALUES ('AMO','ult',4,2,'keep_ai_master','both_changed_ai_master',NULL,100,150,30,100)`,
  ).run();
  upsertConflict(d, {
    book: "AMO", resource: "ult", chapter: 4, verse: 2,
    action: "keep_ai_master", reason: "both_changed_ai_master", overwrittenVersion: null,
    now: 2000, bibleVersion: "ULT", observedVersion: 5,
  });
  const row = d.prepare(`SELECT * FROM verse_merge_conflicts WHERE book='AMO' AND chapter=4 AND verse=2`).get();
  assert(row.resolved_at === 150 && row.resolved_by === 30,
    "keep_ai_master: stale detection also withholds reactivation, preserving the fresh resolution");
}

{
  // buildMergeConflictGuidance classifies by ACTION: a source_attr_divergent
  // row is a KEPT-D1 outcome — it must say "kept D1" / "NOT been taken" and
  // must NEVER claim "took Door43's version" (the misdirection bug the
  // action-keyed classification exists to prevent).
  const g = buildMergeConflictGuidance([{ action: "source_attr_divergent" }]);
  assert(g.includes("kept D1"), "source_attr_divergent guidance says the editor's D1 was kept");
  assert(g.includes("NOT been taken"), "…and warns the export will still revert master until resolved");
  assert(!g.includes("took Door43's version"), "…and never reports it as an overwrite");

  // A mixed set is counted per-action, not lumped: one adopt_conflict is an
  // overwrite, one source_attr_divergent is a kept-D1 divergence.
  const mixed = buildMergeConflictGuidance([
    { action: "adopt_conflict" },
    { action: "source_attr_divergent" },
    { action: "keep_alignment_refused" },
  ]);
  assert(mixed.includes("1 took Door43's version"), "adopt_conflict counted as an overwrite");
  assert(mixed.includes("1 kept the editor's version because adopting Door43's would have cost alignment"),
    "keep_alignment_refused counted as an alignment refusal");
  assert(mixed.includes("1 kept D1 because Door43's original-language source fix"),
    "source_attr_divergent counted as a source-attr divergence, separately from the alignment refusal");

  // #540 item 2. keep_ai_master is also a kept-D1 outcome, but the OPPOSITE one
  // where the export is concerned: nothing is waiting to be reverted, the export
  // is about to publish the kept version. Borrowing the other two's warning
  // would send a human to fight for a change that is already winning.
  const ai = buildMergeConflictGuidance([{ action: "keep_ai_master" }]);
  assert(ai.includes("1 kept the editor's version even though Door43 changed too"),
    "keep_ai_master gets its own sentence");
  // The measured cause, stated narrowly. Not "no maintainer edit" — the bot
  // account pushes on a named human's behalf, so a maintainer may well have
  // directed the change; what was measured is that no commit came from a Door43
  // editor's own account.
  assert(ai.includes("no commit from a Door43 editor's own account was found"),
    "…stating the measured cause, and only that");
  assert(!ai.includes("no maintainer edit"), "…never the stronger claim about intent");
  assert(!ai.includes("took Door43's version"), "…and never reports it as an overwrite");
  assert(!ai.includes("will still write over it"),
    "…and never borrows the refusal's warning: here the export publishes the kept version");
  // …but it must not promise a publish either. The watermark is withheld for the
  // whole book+resource by a systemic refusal, a lock, or a recording failure —
  // any of which can be described in this same banner.
  assert(!ai.includes("Tonight's export publishes"),
    "…and never promises tonight's export, which this banner itself may be reporting as held");
  assert(ai.includes("the next export that runs for this resource"),
    "…it says which export, conditionally");

  const withAi = buildMergeConflictGuidance([{ action: "adopt_conflict" }, { action: "keep_ai_master" }]);
  assert(withAi.includes("1 took Door43's version"),
    "a keep_ai_master row does not absorb the adopt_conflict count");
  assert(withAi.includes("1 kept the editor's version even though Door43 changed too"),
    "…and is counted separately from it");
}

{
  // Issue #537. The keep_no_base sentence must NAME the verses it says tonight's
  // export may overwrite, and must not assert a cause we did not measure.
  const g = buildMergeConflictGuidance([], { noBaseCount: 3, noBaseRefs: ["40:5", "42:2", "42:3"] });
  assert(g.includes("40:5, 42:2, 42:3"), "no-ancestor sentence lists the refs it is talking about");
  assert(g.includes("3 verse(s) could not be adjudicated"), "…and still reports the count");
  assert(!g.includes("more"), "…with no '+N more' when every ref was listed");

  // The cause claim. Prod on 2026-08-19: edit_log spanned 93 days, so the
  // 180-day sweep had deleted nothing and "aged out" described none of the 190
  // verses then in this state. The sentence may only say what is measured.
  assert(!/aged out/i.test(g), "…and never claims the history 'aged out' (a cause we did not measure)");
  // Nor may the replacement overclaim: `base === null` also covers a payload
  // that exists but carries no parseable content, where the ancestor DID
  // survive and merely wasn't recoverable. "recoverable" is the measured word.
  assert(g.includes("no ancestor was recoverable"), "…it states only the measured fact: not recoverable");
  assert(!/survives/i.test(g), "…and does not claim the ancestor is gone, only that it could not be recovered");
  // The lookup is per verse (row_key = book/chapter/verse/RESOURCE), so the
  // sentence must not read as "this book's history is lost".
  assert(!/this book's edit history/i.test(g), "…and does not overstate the lookup as book-wide");
  // Nothing was overwritten in a keep_no_base verse — the reader must not go
  // hunting version history for a replaced value that does not exist.
  assert(g.includes("Nothing was overwritten"), "…and says nothing was overwritten yet");

  // The ref list is a capped sample; '+N more' counts against what was actually
  // listed, never against the cap, and the authoritative count still leads.
  const OVER = NO_BASE_REF_DISPLAY + 2;
  const many = buildMergeConflictGuidance([], {
    noBaseCount: 59,
    noBaseRefs: Array.from({ length: OVER }, (_, i) => `28:${i + 1}`),
  });
  assert(many.includes("59 verse(s)"), "count stays authoritative when the ref sample is short");
  assert(many.includes(`28:${NO_BASE_REF_DISPLAY}`), "…lists up to the display cap");
  assert(!many.includes(`28:${NO_BASE_REF_DISPLAY + 1}`), "…and no further");
  assert(many.includes(`+${59 - NO_BASE_REF_DISPLAY} more`), "…and '+N more' is the count minus what was actually listed");
  // "sample", not a plain list: on a mixed run the listed refs are not
  // necessarily the first N, so the remainder is not a contiguous tail.
  assert(many.includes("Verses (sample):"), "…and labels the list as a sample, not an ordered prefix");

  // Never list more refs than the count claims (the helper is exported, so the
  // invariant is enforced rather than assumed from its only caller).
  const overListed = buildMergeConflictGuidance([], { noBaseCount: 2, noBaseRefs: ["1:1", "1:2", "1:3", "1:4"] });
  assert(overListed.includes("1:1, 1:2."), "lists at most `count` refs…");
  assert(!overListed.includes("1:3"), "…never more than it claims");

  // A Workflow chunk memoized before refs were collected contributes a count and
  // no refs. Say nothing about where, rather than guess.
  const noRefs = buildMergeConflictGuidance([], { noBaseCount: 5 });
  assert(noRefs.includes("5 verse(s) could not be adjudicated"), "count-only still reports the count");
  assert(!noRefs.includes("Verses:"), "…and omits the ref clause rather than printing an empty one");
  assert(!noRefs.includes("more"), "…and claims no '+N more' it cannot substantiate");

  // Zero is not a story: no sentence at all.
  assert(buildMergeConflictGuidance([], { noBaseCount: 0 }) === "", "no no-ancestor sentence when the count is 0");
}

// ─────────────────────────────────────────────────────────────────────────
// buildGroupedRefsClause — pure, no D1 (issue #624).
// ─────────────────────────────────────────────────────────────────────────

function ts(dateStr) {
  return Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 1000);
}

{
  // A mixed-reason row set (the real 2026-08-25 JER UST alert's shape, minus
  // the extra source_attr_ambiguous rows) produces refs grouped under their
  // own reason, each carrying the OLDEST detected_at in that reason as a
  // plain date — not the newest, and not the first-seen row's date.
  const rows = [
    { chapter: 38, verse: 2, reason: "both_changed_ai_master", overwrittenVersion: null, detectedAt: ts("2026-08-24") },
    { chapter: 41, verse: 9, reason: "source_attr_ambiguous", overwrittenVersion: null, detectedAt: ts("2026-08-19") },
    { chapter: 41, verse: 12, reason: "source_attr_ambiguous", overwrittenVersion: null, detectedAt: ts("2026-08-20") },
    { chapter: 41, verse: 16, reason: "source_attr_ambiguous", overwrittenVersion: null, detectedAt: ts("2026-08-19") },
    { chapter: 42, verse: 6, reason: "both_changed_ai_master", overwrittenVersion: null, detectedAt: ts("2026-08-25") },
    { chapter: 42, verse: 8, reason: "alignment_shrink", overwrittenVersion: 7, detectedAt: ts("2026-08-22") },
  ];
  const clause = buildGroupedRefsClause(rows);
  assert(
    clause.includes("both_changed_ai_master: 38:2, 42:6 (first flagged 2026-08-24)."),
    "both_changed_ai_master group lists both its refs, dated by its OLDEST row (38:2), not its newest (42:6)",
  );
  assert(
    clause.includes("source_attr_ambiguous: 41:9, 41:12, 41:16 (first flagged 2026-08-19)."),
    "source_attr_ambiguous group lists all three refs, dated by the oldest of the two 2026-08-19 rows",
  );
  assert(
    clause.includes("alignment_shrink: 42:8@v7 (first flagged 2026-08-22)."),
    "alignment_shrink group carries its own single ref and date, and the overwritten-version suffix survives grouping",
  );
  // Reason order follows first appearance in `rows` — same order
  // reasonBreakdown (built from the same array) would produce — not
  // alphabetical and not grouped-size order.
  const bothIdx = clause.indexOf("both_changed_ai_master");
  const sourceIdx = clause.indexOf("source_attr_ambiguous");
  const alignIdx = clause.indexOf("alignment_shrink");
  assert(bothIdx < sourceIdx && sourceIdx < alignIdx, "groups appear in first-seen order, matching reasonBreakdown's order");
  assert(!clause.includes("more"), "no '+N more' when every row fit under the cap");
}

{
  // A single-reason set (the common case pre-#624) must not regress: one
  // group, its own date, no stray formatting from the grouping machinery.
  const rows = [
    { chapter: 12, verse: 4, reason: "keep_alignment_refused", overwrittenVersion: null, detectedAt: ts("2026-08-10") },
    { chapter: 12, verse: 5, reason: "keep_alignment_refused", overwrittenVersion: null, detectedAt: ts("2026-08-12") },
  ];
  const clause = buildGroupedRefsClause(rows);
  assert(
    clause.trim() === "keep_alignment_refused: 12:4, 12:5 (first flagged 2026-08-10).",
    "a single-reason set collapses to one group, dated by its oldest row",
  );
}

{
  // The overall display cap is GLOBAL, exactly like the flat "Refs: …; +N
  // more" it replaces — not reapplied per reason. And critically: a group's
  // date must reflect its OLDEST row even when that row itself falls PAST
  // the cap and is never printed as a ref — capping what's shown is not
  // license to understate how long the reason has been flagged.
  const rows = [
    { chapter: 1, verse: 1, reason: "a", overwrittenVersion: null, detectedAt: ts("2026-08-20") },
    { chapter: 1, verse: 2, reason: "a", overwrittenVersion: null, detectedAt: ts("2026-08-20") },
    { chapter: 2, verse: 1, reason: "b", overwrittenVersion: null, detectedAt: ts("2026-08-01") },
    { chapter: 2, verse: 2, reason: "b", overwrittenVersion: null, detectedAt: ts("2026-08-01") },
    // The true oldest "a" row — past the cap of 3, never displayed as a ref.
    { chapter: 3, verse: 1, reason: "a", overwrittenVersion: null, detectedAt: ts("2026-08-05") },
  ];
  const clause = buildGroupedRefsClause(rows, 3);
  assert(clause.includes("a: 1:1, 1:2, +1 more (first flagged 2026-08-05)."),
    "group 'a's date is its true oldest row (2026-08-05) — and its own '+1 more' says the dated row is one it did not list");
  assert(!clause.includes("3:1"), "the past-cap row itself is not listed as a ref");
  assert(clause.includes("b: 2:1, +1 more (first flagged 2026-08-01)."),
    "reason 'b' is truncated in its own group too, rather than by a trailing count that reads as 'a's");
  assert(!/\+\d+ more\./.test(clause.replace(/\+\d+ more \(/g, "")),
    "no free-floating global remainder: every hidden row is counted inside the group it belongs to");
}

{
  // PR #630 review F1, the measured motivation: a reason whose every row sorts
  // past the cap used to vanish from the clause entirely. That is exactly
  // backwards — the rare reason is the one needing hand work, and the crowded
  // one is what a reader can already infer from the count parenthetical.
  // Round-robin gives every reason its first ref before any gets a second.
  const rows = [
    { chapter: 1, verse: 1, reason: "a", overwrittenVersion: null, detectedAt: ts("2026-08-20") },
    { chapter: 1, verse: 2, reason: "a", overwrittenVersion: null, detectedAt: ts("2026-08-20") },
    { chapter: 2, verse: 1, reason: "b", overwrittenVersion: null, detectedAt: ts("2026-08-01") },
  ];
  const clause = buildGroupedRefsClause(rows, 2);
  assert(/\bb: 2:1\b/.test(clause), "reason 'b', last in chapter order, still names its ref instead of being capped away");
  assert(clause.includes("a: 1:1, +1 more"), "…the crowded reason yields the slot, and says so in its own group");
  assert(!clause.includes("1:2"), "…so 'a's second ref is the one dropped, not 'b's only ref");
}

{
  // The one case that can still omit a group outright: more distinct reasons
  // than the cap has slots. Those rows are reported in a trailing clause that
  // says what it is, rather than silently discarded or folded into the last
  // group's own overflow.
  const rows = [
    { chapter: 1, verse: 1, reason: "a", overwrittenVersion: null, detectedAt: ts("2026-08-20") },
    { chapter: 2, verse: 1, reason: "b", overwrittenVersion: null, detectedAt: ts("2026-08-20") },
    { chapter: 3, verse: 1, reason: "c", overwrittenVersion: null, detectedAt: ts("2026-08-20") },
    { chapter: 3, verse: 2, reason: "c", overwrittenVersion: null, detectedAt: ts("2026-08-20") },
  ];
  const clause = buildGroupedRefsClause(rows, 2);
  assert(/\ba: 1:1\b/.test(clause) && /\bb: 2:1\b/.test(clause), "the reasons that fit are listed");
  assert(!/\bc:/.test(clause), "reason 'c' has no slot left — the cap is smaller than the reason count");
  assert(clause.includes("+2 more in reasons not listed."),
    "…and its rows are counted in a clause naming them as a different reason, not as 'b's overflow");
}

{
  // Empty input -> empty string, so the caller's message template does not
  // grow a stray leading space when there is nothing to report.
  assert(buildGroupedRefsClause([]) === "", "no rows -> no clause");
}

{
  // A row with no detectedAt (the write path never sets it — see
  // VerseMergeConflictRow.detectedAt's doc comment) must not crash the
  // formatter or fabricate a date; it degrades to no date for that group.
  const rows = [{ chapter: 5, verse: 5, reason: "keep_alignment_refused", overwrittenVersion: null, detectedAt: undefined }];
  const clause = buildGroupedRefsClause(rows);
  assert(clause.trim() === "keep_alignment_refused: 5:5.", "a row with no detectedAt formats with no date, not 'undefined'");
}

{
  // Default cap matches the exported constant (and therefore the pre-#624
  // flat-list behavior) when the caller does not pass one explicitly.
  const rows = Array.from({ length: MERGE_CONFLICT_REFS_DISPLAY + 1 }, (_, i) => ({
    chapter: 1,
    verse: i + 1,
    reason: "keep_alignment_refused",
    overwrittenVersion: null,
    detectedAt: ts("2026-08-01"),
  }));
  const clause = buildGroupedRefsClause(rows);
  // Asserting on `1:10`, not the bare "10": the loose form also matches the
  // "+10 more" tail, so it never actually proved the 10th ref was listed.
  assert(clause.includes(`1:${MERGE_CONFLICT_REFS_DISPLAY}`), "default cap lists up to MERGE_CONFLICT_REFS_DISPLAY refs");
  assert(!clause.includes(`1:${MERGE_CONFLICT_REFS_DISPLAY + 1}`), "…and no further");
  assert(clause.includes("+1 more"), "…and reports the one remaining row, inside the group it belongs to");
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("\nAll verseMergeConflicts tests passed");
}
