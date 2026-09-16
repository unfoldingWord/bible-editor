-- Stage 6 (#691): the dcs_commits poller's first successful post-migration
-- walk establishes the oldest time window the ledger can honestly claim. A
-- NULL floor deliberately leaves existing rows untrusted: the old poller did
-- not record how far its bootstrap walk actually proved coverage.
ALTER TABLE dcs_repo_polls ADD COLUMN coverage_since INTEGER;

