-- User-controlled within-verse order for translation word links, mirroring
-- the tn_rows sort_order migration. Existing rows seed with rowid * 100 so
-- initial display matches insertion order.

ALTER TABLE twl_rows ADD COLUMN sort_order REAL;
UPDATE twl_rows SET sort_order = rowid * 100.0;
CREATE INDEX twl_chapter_sort ON twl_rows(book, chapter, verse, sort_order) WHERE deleted_at IS NULL;
