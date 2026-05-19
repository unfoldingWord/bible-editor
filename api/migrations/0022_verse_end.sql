-- Preserve multi-verse USFM blocks (\v 6-9) end-to-end.
-- Singleton verse: verse_end IS NULL. Multi-verse: verse stores the start
-- (canonical PK component) and verse_end stores the inclusive end.
ALTER TABLE verses ADD COLUMN verse_end INTEGER;

-- Supports "find the range row covering verse N" lookups added in PR 2.
CREATE INDEX verses_range_lookup
  ON verses (book, chapter, bible_version, verse, verse_end);
