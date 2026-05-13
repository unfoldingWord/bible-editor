-- Provenance marker on edit_log entries. NULL for ordinary human edits,
-- 'ai_pipeline' for rows written by the auto-apply step on a pipeline_jobs
-- done transition. Downstream UI (the "✨ AI" chip) can key off this.
ALTER TABLE edit_log ADD COLUMN source TEXT;
