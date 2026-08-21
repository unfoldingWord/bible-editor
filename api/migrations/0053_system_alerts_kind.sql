-- Splits system_alerts into two audiences (issue #535): 'review' rows are a
-- decision a human still needs to make and stay in the personal banner
-- (GET /api/alerts/me); 'record' rows are a durable, non-blocking record of
-- something that already happened as expected (e.g. "export shipped and
-- overwrote master's content") and belong in the admin panel's activity log
-- only, not as a personal alert. Deliberately not named 'info' — that would
-- share a literal with the existing `severity` column ('error'/'warning'/
-- 'info'), inviting a future caller to bind the wrong parameter. Every
-- existing and future row defaults to 'review' so nothing already-actionable
-- silently stops alerting; only the two purely-observational export-side
-- sources are backfilled to 'record'.
ALTER TABLE system_alerts ADD COLUMN kind TEXT NOT NULL DEFAULT 'review';

UPDATE system_alerts
   SET kind = 'record'
 WHERE source LIKE 'export_revert:%'
    OR source LIKE 'mechanical_overwrite:%';

CREATE INDEX system_alerts_kind_created ON system_alerts (kind, created_at);
