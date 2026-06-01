-- Alignment-memory frequency table. For each (bible, source Strong's number),
-- how often each target English surface word was aligned to it across the
-- canonical published corpus (ULT/UST). This is wordMAP's "alignment memory"
-- reduced to per-token frequencies, precomputed offline by
-- scripts/train-aligner.mjs from the gold \zaln-s alignments in the published
-- USFM (parsed with usfm-js). /api/align/suggest reads it to rank alignment
-- suggestions; source words with no row here fall back to lexicon gloss match.
-- Re-runnable: the trainer emits `DELETE FROM align_freq;` first, so the table
-- is an authoritative cache rebuilt whenever a new canonical version publishes.

CREATE TABLE align_freq (
  bible TEXT NOT NULL,       -- 'ult' | 'ust'
  strong TEXT NOT NULL,      -- normalized Strong's, e.g. 'H7225'
  surface TEXT NOT NULL,     -- lowercased target surface word, e.g. 'beginning'
  count INTEGER NOT NULL,    -- times this (strong -> surface) alignment occurs
  -- Composite PK doubles as the lookup index: /api/align/suggest filters
  -- `WHERE bible = ? AND strong IN (...)`, which rides the leftmost columns.
  PRIMARY KEY (bible, strong, surface)
);
