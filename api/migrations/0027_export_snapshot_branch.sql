-- Record which DCS branch each export snapshot landed on. Exports moved from a
-- single fixed `live-snapshot` branch to a per-(book,resource) branch named for
-- the book + its human contributors (see export.ts:buildExportBranch). Storing
-- the branch makes `GET /api/exports` show where each snapshot was pushed.
ALTER TABLE export_snapshots ADD COLUMN branch TEXT;
