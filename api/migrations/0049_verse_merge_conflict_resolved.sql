-- Mark-not-delete for verse_merge_conflicts (migration 0044). Until now a
-- human re-saving the flagged verse made verses.ts's PATCH route DELETE the
-- row outright, which erased the audit trail exactly as people fixed their
-- own overwritten work — measured 2026-08-14: at least 14 rows already gone
-- from prod. resolved_at/resolved_by let the row survive the save; "active"
-- readers (raiseVerseMergeConflictAlert's banner query, GET
-- /api/verse-merge-conflicts/:book) filter WHERE resolved_at IS NULL instead
-- of relying on the row's mere existence. deleteLostAdoptionConflicts (a
-- speculative row whose write never actually landed) is unaffected — that
-- path stays a real DELETE, because nothing was overwritten there at all.
--
-- Numbering note (2026-08-14): three sibling branches claimed adjacent
-- migration numbers off the same main tip (0046) — PR #444
-- (0047_tq_twl_review_flag.sql), the master-confirmed-watermark fix sibling
-- (0048), and this one, renumbered to 0049 to land after both. Before
-- merging, confirm the actual order applied with
-- `wrangler d1 migrations list --remote` in case that ordering shifts.
--
-- last_recorded_at (2026-08-15, Codex second-opinion review fix): a SEPARATE
-- column from detected_at, refreshed unconditionally on every
-- recordVerseMergeConflicts upsert (see verseMergeConflictSql.ts's
-- UPSERT_VERSE_MERGE_CONFLICT_SQL). Its only job is letting
-- deleteLostAdoptionConflicts recognize "this row was touched by THIS run's
-- speculative write" — detected_at deliberately keeps its original meaning
-- ("first detected, preserved across every re-detection while still
-- unresolved") untouched, since conflating the two would silently reset the
-- age of a long-unresolved conflict every time the upsert re-ran.
ALTER TABLE verse_merge_conflicts ADD COLUMN resolved_at INTEGER;
ALTER TABLE verse_merge_conflicts ADD COLUMN resolved_by INTEGER REFERENCES users(id);
ALTER TABLE verse_merge_conflicts ADD COLUMN last_recorded_at INTEGER;

CREATE INDEX verse_merge_conflicts_active
  ON verse_merge_conflicts (book, resource)
  WHERE resolved_at IS NULL;
