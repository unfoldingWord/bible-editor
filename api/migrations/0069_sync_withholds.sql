-- Issue #829: durable record of WHY the nightly reimport withheld a
-- (book, resource) sync watermark, so the export_stale banner (exportWorkflow.ts
-- recordStaleSkipAlert) can name the measured cause instead of asserting one it
-- never checked ("the pre-export sync didn't catch up; re-run the sync" — wrong
-- and a dead-end loop when the real cause is a deliberate chapters_locked hold).
--
-- One row per (book, resource), overwritten on every reimport run: this
-- records "what did TONIGHT's run measure", not a history of past withholds —
-- unlike stale_base_holds (0056), which is keyed per offending revision because
-- each one is a distinct event a human adjudicates, a withhold reason is only
-- ever about the run that just finished. A resource that syncs cleanly deletes
-- its row (bookReimport.ts's clearSyncWithhold) rather than leaving a stale
-- reason behind.
CREATE TABLE sync_withholds (
  book TEXT NOT NULL,
  -- lowercase, matching book_resource_syncs.resource.
  resource TEXT NOT NULL,
  -- One of computeWithholdReason's WithholdReason values (reimportSyncGate.ts):
  -- chapters_locked | prune_locked | conflict_skipped | tombstone_blocked |
  -- counts_incomplete | structure_overlap | systemic_refusal |
  -- merge_record_failed | apply_incomplete.
  reason TEXT NOT NULL,
  -- The measured count backing the reason, where the reason has one (a row
  -- count, a chapter count); 0 for the boolean-flag reasons.
  count INTEGER NOT NULL DEFAULT 0,
  -- Epoch millis — this run's alertObservedAt (bookReimport.ts), the same
  -- per-run token the sibling alert writers in this step use.
  occurred_at INTEGER NOT NULL,
  -- exportWorkflow.ts's `instanceId` — deterministic per Workflow instance
  -- (derived from event.timestamp, so replay-stable) and shared by BOTH the
  -- reimport-sync step that writes this row and the export step that reads
  -- it, since both run inside the same runCore() call. Read-side generation
  -- guard (issue #829 codex follow-up): a resource this run's reimport never
  -- reaches the sync-step record for — a book-level reimport failure, or a
  -- stale-base hold decided at STAGING time before the sync loop even sees
  -- the resource — must not have export_stale attribute a PREVIOUS run's
  -- leftover row to tonight's skip. readSyncWithhold only trusts a row whose
  -- run_id matches the run asking; a mismatched or absent row reads as "no
  -- reason recorded", never a stale one.
  run_id TEXT NOT NULL,
  PRIMARY KEY (book, resource)
);
