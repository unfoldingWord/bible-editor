import { DatabaseSync } from "node:sqlite";
import { appendSyncRunEvent, syncRunEventKey } from "./syncRunLog.ts";

let failed = 0;
function ok(value, message) {
  if (!value) { console.error(`FAIL: ${message}`); failed++; }
  else console.log(`  ok: ${message}`);
}
function makeD1(db, fail = false) {
  const make = (sql, args) => ({
    bind: (...next) => make(sql, next),
    run: async () => {
      if (fail) throw new Error("simulated D1 outage");
      const result = db.prepare(sql).run(...args);
      return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    },
  });
  return { prepare: (sql) => make(sql, []) };
}
function fresh() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE sync_run_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
    event_key TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL, status TEXT,
    book TEXT, resource TEXT, details_json TEXT, occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  return db;
}

console.log("\n[Stage 9: replay-safe append-only run ledger]");
{
  const db = fresh();
  const env = { DB: makeD1(db) };
  const runId = "export-2026-09-16T05-30-00-000Z";
  const start = { runId, eventKey: syncRunEventKey(runId, "run_started"), eventType: "run_started", occurredAt: 100, status: "started" };
  await appendSyncRunEvent(env, start);
  await appendSyncRunEvent(env, start);
  const item = { runId, eventKey: syncRunEventKey(runId, "item_terminal", "JER", "ust"), eventType: "item_terminal", occurredAt: 100, status: "success", book: "JER", resource: "ust", details: { rowCount: 12 } };
  await appendSyncRunEvent(env, item);
  await appendSyncRunEvent(env, item);
  ok(db.prepare("SELECT COUNT(*) AS n FROM sync_run_log").get().n === 2, "replayed start/item events remain one row each");
  ok(db.prepare("SELECT details_json FROM sync_run_log WHERE event_type = 'item_terminal'").get().details_json === '{"rowCount":12}', "structured item details are retained");
}

console.log("\n[Stage 9: writer failures are non-blocking]");
{
  const db = fresh();
  const result = await appendSyncRunEvent({ DB: makeD1(db, true) }, {
    runId: "r", eventKey: "r:run_started", eventType: "run_started", occurredAt: 1,
  });
  ok(result === false, "a D1 logging failure returns false instead of throwing");
}

if (failed) process.exit(1);
