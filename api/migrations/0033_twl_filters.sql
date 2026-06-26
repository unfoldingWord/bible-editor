-- TWL suggestion filtering decisions, exported from the upstream TWL tool.
-- The per-verse Suggestions matcher (twlSuggest.ts) proposes links from ULT
-- English alone, with no memory of what translators already rejected. These two
-- deny-list tables let the client (where English→original-language resolution
-- happens) suppress those re-suggestions.
--
-- Both store the upstream's vowel-stripped normalized form verbatim; the client
-- folds further to bare consonants (web/src/lib/hebrew.ts twlFilterKey) before
-- comparing, so separator/pointing drift never splits a match. Re-runnable
-- snapshot: scripts/import-twl-filters.mjs begins with DELETE FROM both tables.

-- Hebrew/Greek word + article pairs that must NEVER be linked, anywhere
-- (book/reference irrelevant). E.g. (בני⁠ך, rc://*/tw/dict/bible/kt/sonofgod).
CREATE TABLE twl_unlinked_words (
  norm_orig_words TEXT NOT NULL,   -- upstream origWords (already vowel-stripped)
  tw_link         TEXT NOT NULL,
  -- Apply-time stamp. The route's cache signature keys on MAX(last_synced) (NOT
  -- rowid): the importer does DELETE-then-reinsert, and SQLite reuses rowids
  -- after a table is emptied, so a same-sized re-import would otherwise keep an
  -- unchanged signature and warm Workers would serve stale filters. Mirrors
  -- tw_articles (migration 0032).
  last_synced     INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (norm_orig_words, tw_link)
);

-- Specific Reference+Quote links that were deleted and must not come back AT
-- THAT reference (fine at another). Article-agnostic — the upstream table
-- carries no twLink, so any link at this (book, reference, quote) is suppressed.
CREATE TABLE twl_deleted_rows (
  book            TEXT NOT NULL,   -- UPPERCASE, e.g. "1SA" (matches suggest route)
  reference       TEXT NOT NULL,   -- "chapter:verse", e.g. "10:11"
  norm_orig_words TEXT NOT NULL,   -- upstream normalizedOrigWords
  last_synced     INTEGER NOT NULL DEFAULT (unixepoch()),  -- see twl_unlinked_words
  PRIMARY KEY (book, reference, norm_orig_words)
);
CREATE INDEX twl_deleted_rows_book ON twl_deleted_rows(book);
