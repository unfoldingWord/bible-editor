-- Belt-and-suspenders backstop for the existing 48h time-based stuck-job
-- threshold. Some upstream failure modes (e.g. bot returns 200 with state
-- "running" forever) keep `updated_at` fresh on every poll but never reach
-- a terminal state. Counting poll attempts catches those. The */5 cron runs
-- 12×/hour, so 100 attempts ≈ 8 hours of stuckness before we auto-fail.
ALTER TABLE pipeline_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
