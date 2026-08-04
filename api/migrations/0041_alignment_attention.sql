-- Per-(book,resource) replace-all snapshot of the last nightly export's
-- alignment-shrink findings (exportWorkflow.ts's checkUsfmAlignmentShrink /
-- recordAlignmentShrinkSkipAlert). Every export run for a book+resource
-- deletes and re-inserts this table's rows for that pair — it is evidence
-- as-of-last-export, not live truth, and it goes stale the moment a
-- translator re-aligns a verse in the app without waiting for the next
-- export to confirm it. The app reads this to render a sticky per-book
-- "needs alignment attention" indicator that survives page reloads (unlike
-- the dismissible system_alerts banner it's derived from).
CREATE TABLE alignment_attention (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book TEXT NOT NULL,
  resource TEXT NOT NULL,          -- 'ult' | 'ust'
  ref TEXT NOT NULL,               -- 'chapter:verse' or 'chapter:start-end' (bridges), exactly as offenders carry it
  lost_words TEXT NOT NULL,        -- JSON array of strings
  provenance TEXT,                 -- the provenance bucket string the alert already computes
  detected_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX alignment_attention_book ON alignment_attention (book);
CREATE UNIQUE INDEX alignment_attention_unique ON alignment_attention (book, resource, ref);
