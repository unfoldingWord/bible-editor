-- Tracks AI-pipeline runs started from the editor against uw-bt-bot
-- (see docs/ai-pipeline-integration.md). One row per job; job_id is the
-- opaque-but-stable key returned by bp-assistant. Phase 1 stores state
-- + the verbatim output[] blob on completion; parsing into tn_rows /
-- verses comes in a later migration.

CREATE TABLE pipeline_jobs (
  job_id          TEXT    PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  pipeline_type   TEXT    NOT NULL,        -- 'generate' | 'notes' | 'tqs'
  book            TEXT    NOT NULL,
  start_chapter   INTEGER NOT NULL,
  end_chapter     INTEGER NOT NULL,
  session_key     TEXT    NOT NULL,
  state           TEXT    NOT NULL,        -- 'running' | 'paused_for_outage' | 'paused_for_usage_limit' | 'failed' | 'done'
  current_skill   TEXT,
  current_status  TEXT,
  error_kind      TEXT,
  error_message   TEXT,
  output_json     TEXT,                    -- contract §4 output[] JSON, populated on state=done
  raw_status_json TEXT,                    -- last full upstream response, kept for debugging
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  last_polled_at  INTEGER
);

CREATE INDEX pipeline_jobs_user_state ON pipeline_jobs(user_id, state, updated_at DESC);
CREATE INDEX pipeline_jobs_scope      ON pipeline_jobs(book, start_chapter, pipeline_type, state);
