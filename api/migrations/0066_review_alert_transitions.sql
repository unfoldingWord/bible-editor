-- Stage 7: system_alerts are transitions of measured review conditions, not
-- nightly snapshots. resolved_at preserves the old row as history; a new
-- condition gets a new row. condition_key is deliberately nullable so legacy
-- comments/events and pre-0066 rows remain valid during rollout.
ALTER TABLE system_alerts ADD COLUMN condition_key TEXT;
ALTER TABLE system_alerts ADD COLUMN resolved_at INTEGER;
ALTER TABLE system_alerts ADD COLUMN condition_observed_at INTEGER;

-- Old duplicate active banners were a known consequence of the former
-- delete/insert races. Keep the newest active row and mark earlier copies
-- resolved before creating the standing-condition uniqueness invariant.
UPDATE system_alerts
   SET resolved_at = COALESCE(created_at, unixepoch())
 WHERE kind = 'review'
   AND source NOT IN ('comment_mention', 'comment_reply')
   AND dismissed_at IS NULL
   AND id NOT IN (
     SELECT MAX(id) FROM system_alerts
      WHERE kind = 'review'
        AND source NOT IN ('comment_mention', 'comment_reply')
        AND dismissed_at IS NULL
      GROUP BY username, source
   );

-- Legacy rows have no trustworthy semantic fingerprint: their messages often
-- contain nightly counts and ref samples. Give each surviving historical row
-- an explicit migration-era identity rather than pretending two old messages
-- describe the same measured condition. The next measured producer call
-- transitions from this opaque legacy state to a canonical review:v1 key.
UPDATE system_alerts
   SET condition_key = 'legacy:v1:' || source || ':' || id
 WHERE condition_key IS NULL
   AND kind = 'review'
   AND source NOT IN ('comment_mention', 'comment_reply');

CREATE UNIQUE INDEX system_alerts_one_standing_review
  ON system_alerts (username, source)
 WHERE kind = 'review'
   AND condition_key IS NOT NULL
   AND dismissed_at IS NULL
   AND resolved_at IS NULL;

CREATE INDEX system_alerts_condition_history
  ON system_alerts (source, username, condition_key, resolved_at);
