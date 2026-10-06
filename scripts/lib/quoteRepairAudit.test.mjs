// Tests for the edit_log audit INSERT the quote-repair scripts emit (#1152).
// Run from the repo root:
//   node --experimental-strip-types --no-warnings scripts/lib/quoteRepairAudit.test.mjs
//
// Applies the real generated SQL to an in-memory SQLite and feeds the resulting
// edit_log rows to classifyKept: a repaired AI note must not count as kept.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { quoteRepairAuditSql } from "./quoteRepairAudit.mjs";
import { classifyKept } from "../../api/src/keptNotes.ts";

const sql = quoteRepairAuditSql(2, "ZEC", "ab12").join("\n");
assert.match(sql, /\bsource\b/, "column list names source");
assert.match(sql, /'quote_repair'/, "selects the quote_repair literal");

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE tn_rows (id TEXT, book TEXT, quote TEXT, version INTEGER);
  CREATE TABLE edit_log (
    id INTEGER PRIMARY KEY, kind TEXT, row_key TEXT, book TEXT, user_id INTEGER,
    prev_version INTEGER, new_version INTEGER, action TEXT, source TEXT,
    payload_json TEXT, created_at INTEGER DEFAULT (unixepoch())
  );
  INSERT INTO tn_rows VALUES ('ab12', 'ZEC', 'old', 1);
`);
const aiCreate = {
  action: "create", source: "ai_pipeline", user_id: 7, created_at: 1,
  payload_json: JSON.stringify({ quote: "old", note: "n", support_reference: "s", ref_raw: "1:1" }),
};

// UPDATE that lands → exactly one audit row, labelled quote_repair.
db.exec(`UPDATE tn_rows SET quote = 'fixed', version = version + 1 WHERE id = 'ab12' AND version = 1;`);
db.exec(sql);
const rows = db.prepare("SELECT * FROM edit_log").all();
assert.equal(rows.length, 1);
assert.equal(rows[0].source, "quote_repair");
assert.equal(rows[0].user_id, 2);
assert.equal(rows[0].action, "update");
assert.equal(rows[0].payload_json, '{"quote":"fixed"}');

const row = { id: "ab12", book: "ZEC", chapter: 1, verse: 1, ref_raw: "1:1", preserve: 0, quote: "fixed", note: "n", support_reference: "s" };
const history = [aiCreate, { action: rows[0].action, source: rows[0].source, user_id: rows[0].user_id, created_at: 2, payload_json: rows[0].payload_json }];
assert.equal(classifyKept(row, history).kept, false, "repaired AI note is not kept");

// UPDATE that did not land (version guard lost) → changes() = 0 → no audit row.
db.exec("DELETE FROM edit_log");
db.exec(`UPDATE tn_rows SET quote = 'x' WHERE id = 'ab12' AND version = 99;`);
db.exec(sql);
assert.equal(db.prepare("SELECT count(*) AS n FROM edit_log").get().n, 0, "no audit row when the UPDATE matched nothing");

console.log("quoteRepairAudit tests passed");
