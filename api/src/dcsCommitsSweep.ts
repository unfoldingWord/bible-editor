// dcs_commits retention sweep (issue #692, follow-up 1 from #685's review).
//
// dcs_commits grows without bound: every commit on every tracked repo's
// master gets one row, and each can carry up to DCS_POLL_MAX_FILES paths of
// files_json (dcsCommitPoll.ts). Same shape of problem edit_log had before
// editLogSweep.ts, and the same "once per hour, gated on minute-of-hour" cron
// slot in index.ts's scheduled() handles it.
//
// NO PER-ROW ANCESTOR EXEMPTION, UNLIKE edit_log's SWEEP — but a coverage-
// floor RAISE is required, which is what DCS_COMMITS_SWEEP_COVERAGE_SQL is
// for. The edit_log sweep exempts specific rows because the three-way
// verse/TSV merge reads edit_log as its ancestor source by picking out
// individual rows; losing the wrong one makes a verse permanently
// unadjudicable. dcs_commits has no reader that picks individual rows out —
// masterLineageLedger.ts's readLedgerMasterLineage (#692 item 3, landed)
// instead reads the WHOLE window `committed_at >= confirmedAt` and trusts it
// completely whenever `confirmedAt >= dcs_repo_polls.coverage_since`. That
// trust is only honest as long as coverage_since never claims a floor older
// than what dcs_commits actually still holds. dcsCommitPoll.ts's own upsert
// deliberately never ADVANCES coverage_since ("moving it forward would make
// an older proven window unexpectedly fall back to live Gitea") — polling
// only ever extends coverage backward-in-history, so the floor it already
// proved stays proved. This sweep runs in the opposite direction: it removes
// rows the floor was vouching for. Left unraised, a book/resource whose
// export watermark (confirmedAt) stalls past the retention window would
// still pass the `confirmedAt >= coverage_since` check on a coverage_since
// stamped back when the repo was bootstrapped, while the rows between that
// old floor and today's cutoff are gone — readLedgerMasterLineage would
// report `usable: true` over a silently truncated commit list instead of
// falling back to the live walk, which is exactly the "reads as no human"
// failure mode this ledger exists to avoid. So every sweep tick also raises
// coverage_since up to its own cutoff for any repo whose floor sits below
// it — never inventing a floor where none was proven (NULL stays NULL), only
// tightening an existing one to match what was just deleted.
//
// COALESCE(committed_at, seen_at): committed_at is Door43's clock and can be
// NULL when a commit's date failed to parse (ledgerRowsFromCommits already
// tolerates that). A row with no committed_at still has our own seen_at
// (ingest time, NOT NULL), so it ages out on that instead of surviving
// forever for want of a comparable column.

export const DCS_COMMITS_RETENTION_SECONDS = 548 * 86400; // ~18 months

export const DCS_COMMITS_SWEEP_SQL = `
  DELETE FROM dcs_commits
   WHERE COALESCE(committed_at, seen_at) < ?1`;

// Companion to DCS_COMMITS_SWEEP_SQL, run with the SAME ?1 cutoff (ideally in
// the same batch, so the floor raise and the deletion it accounts for commit
// together): raises any repo's proven-coverage floor up to the cutoff when it
// currently claims an older one, and leaves a repo with no proven floor
// (coverage_since IS NULL) alone — this sweep never establishes coverage that
// was never proven, it only retracts a floor to match what it just deleted.
export const DCS_COMMITS_SWEEP_COVERAGE_SQL = `
  UPDATE dcs_repo_polls
     SET coverage_since = ?1
   WHERE coverage_since IS NOT NULL AND coverage_since < ?1`;
