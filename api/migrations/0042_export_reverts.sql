-- Per-(book,resource) replace-all snapshot of the last nightly export's
-- "we overwrote something on master" findings (export.ts's usfmRevertReport /
-- tsvRevertReport, wired in exportWorkflow.ts). Every export run for a
-- book+resource that actually committed a render over master's current
-- content deletes and re-inserts this table's rows for that pair — it is
-- evidence as-of-last-export, not live truth, same replace-all discipline as
-- alignment_attention (migration 0041).
--
-- What this exists to fix: the nightly export renders D1 over whatever is
-- currently on master, and until now we only learned a maintainer's hand-edit
-- (a DCS-side USFM cleanup, a manual TSV tweak) got silently overwritten when
-- they noticed and complained (see PR #417, "stop reverting Rich's USFM
-- cleanups every night"). This table is purely observational — it records
-- what differed from master at export time, it never blocks or changes what
-- ships.
CREATE TABLE export_reverts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book TEXT NOT NULL,
  resource TEXT NOT NULL,          -- 'tn' | 'tq' | 'twl' | 'ult' | 'ust'
  ref TEXT NOT NULL,               -- verse ref ('chapter:verse'/bridge) or TSV row's Reference column
  class TEXT NOT NULL,             -- 'formatting' | 'substantive' (usfm) | 'tags_only' | 'whitespace_only' | 'substantive' (tsv)
  fields TEXT,                     -- JSON array of differing TSV column names (substantive tsv only), nullable
  detected_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX export_reverts_book ON export_reverts (book);
CREATE UNIQUE INDEX export_reverts_unique ON export_reverts (book, resource, ref);
