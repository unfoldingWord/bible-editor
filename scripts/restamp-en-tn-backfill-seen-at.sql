-- One-time correction for issue #691 (PR #1088). Run AFTER the deploy that
-- ships #1088, then once more the next day (see "When" below).
--
-- WHY. #1088 makes readLedgerMasterLineage admit a dcs_commits row when
-- `seen_at > window start`, so a commit pushed late (its Door43 dates older
-- than the window) still counts. Before #1088, the en_tn gap backfill stamped
-- every row it wrote with seen_at = the time the backfill ran, not the time
-- the commit reached master. Under the new read, such a row looks like a
-- human commit that arrived inside any TN window opened between the coverage
-- floor and the backfill: merge_no_base clears get blocked and lineage
-- confirmation withheld for TN books. No data is lost, but the gates misfire.
-- #1088's backfill stamps gap_at instead; rows the OLD code wrote keep their
-- stamp, because INSERT ... ON CONFLICT DO NOTHING never restamps.
--
-- WHAT. Restamp those rows to en_tn's gap-opening time, 1789091175
-- (2026-09-11T01:46:15Z, dcs_repo_polls.gap_at for en_tn, read 2026-10-15),
-- which is what the fixed backfill writes. It is hardcoded because the gap
-- clears gap_at when it closes, and any value at or below coverage_since
-- keeps the row out of every trusted window (the read is strictly `>`).
-- Only en_tn: it is the only repo whose backfill was still running.
--
-- WHAT IT CAN GET WRONG. A real late push (committed before the floor,
-- pushed after it) is indistinguishable here from a backfilled row and would
-- be restamped too, so that one commit is missed as a late push, which is
-- how every read behaved before #1088. Benjamin accepted this on #691.
--
-- WHEN. The count on 2026-10-15 was 0: the old retention sweep had already
-- deleted the 455 rows found on 2026-10-02 (all committed before its
-- 548-day cutoff). The en_tn backfill is still open, though, so the old code
-- can write more such rows up to the deploy, and #1088's sweep keeps a row
-- until it is old on BOTH clocks, so they would no longer be swept. Run it
-- right after the deploy, and again a day later in case a backfill tick that
-- started under the old code wrote rows after the first run.
--
-- HOW (from api/). Idempotent: a second run changes 0 rows.
--   1. Count (read-only), from the repo root:
--        node scripts/d1-select.mjs "SELECT COUNT(*) AS n FROM dcs_commits WHERE repo = 'en_tn' AND committed_at < (SELECT coverage_since FROM dcs_repo_polls WHERE repo = 'en_tn') AND seen_at > (SELECT coverage_since FROM dcs_repo_polls WHERE repo = 'en_tn')"
--      0 means there is nothing to do; stop here.
--   2. Record the Time Travel bookmark on #691:
--        npx wrangler d1 time-travel info bible_editor --env production
--   3. Apply:
--        npx wrangler d1 execute bible_editor --remote --env production --file=../scripts/restamp-en-tn-backfill-seen-at.sql
--   4. Re-run step 1. It must print 0.
UPDATE dcs_commits
   SET seen_at = 1789091175
 WHERE repo = 'en_tn'
   AND committed_at < (SELECT coverage_since FROM dcs_repo_polls WHERE repo = 'en_tn')
   AND seen_at > (SELECT coverage_since FROM dcs_repo_polls WHERE repo = 'en_tn');
