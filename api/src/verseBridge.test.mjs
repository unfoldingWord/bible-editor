// Tests for verse bridge create (merge-with-next) and break (split).
//
// Two halves, same split as verseMergeConflicts.test.mjs:
//   - the pure math helpers, tested directly (no D1);
//   - the REAL version-guarded SQL, driven against node:sqlite so the
//     `EXISTS` + `changes() > 0` chaining that makes a two-row merge atomic is
//     proven, not asserted about a hand-copied stand-in.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/verseBridge.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { DatabaseSync } from "node:sqlite";
import {
  absorbedVerseNumbers,
  BRIDGE_DELETE_NEXT_SQL,
  BRIDGE_UPDATE_START_SQL,
  computeBridgeEnd,
  DELETE_VERSE_LANE_CHECKS_RANGE_SQL,
  DELETE_VERSE_STATUSES_RANGE_SQL,
  expectedNextStart,
  hasVerseObjectsArray,
  isBridge,
  mergeVerseObjects,
  splitSeedVerseObjects,
  splitVerseNumbers,
  SPLIT_INSERT_EDITLOG_RANGE_SQL,
  SPLIT_INSERT_VERSES_RANGE_SQL,
  findOverlappingRanges,
  formatVerseRange,
  SPLIT_UPDATE_START_SQL,
  verseRangeEnd,
} from "./verseBridge.ts";

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  passed++;
}
function eq(a, b, msg) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// ── pure helpers ───────────────────────────────────────────────────────────
eq(verseRangeEnd({ verse: 1, verse_end: null }), 1, "verseRangeEnd singleton");
eq(verseRangeEnd({ verse: 1, verse_end: 2 }), 2, "verseRangeEnd bridge");
assert(!isBridge({ verse: 1, verse_end: null }), "singleton is not a bridge");
assert(!isBridge({ verse: 1, verse_end: 1 }), "degenerate verse_end==verse is not a bridge");
assert(isBridge({ verse: 1, verse_end: 2 }), "1-2 is a bridge");

eq(expectedNextStart({ verse: 1, verse_end: null }), 2, "next after singleton 1 is 2");
eq(expectedNextStart({ verse: 1, verse_end: 2 }), 3, "next after bridge 1-2 is 3");
eq(computeBridgeEnd({ verse: 3, verse_end: null }), 3, "computeBridgeEnd singleton next");
eq(computeBridgeEnd({ verse: 3, verse_end: 4 }), 4, "computeBridgeEnd bridge next");
eq(absorbedVerseNumbers({ verse: 2, verse_end: null }), [2], "absorbed singleton");
eq(absorbedVerseNumbers({ verse: 3, verse_end: 5 }), [3, 4, 5], "absorbed bridge range");
eq(splitVerseNumbers({ verse: 1, verse_end: 2 }), [2], "split 1-2 mints verse 2");
eq(splitVerseNumbers({ verse: 1, verse_end: 4 }), [2, 3, 4], "split 1-4 mints 2,3,4");

// ── findOverlappingRanges (issue #727) ─────────────────────────────────────
const R = (verse, verse_end = null) => ({ verse, verse_end });
const pairs = (rows) => findOverlappingRanges(rows).map((p) => `${formatVerseRange(p.a)} ∩ ${formatVerseRange(p.b)}`);
eq(formatVerseRange(R(5)), "5", "formatVerseRange singleton");
eq(formatVerseRange(R(5, 7)), "5-7", "formatVerseRange bridge");
eq(formatVerseRange(R(5, 5)), "5", "formatVerseRange degenerate verse_end==verse reads as singleton");
eq(pairs([]), [], "empty chapter has no overlaps");
eq(pairs([R(0), R(1), R(2, 3), R(4)]), [], "front matter + singleton + bridge + singleton, all disjoint");
eq(pairs([R(1, 2), R(2)]), ["1-2 ∩ 2"], "the #727 shape: bridge 1-2 beside standalone 2");
eq(pairs([R(2), R(1, 2)]), ["1-2 ∩ 2"], "…input order does not matter");
eq(pairs([R(1, 3), R(2, 4)]), ["1-3 ∩ 2-4"], "two bridges sharing an interior verse");
eq(pairs([R(1, 5), R(3), R(7)]), ["1-5 ∩ 3"], "a singleton inside a long bridge; the later singleton is clean");
eq(pairs([R(1, 5), R(2), R(3)]), ["1-5 ∩ 2", "1-5 ∩ 3"], "every offender against the same reach is reported");
eq(pairs([R(1, 2), R(3, 4), R(4)]), ["3-4 ∩ 4"], "the reach advances to the later bridge");
eq(pairs([R(1), R(1, 2)]), ["1 ∩ 1-2"], "same start verse, singleton and bridge (impossible under the PK, still detected)");
eq(splitVerseNumbers({ verse: 1, verse_end: null }), [], "splitting a non-bridge mints nothing");

