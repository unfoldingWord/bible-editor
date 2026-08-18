// Regression test for issue #514: the `export_lock_override:{book}:{resource}`
// info alert is exportWorkflow.ts's durable record that a human bypassed the
// book-lock guard for a given (book, resource). writeAlert (exportWorkflow.ts,
// private method) skips its INSERT when the most recent alert for a source was
// dismissed and carries an IDENTICAL message — a rule that exists so a
// nightly-retried failure doesn't reappear after being dismissed (issue #458).
// Before this fix the lock-override message was a CONSTANT string per (book,
// resource) — no counts, no dates, nothing that varies — so dismissing one
// bypass's alert permanently silenced every future bypass of that book+resource:
// the record this alert exists to be, stopped being made at all.
//
// The fix (exportOne, exportWorkflow.ts) folds the per-run `instanceId` into the
// message, so each bypass is a distinct message and the dismissed-identical-
// message skip no longer applies to it.
//
// writeAlert cannot be imported directly: exportWorkflow.ts pulls in
// `cloudflare:workers` (WorkflowEntrypoint), which does not exist outside the
// Workers runtime. Per the convention tombstoneCollision.test.mjs establishes
// for this exact problem, the SELECT/DELETE/INSERT below are re-typed verbatim
// (param style only changed to anonymous ?) from exportWorkflow.ts's writeAlert
// (~line 2497) and system_alerts' schema is copied from
// api/migrations/0023_system_alerts.sql. Keep both in sync with their source.
//
// Run from api/ (needs the sqlite flag):
//   node --experimental-sqlite --experimental-strip-types --no-warnings src/lockOverrideAlert.test.mjs

import { DatabaseSync } from "node:sqlite";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE system_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      severity TEXT NOT NULL,
      source TEXT NOT NULL,
      message TEXT NOT NULL,
      link_url TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      dismissed_at INTEGER
    );
  `);
  return db;
}

const EXPORT_ALERT_USERNAME = "deferredreward";

// writeAlert, re-typed verbatim from exportWorkflow.ts apart from param style.
function writeAlert(db, source, message, linkUrl, severity = "error") {
  const latest = db
    .prepare(
      `SELECT message, dismissed_at FROM system_alerts
        WHERE username = ? AND source = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .all(EXPORT_ALERT_USERNAME, source)[0];
  db.prepare(`DELETE FROM system_alerts WHERE username = ? AND source = ? AND dismissed_at IS NULL`).run(
    EXPORT_ALERT_USERNAME,
    source,
  );
  if (latest && latest.dismissed_at !== null && latest.message === message) {
    return;
  }
  db.prepare(
    `INSERT INTO system_alerts (username, severity, source, message, link_url) VALUES (?, ?, ?, ?, ?)`,
  ).run(EXPORT_ALERT_USERNAME, severity, source, message, linkUrl);
}

function dismiss(db, source) {
  db.prepare(
    `UPDATE system_alerts SET dismissed_at = unixepoch() WHERE username = ? AND source = ? AND dismissed_at IS NULL`,
  ).run(EXPORT_ALERT_USERNAME, source);
}

function undismissedRow(db, source) {
  return db
    .prepare(`SELECT message, dismissed_at FROM system_alerts WHERE username = ? AND source = ? AND dismissed_at IS NULL`)
    .all(EXPORT_ALERT_USERNAME, source)[0];
}

const SOURCE = "export_lock_override:REV:ult";
const linkUrl = "https://example.test/unfoldingWord";

// Exactly exportOne's message shape, before and after the fix, so the two
// scenarios below prove both the bug and the fix against the real semantics.
const constantMessage =
  "REV ULT: book-lock guard bypassed by explicit request — a human cleared the lock so this export could proceed.";
const messageWithInstance = (instanceId) =>
  `REV ULT: book-lock guard bypassed by explicit request — a human cleared the lock so this export could proceed (${instanceId}).`;

console.log("\n[the pre-#514 bug: a constant message silences every future bypass once dismissed]");
{
  const db = freshDb();
  writeAlert(db, SOURCE, constantMessage, linkUrl, "info");
  dismiss(db, SOURCE);
  // A second, later bypass — same (book, resource), same constant message.
  writeAlert(db, SOURCE, constantMessage, linkUrl, "info");
  eq(undismissedRow(db, SOURCE), undefined, "reproduces the bug: the second bypass wrote nothing — no durable record");
}

console.log("\n[issue #514's success check: instanceId varies the message, so a new bypass re-alerts]");
{
  const db = freshDb();
  // (1) write lock-override alert for (REV, ult)
  writeAlert(db, SOURCE, messageWithInstance("export-2026-08-17T02-00-00-000Z"), linkUrl, "info");
  eq(undismissedRow(db, SOURCE)?.message.includes("export-2026-08-17T02-00-00-000Z"), true, "first bypass alert lands");

  // (2) dismiss it
  dismiss(db, SOURCE);
  eq(undismissedRow(db, SOURCE), undefined, "dismissed: no undismissed row remains");

  // (3) simulate a second bypass of the same (book, resource), a later run
  writeAlert(db, SOURCE, messageWithInstance("export-2026-08-18T02-00-00-000Z"), linkUrl, "info");

  // (4) assert a new undismissed row exists
  const row = undismissedRow(db, SOURCE);
  eq(row !== undefined, true, "a new undismissed row exists — the durable record is made again");
  eq(row?.message.includes("export-2026-08-18T02-00-00-000Z"), true, "carries the new run's instanceId");
  eq(row?.message === messageWithInstance("export-2026-08-17T02-00-00-000Z"), false, "distinct from the dismissed message");
}

console.log("\n[an identical re-run of the SAME instance still collapses to one row, not a flood]");
{
  const db = freshDb();
  // The 5-resource fan-out for one book in one lock-push run would call this
  // with the same instanceId per resource-source pair only once each — but
  // guard the underlying replace-undismissed semantics directly: writing the
  // same (source, message) twice without a dismissal in between must still
  // replace, not duplicate.
  writeAlert(db, SOURCE, messageWithInstance("export-2026-08-17T02-00-00-000Z"), linkUrl, "info");
  writeAlert(db, SOURCE, messageWithInstance("export-2026-08-17T02-00-00-000Z"), linkUrl, "info");
  const count = db.prepare(`SELECT COUNT(*) AS n FROM system_alerts WHERE username = ? AND source = ?`).all(
    EXPORT_ALERT_USERNAME,
    SOURCE,
  )[0];
  eq(Number(count.n), 1, "still exactly one row for the source — no duplicate pile-up");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll lockOverrideAlert assertions passed.");
