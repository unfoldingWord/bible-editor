// The edit_log INSERT shared by scan-tn-quotes.mjs and rollback-tn-quotes.mjs.
//
// source is 'quote_repair' so the keep rule (api/src/keptNotes.ts,
// REPAIR_SOURCES) never counts a script's quote rewrite as a person's edit.
// Without it the row looks like an ordinary translator edit (source NULL, real
// user_id) and a repaired AI note gets kept on the next notes run (#1152).
//
// Gated on `changes()`: it reflects the UPDATE immediately before it on this
// connection, so the audit row exists only if that UPDATE really landed.
// `book` and `id` must already be SQL-escaped; `actor` is a users.id number.
export function quoteRepairAuditSql(actor, book, id) {
  return [
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source, payload_json)`,
    `  SELECT 'tn', id, book, ${actor}, version - 1, version, 'update', 'quote_repair', json_object('quote', quote)`,
    `    FROM tn_rows WHERE book = '${book}' AND id = '${id}' AND changes() > 0;`,
  ];
}
