-- "Completed while you were away" notifications for pipeline jobs.
--
-- When the server's */5-minute cron polls a job to a terminal state
-- (done or failed), the user may not have an open tab. notified_user_at
-- stays NULL until the *next* time their browser fetches /api/pipelines
-- and the client surfaces a toast — then the client marks the row
-- notified so a future reload doesn't re-toast the same job.

ALTER TABLE pipeline_jobs ADD COLUMN notified_user_at INTEGER;

-- Targets the "what should I toast on this user's next load?" query:
-- terminal jobs they own with notified_user_at IS NULL.
CREATE INDEX pipeline_jobs_user_unnotified
  ON pipeline_jobs(user_id, notified_user_at, updated_at DESC);
