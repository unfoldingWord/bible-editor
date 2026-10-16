-- Issue #1200: every parent of a ledger commit, as Door43 returned it, so the
-- gap backfill (dcsCommitBackfill.ts) can follow history it has already
-- fetched without fetching it again. A JSON array of shas: '[]' for a root
-- commit, two or more entries for a merge. NULL means the parents were never
-- recorded (every row written before this migration), and the backfill treats
-- that as unknown: it fetches the commit again rather than guess. parent_sha
-- (first parent only) is unchanged.
ALTER TABLE dcs_commits ADD COLUMN parent_shas_json TEXT;
