import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  reconcileReviewAlert,
  resolveReviewAlert,
  activeReviewAlertUsernames,
  appendSystemRecord,
  reviewConditionKey,
  verseMergeEditorConditionKey,
} from "./reviewAlerts.ts";

let failed = 0;
function ok(value, message) {
  if (!value) {
    console.error(`FAIL: ${message}`);
    failed++;
  } else console.log(`  ok: ${message}`);
}
function makeD1(db) {
  const make = (sql, args) => ({
    bind: (...next) => make(sql, next),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => {
      const result = db.prepare(sql).run(...args);
      return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    },
  });
  return { prepare: (sql) => make(sql, []) };
}
function fresh() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE system_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, severity TEXT NOT NULL,
    source TEXT NOT NULL, message TEXT NOT NULL, link_url TEXT, created_at INTEGER NOT NULL DEFAULT 1,
    dismissed_at INTEGER, kind TEXT NOT NULL DEFAULT 'review', condition_key TEXT, resolved_at INTEGER,
    condition_observed_at INTEGER, event_key TEXT
  );
  CREATE UNIQUE INDEX standing ON system_alerts(username, source)
    WHERE condition_key IS NOT NULL AND dismissed_at IS NULL AND resolved_at IS NULL;
  CREATE UNIQUE INDEX record_event ON system_alerts(event_key)
    WHERE kind = 'record' AND event_key IS NOT NULL;`);
  return { db, env: { DB: makeD1(db) } };
}
const key = (n) => reviewConditionKey("test", { book: "JER", resource: "ult" }, { n });
const rows = (db) => db.prepare(`SELECT username, source, message, condition_key, dismissed_at, resolved_at, condition_observed_at
  FROM system_alerts ORDER BY id`).all();

console.log("\n[Stage 7: same measured condition updates in place]");
{
  const { db, env } = fresh();
  await reconcileReviewAlert(env, { username: "ben", source: "verse_merge_conflict:JER:ult", conditionKey: key(1), message: "first", now: 10 });
  await reconcileReviewAlert(env, { username: "ben", source: "verse_merge_conflict:JER:ult", conditionKey: key(1), message: "refreshed count", now: 11 });
  const r = rows(db);
  ok(r.length === 1 && r[0].message === "refreshed count", "same key refreshes details without a new row");
}

console.log("\n[Stage 8: expected telemetry is append-only record history]");
{
  const { db, env } = fresh();
  const input = {
    username: "deferredreward",
    source: "export_revert:JER:ust",
    message: "export overwrote one verse",
    severity: "warning",
    eventKey: "night-1:export_revert:JER:ust",
  };
  await appendSystemRecord(env, input);
  await appendSystemRecord(env, input);
  await appendSystemRecord(env, { ...input, message: "export overwrote two verses", eventKey: "night-2:export_revert:JER:ust" });
  const records = db.prepare(`SELECT kind, message, dismissed_at, resolved_at FROM system_alerts WHERE source = ? ORDER BY id`).all(input.source);
  ok(records.length === 2, "replay is idempotent while a genuinely later telemetry event appends");
  ok(records.every((r) => r.kind === "record" && r.dismissed_at == null && r.resolved_at == null), "telemetry rows are non-actionable record history");
}

console.log("\n[Stage 7: dismissal and transition semantics]");
{
  const { db, env } = fresh();
  const input = { username: "ben", source: "s", conditionKey: key(1), message: "same" };
  await reconcileReviewAlert(env, input);
  db.prepare(`UPDATE system_alerts SET dismissed_at = 20`).run();
  await reconcileReviewAlert(env, { ...input, message: "different wording" });
  ok(rows(db).length === 1 && rows(db)[0].dismissed_at === 20, "dismissed identical condition stays dismissed");
  await reconcileReviewAlert(env, { ...input, conditionKey: key(2), message: "new condition" });
  const r = rows(db);
  ok(r.length === 2 && r[1].resolved_at == null && r[0].dismissed_at === 20, "a different condition creates a new standing row and preserves dismissal history");
}

console.log("\n[Stage 7: remeasuring a dismissed condition advances its race generation]");
{
  const { db, env } = fresh();
  const input = { username: "ben", source: "s", conditionKey: key(1), message: "same" };
  await reconcileReviewAlert(env, { ...input, now: 10, observedAt: 100 });
  db.prepare(`UPDATE system_alerts SET dismissed_at = 11`).run();
  await reconcileReviewAlert(env, { ...input, now: 30, observedAt: 300 });
  await reconcileReviewAlert(env, { ...input, conditionKey: key(2), message: "delayed different", now: 20, observedAt: 200 });
  const r = rows(db);
  ok(r.length === 1 && r[0].dismissed_at === 11 && r[0].resolved_at == null, "a delayed intermediate condition cannot reopen after a newer dismissed remeasurement");
}

console.log("\n[Stage 7: clean, unmeasured, recurrence, and per-user scope]");
{
  const { db, env } = fresh();
  const observedBase = Date.now();
  await reconcileReviewAlert(env, { username: "a", source: "s", conditionKey: key(1), message: "a", observedAt: observedBase });
  await reconcileReviewAlert(env, { username: "b", source: "s", conditionKey: key(1), message: "b", observedAt: observedBase });
  await resolveReviewAlert(env, "s", 30, "a", observedBase + 1);
  let r = rows(db);
  ok(r[0].resolved_at === 30 && r[1].resolved_at == null, "resolution is per editor and retains the resolved row");
  await reconcileReviewAlert(env, { username: "a", source: "s", conditionKey: key(1), message: "late run", measured: false });
  r = rows(db);
  ok(r[0].resolved_at === 30 && r[0].message === "a", "an unmeasured run leaves the standing/history state untouched");
  await reconcileReviewAlert(env, {
    username: "a",
    source: "s",
    conditionKey: key(1),
    message: "recurrence",
    observedAt: observedBase + 2,
  });
  r = rows(db);
  ok(r.length === 3 && r[2].resolved_at == null, "a recurrence after resolution mints a new transition");
  ok((await activeReviewAlertUsernames(env, "s")).sort().join(",") === "a,b", "active recipients remain independently discoverable");
}

console.log("\n[Stage 7: concurrent identical writers]");
{
  const { db, env } = fresh();
  await Promise.all(Array.from({ length: 8 }, (_, i) => reconcileReviewAlert(env, {
    username: "ben", source: "s", conditionKey: key(9), message: `run ${i}`,
  })));
  const active = rows(db).filter((r) => r.resolved_at == null && r.dismissed_at == null);
  ok(active.length === 1, "the partial unique index leaves one standing row under concurrent writers");
}

console.log("\n[Stage 7: concurrent different writers converge on the newer observation]");
{
  const { db, env } = fresh();
  await Promise.all([
    reconcileReviewAlert(env, { username: "ben", source: "s", conditionKey: key(1), message: "old", now: 10, observedAt: 10 }),
    reconcileReviewAlert(env, { username: "ben", source: "s", conditionKey: key(2), message: "new", now: 20, observedAt: 20 }),
  ]);
  const active = rows(db).filter((r) => r.resolved_at == null && r.dismissed_at == null);
  ok(active.length === 1 && active[0].message === "new", "the unique-index race cannot leave the older condition standing");
}

console.log("\n[Stage 7: an older run cannot retire a newer measured condition]");
{
  const { db, env } = fresh();
  await reconcileReviewAlert(env, { username: "ben", source: "s", conditionKey: key(2), message: "new", now: 20, observedAt: 20 });
  await reconcileReviewAlert(env, { username: "ben", source: "s", conditionKey: key(1), message: "old", now: 10, observedAt: 10 });
  await resolveReviewAlert(env, "s", 10, undefined, 10);
  const active = rows(db).filter((r) => r.resolved_at == null && r.dismissed_at == null);
  ok(active.length === 1 && active[0].message === "new", "older measurement cannot overwrite or clean a newer standing condition");
}

console.log("\n[Stage 7: an older run cannot resurrect after a newer clean measurement]");
{
  const { db, env } = fresh();
  await reconcileReviewAlert(env, { username: "ben", source: "s", conditionKey: key(2), message: "new", now: 20, observedAt: 20 });
  await resolveReviewAlert(env, "s", 21, undefined, 21);
  await reconcileReviewAlert(env, { username: "ben", source: "s", conditionKey: key(1), message: "late old", now: 10, observedAt: 10 });
  const r = rows(db);
  ok(r.length === 1 && r[0].resolved_at === 21, "resolved newer history prevents a delayed older condition from resurfacing");
}

console.log("\n[Stage 7: a clean observation advances ordering beyond the condition it resolved]");
{
  const { db, env } = fresh();
  await reconcileReviewAlert(env, { username: "ben", source: "s", conditionKey: key(1), message: "original", now: 10, observedAt: 10 });
  await resolveReviewAlert(env, "s", 30, "ben", 30);
  await reconcileReviewAlert(env, { username: "ben", source: "s", conditionKey: key(2), message: "delayed middle run", now: 20, observedAt: 20 });
  const r = rows(db);
  ok(
    r.length === 1 && r[0].resolved_at === 30 && r[0].condition_observed_at === 30,
    "the clean generation is retained, so a run newer than the old alert but older than the clean check cannot resurrect it",
  );
}

console.log("\n[Stage 7 producer semantics: editor episodes are independently keyed]");
{
  const { db, env } = fresh();
  const source = "verse_merge_conflict:JER:ult";
  const bKey = verseMergeEditorConditionKey("JER", "ult", "editor-b", ["31:1@v4"]);
  await reconcileReviewAlert(env, { username: "editor-b", source, conditionKey: bKey, message: "B first", now: 100, observedAt: 100 });
  db.prepare(`UPDATE system_alerts SET dismissed_at = 101`).run();
  const aKey = verseMergeEditorConditionKey("JER", "ult", "editor-a", ["31:2@v4"]);
  await reconcileReviewAlert(env, { username: "editor-a", source, conditionKey: aKey, message: "A first", now: 100, observedAt: 100 });
  // The next run changes only A's refs. B's same condition remains dismissed.
  await reconcileReviewAlert(env, { username: "editor-a", source, conditionKey: verseMergeEditorConditionKey("JER", "ult", "editor-a", ["31:3@v5"]), message: "A changed", now: 200, observedAt: 200 });
  const b = rows(db).filter((r) => r.username === "editor-b");
  const a = rows(db).filter((r) => r.username === "editor-a");
  ok(b.length === 1 && b[0].dismissed_at === 101, "an unchanged editor keeps its dismissed alert when another editor's refs change");
  ok(a.length === 2 && a[1].resolved_at == null, "the changed editor gets a new alert transition");
}

console.log("\n[Stage 7: unrelated comment/event rows are not reconciled]");
{
  const { db, env } = fresh();
  db.prepare(`INSERT INTO system_alerts (username, severity, source, message) VALUES ('ben','info','comment:7','mentioned')`).run();
  await resolveReviewAlert(env, "verse_merge_conflict:JER:ult");
  ok(rows(db)[0].resolved_at == null, "a source-scoped clean state leaves comment notifications untouched");
}

console.log("\n[Stage 7 migration: legacy duplicates are retained as history and notifications are excluded]");
{
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE system_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, severity TEXT NOT NULL,
    source TEXT NOT NULL, message TEXT NOT NULL, link_url TEXT, created_at INTEGER NOT NULL DEFAULT 1,
    dismissed_at INTEGER, kind TEXT NOT NULL DEFAULT 'review'
  );`);
  db.prepare(`INSERT INTO system_alerts (username,severity,source,message) VALUES ('ben','warning','s','old')`).run();
  db.prepare(`INSERT INTO system_alerts (username,severity,source,message) VALUES ('ben','warning','s','new')`).run();
  db.prepare(`INSERT INTO system_alerts (username,severity,source,message) VALUES ('deferredreward','warning','reimport_kept_over_door43:JER:ust','kept 5')`).run();
  db.prepare(`INSERT INTO system_alerts (username,severity,source,message) VALUES ('ben','info','comment_mention','mention')`).run();
  db.prepare(`INSERT INTO system_alerts (username,severity,source,message,kind) VALUES ('ben','info','record','event','record')`).run();
  const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "0066_review_alert_transitions.sql"), "utf8");
  db.exec(migration);
  db.exec(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "0067_sync_record_alerts.sql"), "utf8"));
  const migrated = db.prepare(`SELECT source,kind,condition_key,resolved_at FROM system_alerts ORDER BY id`).all();
  ok(migrated[0].resolved_at != null && migrated[1].resolved_at == null, "legacy duplicate review rows collapse to the newest standing row");
  ok(String(migrated[1].condition_key).startsWith("legacy:v1:"), "surviving legacy review rows receive an explicit opaque history key");
  const comment = migrated.find((r) => r.source === "comment_mention");
  const record = migrated.find((r) => r.source === "record");
  ok(comment?.resolved_at == null && comment?.condition_key == null, "comment notifications are untouched by legacy cleanup/backfill");
  ok(record?.resolved_at == null && record?.condition_key == null, "record telemetry is untouched by legacy cleanup/backfill");
  const kept = migrated.find((r) => r.source === "reimport_kept_over_door43:JER:ust");
  ok(kept?.kind === "record", "legacy kept-over-Door43 rows are backfilled as non-actionable telemetry");
  ok(kept?.condition_key == null, "telemetry backfill does not invent a review condition key");
}

if (failed) process.exitCode = 1;
else console.log("reviewAlerts.test.mjs: all assertions passed");
