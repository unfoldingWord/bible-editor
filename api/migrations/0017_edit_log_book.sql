-- Add `book` to edit_log so audit/history queries can scope by (kind, book,
-- row_key) instead of just (kind, row_key). Without this, the same 4-char
-- row id appearing in two books interleaves their history, and pipeline
-- imports that touch tn_rows by bare id (now fixed in pipelineImport.ts) had
-- no way to disambiguate after the fact.
--
-- Backfill is best-effort: a correlated subquery against tn/tq/twl_rows looks
-- up the row's current book. LIMIT 1 absorbs any pre-existing cross-book id
-- collisions (extremely unlikely on existing data — the 4-char IDs were minted
-- per-book in import-book.mjs and the migration to composite PK was the first
-- chance for any collision to land). For verse entries, row_key already
-- encodes book in the leading segment.

ALTER TABLE edit_log ADD COLUMN book TEXT;

UPDATE edit_log
   SET book = (SELECT book FROM tn_rows WHERE id = edit_log.row_key LIMIT 1)
 WHERE kind = 'tn';

UPDATE edit_log
   SET book = (SELECT book FROM tq_rows WHERE id = edit_log.row_key LIMIT 1)
 WHERE kind = 'tq';

UPDATE edit_log
   SET book = (SELECT book FROM twl_rows WHERE id = edit_log.row_key LIMIT 1)
 WHERE kind = 'twl';

-- row_key for verses is 'BOOK/ch/v/version'. instr() returns 1-indexed
-- position of '/'; we slice everything before it.
UPDATE edit_log
   SET book = substr(row_key, 1, instr(row_key, '/') - 1)
 WHERE kind = 'verse' AND instr(row_key, '/') > 0;

CREATE INDEX edit_log_row_by_book ON edit_log (kind, book, row_key);