// mergeVerseObjects concatenates with a single space separator, mutating neither
{
  const a = [{ type: "text", text: "hello" }];
  const b = [{ type: "text", text: "world" }];
  eq(
    mergeVerseObjects(a, b),
    [{ type: "text", text: "hello" }, { type: "text", text: " " }, { type: "text", text: "world" }],
    "mergeVerseObjects joins with a space",
  );
  eq(a, [{ type: "text", text: "hello" }], "mergeVerseObjects does not mutate start");
  eq(b, [{ type: "text", text: "world" }], "mergeVerseObjects does not mutate next");
  eq(mergeVerseObjects([], b), b, "empty start returns next copy");
  eq(mergeVerseObjects(a, []), a, "empty next returns start copy");
}

// splitSeedVerseObjects is a valid, non-empty tree (empty is refused for real
// verses — refusesEmptyVerseObjects in contentJson.ts)
assert(splitSeedVerseObjects().length > 0, "split seed is non-empty");

// hasVerseObjectsArray — the merge route refuses when either side fails this so
// an off-shape (but parseable) row can't be silently dropped while deleted.
assert(hasVerseObjectsArray({ verseObjects: [] }), "empty verseObjects is in-shape (nothing to lose)");
assert(hasVerseObjectsArray({ verseObjects: [{ type: "text", text: "hi" }] }), "populated verseObjects is in-shape");
assert(!hasVerseObjectsArray(null), "null is off-shape");
assert(!hasVerseObjectsArray([]), "a bare array is off-shape");
assert(!hasVerseObjectsArray({ verseobjects: [] }), "a typo'd key is off-shape");
assert(!hasVerseObjectsArray({ verseObjects: "nope" }), "a non-array verseObjects is off-shape");

