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
-- NOTE for anyone merging a sibling PR: this repo runs many parallel
-- worktrees, so another branch may also claim migration number 0047 — check
-- `wrangler d1 migrations list --remote` and renumber on conflict.
ALTER TABLE verse_merge_conflicts ADD COLUMN resolved_at INTEGER;
ALTER TABLE verse_merge_conflicts ADD COLUMN resolved_by INTEGER REFERENCES users(id);

CREATE INDEX verse_merge_conflicts_active
  ON verse_merge_conflicts (book, resource)
  WHERE resolved_at IS NULL;
