-- Stage 8: record rows are append-only events. A durable producer key makes
-- Workflow replay idempotent without collapsing genuinely separate nights.
ALTER TABLE system_alerts ADD COLUMN event_key TEXT;

CREATE UNIQUE INDEX system_alerts_record_event_key
  ON system_alerts (event_key)
 WHERE kind = 'record' AND event_key IS NOT NULL;

-- These sources describe expected, non-actionable sync/export events.
-- Older deployments wrote reimport_kept_over_door43 as a review banner before
-- it was classified as telemetry. Convert those rows in place so migration
-- 0066's standing review index no longer exposes them as personal alerts.
UPDATE system_alerts
   SET kind = 'record',
       condition_key = NULL,
       resolved_at = NULL,
       condition_observed_at = NULL
 WHERE kind = 'review'
   AND source LIKE 'reimport_kept_over_door43:%';

-- Replace-all export_reverts snapshots need a per-pair generation claim.
-- Every delete/insert also checks this row, so a superseded workflow cannot
-- erase or append into the newer workflow's snapshot.
CREATE TABLE export_revert_generations (
  book TEXT NOT NULL,
  resource TEXT NOT NULL,
  generation TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (book, resource)
);
