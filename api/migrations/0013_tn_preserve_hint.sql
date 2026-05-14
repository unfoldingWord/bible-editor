-- Two intent bits on tn_rows: explicit "preserve me through the next AI
-- pipeline sweep" and "this row is a hint stub — send to the pipeline as a
-- directive and expand in place". Both are read by deleteUnkeptTns; the
-- hint bit additionally gates server-side gather of options.hints in
-- /api/pipelines/start. Defaults of 0 are correct for every existing row.

ALTER TABLE tn_rows ADD COLUMN preserve INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tn_rows ADD COLUMN hint INTEGER NOT NULL DEFAULT 0;
