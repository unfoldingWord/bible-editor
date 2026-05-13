-- Track when a row's latest update was a revert to a previous version. The
-- chip on a note shows v{restored_from_version} when set, instead of the
-- monotonically-increasing row.version — so a user who picks "switch to v1"
-- from history sees the chip read v1, not v(prev+1).
--
-- Cleared on the next non-revert PATCH. Mirrored onto edit_log so history
-- entries that came from a revert can be hidden from the UI list (the
-- snapshot is identical to the version they restored).

ALTER TABLE tn_rows ADD COLUMN restored_from_version INTEGER;
ALTER TABLE tq_rows ADD COLUMN restored_from_version INTEGER;
ALTER TABLE twl_rows ADD COLUMN restored_from_version INTEGER;
ALTER TABLE edit_log ADD COLUMN restored_from_version INTEGER;
