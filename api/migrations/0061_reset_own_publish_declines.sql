-- own_publish_declines changes meaning with the accountOwnPublishDecline change
-- (2026-09-02). Until now it counted consecutive nights the byte comparison
-- returned `content_differs` for ANY reason — an editor's commit, the
-- bp-assistant bot's evening push, or our own -be- branch not having merged yet.
-- From now on it counts merges of our own push that were MEASURED to have landed
-- different bytes from the ones we pushed (fileBlobShaAtCommit against
-- pushed_blob_sha), which is the only reading the inert banner acts on.
--
-- The stored values are therefore in the old unit (prod's JER tq stood at 3+ for
-- three nights of bot pushes), and carrying them forward would let a single
-- measured rewrite raise a "3 syncs" banner. Zero them once; the new accounting
-- rebuilds the count from measured merges only.
UPDATE book_resource_syncs SET own_publish_declines = 0;

-- own_publish_rewrite_sha — the master commit sha of the LAST merge counted as a
-- rewrite for this pair. The counter is incremented only when the measured merge
-- differs from it, which makes the count idempotent per merge: a retried Workflow
-- step re-measuring the same merge, or a run of nights on which no new export
-- pushed (locked book, nothing changed) and the same rewritten merge is measured
-- again, adds nothing. Cleared when a preserved merge resets the count. Byte
-- recognition (markOwnPublishConverged) resets the count but leaves this column
-- alone on purpose — that statement is the watermark stamp and must not depend
-- on this migration — which is safe: a later rewrite is necessarily a different
-- merge, so a stale sha here can only ever fail to match. NULL = nothing counted.
ALTER TABLE book_resource_syncs ADD COLUMN own_publish_rewrite_sha TEXT;
