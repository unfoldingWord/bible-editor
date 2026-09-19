-- #686 item 3 (remainder): verse_statuses had no actor column at all, unlike
-- its sibling per-user stamp columns (twl_order_locks.locked_by,
-- verse_lane_checks.checked_by) — "who last toggled this verse done" was only
-- ever recoverable by joining edit_log, and PR #785 (the mechanical half of
-- item 3) explicitly deferred this half as needing a schema migration.
ALTER TABLE verse_statuses ADD COLUMN updated_by INTEGER;
