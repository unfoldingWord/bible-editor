-- Per-(book, resource) DCS sync watermark for the incremental self-heal
-- reimport. The nightly reimport compares the current master commit SHA of each
-- resource file (en_ult/en_ust/en_tn/en_tq/en_twl) against source_sha here and
-- skips the whole resource when they match — so an unchanged book costs one
-- cheap SHA lookup per resource instead of a full fetch + per-chapter reimport.
--
-- book_imports.source_sha (0001) is a single per-BOOK column that was never
-- wired up; one watermark per book can't represent 6 independently-versioned
-- resource files, so this table supersedes it. A missing row means "no
-- watermark → never skip" (the safe default: reimport runs).
--
-- origin records what last wrote the watermark: 'import' (first-time bootstrap),
-- 'reimport' (a self-heal that pulled fresh content), or 'export' (telemetry
-- only — export watermarks do NOT gate skipping; see bookReimport.ts).
CREATE TABLE book_resource_syncs (
  book        TEXT NOT NULL,
  resource    TEXT NOT NULL,            -- 'ult' | 'ust' | 'tn' | 'tq' | 'twl'
  source_sha  TEXT,                     -- DCS master commit SHA last synced
  synced_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  origin      TEXT NOT NULL,            -- 'import' | 'reimport' | 'export'
  PRIMARY KEY (book, resource)
);
