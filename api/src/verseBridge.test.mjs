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
  isBridge,
  mergeVerseObjects,
  splitSeedVerseObjects,
  splitVerseNumbers,
  SPLIT_INSERT_VERSE_SQL,
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
function runSplit(d, { verse, expectedVersion, newVerses, seed }) {
  const up = d
    .prepare(SPLIT_UPDATE_START_SQL)
    .run(200, 30, "split", "user", "actor", "ZEC", 5, verse, "UST", expectedVersion);
  for (const v of newVerses) {
    d.prepare(SPLIT_INSERT_VERSE_SQL).run("ZEC", 5, v, "UST", seed, 200, 30, "split", "user", "actor");
  }
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
  const changed = runSplit(d, { verse: 1, expectedVersion: 4, newVerses: splitVerseNumbers({ verse: 1, verse_end: 2 }), seed });
  assert(changed === 1, "split landed");
  const start = getVerse(d, 1);
  eq(start.verse_end, null, "start de-bridged");
  eq(start.version, 5, "start version bumped");
  eq(start.content_json, '{"all":"text"}', "start keeps ALL content");
  const v2 = getVerse(d, 2);
  assert(!!v2, "verse-2 row created");
  eq(v2.content_json, seed, "verse-2 seeded with the empty tree");
  eq(v2.version, 1, "new verse starts at version 1");
}

// split: 5:1-3 → 5:1 + 5:2 + 5:3
{
  const d = verseDb();
  insertVerse(d, { verse: 1, verse_end: 3, version: 1 });
  const seed = JSON.stringify({ verseObjects: splitSeedVerseObjects() });
  runSplit(d, { verse: 1, expectedVersion: 1, newVerses: [2, 3], seed });
  assert(getVerse(d, 1).verse_end === null && !!getVerse(d, 2) && !!getVerse(d, 3), "1-3 split into three rows");
}

// split: not a bridge → UPDATE matches nothing, no rows minted
{
  const d = verseDb();
  insertVerse(d, { verse: 1, version: 1 }); // singleton, verse_end null
  const seed = JSON.stringify({ verseObjects: splitSeedVerseObjects() });
  const changed = runSplit(d, { verse: 1, expectedVersion: 1, newVerses: [2], seed });
  assert(changed === 0, "splitting a non-bridge changes nothing");
  assert(getVerse(d, 2) === undefined, "no phantom verse minted");
}

// split: stale version → nothing changes
{
  const d = verseDb();
  insertVerse(d, { verse: 1, verse_end: 2, version: 4 });
  const seed = JSON.stringify({ verseObjects: splitSeedVerseObjects() });
  const changed = runSplit(d, { verse: 1, expectedVersion: 99, newVerses: [2], seed });
  assert(changed === 0, "stale split version does not split");
  assert(getVerse(d, 1).verse_end === 2, "bridge intact");
  assert(getVerse(d, 2) === undefined, "no verse minted on a lost CAS");
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
