-- Issue #908 (performance audit #884): two per-tab 30-second polls were
-- reading more rows than needed because no index matched their predicates.
--
-- GET /api/:book/trash (chapters.ts) filtered tn_rows on
-- (book, trashed_at IS NOT NULL, deleted_at IS NULL) but the only usable
-- index was tn_book(book) WHERE deleted_at IS NULL, so the plan fetched
-- every non-deleted tn row of the book and tested trashed_at on each one.
CREATE INDEX IF NOT EXISTS tn_trashed
  ON tn_rows (book, trashed_at)
  WHERE trashed_at IS NOT NULL AND deleted_at IS NULL;

-- GET /api/alerts/me (alerts.ts) filters system_alerts on
-- (username = ?, dismissed_at IS NULL, resolved_at IS NULL, kind = 'review')
-- but the planner picked system_alerts_kind_created(kind, created_at), which
-- reads every 'review' alert ever raised rather than just this user's open
-- ones (system_alerts_active predates the 'kind'/'resolved_at' columns and
-- doesn't cover them either).
CREATE INDEX IF NOT EXISTS system_alerts_review_open
  ON system_alerts (username, created_at)
  WHERE kind = 'review' AND dismissed_at IS NULL AND resolved_at IS NULL;