// ── real SQL against node:sqlite ─────────────────────────────────────────────
function verseDb() {
  const d = new DatabaseSync(":memory:");
  d.exec(`CREATE TABLE verses (
    book TEXT, chapter INTEGER, verse INTEGER, verse_end INTEGER,
    bible_version TEXT, content_json TEXT, plain_text TEXT,
    version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER, updated_by INTEGER,
    last_change_action TEXT, last_change_source TEXT, last_change_actor TEXT,
    PRIMARY KEY (book, chapter, verse, bible_version)
  )`);
  d.exec(`CREATE TABLE verse_statuses (
    book TEXT, chapter INTEGER, verse INTEGER, done INTEGER DEFAULT 0, updated_at INTEGER,
    PRIMARY KEY (book, chapter, verse)
  )`);
  d.exec(`CREATE TABLE verse_lane_checks (
    book TEXT, chapter INTEGER, verse INTEGER, lane TEXT, checked_by INTEGER, checked_at INTEGER,
    PRIMARY KEY (book, chapter, verse, lane, checked_by)
  )`);
  d.exec(`CREATE TABLE edit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, row_key TEXT, book TEXT, user_id INTEGER,
    prev_version INTEGER, new_version INTEGER, action TEXT, payload_json TEXT
  )`);
  return d;
}
function insertVerse(d, { verse, verse_end = null, version = 1, content = "{}", bv = "UST" }) {
  d.prepare(
    `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, version)
     VALUES ('ZEC', 5, ?, ?, ?, ?, ?)`,
  ).run(verse, verse_end, bv, content, version);
}
function getVerse(d, verse, bv = "UST") {
  return d.prepare(`SELECT * FROM verses WHERE book='ZEC' AND chapter=5 AND verse=? AND bible_version=?`).get(verse, bv);
}
// Drive the merge batch's two chained statements in order, exactly as the route's
// env.DB.batch does. Returns statement-1's change count (the success signal).
function runMerge(d, { startVerse, startVersion, nextVerse, nextVersion, bridgeEnd, content = "{}" }) {
  const up = d
    .prepare(BRIDGE_UPDATE_START_SQL)
    .run(content, bridgeEnd, 200, 30, "bridge", "user", "actor", "ZEC", 5, startVerse, "UST", startVersion, nextVerse, nextVersion, "merged plain");
  d.prepare(BRIDGE_DELETE_NEXT_SQL).run("ZEC", 5, nextVerse, "UST");
  return up.changes;
}
// Mirrors the route's four-statement batch: de-bridge, edit_log(split), then the
// two CTE-driven range INSERTs. `verseEnd` drives the CTE, exactly as the route
// passes bridge.verse_end. Returns statement-1's change count (the success flag).
function runSplit(d, { verse, verseEnd, expectedVersion, seed }) {
  const up = d
    .prepare(SPLIT_UPDATE_START_SQL)
    .run(200, 30, "split", "user", "actor", "ZEC", 5, verse, "UST", expectedVersion);
  d.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
     SELECT 'verse', ?1, ?2, ?3, ?4, ?5, 'split', ?6 WHERE changes() > 0`,
  ).run(`ZEC/5/${verse}/UST`, "ZEC", 30, expectedVersion, expectedVersion + 1, "{}");
  d.prepare(SPLIT_INSERT_VERSES_RANGE_SQL).run("ZEC", 5, "UST", seed, 200, 30, verse, verseEnd, "split", "user", "actor", expectedVersion);
  d.prepare(SPLIT_INSERT_EDITLOG_RANGE_SQL).run("ZEC", 5, "UST", verse, verseEnd, 30, "{}", expectedVersion);
  return up.changes;
}

// merge: happy path — 5:1 + 5:2 → 5:1-2, verse 2 row deleted
{
  const d = verseDb();
  insertVerse(d, { verse: 1, version: 3, content: '{"a":1}' });
  insertVerse(d, { verse: 2, version: 7, content: '{"b":2}' });
  const changed = runMerge(d, { startVerse: 1, startVersion: 3, nextVerse: 2, nextVersion: 7, bridgeEnd: 2, content: '{"merged":1}' });
  assert(changed === 1, "merge landed");
  const start = getVerse(d, 1);
  eq(start.verse_end, 2, "start row is now a 1-2 bridge");
  eq(start.version, 4, "start version bumped");
  eq(start.content_json, '{"merged":1}', "start content replaced with merged tree");
  eq(start.last_change_action, "bridge", "provenance action stamped");
  assert(getVerse(d, 2) === undefined, "absorbed verse-2 row deleted");
}

// merge: extend a bridge — 5:1-2 + 5:3 → 5:1-3
{
  const d = verseDb();
  insertVerse(d, { verse: 1, verse_end: 2, version: 1 });
  insertVerse(d, { verse: 3, version: 1 });
  const changed = runMerge(d, { startVerse: 1, startVersion: 1, nextVerse: 3, nextVersion: 1, bridgeEnd: 3 });
  assert(changed === 1, "bridge extended");
  eq(getVerse(d, 1).verse_end, 3, "1-2 extended to 1-3");
  assert(getVerse(d, 3) === undefined, "verse-3 row absorbed");
}

// merge: stale START version → nothing changes, BOTH rows survive
{
  const d = verseDb();
  insertVerse(d, { verse: 1, version: 3 });
  insertVerse(d, { verse: 2, version: 7 });
  const changed = runMerge(d, { startVerse: 1, startVersion: 99, nextVerse: 2, nextVersion: 7, bridgeEnd: 2 });
  assert(changed === 0, "stale start version does not merge");
  assert(getVerse(d, 1).verse_end === null, "start left un-bridged");
  assert(getVerse(d, 2) !== undefined, "next row NOT deleted (no half-commit)");
}

// merge: stale NEXT version (concurrent edit to verse 2) → nothing changes,
// verse 2 preserved. This is the half-commit guard: the EXISTS blocks the whole op.
{
  const d = verseDb();
  insertVerse(d, { verse: 1, version: 3 });
  insertVerse(d, { verse: 2, version: 7 });
  const changed = runMerge(d, { startVerse: 1, startVersion: 3, nextVerse: 2, nextVersion: 99, bridgeEnd: 2 });
  assert(changed === 0, "stale next version does not merge");
  assert(getVerse(d, 1).verse_end === null, "start left un-bridged");
  assert(getVerse(d, 2) !== undefined, "next row preserved despite start version matching");
}

// split: happy path — 5:1-2 → 5:1 (all content) + empty 5:2
{
  const d = verseDb();
  insertVerse(d, { verse: 1, verse_end: 2, version: 4, content: '{"all":"text"}' });
  const seed = JSON.stringify({ verseObjects: splitSeedVerseObjects() });
  const changed = runSplit(d, { verse: 1, verseEnd: 2, expectedVersion: 4, seed });
  assert(changed === 1, "split landed");
  const start = getVerse(d, 1);
  eq(start.verse_end, null, "start de-bridged");
  eq(start.version, 5, "start version bumped");
  eq(start.content_json, '{"all":"text"}', "start keeps ALL content");
  const v2 = getVerse(d, 2);
  assert(!!v2, "verse-2 row created");
  eq(v2.content_json, seed, "verse-2 seeded with the empty tree");
  // NOT version 1 — floored above the bridge version (4) so a stale pre-bridge
  // If-Match can't pass CAS against the re-minted row (finding 6). max(0,4)+1 = 5.
  eq(v2.version, 5, "recreated verse starts above the bridge version, not at 1");
  const auditRow = d.prepare(`SELECT COUNT(*) c, MAX(new_version) nv FROM edit_log WHERE row_key='ZEC/5/2/UST' AND action='create'`).get();
  eq(auditRow.c, 1, "verse-2 got its create audit row");
  // The create audit records the ACTUAL seeded version (5), not a literal 1 — so
  // edit_log's high-water is truthful and a repeat bridge→split can't re-mint the
  // same number and re-open the stale-If-Match replay (re-review finding 1).
  eq(auditRow.nv, getVerse(d, 2).version, "create audit new_version == the seeded row version");
  eq(auditRow.nv, 5, "…which is 5, not 1");
}

// split version floors above the verse's OWN edit_log history too (finding 6):
// if verse 2 had reached version 9 before it was bridged, the re-minted row must
// start at 10 — not the bridge version — so a stale If-Match:9 can't match.
{
  const d = verseDb();
  insertVerse(d, { verse: 1, verse_end: 2, version: 4 });
  // Verse 2's pre-bridge history: it once reached new_version 9.
  d.prepare(`INSERT INTO edit_log (kind, row_key, book, new_version, action) VALUES ('verse','ZEC/5/2/UST','ZEC',9,'update')`).run();
  const seed = JSON.stringify({ verseObjects: splitSeedVerseObjects() });
  runSplit(d, { verse: 1, verseEnd: 2, expectedVersion: 4, seed });
  eq(getVerse(d, 2).version, 10, "recreated verse floors above its own edit_log max (9), not the bridge version (4)");
}

// split: 5:1-3 → 5:1 + 5:2 + 5:3
{
  const d = verseDb();
  insertVerse(d, { verse: 1, verse_end: 3, version: 1 });
  const seed = JSON.stringify({ verseObjects: splitSeedVerseObjects() });
  runSplit(d, { verse: 1, verseEnd: 3, expectedVersion: 1, seed });
  assert(getVerse(d, 1).verse_end === null && !!getVerse(d, 2) && !!getVerse(d, 3), "1-3 split into three rows");
}

// split: a 60-verse bridge (1-60) — the old one-INSERT-per-verse batch would
// have been 2 + 2*59 = 120 statements and overflowed D1's 100-statement cap.
// The CTE range INSERTs keep it at four statements and must mint all 59.
{
  const d = verseDb();
  insertVerse(d, { verse: 1, verse_end: 60, version: 1 });
  const seed = JSON.stringify({ verseObjects: splitSeedVerseObjects() });
  const changed = runSplit(d, { verse: 1, verseEnd: 60, expectedVersion: 1, seed });
  assert(changed === 1, "large split landed");
  eq(getVerse(d, 1).verse_end, null, "start de-bridged");
  const count = d.prepare(`SELECT COUNT(*) c FROM verses WHERE book='ZEC' AND chapter=5`).all()[0].c;
  eq(count, 60, "all 60 rows present (start + 59 seeded)");
  eq(getVerse(d, 60).content_json, seed, "last seeded verse present and seeded");
  const audits = d.prepare(`SELECT COUNT(*) c FROM edit_log WHERE action='create'`).get().c;
  eq(audits, 59, "one create audit row per seeded verse");
}

// split: not a bridge → UPDATE matches nothing, no rows minted
{
  const d = verseDb();
  insertVerse(d, { verse: 1, version: 1 }); // singleton, verse_end null
  const seed = JSON.stringify({ verseObjects: splitSeedVerseObjects() });
  // Pass verseEnd=1 (route would never reach here for a non-bridge, but the CTE
  // must still mint nothing because the CAS'd UPDATE changed 0 rows).
  const changed = runSplit(d, { verse: 1, verseEnd: 1, expectedVersion: 1, seed });
  assert(changed === 0, "splitting a non-bridge changes nothing");
  assert(getVerse(d, 2) === undefined, "no phantom verse minted");
}

// split: stale version → nothing changes
{
  const d = verseDb();
  insertVerse(d, { verse: 1, verse_end: 2, version: 4 });
  const seed = JSON.stringify({ verseObjects: splitSeedVerseObjects() });
  const changed = runSplit(d, { verse: 1, verseEnd: 2, expectedVersion: 99, seed });
  assert(changed === 0, "stale split version does not split");
  assert(getVerse(d, 1).verse_end === 2, "bridge intact");
  assert(getVerse(d, 2) === undefined, "no verse minted on a lost CAS");
}

// split: a freed verse whose ONLY history is the bridge's 'delete' audit row
// (new_version NULL, prev_version = the deleted row's version) is still minted
// ABOVE that version. Before the COALESCE(new_version, prev_version) fix in
// verseVersionFloorSql, MAX(new_version) over a delete-only history was NULL and
// the verse came back at MAX(0, floor) + 1 — for a floor below the deleted
// version, the very version the deleted row had held.
{
  const d = verseDb();
  insertVerse(d, { verse: 1, verse_end: 2, version: 1 });
  // Verse 2 was imported at v1 and never PATCHed (the bootstrap import writes no
  // edit_log rows), then absorbed: its whole history is this one 'delete' row.
  d.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
     VALUES ('verse', 'ZEC/5/2/UST', 'ZEC', 30, 1, NULL, 'delete', '{}')`,
  ).run();
  const seed = JSON.stringify({ verseObjects: splitSeedVerseObjects() });
  // Driven by hand rather than through runSplit: floor 0 on purpose. With the
  // bridge row at v1 the route's own floor (the bridge's version) would also be
  // 1 and mask the bug; the reimport INSERT passes a literal 0, so this is the
  // shape that exposed it.
  const up = d.prepare(SPLIT_UPDATE_START_SQL).run(200, 30, "split", "user", "actor", "ZEC", 5, 1, "UST", 1);
  assert(up.changes === 1, "split landed");
  d.prepare(SPLIT_INSERT_VERSES_RANGE_SQL).run("ZEC", 5, "UST", seed, 200, 30, 1, 2, "split", "user", "actor", 0);
  d.prepare(SPLIT_INSERT_EDITLOG_RANGE_SQL).run("ZEC", 5, "UST", 1, 2, 30, "{}", 0);
  eq(getVerse(d, 2).version, 2, "the freed verse is minted at 2, above the deleted row's v1 (delete-only history)");
  const audit = d.prepare(`SELECT new_version FROM edit_log WHERE row_key = 'ZEC/5/2/UST' AND action = 'create'`).get();
  eq(audit.new_version, 2, "…and its 'create' audit row agrees");
}

