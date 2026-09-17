// Regression coverage for the generation guards around alignment_attention.
// The workflow module itself depends on cloudflare:workers, so these statements
// mirror recordAlignmentAttention / clearAlignmentAttention exactly (the same
// test convention used by lockOverrideAlert.test.mjs).

import { DatabaseSync } from "node:sqlite";

let failed = 0;
function ok(value, message) {
  if (!value) {
    console.error(`FAIL: ${message}`);
    failed++;
  } else console.log(`  ok: ${message}`);
}

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE system_alerts (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL, source TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'review', dismissed_at INTEGER, resolved_at INTEGER,
    condition_observed_at INTEGER
  );
  CREATE TABLE alignment_attention (
    id INTEGER PRIMARY KEY AUTOINCREMENT, book TEXT NOT NULL, resource TEXT NOT NULL,
    ref TEXT NOT NULL, lost_words TEXT NOT NULL, provenance TEXT,
    UNIQUE(book, resource, ref)
  );
`);

const user = "deferredreward";
const source = "export_align_shrink:EZK:ust";
const rows = () => db.prepare(`SELECT ref FROM alignment_attention ORDER BY ref`).all().map((r) => r.ref);

function guardedClear(observedAt) {
  db.prepare(`DELETE FROM alignment_attention
    WHERE book = ?1 AND resource = ?2
      AND NOT EXISTS (
        SELECT 1 FROM system_alerts
         WHERE username = ?3 AND source = ?4 AND kind = 'review'
           AND condition_observed_at > ?5
      )`).run("EZK", "ust", user, source, observedAt);
}

function guardedReplace(ref, observedAt) {
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM alignment_attention
      WHERE book = ?1 AND resource = ?2
        AND EXISTS (
          SELECT 1 FROM system_alerts
           WHERE username = ?3 AND source = ?4 AND kind = 'review'
             AND resolved_at IS NULL AND condition_observed_at = ?5
        )`).run("EZK", "ust", user, source, observedAt);
    db.prepare(`INSERT OR REPLACE INTO alignment_attention (book, resource, ref, lost_words, provenance)
      SELECT ?1, ?2, ?3, ?4, ?5
       WHERE EXISTS (
         SELECT 1 FROM system_alerts
          WHERE username = ?6 AND source = ?7 AND kind = 'review'
            AND resolved_at IS NULL AND condition_observed_at = ?8
       )`).run("EZK", "ust", ref, "[]", null, user, source, observedAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

console.log("\n[alignment attention snapshot follows the newest observation]");
db.prepare(`INSERT INTO alignment_attention (book,resource,ref,lost_words) VALUES ('EZK','ust','48:21','[]')`).run();
db.prepare(`INSERT INTO system_alerts (id,username,source,condition_observed_at) VALUES (1,?1,?2,200)`).run(user, source);

guardedClear(100);
ok(JSON.stringify(rows()) === JSON.stringify(["48:21"]), "an older clean workflow cannot erase a newer offender snapshot");

guardedReplace("47:2", 100);
ok(JSON.stringify(rows()) === JSON.stringify(["48:21"]), "an older offender workflow cannot replace a newer snapshot");

guardedReplace("47:2", 200);
ok(JSON.stringify(rows()) === JSON.stringify(["47:2"]), "the authoritative offender generation replaces the prior snapshot");

db.prepare(`UPDATE system_alerts SET resolved_at = 300, condition_observed_at = 300 WHERE id = 1`).run();
guardedClear(300);
ok(rows().length === 0, "the authoritative clean generation clears the snapshot");

if (failed) process.exit(1);
console.log("alignmentAttentionGeneration.test.mjs: all assertions passed");
