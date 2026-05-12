-- User-controlled within-verse order for translation notes. New column is
-- NULLable; existing rows seed with rowid * 100 so initial display matches
-- insertion order. New rows get a sort_order at INSERT time, chosen by the
-- client to fall between two neighbors.

ALTER TABLE tn_rows ADD COLUMN sort_order REAL;
UPDATE tn_rows SET sort_order = rowid * 100.0;
CREATE INDEX tn_chapter_sort ON tn_rows(book, chapter, verse, sort_order) WHERE deleted_at IS NULL;
