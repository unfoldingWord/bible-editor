-- Book lock overrides. A row in `book_locks` is an EXPLICIT override of the
-- published-books default computed in api/src/publishedGuard.ts — absence of
-- a row for a book means "fall back to that default" (locked if published in
-- the latest DCS release, unlocked otherwise). A row with `locked=0` is a
-- deliberate UNLOCK of an otherwise-published book (e.g. a maintainer opens a
-- published book for a hand-cleanup pass); it is NOT the same thing as no
-- row at all, and it must win over the published default.
--
-- This table is unrelated to the existing `book_import_locks` (migration
-- 0019), which is a short-lived mutex preventing two concurrent DCS→D1 import
-- requests for the same book from racing each other. `book_locks` is a
-- long-lived editorial/publication lock: it blocks app edits and export to
-- Door43 for a book, independent of whether an import is running.
--
-- Add/remove lock admins via SQL, no redeploy needed — same convention as
-- migration 0016's user_roles. COLLATE NOCASE so a casing mismatch in a DCS
-- login doesn't silently deny an admin.

CREATE TABLE book_locks (
  book   TEXT PRIMARY KEY,
  locked INTEGER NOT NULL CHECK (locked IN (0, 1)),
  reason TEXT,
  set_at INTEGER NOT NULL DEFAULT (unixepoch()),
  set_by INTEGER REFERENCES users(id)
);

CREATE TABLE book_lock_admins (
  dcs_username TEXT PRIMARY KEY COLLATE NOCASE,
  added_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT OR IGNORE INTO book_lock_admins (dcs_username) VALUES
  ('deferredreward'), ('richmahn'), ('pjoakes');
