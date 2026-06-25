-- Canonical Translation Words (TW) article catalog, imported from the
-- unfoldingWord en_tw repo (bible/{kt,names,other}/*.md). One row per article.
--
-- Two jobs:
--   1. Replace the usage-derived twLinks catalog (catalogs.ts bootstraps from
--      whatever tw_link values already exist in twl_rows, so typos / stale links
--      propagate) with the real article list.
--   2. Seed the per-verse TWL suggestion matcher (Phase 2): the matcher builds a
--      headword trie from `title` (the first markdown heading, which may list
--      synonyms) and proposes links for ULT words a verse doesn't already carry.
--
-- Re-runnable cache: scripts/import-tw.mjs begins with DELETE FROM, so the table
-- is always the authoritative snapshot of en_tw master.

CREATE TABLE tw_articles (
  id TEXT PRIMARY KEY,                 -- "<category>/<slug>", e.g. "kt/god"
  category TEXT NOT NULL,              -- 'kt' | 'names' | 'other'
  title TEXT NOT NULL,                 -- first markdown heading (headword line; may list comma-separated synonyms)
  testament TEXT,                      -- 'ot' | 'nt' | 'both' | NULL — en_tw carries no per-article testament; reserved for future filtering
  tw_link TEXT NOT NULL,               -- rc://*/tw/dict/bible/<category>/<slug>
  last_synced INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX tw_articles_category ON tw_articles(category);
