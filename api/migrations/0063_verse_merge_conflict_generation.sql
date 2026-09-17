-- Optimistic generation for system retirement of converged kept-D1 conflicts.
-- Every re-detection increments this value. A cleanup that read an older
-- generation therefore cannot resolve a conflict freshly recorded by a
-- concurrent reimport between its backlog read and UPDATE (#789).
ALTER TABLE verse_merge_conflicts ADD COLUMN recorded_generation INTEGER NOT NULL DEFAULT 0;
