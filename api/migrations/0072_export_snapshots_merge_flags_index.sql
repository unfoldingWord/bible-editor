-- Issue #990 (follow-up to #442): the admin merge-flags route
-- (GET /api/admin/merge-flags, exportMergeState.ts computeExportMergeFlags)
-- groups every export_snapshots row with pr_number IS NOT NULL by
-- (book, resource, pr_number), then runs a correlated EXISTS per pair
-- looking for a later 'unchanged' row. export_snapshots only had
-- export_snapshots_book(book, committed_at DESC), so neither the GROUP BY
-- nor the EXISTS could use an index and both ran a full table scan
-- (~270 rows/night, ~100k rows/year).
CREATE INDEX IF NOT EXISTS export_snapshots_pair_pr
  ON export_snapshots (book, resource, pr_number);

-- Covers the `unchanged` EXISTS (book, resource, error = 'unchanged', id > ?)
-- without touching the table row itself.
CREATE INDEX IF NOT EXISTS export_snapshots_unchanged
  ON export_snapshots (book, resource, id)
  WHERE error = 'unchanged';
