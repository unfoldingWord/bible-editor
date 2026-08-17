-- Append-only audit trail for book lock/unlock actions. `book_locks` is an
-- upsert (see migration 0043) — set_at/set_by get overwritten on every
-- change, so it cannot answer "who locked/unlocked this book, and when" once
-- a second change lands. That gap destroyed the evidence trail during the
-- incident investigated in #512. This table is insert-only: every lock,
-- unlock, and lock-push writes a new row here in addition to whatever
-- book_locks does, so the history survives later changes.
--
-- No read endpoint or UI yet — queryable via wrangler d1 execute is enough
-- for now (see #513).

CREATE TABLE book_lock_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book TEXT NOT NULL,
  locked INTEGER NOT NULL,          -- 1 = lock, 0 = unlock
  reason TEXT,
  action TEXT NOT NULL,             -- 'lock' | 'unlock' | 'lock_push'
  user_id INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX book_lock_events_book ON book_lock_events(book, created_at);
