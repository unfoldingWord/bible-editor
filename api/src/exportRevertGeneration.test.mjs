import { DatabaseSync } from "node:sqlite";
import {
  CLAIM_EXPORT_REVERT_GENERATION_SQL,
  DELETE_EXPORT_REVERTS_FOR_GENERATION_SQL,
  INSERT_EXPORT_REVERT_FOR_GENERATION_SQL,
  INSERT_EXPORT_RECORD_FOR_GENERATION_SQL,
  RESOLVE_EXPORT_REVERT_PERSISTENCE_FOR_GENERATION_SQL,
  SELECT_EXPORT_REVERT_GENERATION_SQL,
} from "./exportRevertGeneration.ts";

let failed = 0;
function ok(value, message) {
  if (!value) {
    console.error(`FAIL: ${message}`);
    failed++;
  } else console.log(`  ok: ${message}`);
}

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE export_reverts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, book TEXT NOT NULL, resource TEXT NOT NULL,
  ref TEXT NOT NULL, class TEXT NOT NULL, fields TEXT, detected_at INTEGER DEFAULT 1
);
CREATE UNIQUE INDEX export_reverts_unique ON export_reverts(book,resource,ref);
CREATE TABLE export_revert_generations (
  book TEXT NOT NULL, resource TEXT NOT NULL, generation TEXT NOT NULL,
  observed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(book,resource)
);
CREATE TABLE system_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, severity TEXT, source TEXT,
  message TEXT, link_url TEXT, kind TEXT DEFAULT 'review', event_key TEXT,
  resolved_at INTEGER, condition_observed_at INTEGER
);
CREATE UNIQUE INDEX system_alerts_record_event_key ON system_alerts(event_key)
  WHERE kind='record' AND event_key IS NOT NULL;`);

console.log("\n[Stage 8: a superseded export cannot corrupt the newer revert snapshot]");
const claim = db.prepare(CLAIM_EXPORT_REVERT_GENERATION_SQL);
const del = db.prepare(DELETE_EXPORT_REVERTS_FOR_GENERATION_SQL);
const insert = db.prepare(INSERT_EXPORT_REVERT_FOR_GENERATION_SQL);
const current = db.prepare(SELECT_EXPORT_REVERT_GENERATION_SQL);

ok(Number(claim.run("JER", "ust", "old", 100).changes) === 1, "older workflow initially claims the pair");
db.prepare(`INSERT INTO export_reverts(book,resource,ref,class) VALUES ('JER','ust','1:1','substantive')`).run();
ok(Number(del.run("JER", "ust", "old", 100).changes) === 1, "older claim can clear the prior snapshot while current");
ok(Number(claim.run("JER", "ust", "new", 200).changes) === 1, "newer workflow supersedes the older claim");
ok(Number(insert.run("JER", "ust", "1:2", "substantive", null, "new", 200).changes) === 1, "newer workflow writes its row");
ok(Number(insert.run("JER", "ust", "1:3", "substantive", null, "old", 100).changes) === 0, "late older insert is rejected by the generation guard");
ok(Number(del.run("JER", "ust", "old", 100).changes) === 0, "late older delete cannot erase the newer snapshot");
ok(Number(claim.run("JER", "ust", "old", 100).changes) === 0, "older workflow cannot reclaim the pair");
ok(current.get("JER", "ust", "new", 200)?.ok === 1, "newer generation remains authoritative");
const refs = db.prepare(`SELECT ref FROM export_reverts WHERE book='JER' AND resource='ust' ORDER BY ref`).all().map((r) => r.ref);
ok(refs.join(",") === "1:2", "snapshot contains only the newer workflow's rows");

console.log("\n[Stage 8: post-verification alert/activity writes are atomically generation-guarded]");
db.prepare(`INSERT INTO system_alerts(username,severity,source,message,condition_observed_at)
  VALUES ('deferredreward','warning','export_revert_persistence:JER:ust','failed',100)`).run();
const record = db.prepare(INSERT_EXPORT_RECORD_FOR_GENERATION_SQL);
const resolve = db.prepare(RESOLVE_EXPORT_REVERT_PERSISTENCE_FOR_GENERATION_SQL);
ok(Number(record.run('deferredreward','warning','export_revert:JER:ust','old event',null,'old-event','JER','ust','old',100).changes) === 0,
  "superseded workflow cannot append telemetry after its final snapshot check");
ok(Number(resolve.run('deferredreward','export_revert_persistence:JER:ust',100,'JER','ust','old').changes) === 0,
  "superseded workflow cannot resolve the persistence condition");
ok(Number(record.run('deferredreward','warning','export_revert:JER:ust','new event',null,'new-event','JER','ust','new',200).changes) === 1,
  "current workflow appends its telemetry");
ok(Number(resolve.run('deferredreward','export_revert_persistence:JER:ust',200,'JER','ust','new').changes) === 1,
  "current workflow resolves the older persistence condition");

if (failed) process.exitCode = 1;
else console.log("exportRevertGeneration.test.mjs: all assertions passed");
