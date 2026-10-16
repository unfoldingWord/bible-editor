-- #1029: blob shas of every render pushed since master was last confirmed
-- (JSON array, newest capped at 10). Lets the export-revert report recognise a
-- master that lags behind unmerged export PRs as still holding our own bytes.
ALTER TABLE book_resource_syncs ADD COLUMN unconfirmed_renders_json TEXT;
