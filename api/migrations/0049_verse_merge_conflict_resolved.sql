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
ALTER TABLE verse_merge_conflicts ADD COLUMN resolved_at INTEGER;
ALTER TABLE verse_merge_conflicts ADD COLUMN resolved_by INTEGER REFERENCES users(id);

CREATE INDEX verse_merge_conflicts_active
  ON verse_merge_conflicts (book, resource)
  WHERE resolved_at IS NULL;
