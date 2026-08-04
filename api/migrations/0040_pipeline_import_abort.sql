-- #402: cooperative cancellation for the AI-pipeline apply path.
--
-- A terminal transition (a human force-stop, a cron-issued cancel, or the
-- no-progress 'interrupted' sentinel in pollAllNonTerminal) can land WHILE
-- importJobOutput is mid-apply. Before this, the apply had no cancellation
-- point and ran to completion regardless. It now checks pipeline_jobs.state/
-- error_kind at batch boundaries (see maybeCheckCancelled in
-- pipelineImport.ts) and stops issuing new writes once the job has gone
-- terminal.
--
-- Policy is keep-and-record, not roll back: everything already applied when
-- an abort is detected STAYS — nothing is deleted or undone. These two
-- columns record that an abort happened and what had been applied so far, so
-- the resulting partial state is inspectable rather than silent.
ALTER TABLE pipeline_jobs ADD COLUMN import_aborted_at INTEGER;
ALTER TABLE pipeline_jobs ADD COLUMN import_abort_summary TEXT;
