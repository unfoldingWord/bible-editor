-- Per-verse "this verse's TWL order is owned by a human" lock.
--
-- TWL link order is otherwise a pure function of the ULT alignment, recomputed
-- and written back by the nightly export and the reimport post-pass. A row in
-- this table makes canonical ordering SKIP that verse: the stored sort_order is
-- the human's and nothing overwrites it.
--
-- A side table rather than a column on twl_rows: the lock is per-VERSE data, and
-- keying it by reference means it survives rows being deleted and recreated by a
-- reimport.
CREATE TABLE IF NOT EXISTS twl_order_locks (
  book      TEXT NOT NULL,
  chapter   INTEGER NOT NULL,
  verse     INTEGER NOT NULL,
  locked_by INTEGER NOT NULL,
  locked_at INTEGER NOT NULL DEFAULT (unixepoch()),
  -- "Keep mine": the canonical id sequence at the moment the user dismissed the
  -- "automatic order differs" hint. The hint stays quiet until canonical
  -- ordering proposes something DIFFERENT, instead of nagging every page load.
  dismissed_order TEXT,
  PRIMARY KEY (book, chapter, verse)
);
CREATE INDEX IF NOT EXISTS idx_twl_locks_chapter ON twl_order_locks (book, chapter);
