-- Issue #686: what the last change to this row was, where it happened, and who did it.
--
-- THE QUESTION THE SCHEMA COULD NOT ANSWER. "Who last changed this row" lived
-- only in `edit_log`, reachable by a latest-entry subquery (`rows.ts`
-- selectRowWithLatestSource, which skips twl entirely), and `updated_by` — the
-- one actor-shaped column on the row — cannot be read as the actor:
--   * For an AI write it names the human who CLICKED RUN, not the writer
--     (`pipelineImport.ts` attributes every AI row to the pipeline's starter).
--   * For a Door43-owned row it must stay NULL, because NULL *is* the reimport's
--     pristine predicate (`isPristineTsv`). "Master owns this row" is therefore
--     encoded as the ABSENCE of an actor — indistinguishable from "never
--     touched."
--   * Several paths move `updated_at` with no edit_log row at all (in-app
--     reorder, review-flag clear, reimport ref_moved clear, reimport reorder,
--     applyTwlSortOrderUpdates, the whole-book import wipe), so even the row's
--     own timestamp had nothing behind it.
-- These three columns are additive and answer it on the row itself. NOTHING
-- reads `updated_by` differently because of them — the pristine predicate is
-- untouched, deliberately, and must stay that way.
--
-- last_change_action — WHAT: 'create' | 'update' | 'delete' | 'restore' |
--   'reorder' | 'preserve' | 'hint' | 'trash' | 'untrash' | 'review_clear' |
--   'dismiss_review' | 'hint_expansion' | 'ai_apply' | 'import' |
--   'finalize_trash' | 'sync_merge' | 'sync_reseed' | 'sync_prune' |
--   'sync_reorder'.
-- last_change_source — WHERE: 'user' | 'ai_pipeline' | 'dcs_sync' | 'import' |
--   'system'.
-- last_change_actor — WHO, human-readable and DENORMALIZED ON PURPOSE: the DCS
--   username as a STRING, not a users.id, so the answer survives a user being
--   renamed, merged, or removed. "AI pipeline (run by <username>)" for an AI
--   apply — the only encoding that keeps both facts (a machine wrote it; a named
--   human asked for it) without overloading one column the way updated_by was.
--   For a Door43 sync it carries the MEASURED commit author when the run's
--   lineage measured one ("Door43: <name>"), "Door43 (AI/bot push)" only when a
--   COMPLETE walk found no human commit, and the bare "Door43 sync" otherwise.
--   Never a name the lineage did not measure — the standing repo rule that a
--   label states only measured causes.
--
-- NULL MEANS "no change since this migration shipped" — consult edit_log. It
-- does NOT mean unknown-forever and it does not mean unedited. There is
-- DELIBERATELY NO BACKFILL: the four tables hold hundreds of thousands of prod
-- rows, D1's per-migration limits are uncharted here, and a wrong-but-confident
-- backfill (edit_log's latest entry is not the same fact — it does not cover the
-- unaudited paths listed above, which are precisely the ones this exists for)
-- would be worse than an honest NULL. The columns fill as writes happen and
-- edit_log remains the historical record.
--
-- TEXT and unconstrained, not CHECK-constrained enums: a CHECK on a live D1
-- table makes every future vocabulary addition a table rebuild, and the write
-- sites are all in one repo with one typed union (`api/src/rowProvenance.ts`)
-- guarding them, which is where the enforcement belongs. INTERNAL to D1 — the
-- TSV/USFM export serializers emit explicit fixed column lists, so none of this
-- ever reaches Door43.
--
-- No index. Nothing queries BY these columns; they are read back with the row
-- they belong to (`SELECT *` on every client-facing path), and three unused
-- indexes on four large tables would cost every write for nobody.
ALTER TABLE tn_rows ADD COLUMN last_change_action TEXT;
ALTER TABLE tn_rows ADD COLUMN last_change_source TEXT;
ALTER TABLE tn_rows ADD COLUMN last_change_actor TEXT;

ALTER TABLE tq_rows ADD COLUMN last_change_action TEXT;
ALTER TABLE tq_rows ADD COLUMN last_change_source TEXT;
ALTER TABLE tq_rows ADD COLUMN last_change_actor TEXT;

ALTER TABLE twl_rows ADD COLUMN last_change_action TEXT;
ALTER TABLE twl_rows ADD COLUMN last_change_source TEXT;
ALTER TABLE twl_rows ADD COLUMN last_change_actor TEXT;

ALTER TABLE verses ADD COLUMN last_change_action TEXT;
ALTER TABLE verses ADD COLUMN last_change_source TEXT;
ALTER TABLE verses ADD COLUMN last_change_actor TEXT;
