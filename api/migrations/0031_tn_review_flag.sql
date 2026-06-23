-- Workflow-only review flags for adapted/migrated TN rows.
--
-- When a note is adapted from a parallel passage (e.g. 2 Kings 18-20 → Isaiah
-- 36-39) and something needs a human eye — most often a Hebrew quote that
-- couldn't be re-anchored exactly onto the target verse, or a cross-reference
-- that couldn't be auto-resolved — the row is stamped with review_kind +
-- review_reason. NULL = no review needed.
--
-- These columns are INTERNAL to D1. buildTnTsv (api/src/export.ts) serializes
-- an explicit 7-column list, so review_* never reaches DCS — no export churn.
-- They drive the in-app "issues to clean up" chip (api/src/lint.ts) and are
-- cleared on the next TN content save (api/src/rows.ts PATCH).
ALTER TABLE tn_rows ADD COLUMN review_kind TEXT;
ALTER TABLE tn_rows ADD COLUMN review_reason TEXT;
