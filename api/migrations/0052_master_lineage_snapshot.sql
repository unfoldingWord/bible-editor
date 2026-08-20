-- Persists loadMasterLineage's compact MasterLineageSummary so an
-- after-the-fact question ("why did the sync keep D1 on JER tn three weeks
-- ago?") can be answered from the row instead of re-walking Door43's history
-- as it looks NOW, which is not what the run saw — worker logs age out.
--
-- #548 threaded the lineage through a single nightly run (onto MergeCutoff)
-- so the alerts THAT run raises can name their evidence, but never persisted
-- it. book_resource_syncs (0028) is the only per-(book, resource) durable
-- row, so this is last-run-wins, keyed the same way every other watermark on
-- this table already is.
--
-- master_lineage_sha is the newest master commit the walk actually examined
-- for that file (the first entry `listMasterCommitsSince` returns, since the
-- Gitea commits API pages newest-first) — i.e. "as of this master commit,
-- here is what we found" — NOT source_sha or master_confirmed_edit_id, both
-- of which name D1's boundary rather than the far end of the walk.
--
-- See issue #551, split from #540 item 1 while #548 landed.
ALTER TABLE book_resource_syncs ADD COLUMN master_lineage_json TEXT;
ALTER TABLE book_resource_syncs ADD COLUMN master_lineage_sha TEXT;
ALTER TABLE book_resource_syncs ADD COLUMN master_lineage_computed_at INTEGER;
