-- Within-verse ordering for translation questions, mirroring tn_rows (0003)
-- and twl_rows (0004). tq_rows never got the column, so the nightly export
-- ordered tq by id (alphabetical) instead of authored order and reordered any
-- verse with more than one question on round-trip. Existing rows seed with
-- rowid * 100 so display + export order matches the original import order.

ALTER TABLE tq_rows ADD COLUMN sort_order REAL;
UPDATE tq_rows SET sort_order = rowid * 100.0;
