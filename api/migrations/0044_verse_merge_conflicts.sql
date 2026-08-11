-- Per-verse record of a nightly Door43->D1 sync merge that needed human
-- review (bookReimport.ts's applyVerseRows, driven by verseMerge.ts's
-- computeVerseMerge). Three cases land here:
--   'adopt_conflict'         — both D1 and master moved since the last
--                              published ancestor; master won, but the
--                              overwritten D1 edit may need recovery.
--   'keep_alignment_refused' — adopting master's edit would have lost
--                              alignment on words neither side touched, so D1
--                              was kept instead and a human should look.
--   'adopt'                  — only master moved, so adopting it was
--                              unambiguous and needs NO human judgement. It
--                              is still recorded, because the write overwrote
--                              a verse a human owns (updated_by != null) and
--                              the invariant is that no such overwrite is
--                              silent: this row is its audit trail and its
--                              recovery pointer. The banner alert deliberately
--                              EXCLUDES this action so the human-facing signal
--                              stays actionable — a 1CH-scale event would
--                              otherwise bury the real conflicts under ~174
--                              routine adoptions. Read it via
--                              GET /api/verse-merge-conflicts/:book.
-- There is deliberately NO CHECK constraint on `action`: a future merge
-- outcome must not require a migration to become recordable.
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
-- INSERT ... ON CONFLICT DO UPDATE (NOT INSERT OR REPLACE, which deletes-
-- then-reinserts and would reset detected_at on every re-detection) — a
-- conflict row is written once when detected and persists, its detected_at
-- unchanged on re-detection, until a human next saves that verse (see
-- verses.ts's PATCH route, which DELETEs the row for the verse it just
-- saved). See verseMergeConflicts.ts's recordVerseMergeConflicts.
CREATE TABLE verse_merge_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book TEXT NOT NULL,
  resource TEXT NOT NULL,            -- 'ult' | 'ust'
  chapter INTEGER NOT NULL,
  verse INTEGER NOT NULL,
  action TEXT NOT NULL,              -- 'adopt' | 'adopt_conflict' | 'keep_alignment_refused'
  reason TEXT NOT NULL,              -- 'master_only' | 'both_changed' | 'alignment_shrink' | 'unparseable'
  overwritten_version INTEGER,       -- the D1 version replaced; the old text is at this version in verse history
  alignment TEXT,                    -- JSON {beforeAligned, afterAligned, lostWords} or NULL
  detected_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX verse_merge_conflicts_book ON verse_merge_conflicts (book);
CREATE UNIQUE INDEX verse_merge_conflicts_unique ON verse_merge_conflicts (book, resource, chapter, verse);
