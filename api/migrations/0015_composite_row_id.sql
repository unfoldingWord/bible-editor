-- Change tn_rows, tq_rows, twl_rows from a global PRIMARY KEY on (id) to a
-- composite PRIMARY KEY on (book, id). The 4-char sticky IDs are unique per
-- book but not globally, so the global constraint blocks importing any two
-- books that share an ID. SQLite doesn't support ALTER PRIMARY KEY, so we
-- recreate each table and copy the data.

-- ── tn_rows ──────────────────────────────────────────────────────────────────
CREATE TABLE tn_rows_new (
  id TEXT NOT NULL,
  book TEXT NOT NULL,
  chapter INTEGER NOT NULL,
  verse INTEGER NOT NULL,
  ref_raw TEXT NOT NULL,
  tags TEXT,
  support_reference TEXT,
  quote TEXT,
  occurrence INTEGER,
  note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  sort_order REAL,
  restored_from_version INTEGER,
  preserve INTEGER NOT NULL DEFAULT 0,
  hint INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (book, id)
);
INSERT INTO tn_rows_new SELECT * FROM tn_rows;
DROP TABLE tn_rows;
ALTER TABLE tn_rows_new RENAME TO tn_rows;
CREATE INDEX tn_chapter ON tn_rows(book, chapter, verse) WHERE deleted_at IS NULL;
CREATE INDEX tn_book ON tn_rows(book) WHERE deleted_at IS NULL;

-- ── tq_rows ──────────────────────────────────────────────────────────────────
CREATE TABLE tq_rows_new (
  id TEXT NOT NULL,
  book TEXT NOT NULL,
  chapter INTEGER NOT NULL,
  verse INTEGER NOT NULL,
  ref_raw TEXT NOT NULL,
  tags TEXT,
  quote TEXT,
  occurrence INTEGER,
  question TEXT,
  response TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  restored_from_version INTEGER,
  PRIMARY KEY (book, id)
);
INSERT INTO tq_rows_new SELECT * FROM tq_rows;
DROP TABLE tq_rows;
ALTER TABLE tq_rows_new RENAME TO tq_rows;
CREATE INDEX tq_chapter ON tq_rows(book, chapter, verse) WHERE deleted_at IS NULL;

-- ── twl_rows ─────────────────────────────────────────────────────────────────
CREATE TABLE twl_rows_new (
  id TEXT NOT NULL,
  book TEXT NOT NULL,
  chapter INTEGER NOT NULL,
  verse INTEGER NOT NULL,
  ref_raw TEXT NOT NULL,
  tags TEXT,
  orig_words TEXT,
  occurrence INTEGER,
  tw_link TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  sort_order REAL,
  restored_from_version INTEGER,
  PRIMARY KEY (book, id)
);
INSERT INTO twl_rows_new SELECT * FROM twl_rows;
DROP TABLE twl_rows;
ALTER TABLE twl_rows_new RENAME TO twl_rows;
CREATE INDEX twl_chapter ON twl_rows(book, chapter, verse) WHERE deleted_at IS NULL;
