-- Backfills edit_log.book for tn/tq/twl rows still NULL after 0017's
-- best-effort backfill (a correlated subquery against tn/tq/twl_rows LIMIT 1,
-- which leaves NULL for any row whose owner no longer exists). Prod measured
-- 7,689 such rows (#545); a NULL book is exactly the exposure foldTsvRefBase
-- (#543) and foldTsvBase (#545) refuse to fold into a merge ancestor, since a
-- row id is only unique per (book, id) and a NULL-book entry for id "ab12"
-- could otherwise be a DIFFERENT book's history landing on this book's "ab12"
-- ancestor.
--
-- Every tn/tq/twl writer (rows.ts, bookImport.ts, bookReimport.ts,
-- pipelineImport.ts) stamps `book` into the logged payload itself, so — unlike
-- 0017, which had to look the row up in a table that may no longer hold it —
-- the payload is frequently still a live, first-hand record of which book
-- wrote it. Measured on prod (#545, 2026-08-20): 7,589 of 7,689 NULL-book
-- tn/tq/twl entries (98.7%) carry their true book at payload_json.$.book; the
-- remaining ~100 are older tn partial patches that never included it and stay
-- NULL, still protected by the bookKnown guard in foldTsvRefBase/foldTsvBase.
--
-- Purely additive and idempotent: only touches rows that are NULL today, only
-- ever fills in a value never leaves TRUE data out, and re-running it is a
-- no-op once applied.
UPDATE edit_log
   SET book = json_extract(payload_json, '$.book')
 WHERE book IS NULL
   AND kind IN ('tn', 'tq', 'twl')
   AND payload_json IS NOT NULL
   AND json_extract(payload_json, '$.book') IS NOT NULL;
