-- Issue #995: the pointer to the render we published BEFORE the current one.
--
-- The export-revert report (#869/#870) diffs tonight's render against "the
-- render we last published", read from pushed_blob_sha / pushed_r2_key just
-- before recordPushedRender overwrites them. A Workflow step retry re-runs
-- the whole export step, and if the first attempt already reached
-- recordPushedRender, the retry read back that attempt's OWN render as the
-- base. Every verse our translators changed then looked like master had moved
-- there (JER UST, 2026-09-26: 15 false "overwrote master" verses).
--
-- recordPushedRender copies the outgoing pair here whenever the incoming render
-- comes from a different export instance, so a same-instance retry can still
-- find the real previous publish. NULL until the first export after this
-- migration; a NULL here only means the report fails open, as before.
ALTER TABLE book_resource_syncs ADD COLUMN prev_pushed_blob_sha TEXT;
ALTER TABLE book_resource_syncs ADD COLUMN prev_pushed_r2_key TEXT;
