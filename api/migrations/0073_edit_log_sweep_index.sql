-- Issue #928: the hourly edit_log retention sweep (EDIT_LOG_SWEEP_SQL in
-- editLogSweep.ts) filters every exempt branch on (kind, action,
-- created_at < cutoff), but the only index leading with kind was
-- edit_log_row (kind, row_key), so each of its seven verse branches walked
-- every kind='verse' row in the table. Prod rehearsal (2026-09-23) at the
-- 2026-12-01 cutoff: 2.4 s and 1.5M rows read per hourly run.
--
-- With this index each branch seeks straight to the aged rows of its own
-- actions. The planner does not pick it unprompted (it prefers edit_log_row
-- because that index already orders rows for GROUP BY row_key), so the sweep
-- names it with INDEXED BY. That makes this migration a prerequisite of the
-- sweep code: `npm run deploy` applies migrations before deploying the Worker.
--
-- Additive only.
CREATE INDEX IF NOT EXISTS edit_log_kind_action_created
  ON edit_log (kind, action, created_at);
