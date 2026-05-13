-- Staging table for AI-pipeline output. When a pipeline_jobs row transitions
-- to state='done', the poll handler fetches each output[].rawUrl from Door43,
-- parses it, and writes one row here per TN/TQ/verse the pipeline produced.
-- Translators later review these and accept/reject; accept materializes the
-- payload via the existing POST /api/rows or PATCH /api/verses path so the
-- normal version + edit_log invariants hold.
--
-- Soft-delete via rejected_at/accepted_at keeps an audit trail of which AI
-- suggestions were rejected — useful for measuring pipeline quality later.

CREATE TABLE pending_imports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          TEXT    NOT NULL REFERENCES pipeline_jobs(job_id),
  kind            TEXT    NOT NULL,        -- 'tn' | 'tq' | 'verse'
  book            TEXT    NOT NULL,
  chapter         INTEGER NOT NULL,
  verse           INTEGER NOT NULL,
  bible_version   TEXT,                    -- 'ULT' | 'UST' for kind='verse', NULL otherwise
  payload_json    TEXT    NOT NULL,        -- row body matching the live POST shape
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  accepted_at     INTEGER,
  accepted_by     INTEGER REFERENCES users(id),
  rejected_at     INTEGER,
  rejected_by     INTEGER REFERENCES users(id)
);

CREATE INDEX pending_imports_job   ON pending_imports(job_id);
CREATE INDEX pending_imports_scope ON pending_imports(book, chapter, kind)
  WHERE accepted_at IS NULL AND rejected_at IS NULL;
