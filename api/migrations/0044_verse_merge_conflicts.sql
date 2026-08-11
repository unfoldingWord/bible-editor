-- Per-verse record of a nightly Door43->D1 sync merge that needed human
-- review (bookReimport.ts's applyVerseRows, driven by verseMerge.ts's
-- computeVerseMerge). Two cases land here:
--   'adopt_conflict'         — both D1 and master moved since the last
--                              published ancestor; master won, but the
--                              overwritten D1 edit may need recovery.
--   'keep_alignment_refused' — adopting master's edit would have lost
--                              alignment on words neither side touched, so D1
--                              was kept instead and a human should look.
-- overwritten_version is the D1 `verses.version` that was replaced. For
-- 'keep_alignment_refused' it is NULL (the code sets it to NULL on a
-- refusal — nothing was overwritten, so there is no version to point at;
-- verseMergeConflicts.ts and the alert wording both depend on
-- null-means-refusal, so this comment must not claim otherwise) — the old
-- text is recoverable from that verse's version history
-- (GET /api/verses/.../history) at that version.
--
-- Write discipline is deliberately NOT the alignment_attention/export_reverts
-- replace-all-per-(book,resource) pattern (migrations 0041/0042): a nightly
-- export replacing this table's rows for a book+resource would erase a
-- conflict before a human ever saw it. Instead this is per-verse
-- INSERT OR REPLACE — a conflict row is written once when detected and
-- persists until a human next saves that verse (see verses.ts's PATCH route,
-- which DELETEs the row for the verse it just saved).
CREATE TABLE verse_merge_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book TEXT NOT NULL,
  resource TEXT NOT NULL,            -- 'ult' | 'ust'
  chapter INTEGER NOT NULL,
  verse INTEGER NOT NULL,
  action TEXT NOT NULL,              -- 'adopt_conflict' | 'keep_alignment_refused'
  reason TEXT NOT NULL,              -- 'both_changed' | 'alignment_shrink' | 'unparseable'
  overwritten_version INTEGER,       -- the D1 version replaced; the old text is at this version in verse history
  alignment TEXT,                    -- JSON {beforeAligned, afterAligned, lostWords} or NULL
  detected_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX verse_merge_conflicts_book ON verse_merge_conflicts (book);
CREATE UNIQUE INDEX verse_merge_conflicts_unique ON verse_merge_conflicts (book, resource, chapter, verse);
