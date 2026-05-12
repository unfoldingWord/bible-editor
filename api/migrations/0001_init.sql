-- Initial schema for the bible-editor service.
-- Tactical 7-month tool; designed for simple, fast row-level upserts with
-- optimistic concurrency via the `version` column. DCS is *not* in the save
-- path — see docs/plan.md.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dcs_user_id INTEGER NOT NULL UNIQUE,
  dcs_username TEXT NOT NULL,
  dcs_full_name TEXT,
  dcs_email TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX sessions_user ON sessions(user_id);

-- Translation Notes (tn) — one row per note.
CREATE TABLE tn_rows (
  id TEXT PRIMARY KEY,                  -- 4-char sticky ID matching DCS convention
  book TEXT NOT NULL,                   -- e.g. "ZEC"
  chapter INTEGER NOT NULL,             -- 0 for front:intro
  verse INTEGER NOT NULL,               -- 0 for chapter intro / front
  ref_raw TEXT NOT NULL,                -- preserve "front:intro", "1:1-3", etc.
  tags TEXT,
  support_reference TEXT,
  quote TEXT,
  occurrence INTEGER,
  note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER
);
CREATE INDEX tn_chapter ON tn_rows(book, chapter, verse) WHERE deleted_at IS NULL;
CREATE INDEX tn_book ON tn_rows(book) WHERE deleted_at IS NULL;

-- Translation Questions (tq).
CREATE TABLE tq_rows (
  id TEXT PRIMARY KEY,
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
  deleted_at INTEGER
);
CREATE INDEX tq_chapter ON tq_rows(book, chapter, verse) WHERE deleted_at IS NULL;

-- Translation Word Links (twl).
CREATE TABLE twl_rows (
  id TEXT PRIMARY KEY,
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
  deleted_at INTEGER
);
CREATE INDEX twl_chapter ON twl_rows(book, chapter, verse) WHERE deleted_at IS NULL;

-- Bible verses — one row per (book, chapter, verse, version).
-- `bible_version` distinguishes ULT vs UST vs UHB so the same verse can have
-- multiple parallel scriptures in the same chapter view.
CREATE TABLE verses (
  book TEXT NOT NULL,
  chapter INTEGER NOT NULL,
  verse INTEGER NOT NULL,
  bible_version TEXT NOT NULL,          -- 'ULT' | 'UST' | 'UHB' | 'UGNT' | ...
  content_json TEXT NOT NULL,           -- usfm-js verse-objects JSON (preserves \zaln-s/\zaln-e)
  plain_text TEXT,                      -- denormalized plain text for display fallback
  version INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (book, chapter, verse, bible_version)
);
CREATE INDEX verses_chapter ON verses(book, chapter, bible_version);

-- Append-only audit log. Cheap insurance against accidental row clobbering.
CREATE TABLE edit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                   -- 'tn' | 'tq' | 'twl' | 'verse'
  row_key TEXT NOT NULL,                -- 4-char id OR 'book/ch/v/version' for verses
  user_id INTEGER REFERENCES users(id),
  prev_version INTEGER,
  new_version INTEGER,
  action TEXT NOT NULL,                 -- 'create' | 'update' | 'delete' | 'restore'
  payload_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX edit_log_row ON edit_log(kind, row_key);
CREATE INDEX edit_log_recent ON edit_log(created_at DESC);

-- Per-book import + export snapshot manifest.
CREATE TABLE book_imports (
  book TEXT PRIMARY KEY,
  source_url TEXT,
  imported_at INTEGER NOT NULL DEFAULT (unixepoch()),
  source_sha TEXT,
  imported_by INTEGER REFERENCES users(id)
);

CREATE TABLE export_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book TEXT NOT NULL,
  resource TEXT NOT NULL,               -- 'tn' | 'tq' | 'twl' | 'ult' | 'ust'
  commit_sha TEXT,
  committed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  rows_exported INTEGER,
  error TEXT
);
CREATE INDEX export_snapshots_book ON export_snapshots(book, committed_at DESC);
