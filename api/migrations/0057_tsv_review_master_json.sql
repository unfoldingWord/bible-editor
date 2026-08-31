-- Issue #653: what Door43 actually held, recorded WITH the review flag.
--
-- Every tn/tq/twl review flag the nightly sync mints (merge_no_base,
-- merge_conflict, merge_kept, ref_moved) tells a translator that master and D1
-- disagree — and then gives her no way to see master's side. The row in front
-- of her is D1's; Door43's is a file on another server that the next export is
-- about to overwrite. So the flag now carries a snapshot of master's own values
-- for that row, as parsed at the moment the flag was raised.
--
-- JSON, not columns: the mergeable field set differs per kind (tsvMerge.ts's
-- FIELDS_BY_KIND) and this is display evidence, never merge input — nothing
-- reads it back into a decision, so it needs no schema of its own.
--
-- INTERNAL to D1, like review_kind/review_reason (0031, 0047): the TSV export
-- serializers emit an explicit fixed column list, so this never reaches DCS.
-- Cleared everywhere review_kind is cleared — a snapshot behind a NULL
-- review_kind describes nothing. NULL = no snapshot (also every flag minted
-- before this migration).
ALTER TABLE tn_rows ADD COLUMN review_master_json TEXT;
ALTER TABLE tq_rows ADD COLUMN review_master_json TEXT;
ALTER TABLE twl_rows ADD COLUMN review_master_json TEXT;
