-- Issue #1243: store each export_reverts row's #1231 lineage label, so the
-- sync watchdog (scripts/watchdog/collect.mjs) can tell the export_revert
-- alert's rows from the revert_probably_ours record's without parsing the
-- record's message, which lists at most 300 refs.
--   1    probably ours: the stored edit history shows no person touched it
--   0    attention: a person may have hand-edited it (every TSV row, too)
--   NULL written before this migration; the label is unknown. The watchdog
--        falls back to the record message for these. A 0 default would make
--        an old row look like an attention row.
ALTER TABLE export_reverts ADD COLUMN probably_ours INTEGER;
