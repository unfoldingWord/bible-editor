-- Cookie-based sessions. Each row is one browser-side login: rotated on
-- explicit sign-in, revoked on logout, decay-aged by expires_at. The
-- Access cookie still carries a short-lived JWT (it's stateless and fast
-- to verify); the Refresh cookie holds this row's `id` so server-side
-- revocation actually works.
--
-- csrf_token is a per-session double-submit value: the same token rides
-- in the non-HttpOnly `be_csrf` cookie AND in the `X-CSRF-Token` header
-- the client mirrors back on writes. Attacker without script access on
-- our origin can't read the cookie to mirror it.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  csrf_token   TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  last_seen_at INTEGER,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires ON sessions(expires_at) WHERE revoked_at IS NULL;
