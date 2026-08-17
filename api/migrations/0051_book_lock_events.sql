-- Append-only audit trail for book lock/unlock actions. `book_locks` is an
-- upsert (see migration 0043) — set_at/set_by get overwritten on every
-- change, so it cannot answer "who locked/unlocked this book, and when" once
-- a second change lands. That gap destroyed the evidence trail during the
-- incident investigated in #512. This table is insert-only: every lock,
-- unlock, and lock-push writes a new row here in addition to whatever
-- book_locks does, so the history survives later changes.
--
-- Forensic queries must ORDER BY id, not created_at alone: created_at is
-- second-granularity, and a rapid unlock->relock can tie on the same second.
--
-- No read endpoint or UI yet — queryable via wrangler d1 execute is enough
-- for now (see #513).

CREATE TABLE book_lock_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book TEXT NOT NULL,
  -- The lock state in effect for the event (lock and lock_push = 1, unlock = 0).
  locked INTEGER NOT NULL CHECK (locked IN (0, 1)),
  reason TEXT,
  action TEXT NOT NULL,             -- 'lock' | 'unlock' | 'lock_push'
  -- Deliberately no REFERENCES users(id): an audit insert must never fail.
  -- A dangling userId (a JWT that outlives its users row) would make an FK
  -- check fail silently inside the handler's try/catch, losing the only
  -- record of the invocation. The id is still recorded as a plain integer.
  user_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX book_lock_events_book ON book_lock_events(book, created_at);
