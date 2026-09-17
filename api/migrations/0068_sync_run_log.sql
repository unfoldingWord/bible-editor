-- Stage 9: append-only workflow run ledger for overnight visibility.
CREATE TABLE sync_run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  status TEXT,
  book TEXT,
  resource TEXT,
  details_json TEXT,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX sync_run_log_runs
  ON sync_run_log (run_id, occurred_at, id);

CREATE INDEX sync_run_log_recent
  ON sync_run_log (occurred_at DESC, id DESC);

CREATE INDEX sync_run_log_type_recent
  ON sync_run_log (event_type, occurred_at DESC, id DESC);
