-- Issue #1137: a durable record of what a verse_merge_conflicts row said
-- before a reimport's SPECULATIVE upsert (written before the master-adoption
-- compare-and-swap) changed it, so the row can be put back when that adoption
-- never lands, even when the run that wrote it died, was retried, or
-- overlapped another run. Issue #1132 kept this capture in memory, which a
-- crashed Workflow attempt or a second run cannot see.
--
--   prior_run   the run whose speculative adoption write is still unsettled
--               (NULL = settled: the row says what it means). A landed write
--               settles it in the CAS's own batch; a non-adoption flag
--               settles it on upsert.
--   prior_json  the row's columns before the first unsettled speculative
--               write, as JSON; NULL while prior_run is set means the row did
--               not exist before it
--
-- Additive only: two nullable columns, no backfill. Code from before this
-- migration never reads or writes them, so a code rollback keeps working.
ALTER TABLE verse_merge_conflicts ADD COLUMN prior_json TEXT;
ALTER TABLE verse_merge_conflicts ADD COLUMN prior_run TEXT;
