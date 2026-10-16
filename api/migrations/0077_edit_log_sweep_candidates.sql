-- Issue #1057: the hourly edit_log retention sweep (EDIT_LOG_SWEEP_SQL in
-- editLogSweep.ts) now keeps every kind='tn' row forever, so its outer
-- DELETE reads `created_at < cutoff AND kind <> 'tn'`. Through edit_log_recent
-- (created_at) that walk visits every aged tn row and fetches its table row to
-- test kind, every hour, and the aged tn set only grows. Synthetic measurement
-- (node:sqlite, 1.5M rows, 43% tn): an hourly run after the first sweep took
-- 0.7 s before #1057, 3.3 s with the kind filter alone, 0.7 s with this index.
--
-- The partial index holds only the rows the sweep may delete, so the walk
-- skips tn entirely. SQLite uses a partial index only when the query's WHERE
-- implies the index's WHERE, so this predicate must stay textually identical
-- to the sweep's (`kind <> 'tn'`); editLogSweepPlan.test.mjs pins both. The
-- planner picks it unprompted, so the sweep does not name it: if this
-- migration has not been applied, the sweep falls back to edit_log_recent and
-- is slower, not broken.
--
-- Additive only.
CREATE INDEX IF NOT EXISTS edit_log_sweep_candidates
  ON edit_log (created_at) WHERE kind <> 'tn';
