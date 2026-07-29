-- Internal, human-to-human comments/notes anchored to a verse or a tn/tq/twl
-- row. Never exported to DCS: the nightly export hand-writes one SELECT per
-- known resource table (buildResource in exportWorkflow.ts), so this table is
-- structurally invisible to it — no filter to remember, no column to exclude.
--
-- Two kinds:
--   'question' — resolvable; drives an alert to a mentioned person with a
--                 one-click deep link, and carries a resolved/unresolved badge.
--   'note'     — persistent standing guidance, quietly visible to whoever next
--                 opens that verse/row. Resolvable too (Notes archivable), just
--                 without badge pressure.
--
-- Flat replies only (no threads-of-threads): a reply is a row with parent_id
-- set. Its anchor columns (book/chapter/verse/row_kind/row_id) are
-- denormalized copies of the parent's, not derived via JOIN, so the
-- per-chapter read stays a single indexed query instead of a recursive one.
-- Flatness (a reply's parent must itself be top-level) is enforced in the API
-- layer, not the schema.
--
-- Hard rule for the API: this feature writes NOTHING to edit_log. The
-- comments table's own author_id/created_at/deleted_at is the complete audit
-- trail; edit_log entries drive contributor-branch-name derivation for the
-- export (exportWorkflow.ts) and comments must never influence that.
CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book TEXT NOT NULL,
  chapter INTEGER NOT NULL,
  verse INTEGER NOT NULL,
  row_kind TEXT CHECK (row_kind IN ('tn','tq','twl')), -- NULL = verse-level anchor
  row_id TEXT,                                          -- both-or-neither with row_kind
  parent_id INTEGER REFERENCES comments(id),            -- NULL = top-level comment
  kind TEXT NOT NULL CHECK (kind IN ('question','note')),
  body TEXT NOT NULL,
  mentions_json TEXT,                                   -- JSON array of resolved dcs_usernames
  author_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at INTEGER,
  resolved_by INTEGER REFERENCES users(id),
  deleted_at INTEGER                                    -- soft delete
);

CREATE INDEX idx_comments_chapter ON comments (book, chapter) WHERE deleted_at IS NULL;
CREATE INDEX idx_comments_parent ON comments (parent_id);
