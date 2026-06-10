-- Nightly-export PR observability (see exportWorkflow.ts:exportOne). pr_number
-- is the open PR ensured for the snapshot's branch; pr_error carries the
-- failure detail when ensuring it threw (prReason "error"), which previously
-- only went to console.log. Both NULL when no PR was applicable (dry run,
-- no service token, content unchanged vs master, no rows).
ALTER TABLE export_snapshots ADD COLUMN pr_number INTEGER;
ALTER TABLE export_snapshots ADD COLUMN pr_error TEXT;
