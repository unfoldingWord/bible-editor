-- Issue #685: a durable ledger of every commit that lands on the tracked
-- Door43 repos' master branches, with author identity and classification.
--
-- WHY A TABLE AND NOT THE EXISTING WALK. Attribution today is a side effect of
-- the nightly sync: bookReimport walks the Gitea commits API for one
-- (book, resource) file, compacts the answer to counts, and stores it
-- last-run-wins in book_resource_syncs.master_lineage_json. The commit itself —
-- its sha, its author, when it landed — is thrown away, so "who changed this on
-- Door43, and when" is unanswerable after the fact, and nothing notices a
-- Door43 change until the next nightly tick. This table keeps the commits.
--
-- REPO-SCOPED, NOT PATH-SCOPED. The nightly walk asks for one file's history
-- (`?path=tn_ZEC.tsv`). This poller asks for the repo's master history, so a
-- commit touching a book we have not imported is still recorded. That means
-- repo-level history is a NEW input shape for classifyMasterCommit: it includes
-- Gitea merge commits (`Merge pull request 'AI TN for NUM 31
-- [je..s@api.bp-assistant]' (#7585) …`, measured on en_tn 2026-09-01) that
-- path-scoped history mostly hides. The classification is recorded exactly as
-- classifyMasterCommit returns it — this migration adds no second opinion.
--
-- NOT AUTHORITATIVE (yet). Nothing reads this table for a gating decision in
-- the change that introduces it; masterLineage still does its own live walk.
-- The shape below is deliberately ready for that follow-up (per-commit files,
-- so a future reader can join a commit to the books it touched), but coverage
-- must be proven complete over a window before any gate trusts it — see
-- `dcs_repo_polls.gap_since_sha`, which records exactly where coverage is NOT
-- contiguous.
CREATE TABLE dcs_commits (
  -- Repo name without the owner, matching dcsResourceFile().repo — 'en_ult',
  -- 'en_ust', 'en_tn', 'en_tq', 'en_twl'. The owner is unfoldingWord for all of
  -- them (DCS_OWNER in dcsSources.ts); storing it per row would be five
  -- thousand copies of one constant.
  repo TEXT NOT NULL,
  -- Full 40-hex commit sha on master.
  sha TEXT NOT NULL,
  -- parents[0].sha from the Gitea list response. NULL for a root commit or when
  -- the response omitted parents. Second parents of a merge are NOT stored:
  -- first-parent is what "walking master back" means.
  parent_sha TEXT,
  -- commit.author.{name,email} from Gitea. Identity is keyed on THESE, never on
  -- the `author.login` object: login is null on many commits including human
  -- ones (measured — en_tn page 1 on 2026-09-01 had null login on the 'BW Bot'
  -- commits; see docs/sync-attribution-handoff.md).
  author_name TEXT,
  author_email TEXT,
  -- commit.author.date as unix seconds.
  committed_at INTEGER,
  -- SUBJECT ONLY (first line). The body is not stored: the only body signal the
  -- classifier uses (bp-assistant's `X-AI-Pipeline:` trailer) is already folded
  -- into `classification`, and full bodies of 36k commits are not worth the D1
  -- rows. `classification_reason` records which rule fired instead.
  message TEXT,
  classification TEXT NOT NULL CHECK (classification IN ('ours', 'ai', 'human')),
  -- Which rule inside classifyMasterCommit decided, so a later reader can cite
  -- evidence instead of asserting (the standing alert-wording rule).
  classification_reason TEXT,
  -- JSON array of in-repo paths the commit touched, from the list endpoint's
  -- own `files=true` (MEASURED cheap: 102,595 vs 100,445 bytes for 50 commits
  -- of en_tn — ~2% — and ZERO extra subrequests). NULL when the response
  -- carried no file list at all. Capped in the writer, so a mass-rename commit
  -- cannot write a megabyte here.
  files_json TEXT,
  -- When WE first recorded the row, distinct from committed_at (which is
  -- Door43's clock and can be older than our whole table).
  seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (repo, sha)
);

-- The read pattern: "what happened on this repo lately", newest first.
CREATE INDEX dcs_commits_recent ON dcs_commits (repo, committed_at DESC);

-- The OTHER read pattern: "what happened anywhere lately", newest first, with
-- no repo filter. The index above cannot serve it (repo is the leading column),
-- so a repo-less GET /api/dcs-commits would scan the table and sort it. The
-- route branches its SQL so each shape hits one of these two indexes.
CREATE INDEX dcs_commits_by_time ON dcs_commits (committed_at DESC);

-- Per-repo poll state. Same idea as book_resource_syncs (0028) — a watermark
-- plus what wrote it — kept in its own small table because the grain is the
-- repo, not (book, resource).
CREATE TABLE dcs_repo_polls (
  repo TEXT PRIMARY KEY,
  -- High-water mark: the newest sha we have ingested. The next walk stops when
  -- it sees this sha (exclusive), so a steady-state tick reads one page.
  -- NULL means "never polled" → the bootstrap window applies.
  last_sha TEXT,
  -- committed_at of last_sha, for a cheap "how fresh is this repo" read.
  last_committed_at INTEGER,
  -- Every tick that decided to poll this repo stamps this, success or not. It
  -- is the rate-limit key, so a failing repo retries on the next interval
  -- instead of on every 5-minute cron tick.
  last_attempted_at INTEGER,
  -- Only a walk that completed (or that we deliberately accepted a gap on)
  -- stamps this.
  last_success_at INTEGER,
  -- listMasterCommitsSince's own outcome: 'ok', or its incompleteReason
  -- ('page_cap', 'http_502', 'fetch_failed', 'source_sha_not_in_history', …).
  last_status TEXT,
  -- COVERAGE HOLE. Set when a walk could not reach last_sha before its page cap
  -- (or when last_sha turned out not to be in master's history at all — a
  -- force-push). We still advance last_sha to the new tip, because refusing to
  -- advance would re-walk the same capped range forever and never record
  -- anything new; the sha we could NOT reach is recorded here so the hole is
  -- visible rather than silently absorbed.
  --
  -- OLDEST unresolved gap WINS, and nothing in the poller ever clears it. A
  -- newer gap must not overwrite an older one (the first version of the upsert
  -- COALESCEd the other way, which made a repo that capped twice look more
  -- contiguous than it was), because the field's meaning is "history below this
  -- sha is not proven contiguous" — the conservative claim. Only a backfill
  -- that actually walks and closes the hole may clear these two columns, and
  -- that backfill is the follow-up this table is shaped for. Until then, a
  -- non-null gap_since_sha is exactly the signal that stops anything from
  -- treating this ledger as complete coverage of a window.
  gap_since_sha TEXT,
  gap_at INTEGER
);
