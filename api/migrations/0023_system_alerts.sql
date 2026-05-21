-- User-targeted banner alerts surfaced by the SPA. Used so far for the
-- post-export validate-and-merge workflow on en_tn: on failure, insert a
-- row targeted at 'deferredreward'; on success, dismiss any prior row for
-- the same source.
CREATE TABLE system_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  severity TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  link_url TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  dismissed_at INTEGER
);

CREATE INDEX system_alerts_active
  ON system_alerts (username, dismissed_at, source);
