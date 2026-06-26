-- Per-verse, per-lane checkoff with attribution.
--
-- Supersedes the single binary `verse_statuses.done` flag for the editor
-- checkoff UI: instead of one checkbox per verse, each verse is checked
-- independently per lane (the two texts together = 'text', plus 'tn'/'tw'/'tq').
--
-- One row PER (verse, lane, user) — not a single checked_by — so the UI can
-- shade by who checked: a row for me only = "you", a row for someone else only
-- = "someone else", rows for both = "you + others". Anyone with edit access may
-- check any lane; the row of who-did-it is the accountability (open model).
--
-- "Edits reopen": a lane's check rows for a verse are cleared when that lane's
-- underlying content advances (text save / tn|tq|twl row write), done in the
-- write paths — not a trigger, so it can be audited and stays explicit.
CREATE TABLE IF NOT EXISTS verse_lane_checks (
  book       TEXT NOT NULL,
  chapter    INTEGER NOT NULL,
  verse      INTEGER NOT NULL,
  lane       TEXT NOT NULL,            -- 'text' | 'tn' | 'tw' | 'tq'
  checked_by INTEGER NOT NULL,         -- users.id
  checked_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (book, chapter, verse, lane, checked_by)
);

CREATE INDEX IF NOT EXISTS idx_vlc_chapter ON verse_lane_checks (book, chapter);
