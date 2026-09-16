-- Issue #790: retain the R2 artifact that contains the exact render described
-- by pushed_blob_sha / pushed_read_at / pushed_edit_id.  A later reimport can
-- use it as the per-verse merge ancestor only after the pushed boundary has
-- also become the confirmed master boundary.
ALTER TABLE book_resource_syncs ADD COLUMN pushed_r2_key TEXT;
