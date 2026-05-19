-- Replaces the per-Worker-isolate `Set<string> inFlight` in bookImport.ts
-- with a D1-backed lock. Two concurrent POSTs to /api/books/:book/import
-- can land on different Cloudflare edge isolates; the in-memory set is
-- invisible across them, so both would pass the "is this book already
-- importing?" check and race the DELETE-then-INSERT pipeline (a double
-- import that obliterates each other's rows).
--
-- INSERT OR IGNORE on the primary key gives us an atomic "first writer
-- wins" check across all isolates. The DELETE in `finally` releases the
-- lock; if the Worker is killed mid-import, the */5 stale-sweep in the
-- scheduled handler reclaims rows older than 10 minutes (book imports
-- finish well within that — typically 5-60 seconds).
CREATE TABLE book_import_locks (
  book        TEXT PRIMARY KEY,
  started_at  INTEGER NOT NULL,
  started_by  INTEGER REFERENCES users(id)
);