// post-confirm cleanup: absorbed verses' status + lane checks are pruned by range
{
  const d = verseDb();
  d.prepare(`INSERT INTO verse_statuses (book, chapter, verse, done) VALUES ('ZEC',5,2,1),('ZEC',5,3,1),('ZEC',5,1,1)`).run();
  d.prepare(`INSERT INTO verse_lane_checks (book, chapter, verse, lane, checked_by) VALUES ('ZEC',5,2,'text',9),('ZEC',5,1,'text',9)`).run();
  d.prepare(DELETE_VERSE_STATUSES_RANGE_SQL).run("ZEC", 5, 2, 3);
  d.prepare(DELETE_VERSE_LANE_CHECKS_RANGE_SQL).run("ZEC", 5, 2, 3);
  const statuses = d.prepare(`SELECT verse FROM verse_statuses WHERE book='ZEC' AND chapter=5 ORDER BY verse`).all().map((r) => r.verse);
  eq(statuses, [1], "absorbed 2,3 statuses pruned; start verse 1 kept");
  const laneVerses = d.prepare(`SELECT verse FROM verse_lane_checks WHERE book='ZEC' AND chapter=5`).all().map((r) => r.verse);
  eq(laneVerses, [1], "absorbed verse-2 lane check pruned; start verse 1 kept");
}

console.log(`ok — ${passed} assertions passed`);
