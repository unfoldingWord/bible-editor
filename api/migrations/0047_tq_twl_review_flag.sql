-- Extend the workflow-only review flag (migration 0031, tn_rows) to tq_rows and
-- twl_rows so all three TSV kinds can carry an in-app "needs a human eye" mark.
--
-- Why now: the nightly Door43->D1 sync gained a three-way merge for edited
-- tn/tq/twl rows (api/src/tsvMerge.ts). When a maintainer's out-of-band edit on
-- master collides with an app-side edit on the SAME field, master wins (the side
-- a human just touched by hand on Door43) and the row is flagged for review so
-- the overwritten value can be recovered from row version history. tn already
-- had the columns; tq/twl did not.
--
-- Like 0031, these columns are INTERNAL to D1. The TSV export serializers
-- (api/src/export.ts buildTqTsv / buildTwlTsv) emit an explicit fixed column
-- list, so review_* never reaches DCS — no export churn. They drive the in-app
-- "issues to clean up" chip (api/src/lint.ts) and are cleared on the next
-- content save (api/src/rows.ts PATCH). NULL = no review needed.
ALTER TABLE tq_rows ADD COLUMN review_kind TEXT;
ALTER TABLE tq_rows ADD COLUMN review_reason TEXT;
ALTER TABLE twl_rows ADD COLUMN review_kind TEXT;
ALTER TABLE twl_rows ADD COLUMN review_reason TEXT;
