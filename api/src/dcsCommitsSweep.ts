// dcs_commits retention sweep (issue #692, follow-up 1 from #685's review).
//
// dcs_commits grows without bound: every commit on every tracked repo's
// master gets one row, and each can carry up to DCS_POLL_MAX_FILES paths of
// files_json (dcsCommitPoll.ts). Same shape of problem edit_log had before
// editLogSweep.ts, and the same "once per hour, gated on minute-of-hour" cron
// slot in index.ts's scheduled() handles it.
//
// WHY THIS ONE NEEDS NO ANCESTOR EXEMPTION, UNLIKE edit_log's SWEEP. The
// edit_log sweep exempts specific rows because the three-way verse/TSV merge
// actively reads edit_log as its ancestor source — deleting the wrong row
// there makes a verse permanently unadjudicable. dcs_commits has no reader
// like that (yet): dcsCommitPoll.ts's own polling walk never reads this
// table — pollBounds() bounds the NEXT Door43 walk by
// dcs_repo_polls.last_sha, a plain string compared against Door43's live
// API response, not by looking up a row here. GET /api/dcs-commits
// (dcsCommits.ts) is a read-only audit view. And per #685's migration
// comment, "nothing reads this table to make a gating decision yet" — that
// follow-up is #692 item 3, deliberately NOT done by this sweep (see its
// own issue text: wiring lineage reads to the ledger should wait until the
// ledger has PROVEN coverage, which is an ongoing property, not something a
// one-time backfill establishes). So today every row is equally disposable
// once it ages out; when #692 item 3 lands, whatever it adds must get its
// own exemption here, the same way #537 added one to editLogSweep — but
// that is that change's job, not this one's.
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
