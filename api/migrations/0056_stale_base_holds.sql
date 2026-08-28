-- Issue #639: durable record of a nightly sync that REFUSED a wholesale,
-- stale-base replacement of a book's verse file on Door43 master.
--
-- Sibling to verse_merge_conflicts rather than an extension of it, deliberately.
-- That table is keyed (book, resource, chapter, verse) because every row it
-- holds is one verse a human may need to adjudicate. This condition is
-- file-level — a single master commit re-exported the whole book from a stale
-- translationCore snapshot — so writing it per verse would mean ~850 rows for
-- one event (2CH ULT is 858 verses) saying the same sentence, and would flood
-- the very banner that has to stay actionable.
--
-- Conventions copied from verse_merge_conflicts (0044 + 0049) so the two behave
-- the same way for a human:
--   * detected_at is set once, on INSERT, and never moved — it is when we FIRST
--     refused this revision.
--   * last_recorded_at moves on every re-detection, so "still happening
--     tonight" is distinguishable from "happened once in July".
--   * resolved_at / resolved_by are the release. A re-detection never clears
--     them (see UPSERT_STALE_BASE_HOLD_SQL): a human's decision is sticky,
--     exactly like a dismissed alert.
--
-- Keyed on (book, resource, master_sha): one row per offending master revision.
-- The gate re-fires every night the offending revision is still master's tip
-- (the watermark is withheld, so source_sha never advances past it and
-- planAndStageBookResources re-stages the file), and that must re-record rather
-- than accumulate. A DIFFERENT stale revision later gets its own row, because
-- it is a different event with its own evidence.
CREATE TABLE stale_base_holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book TEXT NOT NULL,
  -- 'ult' | 'ust', lowercase, matching verse_merge_conflicts.resource and
  -- book_resource_syncs.resource.
  resource TEXT NOT NULL,
  -- The master file-commit SHA we refused. Full 40-hex.
  master_sha TEXT NOT NULL,
  -- The revision D1 was last synced from, i.e. book_resource_syncs.source_sha
  -- at detection time — the state the refused revision would have reverted to.
  previous_sha TEXT,
  -- The three measurements the decision was made on, stored so the record can
  -- be re-checked rather than trusted (unix seconds). See staleBaseGate.ts.
  incoming_tc_export_at INTEGER,
  previous_tc_export_at INTEGER,
  synced_at INTEGER,
  -- decideStaleBaseReplacement's machine-readable outcome. Always a hold reason
  -- here, but recorded so a future non-hold audit shape can share the table.
  reason TEXT NOT NULL,
  detected_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_recorded_at INTEGER,
  resolved_at INTEGER,
  resolved_by INTEGER REFERENCES users(id)
);

CREATE UNIQUE INDEX stale_base_holds_unique ON stale_base_holds (book, resource, master_sha);
CREATE INDEX stale_base_holds_active ON stale_base_holds (book, resource) WHERE resolved_at IS NULL;
