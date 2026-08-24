// Non-destructive per-chapter, per-resource re-import from Door43.
//
// The bootstrap path (bookImport.ts) wipes the book and re-inserts. This
// module is the maintenance lane: pull fresh content from DCS for selected
// chapters / resources without clobbering rows a translator has edited.
//
// Don't-clobber rule (canonical): a row is "safe to overwrite" iff no HUMAN
// owns it. Two admissible cases (see isReimportableRow in reimportClassify.ts):
//   1. pristine — never touched at all (updated_by IS NULL), plus the human-owned
//      protections clear:
//        tn:  deleted_at IS NULL AND trashed_at IS NULL AND preserve = 0 AND hint = 0
//        tq:  deleted_at IS NULL
//        twl: deleted_at IS NULL
//      (trashed_at: a note pending deletion is never overwritten/resurrected by a
//      reimport — it's promoted to a deleted_at tombstone by the nightly job.)
//   2. AI-only — the AI pipeline wrote the row (so updated_by is the pipeline
//      starter's id) but no human has edited it since: the latest content-bearing
//      edit_log entry is source='ai_pipeline'. This is the same signal the AI
//      pipeline sweep uses in pipelineImport.ts deleteUnkeptTns. An AI-only row is
//      re-seeded from master exactly like a pristine one AND reclaimed to
//      master-owned (updated_by → NULL), counted as `reimported_ai` (NOT the
//      misleading `skipped_edited`). Its write is guarded by version-CAS + the
//      same protection re-assertion so a human edit landing mid-import can't be
//      clobbered (a human PATCH bumps version and writes a null/manual-source
//      edit_log row, so the row stops being AI-only).
// A genuinely human-edited row (latest edit_log source null/manual) is SKIPPED,
// not merged or warned about.
//
// This distinction closes the recurring "N skipped (already edited)" mislabel on
// every AI-touched book: before, updated_by != null alone marked a row edited, so
// AI-generated rows no human had touched were never re-seeded from master.
//
// Concurrency:
//   - book_import_locks is reused (per-book serialization). A second caller
//     gets 409 in_progress.
//   - Active AI pipelines on a chapter cause that chapter to be skipped
//     (counted as skipped_locked) — the AI run would overwrite us anyway.
//   - The UPDATE-WHERE-pristine predicate is the real race guard: if a user
//     edits mid-import, their PATCH bumps updated_by and our UPDATE matches
//     0 rows. No SELECT-then-UPDATE window.

import type { Env } from "./index";
import type { WorkflowStep } from "cloudflare:workers";
import {
  dcsUrls,
  dcsResourceFile,
  dcsRawUrl,
  fileCommitSha,
  fetchText,
  fetchDcsMasterTextVerified,
  fetchHumanTouchedRefs,
  listMasterCommitsSince,
  NT_BOOKS,
} from "./dcsSources";
import {
  classifyMasterCommit,
  compactLineage,
  LINEAGE_REFINE_MAX_HUMAN_COMMITS,
  masterMayHoldHumanEdit,
  masterMayHoldHumanEditForVerse,
  summarizeLineage,
  type HumanRefEvidence,
  type MasterLineageSummary,
} from "./masterLineage.ts";
import { gitBlobShaOrNull, recognizeOwnPublish, type OwnPublishResult } from "./ownPublish";
import {
  collectSourceWords,
  extractVersesForRange,
  healReplacementChars,
  makeVerseSortOrder,
  parseTsv,
  reconcileSourceAttrsFromMaster,
  refParts,
  type SourceWord,
  type VerseExtract,
} from "./importParsers";
import { activePipelineForChapter } from "./chapterLock";
import { coerceRowId } from "./rowId";
import { planTnContentDedup } from "./tnDedup";
import { isCatastrophicTsvShrink } from "./shrinkGuard";
import {
  classifyReimportRow,
  isReimportableRow,
  computeEditedFieldMerge,
  isReissuedTombstone,
} from "./reimportClassify";
import {
  classifyTsvRefMove,
  tsvRefMoved,
  computeTsvMerge,
  foldTsvBase,
  foldTsvRefBase,
  type TsvMergeSide,
  type TsvRefSide,
  type TsvEditLogEntry,
} from "./tsvMerge.ts";
import { shouldRecordResourceSync, isSystemicMergeRefusal, isKeptOverDoor43AtScale } from "./reimportSyncGate";
import { computeTwlSortOrderUpdates } from "./twlCanonicalOrder";
import { applyTwlSortOrderUpdates } from "./twlSortOrderApply";
import { loadTwTitles } from "./twTitles";
import { loadTwlOrderLocks } from "./twlOrderLocks";
import type { TwlRow, VerseRow, CheckLane } from "./types";
import { computeVerseMerge, type VerseMergeResult } from "./verseMerge.ts";
import { NO_BASE_REF_DISPLAY, type NoBaseVerseRef } from "./verseMergeEditorAlerts.ts";
import { verseContentJsonFromPayload } from "./verseHistory.ts";
import { canonizeAlignmentSource } from "./canonizeHebrew.ts";
import {
  recordVerseMergeConflicts,
  confirmAdoptedConflicts,
  deleteLostAdoptionConflicts,
  raiseVerseMergeConflictAlert,
} from "./verseMergeConflicts.ts";
import { lanesForAdoption, reopenLaneChecksBulk } from "./laneReopen.ts";
// REIMPORT_CHAPTER_CHUNK / reimportChunkBoundaries live in their own
// zero-dependency module (reimportChunkPlan.ts) so the chunk-boundary math —
// including the chapter-0 handling — is unit-testable directly under plain
// node; re-exported below so every existing internal/external reference keeps
// working unchanged.
import { REIMPORT_CHAPTER_CHUNK, reimportChunkBoundaries } from "./reimportChunkPlan";

export type Resource = "ult" | "ust" | "tn" | "tq" | "twl";

export const ALL_RESOURCES: readonly Resource[] = ["ult", "ust", "tn", "tq", "twl"];

export { REIMPORT_CHAPTER_CHUNK, reimportChunkBoundaries };

// Max statements per env.DB.batch() write. D1 caps a batch at 100 statements and
// 100 bound params per statement; 90 stays safely under both. The batched
// applyTsvRows / applyVerseRows paths exist to keep the nightly DCS→D1 sync under
// the per-invocation subrequest cap — DO NOT revert them to a per-row loop. That
// exact regression (PR #180 batched them → a later refactor un-batched them →
// PR #195 re-batched) silently reintroduced the cap once. See bookReimport's
// section header + the nightly-sync-subrequest-cap memory.
// Row table per TSV kind. Every other statement in this file hard-codes its
// table inside a per-kind branch; the flag clear (issue #588) is identical for
// all three, so it interpolates from here rather than repeating itself.
const TSV_TABLE: Record<"tn" | "tq" | "twl", string> = {
  tn: "tn_rows",
  tq: "tq_rows",
  twl: "twl_rows",
};

const WRITE_BATCH = 90;

export interface ReimportCounts {
  updated: number;
  // AI-only rows (written by the AI pipeline, never human-edited) that were
  // overwritten from master and reclaimed to master-owned (updated_by → NULL).
  // Tracked separately from `updated` (pristine rows) so the summary can say
  // "N refreshed (AI-generated)" instead of the old, misleading "N skipped
  // (already edited)". See isReimportableRow / the header don't-clobber rule.
  reimported_ai: number;
  inserted: number;
  // Pristine rows soft-deleted because master no longer carries their id. Only
  // the TSV resources populate this (verses are never row-deleted on reimport).
  deleted: number;
  // TSV rows that stayed human-owned (updated_by untouched) but had one or
  // more never-human-owned or whitespace-only fields (tags; note/question/
  // response when the only difference is incidental whitespace) synced in
  // from master. See computeEditedFieldMerge in reimportClassify.ts. Distinct
  // from skipped_edited/reimported_ai — the row is neither a no-op skip nor
  // reclaimed to master ownership.
  merged_fields: number;
  skipped_edited: number;
  skipped_locked: number;
  // Chapters skipped this run because an active AI pipeline job held the
  // chapter lock — DISTINCT from skipped_locked, which also counts row-level
  // prune skips (softDeleteRemovedTsvRows) that are not a sync-freshness
  // concern. Together with prune_locked below, this gates the (book,
  // resource) watermark stamp — see shouldRecordResourceSync / the EZK 40
  // incident at the sync step.
  chapters_locked: number;
  // Row-level prune skips this run because an active AI pipeline job held
  // the chapter lock during softDeleteRemovedTsvRows (the reimport-prune-*
  // Workflow step, a LATER step than the chunk-apply steps that populate
  // chapters_locked above). A lock that starts after the chunk step finishes
  // but is still held during the prune step leaves chapters_locked === 0 —
  // the apply phase never saw it — yet the prune for that chapter never ran,
  // so the row-deletion side of this resource's sync is still stale. Gate on
  // BOTH counters, not just chapters_locked, or the watermark can still be
  // stamped for a resource whose prune phase was incomplete.
  prune_locked: number;
  skipped_noop: number;
  // Incoming row not inserted because an identical-content row already exists
  // (Guard 2, content-dedup). Tracked separately from skipped_noop so the guard
  // firing is visible in the reimport summary / logs.
  skipped_dup: number;
  // ── Issue #427, option 2: the silent tombstone-PK drop, made visible ──────
  //
  // A master row this run intended to INSERT whose `INSERT ... ON CONFLICT(id,
  // book) DO NOTHING` wrote 0 rows — the (book, id) slot was already taken by a
  // row the in-memory diff didn't see (in practice a tombstone; soft deletes
  // keep their primary key forever). Previously folded into `skipped_noop` with
  // a "raced" comment, which asserted a cause the code had not measured. The
  // narrower of the two drop routes: applyTsvRows' `existing` read does NOT
  // filter `deleted_at IS NULL`, so a known tombstone reaches the tombstone
  // branch below and never gets here — this counter is the backstop for a slot
  // taken between the read and the insert.
  conflict_skipped: number;
  // A master row dropped by the TOMBSTONE branch of applyTsvRows where master
  // carries that id at a DIFFERENT reference than the tombstone holds — i.e.
  // the id has been reissued to a genuinely different row, so master's row is
  // real and is being silently lost. This is the route the 1CH 23 tQ incident
  // actually took (six ids tombstoned at 1CH 5:x, reissued by bp-assistant at
  // 1CH 23:x, dropped with no error and no counter while the watermark
  // certified the book in sync). See isReissuedTombstone in reimportClassify.ts
  // for the discriminator and why a SAME-reference tombstone is deliberately
  // NOT counted (that skip is what preserves a delete pending export).
  //
  // These rows are ALSO counted in `skipped_edited`, which is left untouched so
  // no existing reader changes meaning; this is the specific, gating subset of
  // it. (`skipped_noop` DID change meaning: the PK-conflict case used to be
  // folded into it and no longer is. Readers: reimportSummary.ts's "N unchanged"
  // and AdminPanel's counter dump.)
  //
  // Issue #427's option 1 (reclaim a reissued id) has SHIPPED — see
  // `tombstone_reclaimed` below and the tombstone branch of applyTsvRows. This
  // counter no longer means "master's row was dropped and we only reported it";
  // for a reissued tombstone the reimport now ATTEMPTS the reclaim in the same
  // run, and `tombstone_blocked` only still increments for that row when the
  // reclaim itself lost the version-CAS race (something touched the tombstoned
  // row between the read and the write) — a residual, expected-to-self-heal-on-
  // retry case, kept here rather than silently dropped so a lost race is never
  // quieter than the pre-reclaim behavior. `conflict_skipped` above is unrelated
  // to reclaim (it's the INSERT-path race) and still behaves exactly as before.
  //
  // NOTE the asymmetry with tsvMerge.ts's `tsvRefMoved`, which answers a
  // similar-sounding question for LIVE rows and also withholds (via
  // apply_incomplete). The two deliberately differ: tsvRefMoved treats any
  // ref_raw difference as a move, including whitespace and a null-vs-populated
  // ref_raw, because for a live row the safe direction is to flag. Here the safe
  // direction is the opposite — a false positive used to freeze the book's
  // export with no automatic release; now it drives an actual reclaim instead
  // (see isReissuedTombstone's KNOWN FALSE POSITIVE note in reimportClassify.ts
  // for what that means) — so isReissuedTombstone normalizes whitespace and
  // falls back to chapter/verse. Keep them separate; do not "unify" one into the
  // other without re-deciding which direction each should fail.
  tombstone_blocked: number;
  // ── Issue #427, option 1: reclaim a reissued tombstone's slot ────────────────
  //
  // A tombstoned row master's file now carries at a DIFFERENT reference (see
  // isReissuedTombstone) — the exact condition that used to only increment
  // tombstone_blocked and freeze the export — is now RECLAIMED: master's
  // incoming row is written into the freed-up (book, id) slot (deleted_at
  // cleared, content/ref/chapter/verse/sort_order set to master's, version
  // bumped, updated_by reset to NULL so the row is master-owned going forward).
  // The old tombstoned row's content and protection flags (trashed_at/preserve/
  // hint/updated_by) are irrelevant to this decision — master's new row is a
  // completely different logical entity being written into a slot the old row
  // merely happened to vacate, not a continuation of it. See the "Batch the
  // reclaims" write site for the CAS guard this relies on, and the lost-CAS
  // fallback that still counts tombstone_blocked (never a silent drop).
  // Audited as "create" (edit_log): from this slot's new life's perspective,
  // master's row IS a fresh row. Does NOT gate the watermark by itself — a
  // landed reclaim means master's content IS now in D1, so there is nothing
  // left to withhold for; only the lost-CAS fallback (tombstone_blocked) does.
  tombstone_reclaimed: number;
  // Human-readable identification of the rows the two counters above dropped —
  // resource, id, and both references. Capped at BLOCKED_SAMPLE_CAP because the
  // failure mode is a whole book's ids being re-minted at once, and this rides
  // in a Workflow step result and an alert message. Diagnostic ONLY: it is not
  // consulted by any gate, so a truncated or absent list can never change a
  // watermark decision — the counters do that. It exists because withholding a
  // watermark with no automatic release (see the reimport-sync step) is only
  // actionable if a human is told WHICH rows to go fix.
  blocked_samples?: string[];
  // Pristine tombstone that master still carries, brought back to life because
  // an earlier reimport prune had erroneously soft-deleted it (the HAB tn
  // truncated-fetch incident). Human-deleted/trashed rows are never resurrected.
  resurrected: number;
  // Edited verse (updated_by != null) whose SOURCE-owned `\zaln-s` attributes
  // (x-content/x-lemma/x-morph) were reconciled from master while preserving the
  // translator's target text + grouping. Stops the nightly export from reverting
  // a curated original-language fix on an edited verse (the NUM 20–22 incident).
  // verses only — TSV rows have no source attrs.
  source_attr_reconciled: number;
  // Source-attr divergence on an edited verse that could NOT be uniquely
  // reconciled (master ambiguous for the source key). Left as-is, logged so the
  // residual potential clobber is visible. Normally zero.
  source_attr_divergent: number;
  // twl rows whose sort_order was rewritten by the canonical post-pass to match
  // the ULT-position ordering (the same order the nightly export computes). Lets
  // the reimport adopt canonical order back into D1 for content-identical rows
  // that classifyReimportRow otherwise preserves as a local reorder. Book-level
  // pass, tallied onto perResource.twl.
  twl_reordered: number;
  // Verse OR TSV row whose content was adopted from master via a three-way
  // merge — either action "adopt" (master moved, we didn't) or "adopt_conflict"
  // (both moved; master won, flagged for review — see merge_conflicts).
  // Incremented only when the version-CAS write actually landed. verses use
  // computeVerseMerge (verseMerge.ts); tn/tq/twl use computeTsvMerge
  // (tsvMerge.ts). See the 1CH incident this class of fix addresses.
  merge_adopted: number;
  // Verse flagged for human review after a merge: action "adopt_conflict"
  // (both D1 and master moved since the ancestor) or "keep_alignment_refused"
  // (adopting master would lose alignment). Deliberately EXCLUDES a clean
  // "adopt" (master moved, we didn't) — that case needs no human judgment, so
  // it is recorded in verse_merge_conflicts as an audit trail only (see
  // recordVerseMergeConflicts) but never counted here or in the banner alert.
  // Recording is best-effort — see merge_record_failed for when it fails. An
  // "adopt_conflict" whose version-CAS write was LOST is not counted or
  // recorded: nothing was overwritten, so there is nothing yet for a human to
  // recover. verses AND tsv — for tn/tq/twl an adopt_conflict sets the row's
  // review_kind/review_reason (migration 0047), surfaced by the cleanup chip
  // (lint.ts) rather than the verse banner.
  merge_conflicts: number;
  // Verse where computeVerseMerge returned "keep_alignment_refused" — master's
  // edit was NOT adopted because doing so would lose alignment on words
  // neither side touched. A subset of merge_conflicts (every refusal needs a
  // human) tracked separately so the reason breakdown is visible. verses only.
  merge_refused: number;
  // Row or verse where both sides moved since the ancestor but the commit
  // lineage found NO human commit on master's side, so D1 won and the
  // collision was flagged instead (#540 item 2, verseMerge/tsvMerge's
  // "keep_ai_master"). Tracked separately for two reasons: it is the counter
  // that says whether the AI-vs-human policy is actually firing in production,
  // and it must never be folded into merge_refused, which freezes the resource's
  // export at 5 (see isSystemicMergeRefusal — freezing here would strand the very
  // edit this outcome protected). verses AND tsv.
  //
  // Relationship to merge_conflicts differs by side, so do not describe it as a
  // plain subset: for VERSES it is one, but on the TSV side merge_conflicts is
  // incremented only for a write that also adopted a field, and a kept-only row
  // adopts nothing. It also counts DECISIONS, incremented before the write — a
  // row that then loses the version-CAS race, or whose flag text is unchanged
  // from last night and so writes nothing, is counted here and skipped_edited
  // too.
  merge_kept_ai: number;
  // Verse where computeVerseMerge returned "keep_no_base" — no ancestor was
  // recoverable for this specific verse (edit_log aged past the 180-day
  // retention, or the verse has no edit_log row before book_resource_syncs.
  // master_confirmed_at). D1 is kept, matching the pre-existing safe default.
  // Only counted when this book+resource HAS a master_confirmed_at watermark
  // at all; a book/resource never positively confirmed in master skips the
  // merge entirely and counts nothing here. verses AND tsv (computeTsvMerge
  // returns keep_no_base for a whole-row ancestor that couldn't be
  // reconstructed, e.g. edit_log aged out). NOTE (known residual, deliberately
  // NOT gated on): merge_no_base does not withhold the watermark, so a genuinely
  // unattributable differing row is still kept-and-reverted — the pre-existing
  // warm-up tradeoff, left as a flagged follow-up (see the failed-adoption-write
  // gate, apply_incomplete, which IS gated).
  merge_no_base: number;
  // The `chapter:verse` refs behind `merge_no_base`, so the banner can NAME the
  // verses it admits tonight's export may overwrite instead of reporting a bare
  // integer. Capped at NO_BASE_REF_CAP: this is a diagnostic list that gates
  // nothing (merge_no_base stays the authoritative count), and it rides back
  // through a Workflow step's serialized return value, so it must stay small.
  // verses only - the TSV side shares `merge_no_base` but has no banner.
  merge_no_base_refs?: string[];
  // The SAME keep_no_base verses as merge_no_base_refs, but UNCAPPED and each
  // carrying its current D1 version (issue #544) - the input
  // raiseVerseMergeConflictAlert's editor fan-out needs to attribute every
  // affected verse to the human who last edited it (verseMergeEditorAlerts.ts's
  // groupNoBaseVersesByEditor), not just the first NO_BASE_REF_DISPLAY of them.
  // Capped separately (NO_BASE_EDITOR_REF_CAP) - generously, since unlike the
  // display sample this list must not silently drop a translator's verse, but
  // still bounded so a pathological book can't blow up a Workflow step's
  // serialized return value. verses only.
  merge_no_base_editor_refs?: NoBaseVerseRef[];
  // Reference-move attribution (issue #540 item 3), split by WHO moved so a run
  // summary can distinguish "we published a move" from "master moved under us".
  // Only ref_moved_theirs / _both / _unattributable / _ours_conflict withhold the
  // watermark; ref_moved_ours is an ordinary exportable edit and is counted purely
  // so the livelock this replaced stays visible if it ever comes back.
  ref_moved_ours: number;
  // ours_moved that STILL held, because master edited the row surface in the same
  // window - a genuine two-sided change, not the livelock. Counted apart from
  // ref_moved_ours so the livelock canary is not diluted by rows that held.
  ref_moved_ours_conflict: number;
  ref_moved_theirs: number;
  ref_moved_both: number;
  ref_moved_unattributable: number;
  // Rows whose reference-move flag this run CLEARED by the version-neutral write,
  // because the two sides now agree (issue #588). Not a move and not a merge: a
  // flag-only write that makes a resolved cleanup chip disappear. That write
  // serves the no-op path plus protected tn rows on the edited path (whose clear
  // cannot ride a content write — the protection predicate would 0-change it).
  // A non-protected edited row's clear is NOT counted here: it rides a content
  // write whose outcome is already counted (merge_adopted / merged_fields /
  // skipped_edited on a lost CAS), and double-counting it would make this number
  // stop meaning "chips that disappeared for free".
  ref_moved_resolved: number;
  // Human-edited verse that DIFFERS from master but could not be adjudicated
  // at all, because this book+resource has no `master_confirmed_at` watermark
  // yet (migration 0045 adds the column and does not backfill it — only the
  // export can measure that master holds our render). D1 is kept and the
  // export will revert master, exactly as before this fix: the merge is INERT
  // for this book+resource until one export cycle observes convergence.
  // Counted so "the merge never fires here" is distinguishable from "nothing
  // to merge". verses only.
  merge_unavailable: number;
  // Verse where computeVerseMerge returned "keep_converged" (ours/theirs
  // matched after verseMerge.ts's whitespace-insensitive normalization) but
  // the RAW content_json strings actually differed — a genuine, cosmetic-only
  // Door43 edit (e.g. a missing space added after a comma) that this
  // normalization treats as "no change" and is therefore silently reverted
  // by every nightly export. See verseMerge.ts's FIX 5 correction for why
  // this class exists and can't be "handled on the export side" as an
  // earlier, false comment claimed. verses only.
  merge_cosmetic_ignored: number;
  // Master's bytes for this (book, resource) were EXACTLY the render the export
  // last pushed, so master moved because our own `-be-` branch merged and the
  // merge ancestor cutoff (master_confirmed_at) was advanced to that render's
  // D1-read time. 0 or 1 per resource per run, and counted ONLY when the stamp
  // actually landed (see markOwnPublishConverged).
  //
  // What follows the recognition differs by path, deliberately: the nightly cron
  // ALSO skips the resource's row work entirely, while the user/admin "Pull from
  // Door43" route only advances the watermark and then imports as usual (see the
  // comment at that call site for why a human's explicit pull must not be
  // silently skipped).
  //
  // Counted so "converged with our own publish" is distinguishable in the
  // reimport summary from "master's SHA was unchanged" and from "nothing
  // happened" — the pre-fix behavior for this exact case was an `adopt_conflict`
  // storm that silently reverted app edits, so this class firing is the
  // observable evidence the fix is working. See ownPublish.ts.
  own_publish_converged: number;
  // Set true when recordVerseMergeConflicts (verseMergeConflicts.ts) failed to
  // durably write one or more of this run's merge_conflicts rows — see its
  // boolean return. The book-level alert (raiseVerseMergeConflictAlert) reads
  // this so it can say the table may be missing rows instead of silently
  // treating a write failure as "nothing to report". verses only.
  merge_record_failed?: boolean;
  dcs_404: number;
  errors: string[];
  // Set when this object (or an object folded into it via addCounts) was
  // missing `chapters_locked`/`prune_locked` — the legacy/malformed-object
  // case described on shouldRecordResourceSync. addCounts's `?? 0` numeric
  // coercion keeps the running totals sane for logging, but it also erases
  // the "field was absent" signal the gate needs — a replayed pre-fix chunk
  // result would otherwise launder into a PRESENT zero at the aggregate
  // level and stamp the watermark for data we have no evidence is current.
  // This flag survives that coercion so shouldRecordResourceSync can still
  // withhold on the aggregate, not just on a raw, un-aggregated counts object.
  counts_incomplete?: boolean;
  // Set true when a CORRECTNESS-BEARING adoption write batch THREW (a D1
  // batch() error, not a lost CAS race) — the verse master-adoption batch, the
  // verse source-attr reconcile batch, or the TSV three-way merge batch. Those
  // batches adopt a maintainer's out-of-band Door43 correction into D1; if the
  // write throws, D1 stays stale but the rest of the run continues, and without
  // this taint the (book, resource) watermark would still be stamped — so
  // tonight's export renders stale D1 over master (reverting the correction)
  // and the SHA match makes planAndStageBookResources skip this resource on the
  // NEXT run, so it never retries. Gated on at the reimport-sync step alongside
  // chapters_locked / prune_locked / merge_record_failed / systemic refusals
  // (the failed-adoption-write hole Codex flagged in the shipped verse merge).
  // A lost CAS race is NOT this — that's an honest skipped_edited (a human wrote
  // first; nothing of theirs was clobbered). Only a thrown batch sets it.
  apply_incomplete?: boolean;
}

export interface ReimportResult {
  book: string;
  perResource: Record<Resource, ReimportCounts>;
  totals: ReimportCounts;
}

const REIMPORT_SOURCE = "dcs_reimport";

// Cap on ReimportCounts.blocked_samples. Also caps the per-row console.warn at
// each drop site: a mass id-reissue would otherwise emit one Workers log line
// per row, and the per-resource summary at the reimport-sync step already
// carries the total.
// One row's reconstructed ancestor: the content the field merge attributes
// against, and the reference classifyTsvRefMove attributes against. Folded
// together from a single edit_log read (see reconstructTsvBases).
interface TsvBaseRecord {
  content: TsvMergeSide | null;
  ref: TsvRefSide | null;
}

const BLOCKED_SAMPLE_CAP = 20;

// Cap on ReimportCounts.merge_no_base_refs. Deliberately EQUAL to the banner's
// display cap: that sentence is the only consumer (AdminPanel's nonZeroCounts
// type-filters the array out of the admin result view), so anything collected
// beyond it would ride through every Workflow step's serialized return value
// only to be sliced off. A book-wide no-ancestor state is real - EZK/JER carry
// 34-59 such verses per resource today - so the count, not the list, is what
// has to survive; it does, independently.
const NO_BASE_REF_CAP = NO_BASE_REF_DISPLAY;

// Cap on ReimportCounts.merge_no_base_editor_refs (issue #544). Deliberately
// far above any observed count (EZK/JER carry 34-59 keep_no_base verses per
// resource today, per NO_BASE_REF_CAP's comment above) - unlike that display
// cap, every verse here needs to reach an editor, so this cap exists only to
// bound the worst-case Workflow-step serialized return value, not to shrink
// a display list.
export const NO_BASE_EDITOR_REF_CAP = 200;

// Cap on the per-row "we attributed this move to the app" log lines. While one
// held row keeps a resource stuck, every other moved row in the book would
// otherwise log an object every night; the counters carry the totals.
const REF_MOVE_LOG_CAP = 20;

// Record one dropped row's identification, and log it, both capped. Kept as one
// helper so the cap can never be applied to the list but forgotten on the log.
function noteBlockedSample(counts: ReimportCounts, sample: string): void {
  const samples = (counts.blocked_samples ??= []);
  if (samples.length >= BLOCKED_SAMPLE_CAP) return;
  samples.push(sample);
  console.warn("reimport: master row not imported — id already held in D1", { sample });
}

function zeroCounts(): ReimportCounts {
  return {
    updated: 0,
    reimported_ai: 0,
    inserted: 0,
    deleted: 0,
    merged_fields: 0,
    skipped_edited: 0,
    skipped_locked: 0,
    chapters_locked: 0,
    prune_locked: 0,
    skipped_noop: 0,
    skipped_dup: 0,
    conflict_skipped: 0,
    tombstone_blocked: 0,
    tombstone_reclaimed: 0,
    resurrected: 0,
    source_attr_reconciled: 0,
    source_attr_divergent: 0,
    twl_reordered: 0,
    merge_adopted: 0,
    merge_conflicts: 0,
    merge_refused: 0,
    merge_kept_ai: 0,
    merge_no_base: 0,
    merge_no_base_refs: [],
    merge_no_base_editor_refs: [],
    ref_moved_ours: 0,
    ref_moved_ours_conflict: 0,
    ref_moved_theirs: 0,
    ref_moved_both: 0,
    ref_moved_unattributable: 0,
    ref_moved_resolved: 0,
    merge_unavailable: 0,
    merge_cosmetic_ignored: 0,
    own_publish_converged: 0,
    merge_record_failed: false,
    dcs_404: 0,
    errors: [],
    counts_incomplete: false,
    apply_incomplete: false,
  };
}

// Test-only aliases (reimportJourney.test.mjs). The aggregation step is where an
// absent counter could be laundered into a present zero, so the journey test has
// to fold through the REAL addCounts rather than re-implement it.
export const zeroCountsForTest = (): ReimportCounts => zeroCounts();
export const addCountsForTest = (into: ReimportCounts, from: ReimportCounts): void => addCounts(into, from);
export const raiseTombstoneBlockAlertForTest = (
  env: Env,
  book: string,
  resource: Resource,
  counts: ReimportCounts,
  overridden: boolean = false,
): Promise<void> => raiseTombstoneBlockAlert(env, book, resource, counts, overridden);
// aiRowDiffGate.test.mjs (issue #485 P1 follow-up): softDeleteRemovedTsvRows is
// the prune half of the diff gate — this alias lets the test drive the REAL
// prune against the real SQL (same rationale as the aliases above) to confirm
// a gate-flagged chapter is actually processed, not just flagged.
export const softDeleteRemovedTsvRowsForTest = (
  env: Env,
  book: string,
  kind: TsvKind,
  rawTsv: string,
  candidateChapters: number[],
  // Second P1 follow-up: threaded through so the test can drive both the
  // verified-complete widened-coverage case AND the unverified conservative
  // fallback case against the REAL function — see softDeleteRemovedTsvRows.
  verifiedComplete: boolean,
): Promise<{ deleted: number; skippedLocked: number }> =>
  softDeleteRemovedTsvRows(env, book, kind, rawTsv, candidateChapters, verifiedComplete);
// tombstoneSweep.test.mjs (issue #427 option 3): same rationale as the alias
// above — lets the test drive the REAL sweepObsoleteTombstones (hard-delete +
// gated audit row) against the real SQL instead of proving only that SQLite
// behaves the way a hand-copied statement claims it does.
export const sweepObsoleteTombstonesForTest = (
  env: Env,
  book: string,
  kind: TsvKind,
  rawTsv: string,
  verifiedComplete: boolean,
): Promise<{ swept: number }> => sweepObsoleteTombstones(env, book, kind, rawTsv, verifiedComplete);
// The completeness gate softDeleteRemovedTsvRows' coverage fix relies on its
// callers already having run — exposed so the control test can prove the gate
// itself still catches a truncated fetch (the safety invariant the coverage
// fix must not weaken), independent of the prune's own behavior.
export const tsvFetchLooksTruncatedForTest = (
  env: Env,
  book: string,
  kind: TsvKind,
  raw: string,
): Promise<boolean> => tsvFetchLooksTruncated(env, book, kind, raw);
// applyVerseRows itself has no D1-mock test harness above this module (see
// verseMerge.test.mjs's note on collapseWhitespaceForCompare) — exposed here,
// same convention as zeroCountsForTest, so applyVerseRows.test.mjs can drive
// the real chunked-batch write path against a real SQLite-backed env.DB.
export const applyVerseRowsForTest = (
  env: Env,
  book: string,
  bibleVersion: "ULT" | "UST",
  verses: VerseExtract[],
  userId: number | null,
  cutoff: MergeCutoff | null,
  broadcastLaneReopens?: boolean,
): Promise<ReimportCounts> =>
  applyVerseRows(env, book, bibleVersion, verses, userId, cutoff, broadcastLaneReopens);
export const clearTombstoneBlockAlertForTest = (
  env: Env,
  book: string,
  resource: Resource,
): Promise<void> => clearTombstoneBlockAlert(env, book, resource);
// persistMasterLineage's own DB write, exposed directly so
// masterLineagePersist.test.mjs can drive the UPSERT (both the update-existing-
// row path and the insert-when-absent fallback) against a real SQLite-backed
// env.DB without re-fetching from DCS.
export const persistMasterLineageForTest = (
  env: Env,
  book: string,
  resource: Resource,
  summary: MasterLineageSummary,
  asOfSha: string | null,
): Promise<void> => persistMasterLineage(env, book, resource, summary, asOfSha);

function addCounts(into: ReimportCounts, from: ReimportCounts): void {
  into.updated += from.updated;
  into.reimported_ai += from.reimported_ai;
  into.inserted += from.inserted;
  into.deleted += from.deleted;
  into.merged_fields += from.merged_fields ?? 0;
  into.skipped_edited += from.skipped_edited;
  into.skipped_locked += from.skipped_locked;
  // `?? 0` guards a `from` object memoized by a Workflow instance that began
  // before these two fields existed — `step.do` replays its stored result
  // verbatim on resume, so an in-flight instance can hand addCounts an object
  // with `chapters_locked`/`prune_locked` simply absent (not 0). Without the
  // coercion, `into.x += undefined` poisons the running total to NaN for the
  // rest of this merge chain. That said, the coercion itself launders "field
  // absent" into "field present and zero" for the AGGREGATE object — exactly
  // the "no-evidence into a green light" mistake shouldRecordResourceSync's
  // own comment warns about, one layer up. A raw, un-aggregated counts object
  // still shows the absence directly (shouldRecordResourceSync's undefined
  // check catches that route), but once addCounts folds a legacy/replayed
  // chunk into `into`, the absence is gone and the gate would see a present
  // zero and stamp. So the incompleteness is recorded separately, on
  // `counts_incomplete`, which survives the coercion below and is checked by
  // the gate in addition to its direct-absence check.
  //
  // `conflict_skipped` / `tombstone_blocked` (issue #427) join that list for
  // exactly the same reason, and it matters more for them than for the two
  // above: those two fields did not exist before this change, so EVERY chunk
  // result memoized by a Workflow instance that started pre-deploy is missing
  // them. If their absence only coerced to zero, a run that dropped rows to a
  // tombstone collision mid-deploy would aggregate to a clean present-zero and
  // stamp the watermark — the precise laundering this taint flag exists to stop.
  const incomplete =
    from.chapters_locked === undefined ||
    from.prune_locked === undefined ||
    from.conflict_skipped === undefined ||
    from.tombstone_blocked === undefined;
  into.counts_incomplete = Boolean(into.counts_incomplete || from.counts_incomplete || incomplete);
  into.chapters_locked += from.chapters_locked ?? 0;
  into.prune_locked += from.prune_locked ?? 0;
  into.skipped_noop += from.skipped_noop;
  into.skipped_dup += from.skipped_dup;
  into.conflict_skipped += from.conflict_skipped ?? 0;
  into.tombstone_blocked += from.tombstone_blocked ?? 0;
  // tombstone_reclaimed (issue #427, option 1) deliberately does NOT join the
  // `incomplete` taint check above, mirroring tombstones_swept/tombstones_locked
  // (option 3): a landed reclaim means master's content IS now in D1, so there
  // is no watermark decision here for an absent-vs-zero distinction to protect
  // — only the lost-CAS fallback (which still increments tombstone_blocked,
  // already covered above) withholds. Plain `?? 0` coercion is the right and
  // sufficient handling for a legacy/replayed chunk result that predates this
  // field.
  into.tombstone_reclaimed += from.tombstone_reclaimed ?? 0;
  // Diagnostic list, merged under the same cap. Never gates anything, so a
  // truncation here cannot affect a watermark decision.
  if (from.blocked_samples?.length) {
    const into_ = (into.blocked_samples ??= []);
    for (const s of from.blocked_samples) {
      if (into_.length >= BLOCKED_SAMPLE_CAP) break;
      into_.push(s);
    }
  }
  into.resurrected += from.resurrected;
  into.source_attr_reconciled += from.source_attr_reconciled;
  into.source_attr_divergent += from.source_attr_divergent;
  into.twl_reordered += from.twl_reordered;
  into.merge_adopted += from.merge_adopted ?? 0;
  into.merge_conflicts += from.merge_conflicts ?? 0;
  into.merge_refused += from.merge_refused ?? 0;
  into.merge_kept_ai += from.merge_kept_ai ?? 0;
  into.merge_no_base += from.merge_no_base ?? 0;
  // Same shape as blocked_samples above: diagnostic, capped, gates nothing. A
  // chunk memoized before this field existed contributes no refs while still
  // contributing its count, which is why the banner reports the count as
  // authoritative and the refs as a sample.
  if (from.merge_no_base_refs?.length) {
    const into_ = (into.merge_no_base_refs ??= []);
    for (const r of from.merge_no_base_refs) {
      if (into_.length >= NO_BASE_REF_CAP) break;
      into_.push(r);
    }
  }
  // Same shape, same tolerance for a chunk memoized before the field existed -
  // see merge_no_base_refs just above. Capped separately (NO_BASE_EDITOR_REF_CAP)
  // since this list feeds editor attribution, not just the admin sentence.
  if (from.merge_no_base_editor_refs?.length) {
    const into_ = (into.merge_no_base_editor_refs ??= []);
    for (const r of from.merge_no_base_editor_refs) {
      if (into_.length >= NO_BASE_EDITOR_REF_CAP) break;
      into_.push(r);
    }
  }
  into.ref_moved_ours += from.ref_moved_ours ?? 0;
  into.ref_moved_ours_conflict += from.ref_moved_ours_conflict ?? 0;
  into.ref_moved_theirs += from.ref_moved_theirs ?? 0;
  into.ref_moved_both += from.ref_moved_both ?? 0;
  into.ref_moved_unattributable += from.ref_moved_unattributable ?? 0;
  into.ref_moved_resolved += from.ref_moved_resolved ?? 0;
  into.merge_unavailable += from.merge_unavailable ?? 0;
  into.merge_cosmetic_ignored += from.merge_cosmetic_ignored ?? 0;
  into.own_publish_converged += from.own_publish_converged ?? 0;
  into.merge_record_failed = Boolean(into.merge_record_failed || from.merge_record_failed);
  into.apply_incomplete = Boolean(into.apply_incomplete || from.apply_incomplete);
  into.dcs_404 += from.dcs_404;
  if (from.errors.length) into.errors.push(...from.errors);
}

// Recompute + persist canonical TWL sort_order for a whole book from the CURRENT
// ULT alignment — the SAME diff the nightly export computes
// (computeTwlSortOrderUpdates). TWL order is derived from ULT word position, not
// preserved: classifyReimportRow deliberately no-ops a content-identical twl row's
// sort_order (the HOS reorder-revert fix), so canonical order is owned here.
// Verses locked in twl_order_locks (a translator manually reordered them) are
// excluded — their stored sort_order stands untouched. Positional metadata
// only — never touches content/updated_by, never logs edit history; idempotent
// (empty diff when already canonical). Callers must have ULT verses current in
// D1 first. Returns the number of rows re-sequenced.
async function canonicalizeTwlOrder(env: Env, book: string): Promise<number> {
  const twlRows = await env.DB.prepare(
    `SELECT * FROM twl_rows WHERE book = ?1 AND deleted_at IS NULL
     ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
  )
    .bind(book)
    .all<TwlRow>();
  const ultVerses = await env.DB.prepare(
    `SELECT * FROM verses WHERE book = ?1 AND bible_version = 'ULT'
     ORDER BY chapter, verse`,
  )
    .bind(book)
    .all<VerseRow>();
  // Independent reads — awaiting them in the argument list would serialize two
  // D1 round-trips per book for no reason.
  const [twTitles, lockedVerses] = await Promise.all([
    loadTwTitles(env.DB),
    loadTwlOrderLocks(env.DB, book),
  ]);
  const updates = computeTwlSortOrderUpdates(
    twlRows.results,
    ultVerses.results,
    twTitles,
    lockedVerses,
  );
  await applyTwlSortOrderUpdates(env.DB, book, updates);
  return updates.length;
}

export class BookNotImportedError extends Error {
  book: string;
  constructor(book: string) {
    super(`book not imported: ${book}`);
    this.book = book;
  }
}

export class ImportInProgressError extends Error {
  book: string;
  constructor(book: string) {
    super(`import in progress for ${book}`);
    this.book = book;
  }
}

export async function reimportBookFromDcs(
  env: Env,
  book: string,
  chapters: number[],
  resources: Resource[],
  userId: number | null,
  _opts: { source: "user" | "cron" },
): Promise<ReimportResult> {
  const urls = dcsUrls(env, book);
  if (!urls) throw new Error(`unknown book: ${book}`);

  // Re-import is the maintenance lane — book must already be bootstrapped.
  // The first-time path (bookImport.ts POST /:book/import) handles the
  // wipe-and-load case; re-running it post-edits would clobber everything.
  const imported = await env.DB.prepare(
    `SELECT 1 FROM book_imports WHERE book = ?1`,
  )
    .bind(book)
    .first();
  if (!imported) throw new BookNotImportedError(book);

  // Reuse the per-book lock (same table the first-time import uses + the
  // */5 stale sweep cleans up). A second concurrent re-import on the same
  // book gets a 409 from the caller. A first-time import racing a re-import
  // on the same book is also blocked — that's the safe answer.
  const startedAt = Math.floor(Date.now() / 1000);
  const lock = await env.DB.prepare(
    `INSERT OR IGNORE INTO book_import_locks (book, started_at, started_by)
     VALUES (?1, ?2, ?3)`,
  )
    .bind(book, startedAt, userId)
    .run();
  if (!lock.meta.changes) throw new ImportInProgressError(book);

  try {
    return await runReimport(env, book, chapters, resources, userId);
  } finally {
    await env.DB.prepare(`DELETE FROM book_import_locks WHERE book = ?1`)
      .bind(book)
      .run();
  }
}

async function runReimport(
  env: Env,
  book: string,
  chapters: number[],
  resources: Resource[],
  userId: number | null,
): Promise<ReimportResult> {
  const urls = dcsUrls(env, book)!;

  // Fetch each requested resource once at the book level. ULT/UST/TN/TQ/TWL
  // are whole-book files; chapter filtering happens after parse.
  const want = new Set(resources);
  // TSV resources go through fetchTsvMasterVerified (issue #485, second P1
  // follow-up) rather than plain fetchText: softDeleteRemovedTsvRows' widened
  // coveredChapters needs to know whether THIS fetch carried the independent
  // completeness proof fetchDcsMasterText provides — see fetchTsvMasterVerified
  // and softDeleteRemovedTsvRows for the full rationale. ULT/UST stay on
  // fetchText: verses are never row-pruned by chapter absence, so there is
  // nothing here that needs the stronger guarantee.
  const tnFile = dcsResourceFile(book, "tn");
  const tqFile = dcsResourceFile(book, "tq");
  const twlFile = dcsResourceFile(book, "twl");
  const [ultRaw, ustRaw, tnFetch, tqFetch, twlFetch] = await Promise.all([
    want.has("ult") ? fetchText(urls.ult) : Promise.resolve(null),
    want.has("ust") ? fetchText(urls.ust) : Promise.resolve(null),
    want.has("tn") && tnFile
      ? fetchTsvMasterVerified(env, tnFile.repo, tnFile.path)
      : Promise.resolve({ raw: null, verifiedComplete: false }),
    want.has("tq") && tqFile
      ? fetchTsvMasterVerified(env, tqFile.repo, tqFile.path)
      : Promise.resolve({ raw: null, verifiedComplete: false }),
    want.has("twl") && twlFile
      ? fetchTsvMasterVerified(env, twlFile.repo, twlFile.path)
      : Promise.resolve({ raw: null, verifiedComplete: false }),
  ]);
  let tnRaw = tnFetch.raw;
  let tqRaw = tqFetch.raw;
  let twlRaw = twlFetch.raw;
  // Tracks whether the (possibly still-live) raw text above carries the
  // positive completeness proof — read by softDeleteRemovedTsvRows below.
  // tsvFetchLooksTruncated nulling `raw` out (just below) makes these moot for
  // that resource (the prune loop already skips a null raw), so they don't
  // need to be reset in lockstep.
  const tnVerifiedComplete = tnFetch.verifiedComplete;
  const tqVerifiedComplete = tqFetch.verifiedComplete;
  const twlVerifiedComplete = twlFetch.verifiedComplete;

  // Completeness gate (TSV only). A truncated master fetch that slipped past
  // fetchText (e.g. a no-Content-Length partial body — the HAB tn incident)
  // parses to far fewer rows than the book holds live in D1. Treat it as
  // not-fetched so it can't drive the apply OR the prune; the existing dcs_404
  // tally below records the miss. Verses are exempt (never row-pruned; a short
  // USFM just no-ops its missing chapters).
  if (tnRaw && (await tsvFetchLooksTruncated(env, book, "tn", tnRaw))) tnRaw = null;
  if (tqRaw && (await tsvFetchLooksTruncated(env, book, "tq", tqRaw))) tqRaw = null;
  if (twlRaw && (await tsvFetchLooksTruncated(env, book, "twl", twlRaw))) twlRaw = null;

  const perResource: Record<Resource, ReimportCounts> = {
    ult: zeroCounts(),
    ust: zeroCounts(),
    tn: zeroCounts(),
    tq: zeroCounts(),
    twl: zeroCounts(),
  };
  const totals = zeroCounts();

  // Mark DCS-missing resources up front (one 404 per requested resource,
  // not per chapter). If a resource wasn't requested, leave counts at zero.
  if (want.has("ult") && !ultRaw) perResource.ult.dcs_404++;
  if (want.has("ust") && !ustRaw) perResource.ust.dcs_404++;
  if (want.has("tn") && !tnRaw) perResource.tn.dcs_404++;
  if (want.has("tq") && !tqRaw) perResource.tq.dcs_404++;
  if (want.has("twl") && !twlRaw) perResource.twl.dcs_404++;

  // Own-publish recognition on the user/admin "Pull from Door43" route (see
  // ownPublish.ts / the AMOS revert this fixes). This path runs the identical
  // per-verse merge as the nightly cron and could revert an app edit the same
  // way, so it needs the same corrected merge ancestor.
  //
  // DELIBERATELY WEAKER THAN THE NIGHTLY PATH: this only advances the watermark,
  // it does NOT skip the resource. A human explicitly asked to pull master, and
  // "recognized, so we did nothing" both violates that request and removes a real
  // capability — pulling master is how a bad D1 state gets restored from the last
  // good published render, and pristine/AI-owned rows are refreshed from master by
  // the normal row loop below. Skipping here would silently disable that repair
  // route during the window before the next export push. Stamping alone is enough
  // for the attribution the bug was about: with the ancestor corrected to the
  // render master actually holds, an edited verse gets `keep_master_unchanged`
  // instead of `adopt_conflict`, so the app edit survives while pristine rows
  // still refresh. Every other guard in this system offers a human an override;
  // this path IS the human, so it gets the correction without the veto.
  //
  // This now protects BOTH merges. PR #444 added the TSV three-way merge for
  // edited tn/tq/twl rows (tsvMerge.ts), and it reads the SAME ancestor cutoff —
  // reconstructTsvBases folds edit_log up to `created_at < master_confirmed_at`.
  // So the stale watermark this PR fixes was silently breaking that merge in
  // exactly the same way it broke the verse merge: our own merged export read as
  // a foreign edit, and an app-edited note/question/link overwritten by
  // `adopt_conflict`. The stamp below lands BEFORE the getMasterConfirmedAt reads
  // for all five resources, which is why it must stay above them.
  //
  // Runs AFTER the dcs_404 tally above (recognition must not affect what is
  // reported missing) and BEFORE the ancestor-cutoff reads below, which is the
  // whole point — those reads must see the advanced watermark. `masterSha` is not
  // available on this route (no SHA gate here), so source_sha is left untouched.
  // Read-only view of this run's fetched files — recognition never rewrites them
  // (that is the nightly path's behavior, deliberately not this one), so a plain
  // snapshot is enough and the raw variables below stay the single source of truth.
  const fetchedRaw: Record<Resource, string | null> = {
    ult: ultRaw, ust: ustRaw, tn: tnRaw, tq: tqRaw, twl: twlRaw,
  };
  // Which resources still need a "who moved master" walk (#540 item 1). Recorded
  // here rather than fetched here: the walk is bounded by this pair's
  // `master_confirmed_at`, which is read below — and it must be read AFTER the
  // own-publish stamp lands, or the walk would start from a watermark this run
  // has already superseded. A resource recognized as our own publish is skipped
  // entirely: recognition means master did not move under us at all.
  const needsLineage = new Set<Resource>();
  for (const resource of ALL_RESOURCES) {
    const raw = fetchedRaw[resource];
    if (!want.has(resource) || raw == null) continue;
    const state = await resourceSyncState(env, book, resource);
    const own = await recognizePushedRender(env, book, resource, raw, state);
    if (!own.recognized) {
      needsLineage.add(resource);
      continue;
    }
    const stamped = await markOwnPublishConverged(env, book, resource, own.readAt, state.pushedEditId, null);
    if (stamped) perResource[resource].own_publish_converged++;
    console.log("reimport recognized master's movement as our own publish", {
      book,
      resource,
      confirmedAt: own.readAt,
      stamped,
      skipped: false,
    });
  }

  // FIX 1 (hoist): read the verse-merge ancestor cutoff ONCE per (book,
  // resource) for this whole run, not once per chapter — see
  // getMasterConfirmedAt. 2 reads total for this run (ult + ust), down from
  // one per chapter.
  // Carries this run's lineage alongside the cutoff — one object per pair, so a
  // merge call site cannot receive an ancestor without the attribution that goes
  // with it, and so the walk is bounded by the very watermark the ancestor is
  // reconstructed from (see loadMasterLineage).
  const withLineage = async (cutoff: MergeCutoff | null, resource: Resource): Promise<MergeCutoff | null> => {
    if (cutoff == null) return null;
    const lineage = needsLineage.has(resource)
      ? await loadMasterLineage(env, book, resource, cutoff.confirmedAt)
      : null;
    return { ...cutoff, lineage };
  };

  const masterConfirmedAtUlt = await withLineage(
    want.has("ult") && ultRaw ? await getMasterConfirmedAt(env, book, "ult") : null,
    "ult",
  );
  const masterConfirmedAtUst = await withLineage(
    want.has("ust") && ustRaw ? await getMasterConfirmedAt(env, book, "ust") : null,
    "ust",
  );
  // TSV merge ancestor cutoffs — same once-per-run hoist as ult/ust above (the
  // three-way merge for edited tn/tq/twl rows reads this in applyTsvRows). NULL
  // means this (book, resource) has never been positively confirmed on master,
  // so the merge stays inert and edited rows behave exactly as before.
  const masterConfirmedAtTn = await withLineage(
    want.has("tn") && tnRaw ? await getMasterConfirmedAt(env, book, "tn") : null,
    "tn",
  );
  const masterConfirmedAtTq = await withLineage(
    want.has("tq") && tqRaw ? await getMasterConfirmedAt(env, book, "tq") : null,
    "tq",
  );
  const masterConfirmedAtTwl = await withLineage(
    want.has("twl") && twlRaw ? await getMasterConfirmedAt(env, book, "twl") : null,
    "twl",
  );

  // P2.5 (subrequest budget): apply the TSV resources at the BOOK level, not per
  // chapter. The three-way merge for edited tn/tq/twl rows does one batched
  // edit_log read (reconstructTsvBases) per applyTsvRows call; calling it once per
  // chapter meant one such read per chapter with edited candidates, and this
  // (unchunked) full-book path — the user "Pull from Door43" route AND the
  // post-export reimport (postExport.ts submits every chapter) — was already near
  // the ~1000-subrequest cap on the largest books (PSA ~151 ch). applyTsvRows is
  // chapter-independent (makeVerseSortOrder is a per-verse ordinal; tnContentKey
  // includes chapter/verse so book-scope dedup is identical to per-chapter), so
  // one call over all non-locked chapters' rows yields the same result at a fixed
  // read cost. Verses stay per-chapter: applyVerseRows folds its ancestor via a
  // sub-select in the row read (no separate reconstruction read to hoist).
  const nonLockedChapters = new Set<number>();
  for (const chapter of chapters) {
    const lock = await activePipelineForChapter(env, book, chapter);
    if (lock) {
      for (const r of resources) {
        perResource[r].skipped_locked++;
        perResource[r].chapters_locked++;
      }
      continue;
    }
    nonLockedChapters.add(chapter);

    if (want.has("ult") && ultRaw) {
      const c = await reimportVersesForChapter(env, book, chapter, ultRaw, "ULT", userId, masterConfirmedAtUlt);
      addCounts(perResource.ult, c);
    }
    if (want.has("ust") && ustRaw) {
      const c = await reimportVersesForChapter(env, book, chapter, ustRaw, "UST", userId, masterConfirmedAtUst);
      addCounts(perResource.ust, c);
    }
  }

  // Parse each TSV file ONCE and collect the rows for the non-locked requested
  // chapters, then a single applyTsvRows per kind. Parsing once (not once per
  // chapter, as the old rowsForChapter loop did) also drops the repeated
  // whole-file parseTsv the chunked path already avoids for the same CPU reason.
  const collectTsvRows = (raw: string, kind: TsvKind): ParsedTsvRow[] => {
    const rows: ParsedTsvRow[] = [];
    for (const r of parseTsv(raw).rows) {
      const p = parseTsvRow(r, kind);
      if (p && nonLockedChapters.has(p.chapter)) rows.push(p);
    }
    return rows;
  };
  if (want.has("tn") && tnRaw) {
    addCounts(perResource.tn, await applyTsvRows(env, book, "tn", collectTsvRows(tnRaw, "tn"), userId, masterConfirmedAtTn));
  }
  if (want.has("tq") && tqRaw) {
    addCounts(perResource.tq, await applyTsvRows(env, book, "tq", collectTsvRows(tqRaw, "tq"), userId, masterConfirmedAtTq));
  }
  if (want.has("twl") && twlRaw) {
    addCounts(perResource.twl, await applyTsvRows(env, book, "twl", collectTsvRows(twlRaw, "twl"), userId, masterConfirmedAtTwl));
  }

  // Issue #427, option 3: sweep tombstones whose id no longer appears
  // anywhere in master's file for this book — see sweepObsoleteTombstones for
  // why this is disjoint from applyTsvRows' own tombstone branch above. Runs
  // against the WHOLE book's raw text (not `collectTsvRows`' nonLockedChapters
  // filter) — a locked chapter's rows are still on master, just not applied
  // to D1 this run, and still count as "present" for sweep purposes.
  if (want.has("tn") && tnRaw) {
    const res = await sweepObsoleteTombstones(env, book, "tn", tnRaw, tnVerifiedComplete);
    if (res.swept > 0) console.log("reimport swept obsolete tn tombstones", { book, swept: res.swept });
  }
  if (want.has("tq") && tqRaw) {
    const res = await sweepObsoleteTombstones(env, book, "tq", tqRaw, tqVerifiedComplete);
    if (res.swept > 0) console.log("reimport swept obsolete tq tombstones", { book, swept: res.swept });
  }
  if (want.has("twl") && twlRaw) {
    const res = await sweepObsoleteTombstones(env, book, "twl", twlRaw, twlVerifiedComplete);
    if (res.swept > 0) console.log("reimport swept obsolete twl tombstones", { book, swept: res.swept });
  }

  // FIX 4: fire the verse-merge-conflict banner once per (book, resource) for
  // this whole run, not once per chapter (a per-chapter DELETE-then-INSERT
  // alert would have chapter N's alert erase chapter N-1's — see
  // raiseVerseMergeConflictAlert's own comment). It derives its content by
  // reading verse_merge_conflicts directly, so it also reports conflicts that
  // survived from an earlier run.
  if (want.has("ult")) {
    await raiseVerseMergeConflictAlert(env, book, "ult", {
      recordingFailed: perResource.ult.merge_record_failed === true,
      noBaseCount: perResource.ult.merge_no_base,
      noBaseRefs: perResource.ult.merge_no_base_refs,
      noBaseEditorRefs: perResource.ult.merge_no_base_editor_refs,
    });
  }
  if (want.has("ust")) {
    await raiseVerseMergeConflictAlert(env, book, "ust", {
      recordingFailed: perResource.ust.merge_record_failed === true,
      noBaseCount: perResource.ust.merge_no_base,
      noBaseRefs: perResource.ust.merge_no_base_refs,
      noBaseEditorRefs: perResource.ust.merge_no_base_editor_refs,
    });
  }

  // Soft-delete pristine rows whose ids master no longer carries — for the
  // chapters this run touched. The nightly runChunkedReimport already does
  // this; the user-triggered path must too, or an out-of-band master deletion
  // (e.g. a Zulip-run AI rewrite that replaced a verse's notes with new ids,
  // imported via this route) leaves the old ids orphaned in D1 with no human
  // edit to protect them — they then export back onto master as resurrected
  // rows. softDeleteRemovedTsvRows compares against the WHOLE file's id set and
  // only touches pristine rows in covered chapters (see its guardrails).
  const tsvRawByKind: Record<TsvKind, string | null> = { tn: tnRaw, tq: tqRaw, twl: twlRaw };
  const tsvVerifiedByKind: Record<TsvKind, boolean> = {
    tn: tnVerifiedComplete,
    tq: tqVerifiedComplete,
    twl: twlVerifiedComplete,
  };
  for (const kind of ["tn", "tq", "twl"] as TsvKind[]) {
    const raw = tsvRawByKind[kind];
    if (!want.has(kind) || !raw) continue;
    try {
      const res = await softDeleteRemovedTsvRows(env, book, kind, raw, chapters, tsvVerifiedByKind[kind]);
      perResource[kind].deleted += res.deleted;
      perResource[kind].skipped_locked += res.skippedLocked;
    } catch (e) {
      perResource[kind].errors.push(`${kind} prune: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Canonical TWL order post-pass. classifyReimportRow deliberately PRESERVES a
  // content-identical twl row's local sort_order (the HOS reorder-revert fix), so
  // a content-identical-but-misordered file never adopts canonical order through
  // the row loop. Order is instead owned by this pass: now that D1's ULT verses
  // are current (all resources applied above), recompute the ULT-position
  // ordering — the SAME diff the nightly export computes
  // (computeTwlSortOrderUpdates) — and write it. Reads twl rows + ULT from D1 (no
  // dependency on twlRaw), so it also runs on a ULT-ONLY import: re-aligning the
  // ULT changes the canonical order, and D1's twl sort_order must follow. Mirrors
  // the nightly `twl || ult` gate.
  if (want.has("twl") || want.has("ult")) {
    try {
      perResource.twl.twl_reordered += await canonicalizeTwlOrder(env, book);
    } catch (e) {
      perResource.twl.errors.push(`twl canonical order: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  for (const r of resources) addCounts(totals, perResource[r]);

  return { book, perResource, totals };
}

// ── TSV resources (tn / tq / twl) ──────────────────────────────────────────

type TsvKind = "tn" | "tq" | "twl";

interface ParsedTsvRow {
  id: string;
  // True when `id` is NOT master's literal ID — parseTsvRow rewrote a malformed
  // one through coerceRowId (rowId.ts). Issue #427: this must suppress the
  // tombstone/conflict *blocked* counters. coerceRowId hashes into a 96-ID
  // space, so two different malformed master IDs can legitimately land on the
  // same coerced value, and a coerced ID can land on an unrelated tombstone.
  // Neither is "master reissued this ID to a different row" — the coerced ID was
  // never the row's identity in the first place, so the reissue inference is
  // meaningless for it. Counting those as blocked would withhold the watermark,
  // and that withhold has no automatic release (see raiseTombstoneBlockAlert),
  // so a documented-benign coercion no-op would freeze the book's export.
  idCoerced?: boolean;
  refRaw: string;
  chapter: number;
  verse: number;
  occurrence: number | null;
  tags: string | null;
  // tn-specific
  support_reference?: string | null;
  quote?: string | null;
  note?: string | null;
  // tq-specific
  question?: string | null;
  response?: string | null;
  // twl-specific
  orig_words?: string | null;
  tw_link?: string | null;
}

// Normalize one raw TSV record into a ParsedTsvRow (no chapter filter). Shared
// by the reimport row loops (runReimport's collectTsvRows + reimportStagedChunk)
// and changedTsvChapters (the diff gate) so they agree exactly on field
// normalization — otherwise the gate could mis-classify a chapter as unchanged.
// Returns null for a row with no ID.
function parseTsvRow(r: Record<string, string>, kind: TsvKind): ParsedTsvRow | null {
  const rawId = r["ID"];
  if (!rawId) return null;
  // Guard 1 (defense-in-depth): coerce a malformed master id (e.g. the
  // digit-first ids an old newRowId bug minted before PR #225) to a valid one
  // BEFORE it's used anywhere. Coercing in this single shared normalizer is what
  // keeps the three reimport consumers consistent — the apply path's by-id read,
  // the diff gate (changedTsvChapters), and the prune (softDeleteRemovedTsvRows)
  // all see the SAME coerced id, so an inserted-under-coerced-id row is never
  // mistaken by the prune for a row master "no longer carries" and deleted. The
  // coercion is deterministic, so it's idempotent across nights and a no-op for
  // every well-formed id. (storedTsvRowToParsed deliberately does NOT coerce, so
  // a legacy bad id already in D1 mismatches the coerced incoming id, re-runs the
  // chapter, and self-heals: insert coerced + prune removes the stale raw id.)
  const id = coerceRowId(rawId);
  const refRaw = r["Reference"] ?? "";
  const [ch, v] = refParts(refRaw);
  const occRaw = r["Occurrence"];
  const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
  const base: ParsedTsvRow = {
    id,
    // Record that the id is ours, not master's — see ParsedTsvRow.idCoerced.
    // coerceRowId is a strict no-op for a well-formed id, so this is false for
    // essentially every real row.
    idCoerced: id !== rawId,
    refRaw,
    chapter: ch,
    verse: v,
    occurrence,
    tags: r["Tags"] || null,
  };
  if (kind === "tn") {
    base.support_reference = r["SupportReference"] || null;
    base.quote = r["Quote"] || null;
    base.note = r["Note"] || null;
  } else if (kind === "tq") {
    base.quote = r["Quote"] || null;
    base.question = r["Question"] || null;
    base.response = r["Response"] || null;
  } else {
    base.orig_words = r["OrigWords"] || null;
    base.tw_link = r["TWLink"] || null;
  }
  return base;
}


// Upsert already-parsed TSV rows (any chapters). Batched to stay under the
// per-invocation subrequest cap: ONE chunked read of the current rows, an
// in-memory diff, then env.DB.batch() of the pristine UPDATEs (+ their edit_log
// rows). New rows are rare in a reimport, so inserts stay a per-row path. The
// old per-row UPDATE loop issued ~5 D1 calls per row and blew the 10k cap on
// large books — DO NOT revert it (PR #180 batched this; a later refactor
// reverted it; PR #195 re-batched). See the nightly-sync-subrequest-cap memory.
//
// sort_order is a per-verse ordinal (makeVerseSortOrder): deterministic and
// chunk-independent, so an unchanged DCS file produces no churn; a reordered/
// extended verse renumbers only that verse. `incoming` is the chapter's rows in
// file order, so the ordinal tracks source order exactly. The pristine guard +
// version-CAS stay ON each UPDATE, so a translator edit landing between the read
// and the batch matches 0 rows (no clobber) and is counted skipped_edited.
// Exported for the integration test ONLY (reimportJourney.test.mjs). Issue #427:
// the tombstone-collision claims were previously asserted by a test that
// hand-copied this function's SQL, which proves nothing if the real SQL later
// drifts — notably the `existing` read's deliberate absence of a
// `deleted_at IS NULL` filter, which is the whole reason a tombstoned id reaches
// the tombstone branch instead of the insert. Driving the real function is what
// makes that claim drift-detecting. Not part of the module's public API.
export async function applyTsvRows(
  env: Env,
  book: string,
  kind: TsvKind,
  incoming: ParsedTsvRow[],
  userId: number | null,
  // Three-way merge ancestor cutoff for this (book, resource), hoisted once per
  // run by the caller (getMasterConfirmedAt). `confirmedAt` NULL — or the whole
  // object null (resource not present this run) — means never positively
  // confirmed on master: the three-way merge for edited rows stays inert and
  // they fall back to the pre-existing ancestor-free computeEditedFieldMerge,
  // exactly as before. `editId` (P1.3) is the precise id boundary when present.
  cutoff: MergeCutoff | null = null,
): Promise<ReimportCounts> {
  const counts = zeroCounts();
  if (incoming.length === 0) return counts;
  const now = Math.floor(Date.now() / 1000);
  const masterConfirmedAt = cutoff?.confirmedAt ?? null;
  const masterEditId = cutoff?.editId ?? null;

  // One read of the comparable + pristine-predicate columns for the incoming
  // ids (chunked under the 100 bound-param limit) so classification is in memory.
  const pristineCols =
    kind === "tn"
      ? "version, updated_by, deleted_at, trashed_at, preserve, hint"
      : "version, updated_by, deleted_at";
  const existing = new Map<string, Record<string, unknown>>();
  const ids = incoming.map((r) => r.id);
  for (let i = 0; i < ids.length; i += WRITE_BATCH) {
    const slice = ids.slice(i, i + WRITE_BATCH);
    // ?1 = book, ?2 = kind (edit_log.kind = the resource name), ids from ?3.
    const inClause = slice.map((_, j) => `?${j + 3}`).join(", ");
    // latest_source: source of the latest content-bearing edit_log entry, so we
    // can tell an AI-only row (updated_by set, latest source = ai_pipeline) apart
    // from a human edit. Mirrors the deleteUnkeptTns correlated subquery.
    const rs = await env.DB.prepare(
      // review_reason is selected alongside review_kind because two flag writers
      // below compare against it to avoid re-writing an identical message every
      // night — and a version bump is not free (#539). Without the column those
      // comparisons run against `undefined` and never short-circuit.
      `SELECT id, ${TSV_STORED_COLS[kind]}, sort_order, ${pristineCols}, review_kind, review_reason,
              (SELECT source FROM edit_log
                 WHERE kind = ?2 AND row_key = ${kind}_rows.id
                   AND (book = ?1 OR book IS NULL)
                   AND action IN ('create', 'update')
                 ORDER BY id DESC LIMIT 1) AS latest_source
         FROM ${kind}_rows WHERE book = ?1 AND id IN (${inClause})`,
    )
      .bind(book, kind, ...slice)
      .all<Record<string, unknown>>();
    for (const row of rs.results) existing.set(String(row.id), row);
  }

  // Guard 2 (defense-in-depth, TN only): content-dedup. Prevents the AI-note
  // duplication round-trip (see tnDedup.ts). Decide up front which insert
  // candidates duplicate a row that will already exist LIVE + PRISTINE under a
  // different id — the decision is pure (no extra D1 read), off the by-id
  // `existing` map we just loaded.
  let skipDupIdx = new Set<number>();
  if (kind === "tn") {
    const existsAnyId = new Set(existing.keys());
    const existsPristineId = new Set(
      [...existing].filter(([, cur]) => isPristineTsv(kind, cur)).map(([id]) => id),
    );
    skipDupIdx = planTnContentDedup(incoming, existsPristineId, existsAnyId);
  }

  // Classify. Inserts run per-row (DCS-new rows are rare); updates +
  // resurrections are batched.
  const nextSort = makeVerseSortOrder();
  const updates: Array<{ row: ParsedTsvRow; sortOrder: number; oldVersion: number }> = [];
  // AI-only rows to re-seed from master AND reclaim to master-owned (updated_by
  // → NULL). Written under a relaxed guard (version-CAS + protection re-assert)
  // in their own batch so the pristine UPDATE's `updated_by IS NULL` guard stays
  // untouched. Counted `reimported_ai`.
  const aiReseeds: Array<{ row: ParsedTsvRow; sortOrder: number; oldVersion: number }> = [];
  const resurrects: Array<{ row: ParsedTsvRow; sortOrder: number; oldVersion: number }> = [];
  // Issue #427, option 1: reissued tombstones whose slot master's row will
  // reclaim. Deliberately its OWN array, not folded into `resurrects` — reclaim
  // is semantically different (see the tombstone branch below and the "Batch
  // the reclaims" write site): resurrect only fires for a narrow self-heal case
  // (pristine content AND the last delete was a reimport prune bug) and keeps
  // the pristine guard (trashed_at/preserve/hint); reclaim fires for ANY
  // tombstone regardless of how/why it was deleted, because the row being
  // written is a completely different logical entity from whatever the
  // tombstone used to protect.
  const reclaims: Array<{ row: ParsedTsvRow; sortOrder: number; oldVersion: number }> = [];
  // Rows classified "edited" (human-owned) that diverge from master. Deferred
  // and resolved AFTER this loop so the three-way-merge ancestor can be
  // reconstructed for all of them in ONE batched edit_log read
  // (reconstructTsvBases), not one read per row — the subrequest-budget
  // discipline this whole function exists for. Each resolves to either a merge
  // write (adopt master's field(s)) or a plain skipped_edited.
  const editedCandidates: Array<{ row: ParsedTsvRow; cur: Record<string, unknown> }> = [];
  // Ids of rows carrying a review_kind='ref_moved' flag that this run resolved:
  // master and D1 now agree on the reference, so the flag has nothing left to
  // report (issue #588). Collected rather than written inline for the same
  // subrequest-budget reason as every other array here, and written by its own
  // small batch below — deliberately NOT folded into `updates`, whose statement
  // adopts master's content and bumps the version.
  const flagClears: string[] = [];
  // Combined writes for edited rows: the union of the three-way merge's adopted
  // SUBSTANTIVE fields (tsvMerge.ts) and the ancestor-free computeEditedFieldMerge
  // fields (tags / whitespace-only note), plus review_kind/review_reason on a
  // both-sides-changed conflict. One write per row so two writers never race the
  // same version. version-CAS + re-asserted protections; updated_by untouched
  // (the row stays human-owned — the next sync then sees D1==master and no-ops).
  const editedWrites: Array<{
    id: string;
    oldVersion: number;
    chapter: number;
    verse: number;
    fields: Record<string, unknown>;
    conflict: boolean;
    // A substantive three-way adoption landed in this write (drives merge_adopted
    // + the lost-CAS watermark withhold).
    adopted: boolean;
    // The ancestor-free field merge (tags / whitespace note) contributed fields
    // to this write — tallied as merged_fields INDEPENDENTLY of adopted.
    heuristic: boolean;
    // A contested field on this row was kept from D1 because no human commit
    // was behind master's side (#540 item 2). Carried only so the adoption log
    // line can say a mixed row is mixed.
    keptAiConflict?: boolean;
  }> = [];
  // Ids this pass has already INSERTED. `existing` is read once, before the
  // loop, and is never updated afterwards — so if master's own file carries the
  // same id twice, the second occurrence still finds nothing in `existing`,
  // reaches the insert, and is refused by ON CONFLICT with 0 changes. That is a
  // duplicate id ON MASTER, not a primary-key collision with a tombstone, and it
  // must NOT be counted as conflict_skipped: conflict_skipped withholds the
  // watermark, and a duplicate id never clears by itself, so mislabelling it
  // would freeze that book's export indefinitely over a cosmetic condition the
  // old code (rightly) treated as harmless. This repo has shipped duplicated
  // master rows before (the ISA 48 delete+dup repair, the AI TN duplication
  // round-trip), so the case is real, not theoretical. Caught BEFORE the insert
  // so the two causes never share a counter.
  const insertedThisPass = new Set<string>();
  for (let i = 0; i < incoming.length; i++) {
    const row = incoming[i];
    const sortOrder = nextSort(row.chapter, row.verse);
    const cur = existing.get(row.id);
    if (!cur) {
      if (insertedThisPass.has(row.id)) {
        counts.skipped_dup++;
        console.warn("reimport: master file carries this id more than once", {
          book,
          resource: kind,
          id: row.id,
          ref: row.refRaw,
        });
        continue;
      }
      if (skipDupIdx.has(i)) {
        counts.skipped_dup++;
        console.warn("reimport: skipped duplicate-content tn row", {
          book,
          id: row.id,
          chapter: row.chapter,
          verse: row.verse,
        });
        continue;
      }
      try {
        const outcome = await tryInsertTsvRow(env, book, kind, row, sortOrder);
        if (outcome === "inserted") {
          counts.inserted++;
          insertedThisPass.add(row.id);
          await logEdit(env, kind, row.id, book, userId, null, 1, "create", row);
        } else if (outcome === "unknown") {
          // D1 reported no row count, so we do not know whether this row landed.
          // Do NOT call that a conflict: `conflict_skipped` withholds the
          // watermark and a mis-read here would freeze the book's export on a
          // run where nothing was wrong. Taint the run instead — same "absent
          // measurement must not be laundered into a value" rule the rest of
          // this file follows, applied in the red direction as well as the green.
          counts.counts_incomplete = true;
          console.warn("reimport: insert returned no row count — treating as unknown, not as a conflict", {
            book,
            resource: kind,
            id: row.id,
          });
        } else if (row.idCoerced) {
          // The (book, id) slot is taken, but this id is OURS — coerceRowId
          // rewrote a malformed master id into a 96-id space, so a collision
          // here says nothing about master reissuing anything. Documented-benign
          // no-op (see ParsedTsvRow.idCoerced); count it as a duplicate, never as
          // a blocked drop, or a coercion collision would freeze the export.
          counts.skipped_dup++;
          console.warn("reimport: coerced id collided — benign, not counted as blocked", {
            book,
            resource: kind,
            coercedId: row.id,
            ref: row.refRaw,
          });
        } else {
          // 0 rows written by `ON CONFLICT(id, book) DO NOTHING` on a row the
          // diff said to insert, and NOT a duplicate id within master's own file
          // (that is caught above). The (book, id) slot is held by something the
          // `existing` read didn't return — in practice a row created between
          // the read and this insert. Issue #427 — count it as a conflict skip
          // and let it withhold the watermark. The old code called this "raced"
          // and folded it into skipped_noop, which both asserted an unmeasured
          // cause and hid a real drop inside a benign counter.
          counts.conflict_skipped++;
          noteBlockedSample(counts, `${kind} ${row.id} @ ${row.refRaw} (id already taken)`);
        }
      } catch (e) {
        counts.errors.push(`${kind} ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }
    // Tombstone master still carries. Normally a deleted row stays dead — but an
    // erroneous earlier prune (the HAB tn truncated-fetch incident: a short
    // master fetch soft-deleted 559 pristine rows master never actually dropped)
    // leaves a row that should still exist. Resurrect ONLY a pristine tombstone
    // whose latest delete was a reimport prune (source='dcs_reimport'); a
    // human-deleted/trashed row (or any non-reimport delete) stays dead. Must run
    // BEFORE the no-op check below: a tombstone whose content already matches
    // master still needs deleted_at cleared, so it can never be a no-op. See
    // tsvFetchLooksTruncated — this is the self-heal half of the same fix (the
    // gate stops new damage; this revives rows a past truncation already killed).
    if (cur.deleted_at != null) {
      if (isPristineTombstone(kind, cur) && (await lastTsvDeleteWasReimport(env, kind, row.id, book))) {
        resurrects.push({ row, sortOrder, oldVersion: Number(cur.version) });
      } else if (
        // Issue #427, option 1. The tombstone keeps its (book, id) primary key
        // forever, so master's row for that id cannot land via the normal INSERT
        // path — and that is CORRECT when master still carries it at the same
        // reference (a delete awaiting export: reclaiming there would resurrect
        // every pending deletion on the next nightly run). When master carries it
        // at a DIFFERENT reference the id has been reissued to a genuinely
        // different row, and master is authoritative for a row it still carries
        // — so RECLAIM the slot (batched below) instead of dropping it.
        // `!row.idCoerced` first: for a coerced id the "master reissued this id
        // to a different row" inference is meaningless — the id is ours, hashed
        // into a 96-id space, so landing on an unrelated tombstone at a
        // different reference is an expected collision, not evidence master
        // moved anything. Reclaiming (or counting it blocked) would either
        // corrupt an unrelated row or freeze the export over a documented-benign
        // no-op. See ParsedTsvRow.idCoerced.
        !row.idCoerced &&
        isReissuedTombstone(
          { refRaw: (cur.ref_raw as string | null) ?? null, chapter: Number(cur.chapter), verse: Number(cur.verse) },
          { refRaw: row.refRaw, chapter: row.chapter, verse: row.verse },
        )
      ) {
        reclaims.push({ row, sortOrder, oldVersion: Number(cur.version) });
      } else {
        // Same-reference tombstone (a delete awaiting export) — stays dead,
        // exactly as before this fix. Not counted tombstone_blocked: that would
        // withhold the watermark for a condition that clears itself once
        // tonight's export runs.
        counts.skipped_edited++;
      }
      continue;
    }
    // Classify content vs sort_order independently. A divergent sort_order on a
    // content-identical tn/twl row that already carries an order is a local
    // in-app reorder (rows.ts writes sort_order via a non-versioning fast path);
    // order flows app→master via the nightly export, so we must NOT adopt
    // master's file order and revert it — the HOS 11 TN / HOS 12 TWL
    // reorder-revert bug. That preservation is SCOPED: tq has no in-app reorder
    // (master owns its order), and a NULL sort_order has no order to preserve
    // (it must still be repaired to file order). Both fall through to the normal
    // adopt-from-master path. See classifyReimportRow for the full rationale.
    // NOTE: for twl this only preserves the row through the loop; canonical
    // (ULT-position) order is (re)asserted afterwards by the twl canonical
    // post-pass in runReimport, which owns twl sort_order.
    const contentMatches =
      tsvRowSignature(kind, storedTsvRowToParsed(kind, cur)) === tsvRowSignature(kind, row);
    const sortMatches = (cur.sort_order == null ? null : Number(cur.sort_order)) === sortOrder;
    const preserveLocalOrder = (kind === "tn" || kind === "twl") && cur.sort_order != null;
    // "reimportable" spans pristine AND AI-only (see isReimportableRow); aiOnly
    // is the AI-only sub-case (updated_by set but latest edit_log source is AI).
    const reimportable = isReimportableRow({
      updated_by: cur.updated_by as number | null,
      latestSource: (cur.latest_source as string | null) ?? null,
      deleted_at: cur.deleted_at as number | null,
      trashed_at: cur.trashed_at as number | null,
      preserve: cur.preserve as number | null,
      hint: cur.hint as number | null,
      kind,
    });
    const aiOnly = reimportable && cur.updated_by != null;
    // Reorder interaction (by design, not a gap): a pure reorder writes only
    // sort_order via the rows.ts fast path — no version bump, no edit_log — so a
    // reordered AI row stays "AI-only". That's intended: reorder is transient
    // last-write-wins (rows.ts), and a HUMAN content edit is NOT transient — it
    // takes the versioning PATCH path, which logs a source=NULL edit_log row,
    // flipping isReimportableRow false (never re-seeded). For a content-IDENTICAL
    // reordered AI row, `contentMatches && preserveLocalOrder → noop` fires below
    // BEFORE the aiOnly re-seed, so the reorder is preserved (the reorder-revert
    // fix). Only a reordered AI row whose CONTENT also drifted on master takes
    // master wholesale (content + file order) — the re-seed we want.
    const fate = classifyReimportRow(contentMatches, sortMatches, reimportable, preserveLocalOrder, aiOnly);
    if (fate === "noop") {
      counts.skipped_noop++;
      // A resolved reference-move flag has to be cleared HERE, on the no-op path,
      // because this is where the resolved row actually lands (issue #588). Both
      // no-op shapes prove the references agree: tsvRowSignature covers
      // chapter/verse/ref_raw, so `contentMatches` is itself the measurement. And
      // a row whose reference AND content now match master is a no-op by
      // definition, so it never reaches the edited-candidate resolution below —
      // which is why clearing the flag only there (the first cut of this fix)
      // left the chip standing for every tn/twl row and for any tq row whose
      // sort_order happened to match file order.
      //
      // Deliberately NOT a normal write: no version bump and no edit_log entry,
      // matching the in-app acknowledgement in rows.ts ("no version bump, like a
      // bit-toggle"). Nothing about the row's content changed, and bumping the
      // version would invalidate an open editor's If-Match and cost a 409 for a
      // flag nobody needs to see. Guarded on 'ref_moved' so it can never drop an
      // unacknowledged merge_conflict / merge_kept / merge_no_base.
      //
      // Applies to protected tn rows (trashed/preserve/hint) too: the protections
      // exist to stop master overwriting CONTENT, and this write touches none —
      // while a preserved row is exactly the one nobody will edit again, so the
      // stale chip would otherwise be permanent.
      //
      // What this does NOT reach, and why that is survivable: the nightly staging
      // gate skips a whole (book, resource) whose Door43 file SHA is unchanged
      // (see reimportStagedChunk), so this code does not even run on a quiet
      // file. The route that leaves a flag stale WITHOUT touching master is a
      // translator moving the row in-app to match — and that move is a versioned
      // content PATCH, which clears review_kind at the moment it lands
      // (contentPatchClauses.ts). So the flag this branch exists for is one
      // resolved from master's side or raised over a reference that already
      // agreed; either way master moved, the SHA differs, and the resource is
      // staged. A flag left stale with neither side moving again clears on the
      // next manual "Pull from Door43", which reads every file unconditionally.
      if (cur.review_kind === "ref_moved") flagClears.push(row.id);
      continue;
    }
    if (fate === "edited") {
      // Human-owned and divergent. Defer — the three-way merge against the
      // reconstructed ancestor + the ancestor-free field merge both run after
      // the loop (resolveEditedCandidates), so the ancestor read is batched.
      editedCandidates.push({ row, cur });
      continue;
    }
    if (fate === "update_ai") {
      aiReseeds.push({ row, sortOrder, oldVersion: Number(cur.version) });
      continue;
    }
    updates.push({ row, sortOrder, oldVersion: Number(cur.version) });
  }

  // Resolve the deferred edited candidates (the whole point of this fix — an
  // out-of-band Door43 edit to an app-edited tn/tq/twl row must be ADOPTED or
  // flagged, never silently kept-and-reverted). Reconstruct the three-way-merge
  // ancestor for ALL of them in ONE batched edit_log read, then per row combine
  // the substantive three-way merge with the ancestor-free tags/whitespace merge
  // into a single write (so two writers never race one row's version).
  if (editedCandidates.length > 0) {
    // Ancestor is only recoverable once this (book, resource) has been
    // positively confirmed on master. Until then the three-way merge is inert
    // and rows fall back to computeEditedFieldMerge exactly as before this fix.
    const bases =
      masterConfirmedAt != null
        ? await reconstructTsvBases(env, book, kind, editedCandidates.map((c) => c.row.id), masterConfirmedAt, masterEditId)
        : new Map<string, TsvBaseRecord>();
    for (const { row, cur } of editedCandidates) {
      const fields: Record<string, unknown> = {};
      let conflict = false;
      let conflictFields: string[] = [];
      let adopted = false;
      // The conflict was resolved D1-wins because master's side had no human
      // commit behind it (#540 item 2) — the review message has to say that,
      // not the opposite.
      let keptAiConflict = false;

      // A human-protected tn row (preserve/hint/trashed — deleted_at is already
      // handled at the tombstone branch) must NEVER be overwritten from master,
      // exactly as computeEditedFieldMerge enforces for the heuristic path. The
      // three-way merge has no protection gate of its own, and buildTsvEditedWrite
      // Stmt's WHERE re-asserts these — so if we let a protected row become an
      // adopt, the write correctly 0-changes, but the lost-CAS branch below would
      // then read that as a race and set apply_incomplete FOREVER (re-staging the
      // whole resource nightly). Skip the three-way merge for a protected row so
      // it stays a clean skipped_edited, no watermark impact (cold-review #1).
      const protectedRow =
        kind === "tn" &&
        (cur.trashed_at != null || Number(cur.preserve ?? 0) !== 0 || Number(cur.hint ?? 0) !== 0);

      // (a) Substantive three-way merge (quote/note/support_reference /
      //     orig_words/tw_link/question/response), attributed against the
      //     reconstructed ancestor. Only when a watermark exists for this run.
      if (masterConfirmedAt != null && !protectedRow) {
        const merge = computeTsvMerge(
          kind,
          bases.get(row.id)?.content ?? null,
          parsedRowToMergeSide(kind, storedTsvRowToParsed(kind, cur)),
          parsedRowToMergeSide(kind, row),
          // #540 item 2. Always via the helper: an incomplete lineage walk must
          // protect master exactly like a found human commit, and only
          // masterMayHoldHumanEdit encodes that.
          { masterMayHoldHumanEdit: masterMayHoldHumanEdit(cutoff?.lineage) },
        );
        if (merge.action === "keep_no_base") {
          counts.merge_no_base++;
          // Issue #544: unlike the verse side, a keep_no_base tn/tq/twl row got
          // NO visible surface at all - merge_no_base is a shared counter with
          // no banner for TSV (see this field's own doc comment above), and
          // this table has no verse_merge_conflicts-style audit row either. Flag
          // the row itself (review_kind='merge_no_base'), the same cleanup-chip
          // mechanism lint.ts already surfaces every other TSV merge outcome
          // through. Only raise over nothing so we never overwrite a stronger
          // flag (ref_moved / merge_conflict) - ref_moved precedence - and so
          // re-running an unchanged sync never re-sets a field that's already
          // set (issue #539's version-inflation constraint). Cleared the normal
          // way: any human edit to the row clears review_kind (contentPatchClauses.ts).
          if (cur.review_kind == null) {
            fields.review_kind = "merge_no_base";
            fields.review_reason =
              "No earlier version of this row was recoverable, so an out-of-band Door43 edit (if any) could not " +
              "be checked against your change. Nothing has been overwritten - but if Door43 has changed this row, " +
              "tonight's export will still overwrite it unless you re-save it here.";
          }
        }
        // #540 item 2: both sides moved a field, and the lineage found no human
        // commit behind master's side, so D1 keeps that field. See the counter's
        // declaration for why this must never join merge_refused.
        if (merge.action === "keep_ai_master") {
          counts.merge_kept_ai++;
          keptAiConflict = true;
        }
        if (merge.adopt) {
          adopted = true;
          Object.assign(fields, merge.writeFields);
          // Occurrence is excluded from the field merge (renderOccurrence
          // coercion), but adopting a NEW quote/orig_words surface while keeping
          // D1's occurrence — chosen for the OLD surface — can synthesize an
          // invalid (surface, occurrence) pair that hard-rejects on export
          // (cold-review #2). When the surface is adopted, co-adopt master's
          // rendered occurrence: it is the matched pair DCS itself accepted.
          const surfaceField = kind === "twl" ? "orig_words" : "quote";
          if (surfaceField in fields) fields.occurrence = row.occurrence ?? null;
        }
        // OUTSIDE the `merge.adopt` branch deliberately. A collision needs a
        // human whichever side won it, and keep_ai_master can win one for D1
        // while writing no content field at all — nesting this under `adopt`
        // (as it was when adopt_conflict was the only conflicting outcome)
        // would drop the flag for exactly the rows this policy protects.
        if (merge.conflict) {
          conflict = true;
          conflictFields = merge.conflictFields;
        }
      }

      // (b) Ancestor-free field merge — tags (kind-specific rules) and
      //     whitespace-only note/question/response churn. Owns fields the
      //     three-way merge deliberately does not (tsvMerge.ts FIELDS_BY_KIND).
      const heur = computeEditedFieldMerge(
        kind,
        {
          tags: (cur.tags as string | null) ?? null,
          note: kind === "tn" ? ((cur.note as string | null) ?? null) : undefined,
          question: kind === "tq" ? ((cur.question as string | null) ?? null) : undefined,
          response: kind === "tq" ? ((cur.response as string | null) ?? null) : undefined,
        },
        {
          tags: row.tags,
          note: kind === "tn" ? (row.note ?? null) : undefined,
          question: kind === "tq" ? (row.question ?? null) : undefined,
          response: kind === "tq" ? (row.response ?? null) : undefined,
        },
        {
          deleted_at: cur.deleted_at as number | null,
          trashed_at: cur.trashed_at as number | null,
          preserve: cur.preserve as number | null,
          hint: cur.hint as number | null,
        },
      );
      // The two mergers own DISJOINT fields, so a key can't come from both — but
      // if a future field ever overlaps, the ancestor-attributed three-way value
      // wins (it is the stronger signal), so only add heuristic keys not present.
      let heuristic = false;
      if (heur) for (const [k, v] of Object.entries(heur)) if (!(k in fields)) { fields[k] = v; heuristic = true; }

      // This row's Reference differs between D1 and master (same id, different
      // chapter/verse/ref_raw). The field merge can't safely MOVE a row — a
      // chapter change relocates it out of the chapter this reimport is
      // processing and needs the quote re-anchored to the new verse's source (a
      // validated move, tracked as a follow-up, #454) — so a move is never
      // auto-adopted from master. What changes here (issue #540 item 3) is WHO
      // the difference is attributed to: this used to assume master moved it,
      // which is wrong exactly when the app moved it, and wrong in a
      // self-perpetuating way — the flag told the translator to undo her own
      // move, and apply_incomplete withheld the watermark so the export could
      // never ship it, so the same wrong flag returned every night (AMO tq,
      // blocked from 2026-08-17). See classifyTsvRefMove.
      const refBase = bases.get(row.id)?.ref ?? null;
      const refMove = classifyTsvRefMove(cur, row, refBase, protectedRow);
      // Do the two sides actually hold the same reference? Asked separately from
      // the attribution above, and with the protection argument forced off, so the
      // answer is a measurement even for a protected row (see the stale-flag clear
      // below, which is the only thing that needs it).
      const refsAgree = !tsvRefMoved(cur, row, false);
      // The surface field the content merge may have just adopted from master.
      // It matters to the reference decision: master's `occurrence` is co-adopted
      // with it (see block (a)) and is matched to MASTER's verse, so a row D1 has
      // re-anchored elsewhere would publish a surface+occurrence pair anchored to
      // the wrong verse.
      const surfaceField = kind === "twl" ? "orig_words" : "quote";
      const adoptedSurface = adopted && surfaceField in fields;

      // Only ever raise a ref_moved flag over nothing or over an existing
      // ref_moved. A `merge_conflict` set by the block below (or by a previous
      // run and not yet acknowledged) says something this one does not and must
      // not be silently replaced. Rewriting the reason only when it actually
      // changed keeps this from churning a version every night.
      const flagRefMoved = (reason: string): void => {
        if (cur.review_kind != null && cur.review_kind !== "ref_moved") return;
        if (cur.review_reason === reason) return;
        fields.review_kind = "ref_moved";
        fields.review_reason = reason;
      };

      if (refMove === "ours_moved" && !adoptedSurface) {
        // D1 moved, master still holds the ancestor, and master did not touch
        // the surface: an ordinary app edit the export exists to publish. No
        // flag, no hold. This is the ONE outcome that lets the export write over
        // master's location, so it is the only place a mis-attribution costs
        // data — and it is otherwise silent (no alert, and deliberately not in
        // the run summary, since a move we made is not something to review). Log
        // it so a wrong attribution is diagnosable from worker logs rather than
        // only from its damage. Capped: while one held row keeps the resource
        // stuck, every other moved row in the book would otherwise log nightly.
        if (counts.ref_moved_ours < REF_MOVE_LOG_CAP) {
          console.log("reimport: reference move attributed to the app; publishing it", {
            book,
            kind,
            id: row.id,
            ours: `${cur.chapter}:${cur.verse} ${(cur.ref_raw as string | null) ?? ""}`,
            theirs: `${row.chapter}:${row.verse} ${row.refRaw ?? ""}`,
            base: refBase,
          });
        }
        // Clear a flag a previous run raised by mis-attributing this same move —
        // otherwise the row keeps telling its author to undo work that was never
        // wrong. Once: the flag is gone next run, so it cannot churn versions.
        // Guarded on 'ref_moved', so it can never clear a merge_conflict.
        if (cur.review_kind === "ref_moved") {
          fields.review_kind = null;
          fields.review_reason = null;
        }
        counts.ref_moved_ours++;
      } else if (refsAgree && cur.review_kind === "ref_moved") {
        // The two sides AGREE now — the translator moved the row in-app to match
        // Door43, or master moved back — and a flag from an earlier run is still
        // sitting on the row — while some OTHER column still diverges, which is
        // what made this row an edited candidate rather than a no-op. (The
        // resolved-and-otherwise-identical row never reaches here; it is cleared
        // on the no-op path above, which is where it lands.) Before issue #588
        // neither site cleared it — the only clear lived in the `ours_moved`
        // branch — so a resolved reference kept its cleanup chip forever, reading
        // "Reference differs from Door43 — verify" with nothing left to differ and
        // no way to dismiss it (the tn/tq/twl save button is disabled unless the
        // row is dirty, so a translator cannot even produce the no-op re-save that
        // rows.ts accepts as an acknowledgement). Observed on AMO tq 3:14,
        // reported 2026-08-21.
        //
        // Guarded on 'ref_moved' exactly like the other clear, so it can never
        // drop an unacknowledged merge_conflict / merge_kept.
        //
        // The condition is MEASURED agreement (tsvRefMoved with the protection
        // argument forced off), not the classifier's "none". For a protected tn
        // row classifyTsvRefMove returns "none" by POLICY without comparing
        // anything, so keying on it would have to exclude protected rows to avoid
        // clearing a flag whose references still differ — and excluding them then
        // stranded the chip forever on exactly the rows nobody will edit again
        // (PR #589 review). Comparing the references directly separates the two
        // cases instead: agreement clears, disagreement falls through to the hold
        // below.
        //
        // A protected row's clear cannot ride the normal write: buildTsvEdited
        // WriteStmt's WHERE re-asserts `trashed_at IS NULL AND preserve = 0 AND
        // hint = 0`, so it would 0-change and then read as a lost CAS. Route it to
        // the same version-neutral statement the no-op path uses, which carries no
        // protection predicate because it writes no content.
        if (protectedRow) flagClears.push(row.id);
        else {
          fields.review_kind = null;
          fields.review_reason = null;
        }
      } else if (refMove !== "none") {
        // Everything else HOLDS: withhold the resource watermark
        // (apply_incomplete) so the export cannot write D1's location over
        // master, and flag the row for a human.
        //
        // `ours_moved` lands here too when master edited the surface in the same
        // window. That is a genuine two-sided change, not the livelock: block (a)
        // has no reference gate, so it has already adopted master's surface plus
        // master's occurrence, a pair anchored to master's verse rather than the
        // one D1 moved to. Publishing that would either mis-anchor the quote or
        // hard-reject on export (the occurrence column, per this repo's own
        // history). Holding is exactly what `main` did for this shape, so the
        // only behavior this change moves is the pure move — which is the
        // livelock and nothing else.
        counts.apply_incomplete = true;
        if (refMove === "ours_moved") counts.ref_moved_ours_conflict++;
        else if (refMove === "theirs_moved") counts.ref_moved_theirs++;
        else if (refMove === "both_moved") counts.ref_moved_both++;
        else counts.ref_moved_unattributable++;

        // Each message states only what was measured — "a Door43 editor moved
        // this" is a claim we may make only when the ancestor proves master is
        // the side that moved (the standing alert-wording rule). Each also has
        // to be honest about what actually RELEASES the hold: the export stays
        // withheld until this row's reference matches Door43's, so a message
        // offering a free choice ("pick the one you want") would promise a
        // resolution the system does not deliver.
        const hold = "Until this row's reference matches Door43's, this book's export stays on hold.";
        if (refMove === "ours_moved") {
          flagRefMoved(
            `You moved this row to a different verse/reference here, and Door43 edited its ` +
              `${surfaceField === "quote" ? "Quote" : "OrigWords"} in the same window. Door43's text was taken, ` +
              `but it is anchored to Door43's verse — check it against the verse you moved this to. ${hold}`,
          );
        } else if (refMove === "theirs_moved") {
          flagRefMoved(
            "A Door43 editor moved this row to a different verse/reference. " +
              `Move it here in the app to match. ${hold}`,
          );
        } else if (refMove === "both_moved") {
          flagRefMoved(
            "This row was moved to a different verse/reference here AND on Door43, to different places. " +
              `${hold} To publish yours instead, change it on Door43 as well.`,
          );
        } else if (masterConfirmedAt == null) {
          // No watermark at all: no ancestor was even looked up. Saying "the
          // edit history never captured it" would name a cause we never measured.
          flagRefMoved(
            `This row sits at a different verse/reference here than on Door43. This book's ${kind.toUpperCase()} ` +
              `file has not yet been confirmed as holding one of our exports, so the sync has no baseline to ` +
              `say which side moved. ${hold}`,
          );
        } else if (refBase == null) {
          // A watermark exists but no usable edit-history entry survives before
          // it — distinct from "an entry survives but never recorded this
          // column", which is the branch below.
          flagRefMoved(
            "This row sits at a different verse/reference here than on Door43, and no edit history survives " +
              `from before the last confirmed publish, so the sync cannot say which side moved. ${hold}`,
          );
        } else {
          flagRefMoved(
            "This row sits at a different verse/reference here than on Door43, and the recorded edit history " +
              `never captured the part of the reference that differs, so the sync cannot say which side ` +
              `moved. ${hold}`,
          );
        }
      }

      // A both-sides-changed conflict flags the row for in-app review (the
      // cleanup chip, lint.ts) — atomic with the content write, so the flag can
      // never be lost separately from the overwrite. The overwritten value is
      // retained in edit_log (recoverable by an admin) — worded without promising
      // a per-row history UI or naming internal columns (cold-review #5).
      //
      // Runs BEFORE the "nothing to write" bail below, because a keep_ai_master
      // conflict writes no content at all: leaving this where it was would have
      // counted exactly the rows this policy protects as a plain skipped_edited
      // and told nobody. It is also the ONLY write such a row makes, so it is
      // guarded against re-writing an identical message — a flag-only write still
      // bumps the row's version, and this condition recurs every night until a
      // human resolves it (#539).
      //
      // A row the reference-move branch just flagged and HELD keeps that flag:
      // the hold's message is the only thing telling the translator why this
      // whole book+resource has stopped exporting, and a kept-conflict message
      // that replaced it would both destroy that and describe an export that is
      // not going to run. Scoped to the kept case deliberately — a master-wins
      // adopt_conflict still overwrites the ref_moved flag exactly as before,
      // because it also overwrote content and that is the more urgent story.
      const heldByRefMove = keptAiConflict && fields.review_kind === "ref_moved";
      if (conflict && !heldByRefMove) {
        const labels = conflictFields.map((f) => TSV_FIELD_LABELS[f] ?? f);
        // Every clause here is bounded by what was actually measured, because
        // the cheap version of each is a claim this system cannot support:
        //  - "the note-writing pipeline" would be wrong — the `ai` rule matches
        //    the unfoldingWord bot ACCOUNT, which also pushes ULT/UST scripture
        //    and pushes on a named human's behalf (`ULT: EZK 38 [pjoakes]`).
        //  - "no Door43 editor edited this" would be wrong for the same shape: a
        //    maintainer may well have directed the change. What was measured is
        //    narrower — no commit came from a Door43 editor's own account.
        //  - "will be published" would be a promise this per-row code cannot
        //    keep. The export is withheld for the WHOLE book+resource by any
        //    held reference move, a lock, or a recording failure elsewhere in
        //    the same file, so "the next export that runs for this file" is the
        //    honest form.
        //  - "since the last sync" would be the wrong boundary: the walk starts
        //    at master_confirmed_at, the last publish positively confirmed on
        //    master, which can be several syncs back.
        // Outcome first, evidence second: the cleanup chip clamps this to two
        // lines (BookLintIndicator), so a reader who sees only the opening must
        // still learn which way it went and what to do about it.
        const kindLabel = kind.toUpperCase();
        const reason = keptAiConflict
          ? `Your ${labels.join(" and ")} was kept over Door43's, and the next export that runs for this ` +
            `file writes it to Door43. If Door43's version is the one you want, put it in here first. ` +
            `Why: both sides changed this row since the last confirmed publish, and every Door43 commit to ` +
            `this book's ${kindLabel} file since then came from Bible Editor's own export or the ` +
            `unfoldingWord bot account — no commit from a Door43 editor's own account was found.` +
            // A row can keep one contested field AND take another master moved
            // on its own. Saying only the first would misdescribe the row.
            (adopted ? ` Door43's changes to this row's other fields were taken.` : "")
          : `A Door43 edit to this row's ${labels.join(" and ")} was merged over your app-side change. ` +
            `Please double-check it.`;
        // Distinct review_kind, not just distinct prose: the cleanup chip titles
        // itself from this column, and "Merged Door43 edit" over a row whose
        // edit was KEPT is the reverse of what happened (see reviewFlagTitle).
        const reviewKind = keptAiConflict ? "merge_kept" : "merge_conflict";
        if (cur.review_kind !== reviewKind || cur.review_reason !== reason) {
          fields.review_kind = reviewKind;
          fields.review_reason = reason;
        }
      }

      if (Object.keys(fields).length === 0) {
        counts.skipped_edited++;
        continue;
      }
      editedWrites.push({
        id: row.id,
        oldVersion: Number(cur.version),
        chapter: row.chapter,
        verse: row.verse,
        fields,
        conflict,
        adopted,
        heuristic,
        keptAiConflict,
      });
    }
  }

  // Clear the reference-move flags this run resolved (issue #588). Its own tiny
  // batch, and deliberately the simplest statement in this function: it sets only
  // review_kind/review_reason, never touches content, never bumps `version`, and
  // writes no edit_log row — see the collection site for why. No version-CAS is
  // needed (there is no lost update to guard: the statement's own
  // `review_kind = 'ref_moved'` predicate means a concurrent write that replaced
  // the flag with a merge_conflict, or acknowledged it in-app, simply 0-changes),
  // and `deleted_at IS NULL` keeps it off a tombstone. A batch() error is
  // recorded and skipped: the flag is re-detected next run.
  for (let i = 0; i < flagClears.length; i += WRITE_BATCH) {
    const slice = flagClears.slice(i, i + WRITE_BATCH);
    try {
      const results = await env.DB.batch(
        slice.map((id) =>
          env.DB.prepare(
            `UPDATE ${TSV_TABLE[kind]} SET review_kind = NULL, review_reason = NULL, updated_at = ?1
               WHERE id = ?2 AND book = ?3 AND review_kind = 'ref_moved' AND deleted_at IS NULL`,
          ).bind(now, id, book),
        ),
      );
      results.forEach((r) => {
        if ((r?.meta.changes ?? 0) > 0) counts.ref_moved_resolved++;
      });
    } catch (e) {
      counts.errors.push(`flag clear batch: ${String(e)}`);
    }
  }

  // Batch the pristine UPDATEs, then audit only the ones that actually applied
  // (meta.changes > 0 — a row edited between read and batch fails the pristine +
  // version-CAS guard and is counted skipped_edited). On a batch() error record
  // it and move on; the chunk step retries and the next sync catches up.
  for (let i = 0; i < updates.length; i += WRITE_BATCH) {
    const slice = updates.slice(i, i + WRITE_BATCH);
    try {
      const results = await env.DB.batch(
        slice.map((u) => buildTsvUpdateStmt(env, book, kind, u.row, u.sortOrder, u.oldVersion, now)),
      );
      const logs: D1PreparedStatement[] = [];
      slice.forEach((u, j) => {
        if ((results[j]?.meta.changes ?? 0) > 0) {
          counts.updated++;
          logs.push(logEditStmt(env, kind, u.row.id, book, userId, u.oldVersion, u.oldVersion + 1, "update", u.row));
        } else {
          counts.skipped_edited++;
        }
      });
      if (logs.length) await env.DB.batch(logs);
    } catch (e) {
      counts.errors.push(`${kind} update batch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Batch the AI-only re-seeds (overwrite from master + reclaim to master-owned).
  // Relaxed guard vs the pristine UPDATE: no `updated_by IS NULL` (the row IS
  // AI-owned), but version-CAS (`AND version = oldVersion`) PLUS re-asserted
  // protections (deleted_at/trashed_at/preserve/hint) still fire — a human edit
  // landing between the read and the batch bumps version → 0 rows changed →
  // counted skipped_edited, never clobbered. `updated_by = NULL` in the SET
  // returns the row to master-owned. Audited as 'update'.
  for (let i = 0; i < aiReseeds.length; i += WRITE_BATCH) {
    const slice = aiReseeds.slice(i, i + WRITE_BATCH);
    try {
      const results = await env.DB.batch(
        slice.map((u) => buildTsvUpdateStmt(env, book, kind, u.row, u.sortOrder, u.oldVersion, now, false, true)),
      );
      const logs: D1PreparedStatement[] = [];
      slice.forEach((u, j) => {
        if ((results[j]?.meta.changes ?? 0) > 0) {
          counts.reimported_ai++;
          logs.push(logEditStmt(env, kind, u.row.id, book, userId, u.oldVersion, u.oldVersion + 1, "update", u.row));
        } else {
          counts.skipped_edited++;
        }
      });
      if (logs.length) await env.DB.batch(logs);
    } catch (e) {
      counts.errors.push(`${kind} ai-reseed batch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Batch the resurrections (clear deleted_at + bring content to master). Same
  // version-CAS + pristine guard as the UPDATE path, but flipped to require a
  // tombstone (deleted_at IS NOT NULL); a row a human deleted/edited between the
  // read and the batch matches 0 rows and is counted skipped_edited. updated_by
  // stays NULL so the row remains reimport-owned. Audited as 'restore'.
  for (let i = 0; i < resurrects.length; i += WRITE_BATCH) {
    const slice = resurrects.slice(i, i + WRITE_BATCH);
    try {
      const results = await env.DB.batch(
        slice.map((u) => buildTsvUpdateStmt(env, book, kind, u.row, u.sortOrder, u.oldVersion, now, true)),
      );
      const logs: D1PreparedStatement[] = [];
      slice.forEach((u, j) => {
        if ((results[j]?.meta.changes ?? 0) > 0) {
          counts.resurrected++;
          console.warn("reimport: resurrected pristine tombstone master still carries", {
            book,
            kind,
            id: u.row.id,
            chapter: u.row.chapter,
            verse: u.row.verse,
          });
          logs.push(logEditStmt(env, kind, u.row.id, book, userId, u.oldVersion, u.oldVersion + 1, "restore", u.row));
        } else {
          counts.skipped_edited++;
        }
      });
      if (logs.length) await env.DB.batch(logs);
    } catch (e) {
      counts.errors.push(`${kind} resurrect batch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Batch the reclaims (issue #427, option 1: overwrite a reissued tombstone's
  // slot with master's row — deliberately its own write, not folded into the
  // resurrect batch above). The guard is narrower than every other write in
  // this file on purpose: `deleted_at IS NOT NULL AND version = oldVersion`
  // ONLY — no `updated_by IS NULL` / trashed_at / preserve / hint re-assertion.
  // Those flags describe the OLD tombstoned row's protection state, and reclaim
  // discards that row's content wholesale in favor of master's — a completely
  // different logical row moving into a primary-key slot the old row merely
  // happened to vacate, not a continuation of it, so re-asserting its
  // protections would be checking the wrong row. version-CAS is still the full
  // safety net: a concurrent modification to the SAME tombstoned row (another
  // writer's resurrect/reclaim/edit landing between the read and this batch)
  // bumps its version and fails the CAS — that is NOT silently dropped (the
  // whole point of this fix is to stop silent drops): it falls back to
  // `tombstone_blocked`, exactly the pre-reclaim safety net, so a lost race is
  // never quieter than before this change. `updated_by = NULL` in the SET
  // starts master's row life master-owned, same as a fresh insert. Audited as
  // "create" — from this slot's new life's perspective, master's row IS a
  // fresh row, not an update to whatever used to occupy the slot.
  // RECLAIM_PAIR_BATCH (half of WRITE_BATCH): each reclaim now travels as TWO
  // statements — the write immediately followed by its own SQL-`changes()`-
  // gated edit_log INSERT (gatedLogEditStmt) — in the SAME batch() call, so
  // chunking halves to stay within D1's ≤100-statement cap. This keeps the
  // write and its audit row atomic (Codex review on PR #506, round 2): the
  // audit row IS the boundary rowHistoryBoundary.ts relies on to hide the
  // dead tombstoned row's history from the reclaimed row, so a write that
  // landed with no matching log would leave that boundary permanently
  // missing — a RETRY can't repair it, because a reclaimed row is no longer a
  // tombstone and won't hit this branch again next run. Previously (like
  // applyVerseRows' pristine batch before its own PR #496 review fix) the
  // write batch and a follow-up JS-gated log batch were two separate
  // env.DB.batch() calls, so a write batch that landed while the log batch
  // failed independently would go on to be counted `tombstone_reclaimed`
  // ANYWAY (the JS check only asked whether the WRITE landed) — content
  // correct, but boundary silently missing forever.
  const RECLAIM_PAIR_BATCH = Math.floor(WRITE_BATCH / 2);
  for (let i = 0; i < reclaims.length; i += RECLAIM_PAIR_BATCH) {
    const slice = reclaims.slice(i, i + RECLAIM_PAIR_BATCH);
    const stmts: D1PreparedStatement[] = [];
    for (const u of slice) {
      stmts.push(
        buildTsvUpdateStmt(env, book, kind, u.row, u.sortOrder, u.oldVersion, now, false, false, true),
        gatedLogEditStmt(env, kind, u.row.id, book, userId, u.oldVersion, u.oldVersion + 1, "create", u.row),
      );
    }
    try {
      const results = await env.DB.batch(stmts);
      slice.forEach((u, j) => {
        if ((results[j * 2]?.meta.changes ?? 0) > 0) {
          counts.tombstone_reclaimed++;
          console.warn("reimport: reclaimed reissued tombstone slot for master's row", {
            book,
            kind,
            id: u.row.id,
            chapter: u.row.chapter,
            verse: u.row.verse,
          });
        } else {
          // Lost the version-CAS race — something touched this tombstoned row
          // between the read and this batch. Fall back to the pre-reclaim
          // safety net so a lost race is never silently dropped: count it
          // tombstone_blocked (withholds the watermark) exactly as if reclaim
          // had never been attempted for this row. The paired log statement
          // also no-ops (its own `changes() > 0` gate sees the write's 0), so
          // no phantom audit row lands for a reclaim that didn't happen.
          counts.tombstone_blocked++;
          noteBlockedSample(
            counts,
            `${kind} ${u.row.id}: reclaim lost the version-CAS race, deleted row now reissued at ${u.row.refRaw}`,
          );
        }
      });
    } catch (e) {
      // Correctness-bearing, same as the edited-merge and verse master-adoption
      // batches below/above: a thrown batch is one D1 transaction that never
      // committed, so NEITHER the write NOR its paired log landed for this
      // whole slice — this run must not be certified in sync, or the
      // reimport-sync step stamps the watermark over still-missing content
      // and the nightly export never retries (Codex review on PR #506).
      // Taint apply_incomplete so shouldRecordResourceSync withholds it; the
      // next sync retries this same slice from scratch (still tombstoned,
      // since nothing landed).
      counts.apply_incomplete = true;
      counts.errors.push(`${kind} reclaim batch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Batch the combined edited-row merges (three-way adoptions unioned with the
  // ancestor-free tags/whitespace field merge). Modeled on the verse
  // master-adoption batch (applyVerseRows step 7): version-CAS UPDATE (`AND
  // version = oldVersion`), the SAME protections isReimportableRow checks
  // re-asserted at write time, and updated_by is NEVER touched — the row stays
  // human-owned (so the NEXT sync sees D1==master and no-ops). A human PATCH
  // landing between the read and this batch bumps version → 0 rows changed →
  // counted skipped_edited (no clobber). Counters: merge_adopted for a landed
  // three-way adoption (merge_conflicts for its both-changed subset),
  // merged_fields for a heuristic-only write. A THROWN batch taints
  // apply_incomplete so the reimport-sync step withholds this resource's
  // watermark — the failed-adoption-write gate (Codex): without it, a stale D1
  // would be certified in-sync and the export would revert master, un-retried.
  for (let i = 0; i < editedWrites.length; i += WRITE_BATCH) {
    const slice = editedWrites.slice(i, i + WRITE_BATCH);
    try {
      const results = await env.DB.batch(
        slice.map((u) => buildTsvEditedWriteStmt(env, book, kind, u.id, u.fields, u.oldVersion, now)),
      );
      const logs: D1PreparedStatement[] = [];
      slice.forEach((u, j) => {
        if ((results[j]?.meta.changes ?? 0) > 0) {
          if (u.adopted) {
            counts.merge_adopted++;
            if (u.conflict) counts.merge_conflicts++;
            // `keptConflict` distinguishes the mixed row: master's value landed
            // for a field we never touched, while a CONTESTED field on the same
            // row was kept from D1 (#540 item 2). Without it this line reads as
            // "master's correction won" for a row where it half did.
            console.warn("reimport: adopted master's out-of-band TSV correction over D1 (tsvMerge)", {
              book, kind, id: u.id, chapter: u.chapter, verse: u.verse, conflict: u.conflict,
              keptConflict: u.keptAiConflict === true,
            });
          }
          // merged_fields is INDEPENDENT of merge_adopted: a row can both adopt a
          // substantive master edit AND fold in a tags/whitespace field-merge, and
          // the pre-existing heuristic-merge tally must not be lost to the adoption
          // branch (Codex P3.7).
          if (u.heuristic) counts.merged_fields++;
          logs.push(logEditStmt(env, kind, u.id, book, userId, u.oldVersion, u.oldVersion + 1, "update", u.fields));
        } else {
          // Lost the version-CAS race — a human PATCH landed between the read and
          // this batch. Nothing of theirs was clobbered (skipped_edited). BUT if
          // this was an ADOPTION, master's correction did NOT land in D1 and the
          // field is still stale, so the watermark must be withheld or the export
          // reverts master with no retry (Codex P1.2 — the CAS-race twin of the
          // thrown-batch gate). A lost heuristic-only write is not data loss.
          //
          // A `keep_ai_master` row (u.conflict true, u.adopted false — see the
          // `merge.conflict` block above) can lose this same race with NOTHING
          // else to show for it: the review_kind/review_reason flag IS the whole
          // write, so a lost CAS here reports nowhere this run (#552 item 1,
          // decided rather than left an accident of the adopted-only branch
          // below). Left this way deliberately: the conflict this flag exists to
          // surface is recomputed from D1/master on every run, so it either
          // still holds next sync (and gets flagged then) or the human's own
          // edit that won this race resolved it — either way there is nothing
          // to retry, unlike an adoption's stale, unreachable-by-recompute field.
          counts.skipped_edited++;
          if (u.adopted) {
            counts.apply_incomplete = true;
            console.warn("reimport: TSV master-adoption lost the version-CAS race; withholding watermark for retry", {
              book, kind, id: u.id, chapter: u.chapter, verse: u.verse,
            });
          }
        }
      });
      if (logs.length) await env.DB.batch(logs);
    } catch (e) {
      counts.apply_incomplete = true;
      counts.errors.push(`${kind} edited-merge batch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return counts;
}

// Columns buildTsvEditedWriteStmt may write per kind. An allowlist (not
// Object.keys of caller input) so a stray/injected key can never reach the SQL.
// Common to all kinds: tags, occurrence, and the review flags. `sort_order`,
// identity, and updated_by are deliberately absent (never merged from master).
// Human-friendly names for the merge fields, for the conflict review_reason
// (never expose a raw DB column name to a translator).
const TSV_FIELD_LABELS: Record<string, string> = {
  quote: "quote",
  note: "note",
  support_reference: "support reference",
  question: "question",
  response: "response",
  orig_words: "original words",
  tw_link: "translationWords link",
};

const TSV_MERGE_WRITE_COLS: Record<TsvKind, Set<string>> = {
  tn: new Set(["quote", "note", "occurrence", "support_reference", "tags", "review_kind", "review_reason"]),
  tq: new Set(["quote", "question", "response", "occurrence", "tags", "review_kind", "review_reason"]),
  twl: new Set(["orig_words", "tw_link", "occurrence", "tags", "review_kind", "review_reason"]),
};

// Build (don't run) the combined merge UPDATE for one edited TSV row, for
// env.DB.batch(). Writes only the allowlisted columns present in `fields` (the
// union of the three-way merge's adopted fields, the ancestor-free field merge,
// and review_kind/review_reason on a conflict); every other column, including
// sort_order, is left exactly as the human left it. version-CAS (`AND version =
// oldVersion`) is the concurrency guard — NOT `updated_by IS NULL` (the row IS
// human-owned) — and updated_by is never in the SET, so the row stays
// attributed to that human. The same protections isReimportableRow checks are
// re-asserted in the WHERE clause so a delete/trash/preserve/hint change landing
// between the read and this batch blocks the write rather than racing it.
function buildTsvEditedWriteStmt(
  env: Env,
  book: string,
  kind: TsvKind,
  id: string,
  fields: Record<string, unknown>,
  oldVersion: number,
  now: number,
): D1PreparedStatement {
  const allowed = TSV_MERGE_WRITE_COLS[kind];
  const cols = Object.keys(fields).filter((c) => allowed.has(c));
  const binds: unknown[] = [];
  let p = 1;
  const setClauses = cols.map((c) => {
    binds.push(fields[c] ?? null);
    return `${c} = ?${p++}`;
  });
  setClauses.push(`version = version + 1`, `updated_at = ?${p}`);
  binds.push(now);
  p++;
  const protection =
    kind === "tn"
      ? `deleted_at IS NULL AND trashed_at IS NULL AND preserve = 0 AND hint = 0`
      : `deleted_at IS NULL`;
  const idParam = p++;
  const bookParam = p++;
  const versionParam = p++;
  binds.push(id, book, oldVersion);
  return env.DB.prepare(
    `UPDATE ${kind}_rows
        SET ${setClauses.join(", ")}
      WHERE id = ?${idParam} AND book = ?${bookParam} AND ${protection} AND version = ?${versionParam}`,
  ).bind(...binds);
}

// Map a ParsedTsvRow to the TsvMergeSide subset this kind merges (substantive
// content only — tags is owned by computeEditedFieldMerge, sort_order/identity
// are never merged). Used for both `ours` (via storedTsvRowToParsed) and
// `theirs` (the incoming master row).
function parsedRowToMergeSide(kind: TsvKind, row: ParsedTsvRow): TsvMergeSide {
  if (kind === "tn") {
    return { quote: row.quote ?? null, note: row.note ?? null, occurrence: row.occurrence, support_reference: row.support_reference ?? null };
  }
  if (kind === "tq") {
    return { quote: row.quote ?? null, question: row.question ?? null, response: row.response ?? null, occurrence: row.occurrence };
  }
  return { orig_words: row.orig_words ?? null, occurrence: row.occurrence, tw_link: row.tw_link ?? null };
}

// Reconstruct the three-way-merge ancestor for a set of edited TSV rows: the row
// content D1 held as of the master-confirmed watermark (`cutoff`), which is what
// the export rendered to master. Because a human TSV edit logs only the CHANGED
// fields (rows.ts PATCH) while a create/reimport/restore logs the full row, the
// ancestor is FOLDED from the row's edit_log history up to the cutoff (see
// foldTsvBase). Batched under the bound-param limit; one read per WRITE_BATCH ids
// regardless of how long each row's history is. A row with no content-bearing
// history before the cutoff maps to null (caller keeps D1 as keep_no_base).
//
// PRECISE BOUNDARY (Codex P1.3, fixed). When `boundaryId` is non-null the fold
// cuts at `id <= boundaryId` — the MAX(edit_log.id) the export captured at its D1
// read (0050's master_confirmed_edit_id) — instead of `created_at < cutoff`.
// edit_log.id is a monotonic AUTOINCREMENT, so an edit committed in the SAME
// second as the export read (which `created_at < cutoff` wrongly excluded, making
// the ancestor one edit too old and a later D1 edit read as a false both-changed
// conflict) now lands on the correct side of the boundary. `boundaryId` is null
// only during warm-up (a row confirmed before 0050 was stamped); then it falls
// back to the pre-P1.3 `created_at < cutoff` timestamp, unchanged.
//
// SUBREQUEST BUDGET (Codex P2.5): this adds ONE batched read per chapter that has
// edited candidates, and only when a watermark exists. The nightly path is
// chunked (reimportStagedChunk, 8 chapters/step) so it is safely bounded. The
// UNCHUNKED full-book paths — user-triggered runReimport and the post-export
// reimport (postExport.ts submits every chapter to reimportBookFromDcs) — were
// already near the ~1000-subrequest cap for the largest books (PSA ~151 ch)
// before this change; the conditional read here adds to that worst case. Left as
// a follow-up: hoist ancestor reconstruction to the book level (collect all
// edited-candidate ids across chapters, one batched read) so the full-book paths
// pay a fixed, not per-chapter, cost.
async function reconstructTsvBases(
  env: Env,
  book: string,
  kind: TsvKind,
  ids: string[],
  cutoff: number,
  boundaryId: number | null,
): Promise<Map<string, TsvBaseRecord>> {
  const out = new Map<string, TsvBaseRecord>();
  const entriesById = new Map<string, TsvEditLogEntry[]>();
  // P1.3: cut at the precise id boundary when we have one, else the timestamp.
  // Either way ?3 carries the single bound value; only the column/operator swaps.
  const boundaryClause = boundaryId != null ? `id <= ?3` : `created_at < ?3`;
  const boundaryBind = boundaryId != null ? boundaryId : cutoff;
  for (let i = 0; i < ids.length; i += WRITE_BATCH) {
    const slice = ids.slice(i, i + WRITE_BATCH);
    // ?1 book, ?2 kind, ?3 boundary (id or created_at), ids from ?4. Ordered by
    // (row_key, id) so each group folds oldest→newest. `id` is monotonic per row,
    // so it is a valid chronological tiebreak within a row_key even at identical
    // created_at.
    const inClause = slice.map((_, j) => `?${j + 4}`).join(", ");
    const rs = await env.DB.prepare(
      `SELECT row_key, action, payload_json, book FROM edit_log
        WHERE kind = ?2 AND (book = ?1 OR book IS NULL)
          AND action IN ('create', 'update', 'restore')
          AND ${boundaryClause}
          AND row_key IN (${inClause})
        ORDER BY row_key ASC, id ASC`,
    )
      .bind(book, kind, boundaryBind, ...slice)
      .all<{ row_key: string; action: string; payload_json: string | null; book: string | null }>();
    for (const r of rs.results) {
      let payload: Record<string, unknown> | null = null;
      if (r.payload_json) {
        try {
          const p = JSON.parse(r.payload_json);
          if (p && typeof p === "object" && !Array.isArray(p)) payload = p as Record<string, unknown>;
        } catch {
          /* unparseable payload — treat as no content for this entry */
        }
      }
      const list = entriesById.get(r.row_key) ?? [];
      list.push({ action: r.action, payload, bookKnown: r.book != null });
      entriesById.set(r.row_key, list);
    }
  }
  for (const id of ids) {
    const entries = entriesById.get(id) ?? [];
    // Both folds read the SAME entries — the reference ancestor costs no extra
    // D1 read, which is what keeps it affordable on the unchunked full-book
    // paths this function's header already flags as near the subrequest cap.
    out.set(id, { content: foldTsvBase(kind, entries), ref: foldTsvRefBase(entries) });
  }
  return out;
}

// Outcome of one `INSERT ... ON CONFLICT(id, book) DO NOTHING`.
//
// Deliberately TRI-state rather than a boolean (issue #427). The signal is
// D1's `meta.changes`, and the old `(r.meta.changes ?? 0) > 0` collapsed two
// very different situations into "not inserted": a real 0 (the primary key was
// taken — a measured conflict) and `undefined` (D1 did not report a row count
// at all). Since these counters now WITHHOLD the sync watermark, and that
// withhold has no automatic release, treating an unreported count as a measured
// conflict would recount every successful insert as a drop and freeze the book's
// export on a run where nothing was actually wrong.
//
// So: "unknown" is reported separately and taints the run (counts_incomplete)
// instead of asserting a conflict. That is the same direction the rest of this
// file takes — an absent measurement must never be laundered into a value, in
// EITHER direction (not into a green "0", and not into a red "conflict").
//
// NOTE the node:sqlite integration tests prove SQLite's semantics here, not
// D1's. They are strong evidence for the ON CONFLICT behavior but they cannot
// prove what D1 puts in `meta.changes`, which is exactly why this branch exists.
type TsvInsertOutcome = "inserted" | "conflict" | "unknown";

// The one place `meta.changes` is interpreted, so the undefined case cannot be
// re-collapsed at one of the three call sites and not the others.
function insertOutcome(r: { meta?: { changes?: number } }): TsvInsertOutcome {
  const changes = r.meta?.changes;
  if (changes === undefined || changes === null || !Number.isFinite(changes)) return "unknown";
  return changes > 0 ? "inserted" : "conflict";
}

// Returns "inserted" if the row was written, "conflict" if the (book, id) slot
// was already taken, "unknown" if D1 reported no row count (caller must not
// treat that as either).
async function tryInsertTsvRow(
  env: Env,
  book: string,
  kind: TsvKind,
  row: ParsedTsvRow,
  sortOrder: number,
): Promise<TsvInsertOutcome> {
  if (kind === "tn") {
    const r = await env.DB.prepare(
      `INSERT INTO tn_rows
         (id, book, chapter, verse, ref_raw, tags, support_reference, quote, occurrence, note, sort_order)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(id, book) DO NOTHING`,
    )
      .bind(
        row.id, book, row.chapter, row.verse, row.refRaw,
        row.tags, row.support_reference ?? null, row.quote ?? null,
        row.occurrence, row.note ?? null, sortOrder,
      )
      .run();
    return insertOutcome(r);
  }
  if (kind === "tq") {
    const r = await env.DB.prepare(
      `INSERT INTO tq_rows
         (id, book, chapter, verse, ref_raw, tags, quote, occurrence, question, response, sort_order)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(id, book) DO NOTHING`,
    )
      .bind(
        row.id, book, row.chapter, row.verse, row.refRaw,
        row.tags, row.quote ?? null, row.occurrence,
        row.question ?? null, row.response ?? null, sortOrder,
      )
      .run();
    return insertOutcome(r);
  }
  const r = await env.DB.prepare(
    `INSERT INTO twl_rows
       (id, book, chapter, verse, ref_raw, tags, orig_words, occurrence, tw_link, sort_order)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(id, book) DO NOTHING`,
  )
    .bind(
      row.id, book, row.chapter, row.verse, row.refRaw,
      row.tags, row.orig_words ?? null, row.occurrence, row.tw_link ?? null, sortOrder,
    )
    .run();
  return insertOutcome(r);
}

// True iff this stored row has never been touched by a human and isn't pending
// deletion — i.e. safe for the reimport to overwrite. In-memory mirror of the
// pristine SQL predicate, evaluated against the batched read.
function isPristineTsv(kind: TsvKind, row: Record<string, unknown>): boolean {
  if (row.updated_by != null) return false;
  if (row.deleted_at != null) return false;
  if (kind === "tn") {
    if (row.trashed_at != null) return false;
    if (Number(row.preserve ?? 0) !== 0) return false;
    if (Number(row.hint ?? 0) !== 0) return false;
  }
  return true;
}

// True iff this stored row is a TOMBSTONE that is otherwise pristine — deleted,
// but never human-edited, not in the trash queue, no preserve/hint. Mirror of
// isPristineTsv with the deleted_at test INVERTED. Column-shape only: it does
// NOT prove WHO deleted the row. A human trash promoted by the nightly job sets
// `deleted_at = trashed_at, trashed_at = NULL` and never touches updated_by, so
// it is column-identical to a reimport prune here — the caller MUST also gate on
// lastTsvDeleteWasReimport to keep human deletions dead.
function isPristineTombstone(kind: TsvKind, row: Record<string, unknown>): boolean {
  if (row.deleted_at == null) return false;
  if (row.updated_by != null) return false;
  if (kind === "tn") {
    if (row.trashed_at != null) return false;
    if (Number(row.preserve ?? 0) !== 0) return false;
    if (Number(row.hint ?? 0) !== 0) return false;
  }
  return true;
}

// True iff the most recent 'delete' on this row was a reimport prune
// (source='dcs_reimport'), not a human trash-finalize ('nightly_finalize') or
// any other delete. This is the ONLY signal that separates an erroneous
// truncated-fetch prune (resurrect it) from a human deletion (keep it dead),
// because the nightly trash promotion erases the column-level trace. One indexed
// read (edit_log_row covers kind, row_key); resurrection candidates are rare
// (normally zero — a tombstone whose id master still carries).
async function lastTsvDeleteWasReimport(
  env: Env,
  kind: TsvKind,
  id: string,
  book: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT source FROM edit_log
      WHERE kind = ?1 AND row_key = ?2 AND book = ?3 AND action = 'delete'
      ORDER BY id DESC LIMIT 1`,
  )
    .bind(kind, id, book)
    .first<{ source: string | null }>();
  return row?.source === REIMPORT_SOURCE;
}

// ── Verified-complete TSV master fetch (issue #485, second P1 follow-up) ───
// Codex re-review of b826dcb: that commit let softDeleteRemovedTsvRows treat
// ANY chapter absent from the incoming body as "master emptied it" (extending
// coveredChapters to every chapter still holding a live D1 row), gated only on
// the caller already having survived tsvFetchLooksTruncated. But
// tsvFetchLooksTruncated/isCatastrophicTsvShrink is a LOSS-PERCENTAGE
// heuristic (rejects >50% loss, and no-ops below SHRINK_GUARD_MIN_LIVE) — not
// a positive completeness guarantee. A partial fetch that happens to pass it
// (60 of 100 rows, or any book under the small-file floor) would still widen
// coveredChapters over chapters the (partial) body never mentions, and the
// prune would tombstone every pristine/AI-owned row in them — exactly the
// blast radius the review flagged.
//
// PR #502 (issue #494) added fetchDcsMasterTextVerified/dcsFileSize: an
// INDEPENDENT positive proof, cross-checking the downloaded byte count
// against Gitea's own contents-API-recorded size for the file (not just a
// possibly-absent Content-Length), fail-closed (null/false) on a persistent
// short read. This thin adapter renames its `{text, verified}` result to the
// `raw`/`verifiedComplete` shape the rest of this module's TSV-fetch call
// sites already use — nothing more.
//
// FINAL P1 follow-up (a later codex re-review of THIS fix's first version):
// the original version of this function made its OWN separate dcsFileSize()
// call and then called fetchDcsMasterText() (which does its own, separately
// -timed, internal dcsFileSize() call) — two independent network round trips
// to the same "is the size available right now" question, which can
// disagree. `verifiedComplete` was computed from THIS function's own probe,
// not from whatever fetchDcsMasterText's internal probe actually used to
// check the bytes it returned — so `verifiedComplete: true` could land
// alongside a `raw` whose own completeness check never actually ran (that
// internal probe could have failed transiently even though this one
// succeeded). fetchDcsMasterTextVerified closes that gap: the verified flag
// is computed INSIDE the one function that performs the fetch and the check,
// from the exact apiSize/buffer it used — no second, separately-timed probe,
// so "verified" and "raw" can never desynchronize.
//
// THIRD P1 follow-up (round 4 codex re-review of bbb7b25): a same-function
// probe still isn't a same-REVISION proof. `verifiedComplete` used to be
// obtainable even when master's tip moved between fetchDcsMasterTextVerified's
// internal size lookup and its raw fetch, because both of those defaulted to
// the mutable "master" ref — describing "master's tip whenever each request
// happened to land", not one fixed commit. `ref` (this book+resource's file
// SHA, already resolved by planAndStageBookResources's SHA-gate check just
// above this function's one call site — see masterSha there) pins BOTH the
// size lookup and the raw fetch to that exact revision, so `verifiedComplete`
// now means "this SHA's size and this SHA's bytes agreed", not just "some
// size and some bytes agreed". Falls back to fetchDcsMasterTextVerified's own
// unpinned default when the caller has no SHA yet (fileCommitSha failed
// transiently) — verifiedComplete then stays honestly false, never true on an
// unpinned ref (see isPinnedCommitSha in dcsSources.ts).
async function fetchTsvMasterVerified(
  env: Env,
  repo: string,
  path: string,
  ref?: string,
): Promise<{ raw: string | null; verifiedComplete: boolean }> {
  // `ref` undefined falls through to fetchDcsMasterTextVerified's own default
  // ("master", never verified) — a plain JS default-parameter substitution,
  // not a branch worth writing out here.
  const { text, verified } = await fetchDcsMasterTextVerified(env, repo, path, ref);
  return { raw: text, verifiedComplete: verified };
}

// ── Truncated-fetch completeness gate ───────────────────────────────────────
// Does this fetched TSV body look truncated relative to what D1 already holds?
// Compares parsed incoming rows (valid-id only, same normalizer the apply path
// uses) against live (non-deleted) D1 rows for the book/resource. Returns true
// → caller treats the fetch as failed (no apply / no prune / no watermark).
async function tsvFetchLooksTruncated(
  env: Env,
  book: string,
  kind: TsvKind,
  raw: string,
): Promise<boolean> {
  const liveRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${kind}_rows WHERE book = ?1 AND deleted_at IS NULL`,
  )
    .bind(book)
    .first<{ n: number }>();
  const live = Number(liveRow?.n ?? 0);
  let incoming = 0;
  for (const r of parseTsv(raw).rows) if (parseTsvRow(r, kind)) incoming++;
  if (!isCatastrophicTsvShrink(live, incoming)) return false;
  console.error(
    "reimport: incoming TSV is a catastrophic shrink vs live D1 — treating as a truncated fetch (no apply/prune/watermark)",
    { book, kind, liveRows: live, incomingRows: incoming },
  );
  return true;
}

// Build (don't run) the pristine UPDATE for one TSV row, for env.DB.batch().
// version-CAS (`AND version = oldVersion`) + the pristine predicate keep the
// write safe: a row a translator edited between the read and the batch matches
// 0 rows (meta.changes 0 → caller counts skipped_edited; no clobber, no audit).
// updated_by stays NULL so future re-imports still see the row as overwritable.
// `resurrect` flips the deleted_at guard: a normal pristine UPDATE requires a
// LIVE row (deleted_at IS NULL); a resurrection requires a TOMBSTONE
// (deleted_at IS NOT NULL) and clears it in the SET. `reseedAi` (mutually
// exclusive with resurrect and reclaim) is the AI-only re-seed: it DROPS the
// `updated_by IS NULL` guard (the row is AI-owned) and sets `updated_by = NULL`
// to reclaim it to master-owned — safety now rests on the version-CAS + the
// retained deleted_at/trashed_at/preserve/hint re-assertions.
// `reclaim` (mutually exclusive with resurrect and reseedAi; issue #427, option
// 1) is the reissued-tombstone slot reclaim: like resurrect it requires a
// TOMBSTONE (deleted_at IS NOT NULL) and clears it, but UNLIKE every other mode
// it drops the trashed_at/preserve/hint re-assertion entirely (`pristine`
// collapses to just the deletedGuard) — those flags describe the OLD
// tombstoned row's protection state, and master's incoming row is a
// completely different logical entity moving into a slot the old row merely
// vacated, not a continuation of it, so re-asserting them would be checking
// the wrong row's history. For the SAME reason, a tn reclaim also explicitly
// CLEARS trashed_at/preserve/hint in the SET (`clearProtections` below), and
// EVERY kind's reclaim clears restored_from_version/review_kind/review_reason
// (`clearReviewMeta` below) — rather than leaving whatever the tombstoned row
// happened to hold. None of those columns are part of the pristine guard's
// WHERE for reclaim, so nothing else would ever reset them, and a human's
// "preserve this note"/"queue this as an AI hint"/"flag for review"/"showing
// as vN" intent for the OLD content must never silently apply to master's new
// content. It also drops the `updated_by IS NULL` guard (like reseedAi) and
// sets `updated_by = NULL`, starting master's row master-owned.
// version-CAS is the only guard reclaim keeps, and it is load-bearing: a
// concurrent write to the SAME tombstoned row between the read and this batch
// still fails the CAS and is caught by the caller (falls back to
// tombstone_blocked, never a silent drop). Bound-param positions are identical
// in all modes (the `= NULL` clauses carry no param), so the .bind() lists
// below are unchanged.
function buildTsvUpdateStmt(
  env: Env,
  book: string,
  kind: TsvKind,
  row: ParsedTsvRow,
  sortOrder: number,
  oldVersion: number,
  now: number,
  resurrect = false,
  reseedAi = false,
  reclaim = false,
): D1PreparedStatement {
  const deletedGuard = resurrect || reclaim ? "deleted_at IS NOT NULL" : "deleted_at IS NULL";
  const ownerGuard = reseedAi || reclaim ? "" : "updated_by IS NULL AND ";
  const pristine = reclaim
    ? deletedGuard
    : kind === "tn"
      ? `${ownerGuard}${deletedGuard} AND trashed_at IS NULL AND preserve = 0 AND hint = 0`
      : `${ownerGuard}${deletedGuard}`;
  const clearDeleted = resurrect || reclaim ? "deleted_at = NULL, " : "";
  const clearOwner = reseedAi || reclaim ? "updated_by = NULL, " : "";
  // Reclaim ONLY (tn): master's row is starting a fresh life in this slot, the
  // same as a brand-new INSERT would (whose columns default to NULL/0 — see
  // tryInsertTsvRow, which never sets these three either). A tombstoned row's
  // trashed_at/preserve/hint describe intent a human set for the OLD content
  // (the trash queue, "protect from the AI sweep", "queue as an AI hint") —
  // carrying any of those forward onto master's unrelated new content would be
  // applying a human's decision to a row they never made it about. Every other
  // mode leaves these three columns alone (there's nothing to clear: the
  // pristine guard above already requires them clear before a normal
  // UPDATE/resurrect/reseed can proceed at all).
  const clearProtections = reclaim && kind === "tn" ? "trashed_at = NULL, preserve = 0, hint = 0, " : "";
  // Reclaim ONLY, all three kinds: restored_from_version (the "switch to vN"
  // display chip) and review_kind/review_reason (the flag-for-review markers —
  // e.g. 'ref_moved', a keep_alignment_refused-style note) describe the OLD
  // tombstoned row, same rationale as clearProtections above. Left uncleared, a
  // human's stale "this needs review because X" or "showing as vN" carries onto
  // master's unrelated new content with no way to tell it's wrong. Fresh-insert
  // default for both is NULL (tryInsertTsvRow never sets either).
  const clearReviewMeta = reclaim
    ? "restored_from_version = NULL, review_kind = NULL, review_reason = NULL, "
    : "";
  const newVersion = oldVersion + 1;
  if (kind === "tn") {
    return env.DB.prepare(
      `UPDATE tn_rows
          SET ${clearDeleted}${clearOwner}${clearProtections}${clearReviewMeta}ref_raw = ?1, chapter = ?2, verse = ?3, tags = ?4,
              support_reference = ?5, quote = ?6, occurrence = ?7, note = ?8,
              sort_order = ?9, version = ?10, updated_at = ?11
        WHERE id = ?12 AND book = ?13 AND ${pristine} AND version = ?14`,
    ).bind(
      row.refRaw, row.chapter, row.verse, row.tags,
      row.support_reference ?? null, row.quote ?? null, row.occurrence, row.note ?? null,
      sortOrder, newVersion, now, row.id, book, oldVersion,
    );
  }
  if (kind === "tq") {
    return env.DB.prepare(
      `UPDATE tq_rows
          SET ${clearDeleted}${clearOwner}${clearReviewMeta}ref_raw = ?1, chapter = ?2, verse = ?3, tags = ?4,
              quote = ?5, occurrence = ?6, question = ?7, response = ?8,
              sort_order = ?9, version = ?10, updated_at = ?11
        WHERE id = ?12 AND book = ?13 AND ${pristine} AND version = ?14`,
    ).bind(
      row.refRaw, row.chapter, row.verse, row.tags,
      row.quote ?? null, row.occurrence, row.question ?? null, row.response ?? null,
      sortOrder, newVersion, now, row.id, book, oldVersion,
    );
  }
  return env.DB.prepare(
    `UPDATE twl_rows
        SET ${clearDeleted}${clearOwner}${clearReviewMeta}ref_raw = ?1, chapter = ?2, verse = ?3, tags = ?4,
            orig_words = ?5, occurrence = ?6, tw_link = ?7,
            sort_order = ?8, version = ?9, updated_at = ?10
      WHERE id = ?11 AND book = ?12 AND ${pristine} AND version = ?13`,
  ).bind(
    row.refRaw, row.chapter, row.verse, row.tags,
    row.orig_words ?? null, row.occurrence, row.tw_link ?? null,
    sortOrder, newVersion, now, row.id, book, oldVersion,
  );
}

// edit_log INSERT as a statement, for batching alongside the writes it audits.
// Same columns as logEdit (which stays for the per-row insert path).
function logEditStmt(
  env: Env,
  kind: "tn" | "tq" | "twl" | "verse",
  rowKey: string,
  book: string,
  userId: number | null,
  prevVersion: number | null,
  newVersion: number,
  action: "create" | "update" | "restore",
  payload: unknown,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO edit_log
       (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(kind, rowKey, book, userId, prevVersion, newVersion, action, JSON.stringify(payload), REIMPORT_SOURCE);
}

// SQL-`changes()`-gated sibling of logEditStmt, for a write+log pair that MUST
// travel in the SAME env.DB.batch() call, immediately adjacent (write, then
// this). D1 batches are transactional but are NOT one INSERT — two separate
// batch() calls (write batch, then a JS-meta.changes-gated log batch) can
// commit the first and lose the second independently, leaving a write with no
// audit row. `changes()` reflects the immediately-preceding statement in the
// SAME batch, so this only inserts when that statement actually changed a
// row — never a phantom audit row for a write that lost its guard/CAS. Same
// pattern as applyVerseRows' pristine batch (PR #496 review fix, commit
// 9dad85d) — reused here for the reclaim batch (PR #506 review), which needs
// the same guarantee: a reclaim's audit row is also a history BOUNDARY
// (rowHistoryBoundary.ts) that must never land without the write it belongs
// to, or vice versa.
function gatedLogEditStmt(
  env: Env,
  kind: "tn" | "tq" | "twl" | "verse",
  rowKey: string,
  book: string,
  userId: number | null,
  prevVersion: number | null,
  newVersion: number,
  action: "create" | "update" | "restore",
  payload: unknown,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO edit_log
       (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
      WHERE changes() > 0`,
  ).bind(kind, rowKey, book, userId, prevVersion, newVersion, action, JSON.stringify(payload), REIMPORT_SOURCE);
}

// ── Verses (ULT / UST) ─────────────────────────────────────────────────────

async function reimportVersesForChapter(
  env: Env,
  book: string,
  chapter: number,
  rawUsfm: string,
  bibleVersion: "ULT" | "UST",
  userId: number | null,
  cutoff: MergeCutoff | null,
): Promise<ReimportCounts> {
  // broadcastLaneReopens: true — this is the user-triggered runReimport path
  // (POST /:book/reimport), where a human is watching this request. See
  // applyVerseRows's parameter doc.
  return applyVerseRows(
    env,
    book,
    bibleVersion,
    extractVersesForRange(rawUsfm, chapter, chapter),
    userId,
    cutoff,
    true,
  );
}

// FIX 9: source words for a target verse, unioned across a verse bridge
// (verseEnd) so a bridged adopted verse matches source words from every verse
// it spans — mirrors pipelineImport.ts's sourceWordsForRange, adapted to this
// module's `${chapter}:${verse}` string-keyed map.
function sourceWordsForVerseRange(
  map: Map<string, SourceWord[]>,
  chapter: number,
  verse: number,
  verseEnd: number | null,
): SourceWord[] {
  const end = verseEnd != null && verseEnd >= verse ? verseEnd : verse;
  if (end === verse) return map.get(`${chapter}:${verse}`) ?? [];
  const out: SourceWord[] = [];
  for (let v = verse; v <= end; v++) {
    const ws = map.get(`${chapter}:${v}`);
    if (ws) out.push(...ws);
  }
  return out;
}

// The verse-merge ancestor cutoff for one (book, resource):
// book_resource_syncs.master_confirmed_at, stamped ONLY on a positive
// measurement that master holds our rendered output. There are now TWO such
// measurements, and both are real GETs of master's bytes:
//   1. exportWorkflow.ts's stampMasterConfirmed — commitToDcs's pre-check found
//      master already byte-identical to tonight's render (isMasterConfirmed).
//   2. markOwnPublishConverged (this file) — a LATER sync hashed master's bytes
//      and got the git blob sha of the render we recorded at push time, so
//      master moved by the merge of our own `-be-` branch. Measurement (1) alone
//      is what caused the AMOS revert: it can only ever fire on a night we
//      pushed NOTHING, so every night the export actually pushed left the
//      watermark behind while master moved. See ownPublish.ts.
// This is still NOT "when we last pushed to a `-be-` branch": an unmerged branch
// push is routine here and is not proof master moved, and attributing against it
// was the root cause of the 1CH incident (see verseMerge.ts's header).
//
// `confirmedAt` NULL means "never positively
// confirmed" and callers MUST skip the merge entirely for that case — never
// treat "not yet confirmed" as "nothing changed" (identical in effect to a
// missing watermark row before this fix). Constant per (book, resource) for
// an entire reimport run, so callers read it ONCE per run/step rather than
// once per chapter — see the call sites in runReimport and
// reimportStagedChunk for where the hoisting lands.
//
// P1.3: also returns `editId` — 0050's master_confirmed_edit_id, the PRECISE
// edit_log id boundary of the confirmed render. When non-null the reconstruction
// folds `id <= editId` (immune to the 1-second `created_at` granularity that let
// a same-second-as-the-export-read edit fall out of the ancestor); when null
// (warm-up: an existing row confirmed before 0050, not yet re-stamped) the
// reconstruction falls back to `created_at < confirmedAt`, the pre-P1.3 behavior.
interface MergeCutoff {
  confirmedAt: number | null;
  editId: number | null;
  /**
   * WHO moved master's file for this (book, resource) since the ancestor —
   * issue #540 item 1. Fetched once per pair per run at the only place that
   * already holds master's sha (planAndStageBookResources / runReimport's
   * own-publish loop, both via loadMasterLineage), then carried here so both
   * merges can ask the one question that decides a both-changed conflict.
   *
   * ABSENT (undefined) means nobody looked, which masterMayHoldHumanEdit reads
   * as "a human may have" — today's behavior. Never read this field directly;
   * pass it to that helper. See masterLineage.ts.
   */
  lineage?: MasterLineageSummary | null;
}

async function getMasterConfirmedAt(env: Env, book: string, resource: string): Promise<MergeCutoff> {
  try {
    const row = await env.DB.prepare(
      `SELECT master_confirmed_at, master_confirmed_edit_id FROM book_resource_syncs WHERE book = ?1 AND resource = ?2`,
    )
      .bind(book, resource)
      .first<{ master_confirmed_at: number | null; master_confirmed_edit_id: number | null }>();
    return { confirmedAt: row?.master_confirmed_at ?? null, editId: row?.master_confirmed_edit_id ?? null };
  } catch (e) {
    // 0050 not applied yet (deploy raced its migration — the "missing migration
    // = prod 500s" class). Degrade to the timestamp cutoff rather than fail the
    // whole reimport: fall back to master_confirmed_at alone with editId null, so
    // the merge keeps running on the pre-P1.3 `created_at` boundary until 0050
    // lands. Logged loudly — a silently-disabled precision is how the original
    // watermark bug hid for months.
    console.error("reimport: master_confirmed_edit_id read failed (migration 0050 unapplied?) — merge boundary degraded to the second-granularity timestamp", {
      book,
      resource,
      error: e instanceof Error ? e.message : String(e),
    });
    const row = await env.DB.prepare(
      `SELECT master_confirmed_at FROM book_resource_syncs WHERE book = ?1 AND resource = ?2`,
    )
      .bind(book, resource)
      .first<{ master_confirmed_at: number | null }>();
    return { confirmedAt: row?.master_confirmed_at ?? null, editId: null };
  }
}

// Who moved master's file for this (book, resource) since the merge's ancestor
// (#540 item 1). One Gitea call per page, default budget 5 pages (~250 commits)
// — and only ever called where master's sha has ALREADY been observed to move,
// which is the same condition that gates the file fetch itself, so a quiet
// resource costs nothing.
//
// BOUNDED BY `master_confirmed_at`, NOT BY `source_sha`. Those are different
// points in master's history and they drift apart by design: recordResourceSync
// advances source_sha at the end of any successful reimport, while
// master_confirmed_at moves only on a positive measurement that master holds our
// render — so source_sha is routinely NEWER. A sha-bounded walk skips every
// commit between the two, and a human commit hiding in that gap, reported as "no
// human found", is the one answer that unblocks an overwrite. The bound has to be
// the same point the merge attributes CONTENT against, which is the watermark.
// (See dcsSources.ts's "WHICH BOUNDARY" note. The first version of this wiring
// passed source_sha and was wrong for exactly this reason.)
//
// Returns null when there is nothing to ask about: no resource file, or no
// watermark — and with no watermark both merges are inert anyway, so there is no
// decision for a lineage to inform. Every other failure comes back as a summary
// flagged `incomplete`, which masterMayHoldHumanEdit treats exactly like a found
// human commit: a fetch that fell over must never read as "no human touched this".
async function loadMasterLineage(
  env: Env,
  book: string,
  resource: Resource,
  confirmedAt: number | null,
): Promise<MasterLineageSummary | null> {
  const file = dcsResourceFile(book, resource);
  if (!file || confirmedAt == null) return null;
  const page = await listMasterCommitsSince(env, file.repo, file.path, null, { sinceTime: confirmedAt });
  const commits = page.commits.map(classifyMasterCommit);
  // #557: narrow "a human touched this file" to "a human touched THIS verse",
  // but only where it is affordable and only where the file-level answer is
  // actually in play. Skipped when the walk itself was incomplete (that already
  // protects master, and nothing measured here can un-protect it), when no
  // human commit is in the window (there is nothing to narrow), and when there
  // are more human commits than LINEAGE_REFINE_MAX_HUMAN_COMMITS is willing to
  // pay two subrequests each for. Every skip and every failure leaves the
  // file-level answer standing.
  const humans = commits.filter((c) => c.kind === "human");
  let humanRefs: HumanRefEvidence | null = null;
  if (!page.incomplete && humans.length > 0 && humans.length <= LINEAGE_REFINE_MAX_HUMAN_COMMITS) {
    humanRefs = await fetchHumanTouchedRefs(env, file.repo, file.path, humans);
  }
  const lineage = summarizeLineage(commits, {
    incomplete: page.incomplete,
    incompleteReason: page.incompleteReason,
    humanRefs,
  });
  const summary = compactLineage(lineage);
  // Logged for every pair that fetched one, not just the ones that changed a
  // decision: "the merge kept D1 because only the pipeline moved master" is a
  // claim, and this is the measurement behind it.
  console.log("reimport master lineage", {
    book,
    resource,
    confirmedAt,
    mayHoldHumanEdit: summary.mayHoldHumanEdit,
    ...summary.counts,
    incomplete: summary.incomplete,
    incompleteReason: summary.incompleteReason,
    humanShas: summary.humanShas,
    // #557. `refsComplete: false` is not a failure to report as one — it is the
    // file-level answer standing, which is what shipped before. `refsReason`
    // names which of the two it is. The refs themselves are truncated here (the
    // count is authoritative, and the whole set is persisted below) so a nightly
    // tail stays readable.
    refsComplete: summary.refsComplete,
    refsReason: summary.refsReason,
    refCount: summary.humanRefs?.length ?? 0,
    humanRefs: summary.humanRefs?.slice(0, 12),
  });
  // page.commits is newest-first (see listMasterCommitsSince) — its first
  // entry is the far end of the walk, i.e. the master commit this summary was
  // computed as of. Empty when nothing on master moved this file since the
  // watermark; null is honest there rather than a stale prior sha.
  const asOfSha = page.commits[0]?.sha ?? null;
  await persistMasterLineage(env, book, resource, summary, asOfSha);
  return summary;
}

// Durable counterpart to the console.log above — see 0054_master_lineage_snapshot.sql.
// Last-run-wins on the same (book, resource) row every other watermark here
// already keys on. Never blocks the caller: a write failure here must not
// fail a reimport whose only mistake was wanting its evidence remembered.
//
// UPSERT, not a plain UPDATE: loadMasterLineage only ever runs with a non-null
// confirmedAt, which today always traces back to an existing row's
// master_confirmed_at — so the INSERT branch should not fire in the current
// call graph. Written as an upsert anyway (matching recordResourceSync's own
// pattern below) so a future caller, or a row deleted/recreated between the
// confirmedAt read and this write, still records the evidence instead of
// silently no-oping. origin = 'lineage_only' on the insert path is honest
// about why the row exists — NOT a real sync — and leaves source_sha NULL, so
// planAndStageBookResources's SHA skip-gate still fails open to a full
// reimport for this pair, same as a genuinely missing row.
async function persistMasterLineage(
  env: Env,
  book: string,
  resource: Resource,
  summary: MasterLineageSummary,
  asOfSha: string | null,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO book_resource_syncs (book, resource, origin, synced_at, master_lineage_json, master_lineage_sha, master_lineage_computed_at)
       VALUES (?1, ?2, 'lineage_only', unixepoch(), ?3, ?4, unixepoch())
       ON CONFLICT(book, resource) DO UPDATE SET
         master_lineage_json = excluded.master_lineage_json,
         master_lineage_sha = excluded.master_lineage_sha,
         master_lineage_computed_at = excluded.master_lineage_computed_at`,
    )
      .bind(book, resource, JSON.stringify(summary), asOfSha)
      .run();
  } catch (e) {
    console.error("reimport failed to persist master lineage", {
      book,
      resource,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// Heal AI-mangled U+FFFD in `\zaln-s` source attributes (x-content / x-lemma /
// x-morph) on the incoming verses, reconstructing from the parallel UHB/UGNT row
// in D1, BEFORE the diff/write so the repaired (clean) content lands instead of
// re-importing upstream's garbled bytes. Gated on a string `.includes("�")`, so
// the source lookup only runs for the rare verse that carries the defect — no
// extra subrequests on clean chapters (which is every chapter in steady state).
// Structure-preserving (see healReplacementChars): only attribute strings change,
// so plain_text/verse_end are untouched and nothing unaligns. Mutates each
// affected verse's contentJson in place (the same objects the write + per-row
// fallback reuse).
async function healIncomingReplacementChars(
  env: Env,
  book: string,
  bibleVersion: "ULT" | "UST",
  verses: VerseExtract[],
): Promise<void> {
  const need = verses.filter((v) => v.contentJson.includes("�"));
  if (need.length === 0) return;
  const srcVersion = NT_BOOKS.has(book) ? "UGNT" : "UHB";
  const chapters = [...new Set(need.map((v) => v.chapter))];
  const ph = chapters.map((_c, i) => `?${i + 3}`).join(", ");
  const rs = await env.DB.prepare(
    `SELECT chapter, verse, content_json FROM verses
      WHERE book = ?1 AND bible_version = ?2 AND chapter IN (${ph})`,
  )
    .bind(book, srcVersion, ...chapters)
    .all<{ chapter: number; verse: number; content_json: string }>();
  const srcByKey = new Map<string, SourceWord[]>();
  for (const r of rs.results ?? []) {
    try {
      const vo = (JSON.parse(r.content_json) as { verseObjects?: unknown[] }).verseObjects ?? [];
      srcByKey.set(`${r.chapter}:${r.verse}`, collectSourceWords(vo));
    } catch {
      /* unparseable source row — leave the target's FFFD unrepaired */
    }
  }
  for (const v of need) {
    let parsed: { verseObjects?: unknown[] };
    try {
      parsed = JSON.parse(v.contentJson) as { verseObjects?: unknown[] };
    } catch {
      continue;
    }
    const report = healReplacementChars(parsed.verseObjects ?? [], srcByKey.get(`${v.chapter}:${v.verse}`) ?? []);
    if (report.repaired.length > 0) v.contentJson = JSON.stringify(parsed);
    if (report.unrepaired.length > 0) {
      console.warn("reimport: unrepaired U+FFFD in alignment source attrs", {
        book,
        bibleVersion,
        chapter: v.chapter,
        verse: v.verse,
        unrepaired: report.unrepaired,
      });
    }
  }
}

// Reconcile the source-owned `\zaln-s` attributes (x-content/x-lemma/x-morph) of
// an EDITED verse against the incoming master verse, returning the merged
// content_json (translator's target text + grouping preserved, source spelling
// adopted from master) plus a count of source divergences that couldn't be
// uniquely reconciled. `changed` is false (json === d1Json) when nothing applied.
// Unparseable input is treated as a no-op (changed:false) so a malformed row can
// never throw out of the verse diff loop. See reconcileSourceAttrsFromMaster.
function reconcileEditedVerseSourceAttrs(
  d1Json: string,
  masterJson: string,
): { changed: boolean; json: string; divergent: number } {
  let d1Parsed: { verseObjects?: unknown[] };
  let masterParsed: { verseObjects?: unknown[] };
  try {
    d1Parsed = JSON.parse(d1Json) as { verseObjects?: unknown[] };
    masterParsed = JSON.parse(masterJson) as { verseObjects?: unknown[] };
  } catch {
    return { changed: false, json: d1Json, divergent: 0 };
  }
  const report = reconcileSourceAttrsFromMaster(d1Parsed.verseObjects ?? [], masterParsed.verseObjects ?? []);
  const changed = report.reconciled.length > 0;
  return { changed, json: changed ? JSON.stringify(d1Parsed) : d1Json, divergent: report.divergent.length };
}

// Per-verse upsert over already-parsed verses (keys off each verse's own
// chapter, so it works across a whole chunk range). Batched: ONE read of the
// current rows for these verses' chapters, an in-memory diff, then WRITE_BATCH
// (90) -sized batch() calls of the INSERT/UPDATE writes, each followed by its
// own edit_log batch. This collapses the old 2–5 D1 round-trips PER VERSE
// (insert-probe + select + update + version re-select + edit_log) down to a
// couple of subrequests per WRITE_BATCH-sized chunk — the fix for the nightly
// sync blowing the 10k-per-invocation subrequest budget on large books (PSA's
// ~5k ULT+UST verses alone exceeded it, starving every later book). Chunking
// (rather than one unchunked batch() for the whole chapter) matters on its own:
// D1 caps a single batch at 100 statements, same as every other write site in
// this file — an unchunked call on a chapter with >50 changed verses (e.g. a
// chapter-wide master change to PSA 119) would throw and silently degrade to
// the per-row fallback for the WHOLE chapter, blowing the very subrequest
// budget this batching exists to protect. content_json / plain_text /
// verse_end are stored byte-for-byte exactly as extractVersesForRange
// produced them; nothing about the USFM parse changes. The pristine guard
// (updated_by IS NULL) stays ON each UPDATE, so a translator edit landing
// between the read and the batch matches 0 rows — no clobber, and that
// statement's own meta.changes is what routes it to skipped_edited rather
// than counting a phantom update. On a slice's batch error we fall back to
// the isolated per-row path for just that slice, so one bad verse — or one
// oversized chapter — can't sink the whole book.
// An EDITED verse (updated_by != null) is NOT overwritten, but its source-owned
// `\zaln-s` attributes (x-content/x-lemma/x-morph) are reconciled from master in
// a separate version-CAS batch (see reconcileEditedVerseSourceAttrs) so a curated
// original-language fix isn't reverted by re-exporting stale source bytes.
// DO NOT revert this to a per-row loop: that regression silently reintroduced
// the subrequest cap once (PR #180 batched it → a refactor un-batched it → PR
// #195 re-batched). See the nightly-sync-subrequest-cap memory.
async function applyVerseRows(
  env: Env,
  book: string,
  bibleVersion: "ULT" | "UST",
  verses: VerseExtract[],
  userId: number | null,
  cutoff: MergeCutoff | null,
  // FIX 3: whether the master-adoption lane-reopen step (7a below) should
  // fire the best-effort broadcastChapter live-tab notification. The DELETE
  // that actually reopens the checkoff (the correctness-bearing half) always
  // runs regardless of this flag — see reopenLaneChecksBulk. true for the
  // user-triggered path (reimportVersesForChapter, inside runReimport —
  // someone IS watching that request). false for the nightly chunked path
  // (reimportStagedChunk) — WS messages are hints (CLAUDE.md) and nobody has
  // a tab open at 05:30 UTC, so there is nothing to notify and this
  // eliminates that path's broadcast subrequests entirely rather than
  // relying on a per-call cap. Defaults true so any caller that forgets to
  // pass it keeps the pre-existing (safer, notifying) behavior.
  broadcastLaneReopens: boolean = true,
): Promise<ReimportCounts> {
  const counts = zeroCounts();
  if (verses.length === 0) return counts;

  // Heal AI-mangled U+FFFD source attributes before the diff so we never write
  // (or no-op against) upstream's garbled bytes. No-op + zero extra reads unless
  // an incoming verse actually carries the defect.
  await healIncomingReplacementChars(env, book, bibleVersion, verses);

  const now = Math.floor(Date.now() / 1000);

  // 1. Read the current rows for exactly these verses' chapters in ONE query
  //    (callers pass a single chapter's verses, so the IN list is tiny).
  const chapters = [...new Set(verses.map((v) => v.chapter))];
  const chPlaceholders = chapters.map((_, i) => `?${i + 3}`).join(", ");

  // 1a. FIX 1: the verse-merge ancestor cutoff for this (book, resource) —
  // passed in by the caller (getMasterConfirmedAt), which reads it ONCE per
  // run/step rather than once per chapter (see runReimport / reimportStagedChunk).
  // NULL means never positively confirmed in master: skip the merge entirely
  // below and leave today's edited-verse handling
  // (reconcileEditedVerseSourceAttrs) exactly as it was — identical to the
  // pre-fix "no watermark row" behavior, never treated as "nothing changed".
  const resource = bibleVersion.toLowerCase();
  const lastExportAt = cutoff?.confirmedAt ?? null;
  // P1.3: precise id boundary when present; both sub-selects swap to it together.
  const masterEditId = cutoff?.editId ?? null;

  // The two merge-ancestor sub-selects are appended only when a watermark
  // exists, so a book/resource with no successful export ever pays no extra
  // read and behaves identically to before this change. When a precise id
  // boundary exists (P1.3) both sub-selects cut on `id <= / > ?N` instead of
  // `created_at < / >= ?N`, so a same-second-as-the-export-read edit is
  // attributed correctly; ?N carries either value.
  const boundaryParam = chapters.length + 3;
  const baseBoundary = masterEditId != null ? `id <= ?${boundaryParam}` : `created_at < ?${boundaryParam}`;
  const sinceBoundary = masterEditId != null ? `id > ?${boundaryParam}` : `created_at >= ?${boundaryParam}`;
  const boundaryBind = masterEditId != null ? masterEditId : lastExportAt;
  // Issue #537: `pipelineImport.ts` writes a content-bearing `action='baseline'`
  // row (the pre-AI content) whose `created_at` is deliberately back-dated to
  // that content's own timestamp, but whose `id` is assigned at AI-run time —
  // so a baseline row's id is NOT chronological with its content, and the
  // id-based `baseBoundary` above wrongly excludes it even when its real,
  // back-dated timestamp predates the watermark. `baseline` rows are therefore
  // matched on a parallel, always-timestamp boundary (never the id boundary,
  // which cannot see them correctly). base_payload orders the combined
  // candidates by `created_at DESC, id DESC` rather than `id DESC` alone —
  // for the pre-existing `create`/`update` candidates this is equivalent (id
  // is monotonic with created_at within one row's real-time history), and it
  // lets a `baseline` row compete honestly against them for "most recent
  // ancestor at/before the watermark". Measured against prod: 186 of 190
  // verses that were permanently `keep_no_base` recover a real ancestor this
  // way (see issue #537's comment thread for the corpus table).
  const baselineBoundaryParam = boundaryParam + 1;
  const mergeCols =
    lastExportAt != null
      ? `,
            (SELECT payload_json FROM edit_log
               WHERE kind = 'verse'
                 AND row_key = ?1 || '/' || chapter || '/' || verse || '/' || ?2
                 AND (book = ?1 OR book IS NULL)
                 AND (
                   (action IN ('create', 'update') AND ${baseBoundary})
                   OR (action = 'baseline' AND created_at < ?${baselineBoundaryParam})
                 )
               ORDER BY created_at DESC, id DESC LIMIT 1) AS base_payload,
            EXISTS (
              SELECT 1 FROM edit_log
               WHERE kind = 'verse'
                 AND row_key = ?1 || '/' || chapter || '/' || verse || '/' || ?2
                 AND (book = ?1 OR book IS NULL)
                 AND source IS NULL
                 -- Issue #537 fallout: a 'baseline' row is pipelineImport.ts's
                 -- own pre-AI snapshot (user_id NULL, source NULL, but never a
                 -- human touching the row), and its id is assigned at AI-run
                 -- time regardless of how old its (back-dated) content is. Left
                 -- unfiltered, recovering it as base_payload above would ALSO
                 -- make it satisfy this "human edited since export" probe on
                 -- its own id, defeating the clean case-5 adopt in
                 -- computeVerseMerge and forcing every recovered-ancestor verse
                 -- through the conflict-flagged both_changed path for no real
                 -- reason — D1 never moved. Excluded here the same way it is
                 -- deliberately INCLUDED, on its own timestamp boundary, above.
                 AND action <> 'baseline'
                 AND ${sinceBoundary}
            ) AS human_edit_after_export`
      : "";
  const existingBind: unknown[] =
    lastExportAt != null
      ? [book, bibleVersion, ...chapters, boundaryBind, lastExportAt]
      : [book, bibleVersion, ...chapters];
  const existingRs = await env.DB.prepare(
    `SELECT chapter, verse, content_json, plain_text, verse_end, version, updated_by,
            (SELECT source FROM edit_log
               WHERE kind = 'verse'
                 AND row_key = ?1 || '/' || chapter || '/' || verse || '/' || ?2
                 AND (book = ?1 OR book IS NULL)
                 AND action IN ('create', 'update')
               ORDER BY id DESC LIMIT 1) AS latest_source${mergeCols}
       FROM verses
      WHERE book = ?1 AND bible_version = ?2 AND chapter IN (${chPlaceholders})`,
  )
    .bind(...existingBind)
    .all<{
      chapter: number;
      verse: number;
      content_json: string;
      plain_text: string | null;
      verse_end: number | null;
      version: number;
      updated_by: number | null;
      latest_source: string | null;
      base_payload?: string | null;
      human_edit_after_export?: number | null;
    }>();
  const existing = new Map<string, (typeof existingRs.results)[number]>();
  for (const r of existingRs.results) existing.set(`${r.chapter}:${r.verse}`, r);

  // 2. Diff in memory. Stage a write only for verses that are new or
  //    pristine-and-changed; count no-ops / edited rows straight from the
  //    read. inserted/updated are tallied per-statement from meta.changes once
  //    each chunk's batch commits (see step 3) — never assumed up front, since
  //    an INSERT can lose an ON CONFLICT DO NOTHING race and an UPDATE can lose
  //    its `updated_by IS NULL` guard to a concurrent edit.
  const pristineWrites: Array<{
    v: VerseExtract;
    isInsert: boolean;
    stmt: D1PreparedStatement;
    // The audit row, gated on SQL-side `changes() > 0` (not a JS check after
    // the fact) so it MUST land in the exact same batch() call as `stmt`,
    // immediately after it — D1 batches are transactional, so this keeps the
    // write and its audit row atomic: either both commit or neither does.
    // Splitting them into two separate batch() calls (write batch, then a
    // JS-gated log batch) was tried and reverted — a log-batch failure after
    // a landed write batch left version-bumped verses with no edit_log row,
    // and the per-row fallback couldn't recover them (it would see the
    // content already matching and count a no-op). See step 3 below.
    logStmt: D1PreparedStatement;
  }> = [];
  // Edited verses whose source-owned alignment attrs were reconciled from master
  // (target text + grouping unchanged). Written in a separate version-CAS batch.
  const sourceReconciles: Array<{ v: VerseExtract; mergedJson: string; oldVersion: number; plainText: string | null }> = [];
  // AI-only verses (updated_by set but written by the AI pipeline, never
  // human-edited) to re-seed fully from master + reclaim to master-owned. Written
  // in a version-CAS batch below (the main batch's UPDATE guards on
  // `updated_by IS NULL`, which an AI-only verse fails). Counted `reimported_ai`.
  const aiReseeds: Array<{ v: VerseExtract; oldVersion: number }> = [];
  // Edited verses whose content is being ADOPTED from master via
  // computeVerseMerge (master moved out-of-band on Door43, D1 did not — or
  // both moved and master wins with a flagged conflict). Written in a
  // separate version-CAS batch below; updated_by is deliberately left set
  // (see the write batch's comment). See verseMerge.ts / the 1CH incident.
  const masterAdoptions: Array<{
    v: VerseExtract;
    oldVersion: number;
    merge: VerseMergeResult;
    plainText: string | null;
    // FIX 8: D1's content before this adoption, so the lane-reopen decision
    // (lanesToReopenOnVerseEdit) can tell whether the adoption actually
    // changed a word, same as verses.ts's PATCH route does for a normal save.
    beforeContentJson: string;
    // FIX A / Task 3: D1's plain_text before this adoption, so the reopen
    // step can additionally skip when the ADOPTED text is identical to what
    // was already there (a spurious "adopt" purely from render→reparse
    // churn — e.g. the occurrence/nextChar artifacts FIX A closes at the
    // content_json level — must not delete a checker's text sign-off for a
    // change that never touched the verse's actual text).
    beforePlainText: string | null;
  }> = [];
  // Verses needing a durable record after this run's merge — EVERY landed
  // adoption ("adopt" | "adopt_conflict"), every alignment refusal
  // ("keep_alignment_refused"), and every edited verse whose source-owned
  // `\zaln-s` fix on master couldn't be uniquely reconciled
  // ("source_attr_divergent" — kept D1, nothing overwritten, adopted:false).
  // FIX 2: a clean "adopt" is included here too
  // (not just the two that need human judgment) so every overwrite of
  // human-owned text has a recovery pointer — see recordVerseMergeConflicts.
  // The human-facing banner (raiseVerseMergeConflictAlert) still filters this
  // down to only "adopt_conflict"/"keep_alignment_refused" so it stays
  // actionable; see the book-level call sites.
  // `overwrittenVersion` is the version a human can find the replaced text at
  // in that verse's history — so it is only meaningful when we actually
  // overwrote something. It stays null on a refusal (we kept D1; nothing was
  // replaced), and an adopted row is only PERSISTED once its version-CAS write
  // is confirmed to have landed (FIX 3: the tentative row written before the
  // batch is deleted again if the CAS is lost) — claiming we overwrote a
  // version we did not would point a reviewer at the wrong text.
  const mergeConflicts: Array<{
    chapter: number;
    verse: number;
    action: string;
    reason: string;
    overwrittenVersion: number | null;
    alignment: VerseMergeResult["alignment"] | null;
    adopted: boolean;
    // See issue #507's version guard on UPSERT_VERSE_MERGE_CONFLICT_SQL.
    observedVersion: number | null;
  }> = [];
  for (const v of verses) {
    const ex = existing.get(`${v.chapter}:${v.verse}`);
    if (!ex) {
      const rowKey = `${book}/${v.chapter}/${v.verse}/${bibleVersion}`;
      pristineWrites.push({
        v,
        isInsert: true,
        stmt: env.DB.prepare(
          `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT(book, chapter, verse, bible_version) DO NOTHING`,
        ).bind(book, v.chapter, v.verse, v.verseEnd, bibleVersion, v.contentJson, v.plainText),
        // Conditional on the INSERT actually landing: ON CONFLICT DO NOTHING
        // means a verse that already exists (created between our read and
        // this batch) inserts 0 rows — don't log a phantom restorable v1.
        logStmt: env.DB.prepare(
          `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
           SELECT 'verse', ?1, ?2, ?3, NULL, 1, 'create', ?4, ?5
            WHERE changes() > 0`,
        ).bind(rowKey, book, userId, JSON.stringify({ plain_text: v.plainText, content: v.contentJson }), REIMPORT_SOURCE),
      });
      continue;
    }
    if (ex.updated_by != null) {
      // updated_by is set — but by WHOM? An AI-only verse (the AI pipeline wrote
      // it, no human has edited it since: latest content edit_log source is
      // ai_pipeline) is NOT translator-owned, so re-seed it fully from master and
      // reclaim it to master-owned (updated_by → NULL) — the fix for AI-generated
      // verses being wrongly reported "skipped (already edited)".
      const aiOnly = isReimportableRow({
        updated_by: ex.updated_by,
        latestSource: ex.latest_source ?? null,
        deleted_at: null,
        kind: "verse",
      });
      if (aiOnly) {
        if (
          ex.content_json === v.contentJson &&
          (ex.plain_text ?? null) === (v.plainText ?? null) &&
          (ex.verse_end ?? null) === (v.verseEnd ?? null)
        ) {
          counts.skipped_noop++;
        } else {
          aiReseeds.push({ v, oldVersion: ex.version });
        }
        continue;
      }
      // Genuinely human-edited verse — but "edited in the app" and "master
      // never moved" are independent facts. computeVerseMerge attributes a
      // D1/master difference using the recovered ancestor: if master moved
      // out-of-band on Door43 (a maintainer's direct correction) and D1 did
      // not, that correction must be adopted instead of silently reverted by
      // the next export (the 1CH incident, 2026-08-11). Only attempted when
      // this book+resource has a master_confirmed_at watermark at all — see
      // 1a above.
      // WARM-UP, and it must not be silent. `master_confirmed_at` starts NULL
      // for every existing (book, resource) — migration 0045 adds the column
      // and deliberately does not backfill it, because there is no honest value
      // to invent: only the export can MEASURE that master holds our render.
      // Until the first export stamps it, the merge cannot run, this verse
      // keeps D1, and the export will revert master exactly as it did before
      // this fix. That is the pre-existing behavior rather than a new bug, but
      // it means the fix is INERT for a book+resource until one export cycle
      // observes convergence — so count it. An absent measurement that nobody
      // can see is how the watermark-laundering and stale-skip incidents got
      // missed (see STATE.md); leaving this uncounted would make "the merge
      // never fires on this book" indistinguishable from "nothing to merge".
      if (lastExportAt == null) {
        if (ex.content_json !== v.contentJson) counts.merge_unavailable++;
      }
      if (lastExportAt != null) {
        const merge = computeVerseMerge({
          base: verseContentJsonFromPayload(ex.base_payload ?? null),
          ours: ex.content_json,
          theirs: v.contentJson,
          humanEditedSinceExport: Number(ex.human_edit_after_export ?? 0) !== 0,
          // #540 item 2, narrowed per verse by #557. Always the helper, never
          // `cutoff.lineage.hasHumanCommit` — an incomplete walk must protect
          // master exactly like a found human commit, and only this function
          // knows that. The per-verse form answers the file-level question
          // unless a COMPLETE map of every human commit's hunks says this verse
          // is not one they touched: Rich's JER chapter 23 + 31 marker fixes
          // must not authorize reverting an app edit in chapter 40. `v.verseEnd`
          // is passed because a bridged row (`\v 14-15`) is ONE row covering two
          // verses — asking only about its start verse would leave it
          // unprotected when the human's hunk landed in the second half.
          masterMayHoldHumanEdit: masterMayHoldHumanEditForVerse(
            cutoff?.lineage,
            v.chapter,
            v.verse,
            v.verseEnd,
          ),
        });
        if (merge.action === "keep_no_base") {
          counts.merge_no_base++;
          // Name the verse, capped. keep_no_base writes no verse_merge_conflicts
          // row (that table only holds adjudicated outcomes), so without this the
          // banner's own admission — "a Door43-side change to them will still be
          // overwritten by tonight's export" — points at nothing a human can open.
          const refs = (counts.merge_no_base_refs ??= []);
          if (refs.length < NO_BASE_REF_CAP) refs.push(`${v.chapter}:${v.verse}`);
          // Issue #544: the SAME verse, uncapped, carrying its CURRENT D1
          // version (ex.version, not yet touched by this run — keep_no_base
          // writes nothing) so raiseVerseMergeConflictAlert can attribute it to
          // the human who last edited it via edit_log, the same way an
          // overwritten verse is attributed via overwrittenVersion. Reachable
          // here only for a verse already established as genuinely human-edited
          // — see the `aiOnly` branch above, which `continue`s before this ever
          // runs — so ex.version's edit_log row is that human's edit.
          const editorRefs = (counts.merge_no_base_editor_refs ??= []);
          if (editorRefs.length < NO_BASE_EDITOR_REF_CAP) {
            editorRefs.push({ chapter: v.chapter, verse: v.verse, version: ex.version });
          }
        }
        if (merge.action === "keep_alignment_refused") counts.merge_refused++;
        // Deliberately NOT folded into merge_refused: that counter feeds
        // isSystemicMergeRefusal, which freezes the whole (book, resource)
        // export once five verses hit it. Freezing is exactly wrong here — the
        // export is how the human edit this outcome just protected reaches
        // Door43, and withholding it would re-create the livelock #543 killed on
        // the TSV side. Counted separately so the class is still visible.
        // `merge.adopt` is false for keep_ai_master (same as keep_alignment_refused
        // above), so it falls through past the `merge.adopt` branch below to the
        // ordinary edited-verse path — including reconcileEditedVerseSourceAttrs,
        // which still pulls master's x-content/x-lemma/x-morph onto this verse's
        // `\zaln-s` milestones (#552 item 2, decided rather than left an accident
        // of fall-through order). Kept deliberately, not just inherited: we refuse
        // master's TARGET text here because it's AI-authored with no human commit
        // behind it, but the original-language source attributes are source-owned,
        // not translator-owned — the same reasoning keep_alignment_refused already
        // relies on (the NUM 20–22 combining-mark correction is the case that
        // reconcile exists for). Refusing the target text is not a reason to also
        // refuse an unrelated, source-owned correction on the same verse.
        if (merge.action === "keep_ai_master") counts.merge_kept_ai++;
        // FIX 5: converged-per-stableKey but the raw bytes differed — a real,
        // cosmetic-only edit this comparison silently discards. See
        // verseMerge.ts's FIX 5 correction and the field's own doc comment.
        if (merge.action === "keep_converged" && ex.content_json !== v.contentJson) {
          counts.merge_cosmetic_ignored++;
        }
        // FIX 2: record EVERY landed adoption ("adopt" | "adopt_conflict"),
        // not just the conflicted ones — see mergeConflicts's declaration
        // above for why. merge.conflict alone would miss the clean "adopt"
        // case (master moved, we didn't); merge.adopt covers it.
        if (merge.conflict || merge.adopt) {
          mergeConflicts.push({
            chapter: v.chapter,
            verse: v.verse,
            action: merge.action,
            reason: merge.reason,
            overwrittenVersion: merge.adopt ? ex.version : null,
            alignment: merge.alignment ?? null,
            adopted: merge.adopt,
            // See issue #507: the version this verse's merge outcome was
            // detected at, so the speculative upsert's reactivation carve-out
            // (keep_alignment_refused / keep_ai_master) can tell a stale
            // re-detection from a fresh one. Unused (and harmless) for
            // 'adopt' / 'adopt_conflict'.
            observedVersion: ex.version,
          });
        }
        if (merge.adopt) {
          masterAdoptions.push({
            v,
            oldVersion: ex.version,
            merge,
            plainText: v.plainText,
            beforeContentJson: ex.content_json,
            beforePlainText: ex.plain_text,
          });
          continue;
        }
      }
      // Otherwise the translator owns the target text + grouping, so we never
      // overwrite the verse wholesale. BUT the original-language source
      // attributes on its `\zaln-s` milestones (x-content/x-lemma/x-morph) are
      // SOURCE-owned, not translator-owned — reconcile just those from master
      // so a curated source fix (e.g. the NUM 20–22 combining-mark correction)
      // isn't reverted when the nightly export re-renders this verse. Staged into
      // a separate version-CAS batch below; if nothing reconciled it stays a plain
      // edited skip. (verses analogue of the TWL-PSA / Hebrew-NFC clobber class.)
      const rec = reconcileEditedVerseSourceAttrs(ex.content_json, v.contentJson);
      if (rec.divergent > 0) {
        counts.source_attr_divergent += rec.divergent;
        console.warn("reimport: source-attr divergence on edited verse couldn't be uniquely reconciled from master", {
          book, bibleVersion, chapter: v.chapter, verse: v.verse, divergent: rec.divergent,
        });
        // Make the un-adopted master source fix VISIBLE instead of only a
        // counter + log line. The reconcile refused to adopt because the same
        // source word repeats in this verse (EZK 40's architectural terms) — so
        // master's curated original-language fix stays un-applied and tonight's
        // export will render D1's stale source bytes back over master, silently
        // reverting it (the [[project_edited_row_skips_master_edit]] class).
        // Record a keep-D1 conflict — nothing was overwritten, so
        // overwrittenVersion is null (same invariant as keep_alignment_refused)
        // — so it lands in verse_merge_conflicts and the review banner. One row
        // per verse regardless of how many (key, attr) pairs diverged; adopted
        // is false, so it never enters the master-adoption CAS/cleanup dance and
        // it does NOT feed the systemic-refusal watermark gate (merge_refused) —
        // so divergences at scale never freeze the book's export. (A transient
        // D1 failure while RECORDING these rows still withholds the watermark
        // for one self-healing night via merge_record_failed — the fail-safe
        // every conflict recording shares, protective, not a freeze.) Keep D1,
        // surface it. Re-detection reactivates a flag a human resolved without
        // fixing the source (see UPSERT_VERSE_MERGE_CONFLICT_SQL's carve-out).
        mergeConflicts.push({
          chapter: v.chapter,
          verse: v.verse,
          action: "source_attr_divergent",
          reason: "source_attr_ambiguous",
          overwrittenVersion: null,
          alignment: null,
          adopted: false,
          // See issue #507: the version this divergence was detected at.
          observedVersion: ex.version,
        });
      }
      if (rec.changed) {
        sourceReconciles.push({ v, mergedJson: rec.json, oldVersion: ex.version, plainText: ex.plain_text });
      } else {
        counts.skipped_edited++;
      }
      continue;
    }
    if (
      ex.content_json === v.contentJson &&
      (ex.plain_text ?? null) === (v.plainText ?? null) &&
      (ex.verse_end ?? null) === (v.verseEnd ?? null)
    ) {
      counts.skipped_noop++;
      continue;
    }
    // Pristine + changed → update. The guard stays on the UPDATE; new_version is
    // ex.version + 1 because the update only applies while the row is untouched.
    {
      const rowKey = `${book}/${v.chapter}/${v.verse}/${bibleVersion}`;
      pristineWrites.push({
        v,
        isInsert: false,
        stmt: env.DB.prepare(
          `UPDATE verses
              SET content_json = ?1, plain_text = ?2, verse_end = ?3,
                  version = version + 1, updated_at = ?4
            WHERE book = ?5 AND chapter = ?6 AND verse = ?7 AND bible_version = ?8
              AND updated_by IS NULL`,
        ).bind(v.contentJson, v.plainText, v.verseEnd, now, book, v.chapter, v.verse, bibleVersion),
        // Conditional on the UPDATE actually landing. The UPDATE is guarded
        // on `updated_by IS NULL`, so if an editor touched this verse between
        // our read and this batch the UPDATE matches 0 rows — but the
        // content we'd log never landed. An unconditional insert would
        // record a phantom restorable version carrying stale DCS content.
        logStmt: env.DB.prepare(
          `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
           SELECT 'verse', ?1, ?2, ?3, ?4, ?5, 'update', ?6, ?7
            WHERE changes() > 0`,
        ).bind(rowKey, book, userId, ex.version, ex.version + 1, JSON.stringify({ plain_text: v.plainText, content: v.contentJson }), REIMPORT_SOURCE),
      });
    }
  }

  // 3. Chunked batches for all pristine INSERT/UPDATE writes, each verse's
  //    write statement immediately followed by its own SQL-`changes()`-gated
  //    audit row IN THE SAME batch() call — two statements per verse, so
  //    chunked at PRISTINE_PAIR_BATCH (half of WRITE_BATCH) to stay within
  //    the same ≤100-statement D1 cap this file asserts everywhere else.
  //    Keeping the write and its audit row in one atomic batch (rather than
  //    a separate follow-up batch of logs) matters: a batch() call is one D1
  //    transaction, so either both land or neither does. Splitting them
  //    across two batch() calls was tried and reverted — if the (separate)
  //    log batch failed after the write batch had already landed, the catch
  //    below would fall back to the per-row path, which would see the
  //    content already matching and count a silent no-op, permanently
  //    losing the audit row for a verse whose version really did bump.
  //    changes() reflects the immediately-preceding statement, so a lost
  //    race (ON CONFLICT DO NOTHING on the INSERT; the `updated_by IS NULL`
  //    guard losing to a concurrent edit on the UPDATE) is never logged as a
  //    phantom restorable version and never counted as inserted/updated — a
  //    lost UPDATE is routed to skipped_edited (mirrors the aiReseeds/
  //    sourceReconciles batches below); a lost INSERT is routed to
  //    skipped_noop (the verse now exists, same as reading it fresh would
  //    have shown). On a slice failure, only that slice falls back to the
  //    isolated per-row path so one bad verse — or one oversized chapter's
  //    worth of verses — can't sink the whole book.
  const PRISTINE_PAIR_BATCH = Math.floor(WRITE_BATCH / 2);
  for (let i = 0; i < pristineWrites.length; i += PRISTINE_PAIR_BATCH) {
    const slice = pristineWrites.slice(i, i + PRISTINE_PAIR_BATCH);
    const stmts: D1PreparedStatement[] = [];
    for (const w of slice) stmts.push(w.stmt, w.logStmt);
    try {
      const results = await env.DB.batch(stmts);
      slice.forEach((w, j) => {
        const changed = (results[j * 2]?.meta.changes ?? 0) > 0;
        if (!changed) {
          if (w.isInsert) counts.skipped_noop++;
          else counts.skipped_edited++;
          return;
        }
        if (w.isInsert) counts.inserted++;
        else counts.updated++;
      });
    } catch (e) {
      console.error("reimport verse batch failed; falling back per-row", {
        book,
        bibleVersion,
        chapters,
        error: e instanceof Error ? e.message : String(e),
      });
      addCounts(counts, await applyVerseRowsPerRow(env, book, bibleVersion, slice.map((w) => w.v), userId));
    }
  }

  // 4. Reconcile source-owned alignment attrs on edited verses. Separate batch:
  //    the UPDATE is guarded on version-CAS (`AND version = oldVersion`) but
  //    intentionally NOT on `updated_by IS NULL` — the verse IS edited; only its
  //    source spelling syncs, and updated_by is left untouched so the row stays
  //    translator-owned. A translator edit landing between the read and the batch
  //    bumps version → matches 0 rows → counted skipped_edited (no clobber).
  //    Audited only when the UPDATE actually applied (meta.changes > 0).
  for (let i = 0; i < sourceReconciles.length; i += WRITE_BATCH) {
    const slice = sourceReconciles.slice(i, i + WRITE_BATCH);
    try {
      const results = await env.DB.batch(
        slice.map((u) =>
          env.DB.prepare(
            `UPDATE verses
                SET content_json = ?1, version = version + 1, updated_at = ?2
              WHERE book = ?3 AND chapter = ?4 AND verse = ?5 AND bible_version = ?6
                AND version = ?7`,
          ).bind(u.mergedJson, now, book, u.v.chapter, u.v.verse, bibleVersion, u.oldVersion),
        ),
      );
      const logs: D1PreparedStatement[] = [];
      slice.forEach((u, j) => {
        if ((results[j]?.meta.changes ?? 0) > 0) {
          counts.source_attr_reconciled++;
          console.warn("reimport: reconciled source-owned \\zaln attrs on edited verse from master", {
            book, bibleVersion, chapter: u.v.chapter, verse: u.v.verse,
          });
          logs.push(
            logEditStmt(
              env, "verse",
              `${book}/${u.v.chapter}/${u.v.verse}/${bibleVersion}`,
              book, userId, u.oldVersion, u.oldVersion + 1, "update",
              { plain_text: u.plainText, content: u.mergedJson },
            ),
          );
        } else {
          counts.skipped_edited++;
        }
      });
      if (logs.length) await env.DB.batch(logs);
    } catch (e) {
      // Correctness-bearing: this batch syncs a curated source fix onto an
      // edited verse. A thrown batch leaves D1 stale — taint so the watermark
      // is withheld and the export doesn't revert master un-retried.
      counts.apply_incomplete = true;
      counts.errors.push(`verse source-attr reconcile batch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 5. Re-seed AI-only verses from master + reclaim to master-owned. Separate
  //    batch: version-CAS-guarded (`AND version = oldVersion`), NOT
  //    `updated_by IS NULL` — the verse IS AI-owned, and we set `updated_by = NULL`
  //    to return it to master-owned. A human edit landing between the read and the
  //    batch bumps version → 0 rows → counted skipped_edited (no clobber). Audited
  //    only when the UPDATE actually applied.
  for (let i = 0; i < aiReseeds.length; i += WRITE_BATCH) {
    const slice = aiReseeds.slice(i, i + WRITE_BATCH);
    try {
      const results = await env.DB.batch(
        slice.map((u) =>
          env.DB.prepare(
            `UPDATE verses
                SET content_json = ?1, plain_text = ?2, verse_end = ?3,
                    updated_by = NULL, version = version + 1, updated_at = ?4
              WHERE book = ?5 AND chapter = ?6 AND verse = ?7 AND bible_version = ?8
                AND version = ?9`,
          ).bind(u.v.contentJson, u.v.plainText, u.v.verseEnd, now, book, u.v.chapter, u.v.verse, bibleVersion, u.oldVersion),
        ),
      );
      const logs: D1PreparedStatement[] = [];
      slice.forEach((u, j) => {
        if ((results[j]?.meta.changes ?? 0) > 0) {
          counts.reimported_ai++;
          logs.push(
            logEditStmt(
              env, "verse",
              `${book}/${u.v.chapter}/${u.v.verse}/${bibleVersion}`,
              book, userId, u.oldVersion, u.oldVersion + 1, "update",
              { plain_text: u.v.plainText, content: u.v.contentJson },
            ),
          );
        } else {
          counts.skipped_edited++;
        }
      });
      if (logs.length) await env.DB.batch(logs);
    } catch (e) {
      counts.errors.push(`verse ai-reseed batch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 6. Canonize Hebrew/Greek alignment source attrs on adopted master content
  // BEFORE writing it. Adopted bytes come straight from master and may carry
  // legacy (non-UHB) combining-mark order in `\zaln-s` x-content/x-lemma — the
  // same corruption class as the NUM 20–22 incident. Gated on
  // masterAdoptions.length so a normal night with nothing to adopt pays zero
  // extra reads. Restricted to the chapters actually present in
  // masterAdoptions. A verse whose source words aren't available is left
  // as-is rather than guessed — canonizeAlignmentSource is itself fail-closed
  // on ambiguity, but skipping here also avoids the query when nothing needs
  // it. Mutates each adoption's v.contentJson in place, same convention as
  // healIncomingReplacementChars above.
  if (masterAdoptions.length > 0) {
    const adoptChapters = [...new Set(masterAdoptions.map((a) => a.v.chapter))];
    const srcVersion = NT_BOOKS.has(book) ? "UGNT" : "UHB";
    const srcPh = adoptChapters.map((_c, i) => `?${i + 3}`).join(", ");
    const srcRs = await env.DB.prepare(
      `SELECT chapter, verse, content_json FROM verses
        WHERE book = ?1 AND bible_version = ?2 AND chapter IN (${srcPh})`,
    )
      .bind(book, srcVersion, ...adoptChapters)
      .all<{ chapter: number; verse: number; content_json: string }>();
    const srcByKey = new Map<string, SourceWord[]>();
    for (const r of srcRs.results ?? []) {
      try {
        const vo = (JSON.parse(r.content_json) as { verseObjects?: unknown[] }).verseObjects ?? [];
        srcByKey.set(`${r.chapter}:${r.verse}`, collectSourceWords(vo));
      } catch {
        /* unparseable source row — leave this verse's adopted content uncanonized */
      }
    }
    for (const a of masterAdoptions) {
      // FIX 9: union source words across the verse's FULL bridge range
      // (v.verseEnd), mirroring pipelineImport.ts's sourceWordsForRange — a
      // bridged adopted verse otherwise only ever matched its FIRST verse's
      // source words, leaving the rest of the bridge uncanonized (fail-open,
      // not corrupting).
      const words = sourceWordsForVerseRange(srcByKey, a.v.chapter, a.v.verse, a.v.verseEnd);
      if (words.length === 0) continue; // source words unavailable — don't guess
      try {
        const parsed = JSON.parse(a.v.contentJson) as { verseObjects?: unknown[] };
        if (Array.isArray(parsed.verseObjects)) {
          canonizeAlignmentSource(parsed.verseObjects, words);
          a.v.contentJson = JSON.stringify(parsed);
        }
      } catch {
        /* unparseable adopted content — leave as-is */
      }
    }
  }

  // 6b. FIX 3: write EVERY merge-conflict row (including tentative "adopt"
  // rows whose CAS hasn't run yet) BEFORE the adoption batch below, not
  // after. `applyVerseRows` runs inside a Workflow `step.do` that retries on
  // failure — if the write batch below lands but the isolate dies before the
  // OLD post-write recording ran, a retry re-reads D1 (now equal to master),
  // computes `keep_converged`, and nothing is ever recorded even though the
  // overwrite already happened. Writing first means the failure mode inverts
  // to "a spurious flag for a write that turns out lost" (harmless — cleaned
  // up just below) instead of "a lost write with no recovery pointer at all".
  // recordVerseMergeConflicts's INSERT is idempotent (ON CONFLICT DO UPDATE),
  // so writing here and again if this call retries is safe.
  let recordFailed = false;
  if (mergeConflicts.length > 0) {
    const allConflictRows = mergeConflicts.map((mc) => ({
      chapter: mc.chapter,
      verse: mc.verse,
      action: mc.action,
      reason: mc.reason,
      overwrittenVersion: mc.overwrittenVersion,
      alignment: mc.alignment,
      observedVersion: mc.observedVersion,
    }));
    const recorded = await recordVerseMergeConflicts(env, book, resource, bibleVersion, allConflictRows, now);
    if (!recorded) recordFailed = true;
  }

  // 7. Write master adoptions — a human's out-of-band correction on Door43
  // master (or master's side of a both-sides-moved conflict), adopted into
  // D1. Mirrors the source-attr reconcile batch above exactly: version-CAS
  // guard, changes()-gated counter + audit, logs flushed in a separate batch.
  // merge_adopted counts only writes that actually landed; a lost CAS race
  // falls to skipped_edited, same as every other batch here. updated_by is
  // deliberately LEFT SET — we are not erasing the fact a human once owned
  // this verse, and leaving it set means the NEXT sync still routes through
  // computeVerseMerge (which will see D1 now equals master and return
  // keep_converged, writing nothing).
  // Which adoptions actually landed, so the cleanup below only keeps rows for
  // verses we really overwrote — a lost CAS race means a human wrote the
  // verse between our read and our write, so nothing of theirs was replaced
  // and there is nothing yet to review. The next sync re-evaluates that verse
  // from scratch.
  //
  // FIX B: an overwrite must never land without its recovery pointer. If
  // step 6b's recordVerseMergeConflicts write just failed (recordFailed),
  // some or all of these adoptions have no durable verse_merge_conflicts row
  // — writing the CAS batch anyway would overwrite human-owned text with
  // nothing but a vague book-level banner pointing a reviewer nowhere. Fail
  // closed: skip the whole adoption write batch for this call.
  //
  // FIX 1 CORRECTION: this comment previously claimed "nothing is lost by
  // skipping — masterAdoptions is recomputed fresh on the next sync." That
  // was false as written: skipping here did NOT, by itself, stop tonight's
  // export from rendering D1's un-adopted content over master (reverting
  // the maintainer's correction), and once that export stamped a fresh SHA
  // watermark, the NEXT run's planAndStageBookResources SHA-skip gate would
  // treat this resource as unchanged and never retry it at all — the same
  // silent-revert shape as the 1CH incident this PR exists to fix, just
  // relocated to the recording-failure path. The actual fix lives in the
  // caller: `runChunkedReimport`'s `reimport-sync-${book}` step now
  // withholds the sync watermark for any resource whose
  // `merge_record_failed` is set (alongside the existing chapters_locked /
  // prune_locked / systemic-refusal gates), which is what makes "the next
  // sync recomputes masterAdoptions fresh and retries" actually true.
  // counts.merge_adopted and adoptionsApplied simply stay at whatever they
  // already were (0 / empty here), which is honest: nothing was written
  // this call. Separately: these skipped verses land in NO counter and NO
  // `counts.errors` entry below this point on their own — see the
  // `counts.errors.push` / `counts.skipped_edited` bump right after this
  // log, added so they're accounted for rather than invisible (FIX 8).
  const adoptionsApplied = new Set<string>();
  if (recordFailed && masterAdoptions.length > 0) {
    console.error("reimport: skipping master-adoption write batch — merge-conflict recording failed this run", {
      book, bibleVersion, skipped: masterAdoptions.length,
    });
    // FIX 8: these verses were skipped this call and previously landed in NO
    // counter — not merge_adopted, not merge_conflicts, not errors — making
    // the skip invisible to anyone reading counts alone (the console.error
    // above is easy to miss). skipped_edited already means "nothing written
    // this call, existing content stands" for every other lost-write path in
    // this function (a lost CAS race below, a lost source-attr-reconcile
    // race in step 4); this is the same outcome for the same reason.
    counts.skipped_edited += masterAdoptions.length;
    counts.errors.push(
      `verse master-adoption batch skipped for ${masterAdoptions.length} verse(s) in ${book} ${bibleVersion}: ` +
        `merge-conflict recording failed this run (see merge_record_failed)`,
    );
  } else {
    for (let i = 0; i < masterAdoptions.length; i += WRITE_BATCH) {
      const slice = masterAdoptions.slice(i, i + WRITE_BATCH);
      try {
        const results = await env.DB.batch(
          slice.map((a) =>
            env.DB.prepare(
              `UPDATE verses
                  SET content_json = ?1, plain_text = ?2, verse_end = ?3,
                      version = version + 1, updated_at = ?4
                WHERE book = ?5 AND chapter = ?6 AND verse = ?7 AND bible_version = ?8
                  AND version = ?9`,
            ).bind(a.v.contentJson, a.plainText, a.v.verseEnd, now, book, a.v.chapter, a.v.verse, bibleVersion, a.oldVersion),
          ),
        );
        const logs: D1PreparedStatement[] = [];
        slice.forEach((a, j) => {
          if ((results[j]?.meta.changes ?? 0) > 0) {
            counts.merge_adopted++;
            adoptionsApplied.add(`${a.v.chapter}:${a.v.verse}`);
            console.warn("reimport: adopted master's out-of-band correction over D1 (verseMerge)", {
              book, bibleVersion, chapter: a.v.chapter, verse: a.v.verse, action: a.merge.action, reason: a.merge.reason,
            });
            logs.push(
              logEditStmt(
                env, "verse",
                `${book}/${a.v.chapter}/${a.v.verse}/${bibleVersion}`,
                book, userId, a.oldVersion, a.oldVersion + 1, "update",
                { plain_text: a.plainText, content: a.v.contentJson },
              ),
            );
          } else {
            // Lost the version-CAS race — a human wrote this verse between our
            // read and this batch. Master's correction did NOT land, so D1 is
            // still stale for it: withhold the watermark or the export reverts
            // master with no retry (Codex P1.2 — the CAS-race twin of the thrown-
            // batch gate; previously only skipped_edited, which does not gate).
            counts.skipped_edited++;
            counts.apply_incomplete = true;
            console.warn("reimport: verse master-adoption lost the version-CAS race; withholding watermark for retry", {
              book, bibleVersion, chapter: a.v.chapter, verse: a.v.verse,
            });
          }
        });
        if (logs.length) await env.DB.batch(logs);
      } catch (e) {
        // Correctness-bearing: this batch adopts a maintainer's out-of-band
        // Door43 correction into D1. A thrown batch leaves D1 stale — taint so
        // the reimport-sync step withholds this resource's watermark (Codex's
        // failed-adoption-write gate), instead of certifying stale D1 in-sync
        // and letting the export revert master with no retry.
        counts.apply_incomplete = true;
        counts.errors.push(`verse master-adoption batch: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // 7a. FIX 8: adopting master's edit changes words, but it happens on the
  // Workflow's write path, not verses.ts's PATCH route — so the checkoff-
  // reopen logic a normal save triggers (lanesToReopenOnVerseEdit /
  // reopenLaneChecks) never runs for it. Run it here for every LANDED
  // adoption (bounded by adoptionsApplied — a lost CAS race changed nothing,
  // so there's nothing to reopen). A parse failure on either side is treated
  // as "assume the words changed" (the safe direction — a stale check
  // surviving an edit is the failure mode this exists to close) rather than
  // thrown.
  //
  // FIX 4 CORRECTION: computing `lanes` used to happen AFTER an early return
  // that fired whenever the adopted content's plain text matched what was
  // there before (collapseWhitespaceForCompare, same rule as FIX A) — Task
  // 3's guard against deleting a checker's 'text' sign-off for a spurious
  // "adopt" that never actually changed the verse's text. But that early
  // return skipped `lanesToReopenOnVerseEdit` entirely, so it ALSO dropped
  // the 'tw' (Words) lane for any adoption whose `\w` TOKENIZATION changed
  // while its plain text did not — e.g. D1 [w("and"), text " ", w("the")]
  // vs master [w("and the")]: identical plain text ("and the"), but
  // `wordSequenceUnchanged: false`, so `lanesToReopenOnVerseEdit("ULT",
  // false)` should return `["text", "tw"]` and reopen Words. The old guard
  // fired first and reopened neither, leaving a Words checkoff signed off
  // against a changed aligned-word set. Fix: compute wordSequenceUnchanged
  // and the candidate lanes UNCONDITIONALLY, then drop only the 'text' lane
  // when plain text didn't change — 'tw' stays gated purely on
  // wordSequenceUnchanged, as lanesToReopenOnVerseEdit intends. Note:
  // plain_text is already whitespace-collapsed at extraction time
  // (importParsers.ts's collectPlainText, ~line 980), so
  // collapseWhitespaceForCompare here is defensive only, not the primary
  // equality check.
  //
  // FIX 3: the correctness-bearing DELETE and the best-effort broadcast are
  // both now issued via reopenLaneChecksBulk (laneReopen.ts), which batches
  // the DELETEs (one subrequest per REOPEN_WRITE_BATCH-sized slice, not one
  // per verse) and applies LANE_REOPEN_BROADCAST_CAP across this whole call.
  // `broadcastLaneReopens` (this function's parameter) controls whether the
  // broadcast half fires at all — see its own doc for which caller passes
  // which value and why.
  const landedAdoptions = masterAdoptions.filter((a) => adoptionsApplied.has(`${a.v.chapter}:${a.v.verse}`));

  // 7a-confirm. Two-phase reactivation, CONFIRMING half (2026-08-15 Codex
  // second-opinion review fix): step 6b's recordVerseMergeConflicts upsert
  // above runs SPECULATIVELY, before this CAS batch, and deliberately does
  // NOT clear resolved_at/resolved_by — only a LANDED adoption may do that,
  // so a verse whose adoption LOSES its CAS race never falsely reactivates a
  // conflict that was never actually overwritten. Scoped to `landedAdoptions`
  // only (never the lost ones, which deleteLostAdoptionConflicts below
  // handles on its own, disjoint ref set). See confirmAdoptedConflicts's and
  // verseMergeConflictSql.ts's UPSERT_VERSE_MERGE_CONFLICT_SQL doc comments
  // for the full incident this closes.
  if (landedAdoptions.length > 0) {
    await confirmAdoptedConflicts(
      env,
      book,
      resource,
      landedAdoptions.map((a) => ({ chapter: a.v.chapter, verse: a.v.verse })),
    );
  }

  const reopenEntries: Array<{ chapter: number; verse: number; lanes: CheckLane[] }> = [];
  for (const a of landedAdoptions) {
    const lanes = lanesForAdoption(bibleVersion, a.beforePlainText, a.plainText, a.beforeContentJson, a.v.contentJson);
    if (lanes.length === 0) {
      console.log("reimport: skipped lane reopen — adoption changed neither plain_text nor word sequence", {
        book, bibleVersion, chapter: a.v.chapter, verse: a.v.verse,
      });
      continue;
    }
    reopenEntries.push({ chapter: a.v.chapter, verse: a.v.verse, lanes });
  }
  await reopenLaneChecksBulk(env, book, reopenEntries, broadcastLaneReopens);

  // 7b. FIX 3 (cleanup half): the CAS batch above may have lost the race on
  // some adoptions (a human wrote the verse first). Their conflict row was
  // written speculatively in step 6b before we knew that — delete it now so
  // it never misdirects a reviewer to a version that still holds their
  // current text. Refused verses (never attempted a write) are untouched —
  // `mc.adopted` is false for `keep_alignment_refused`, and
  // deleteLostAdoptionConflicts is additionally scoped to
  // `action IN ('adopt', 'adopt_conflict')` as a second, independent guard.
  //
  // FIX 2 CORRECTION: this used to force `lostAdoptionRefs = []` whenever
  // `recordFailed`, on the theory that step 7's adoption-write batch never
  // ran, so nothing here could distinguish "never attempted" from "tried and
  // lost the race" — and running the cleanup would erase whatever
  // verse_merge_conflicts rows DID land from step 6b's WRITE_BATCH-sized
  // slices before the failing slice. That reasoning protected the wrong
  // thing: recordVerseMergeConflicts can fail on batch k>1 with batches
  // 1..k-1 already persisted, and step 7 above skips the ENTIRE adoption
  // write batch when recordFailed (not just the un-recorded slice) — so
  // EVERY row from those earlier-persisted slices asserts
  // `overwritten_version = ex.version` for a verse whose CAS write was never
  // attempted at all. That is a false claim, not evidence worth preserving —
  // it would point a reviewer at a version as "replaced" when the replacement
  // never happened. Since adoptionsApplied is provably empty on the
  // recordFailed path (step 7's else-branch, which is the only place
  // anything gets added to it, never runs), the plain filter below already
  // selects every planned adoption ref in that case — there is no special
  // case left to write; forcing `[]` was actively wrong.
  const lostAdoptionRefs = mergeConflicts
    .filter((mc) => mc.adopted && !adoptionsApplied.has(`${mc.chapter}:${mc.verse}`))
    .map((mc) => ({ chapter: mc.chapter, verse: mc.verse }));
  if (lostAdoptionRefs.length > 0) {
    // Same `now` passed to step 6b's recordVerseMergeConflicts call above —
    // required for deleteLostAdoptionConflicts's detected_at-based scoping to
    // correctly identify only THIS run's own speculative rows (see that
    // function's doc comment).
    await deleteLostAdoptionConflicts(env, book, resource, lostAdoptionRefs, now);
  }

  // 8. Tally this run's landed merge conflicts. FIX 2: excludes a clean
  // "adopt" (master moved, we didn't) — that case needs no human judgment, so
  // it is durably recorded (step 6b, for the audit trail) but not counted
  // here, matching the banner alert's filter (see the book-level call sites
  // in runReimport / runChunkedReimport, which read verse_merge_conflicts
  // directly rather than the rows this call staged). FIX 5: this run's
  // recording failure (if any) is surfaced via merge_record_failed so the
  // caller can fold it into the book-level alert instead of silently letting
  // the "Recorded durably" claim go unverified.
  const liveConflicts = mergeConflicts.filter(
    (mc) => (!mc.adopted || adoptionsApplied.has(`${mc.chapter}:${mc.verse}`)) && mc.action !== "adopt",
  );
  counts.merge_conflicts += liveConflicts.length;
  if (recordFailed) counts.merge_record_failed = true;

  return counts;
}

// Per-row upsert fallback — the original, error-isolated implementation. Invoked
// only when the batched applyVerseRows hits an atomic batch() error, so one bad
// verse can't sink a whole chapter. Keys off each verse's own chapter.
async function applyVerseRowsPerRow(
  env: Env,
  book: string,
  bibleVersion: "ULT" | "UST",
  verses: VerseExtract[],
  userId: number | null,
): Promise<ReimportCounts> {
  const counts = zeroCounts();
  if (verses.length === 0) return counts;

  const now = Math.floor(Date.now() / 1000);
  for (const v of verses) {
    try {
      // Try insert first; cheap signal for "doesn't exist locally".
      const ins = await env.DB.prepare(
        `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(book, chapter, verse, bible_version) DO NOTHING`,
      )
        .bind(book, v.chapter, v.verse, v.verseEnd, bibleVersion, v.contentJson, v.plainText)
        .run();
      if ((ins.meta.changes ?? 0) > 0) {
        counts.inserted++;
        await logEdit(
          env, "verse",
          `${book}/${v.chapter}/${v.verse}/${bibleVersion}`,
          book, userId, null, 1, "create",
          { plain_text: v.plainText, content: v.contentJson },
        );
        continue;
      }
      // Exists locally — SELECT first so we can short-circuit on byte-equal
      // content. content_json is produced by extractVersesForRange in both
      // directions (bootstrap + reimport), so byte-compare is stable for
      // pristine rows. version/updated_by/latest_source drive the pristine vs
      // AI-only vs human-edited classification (mirrors the batched path).
      const existing = await env.DB.prepare(
        `SELECT content_json, plain_text, verse_end, version, updated_by,
                (SELECT source FROM edit_log
                   WHERE kind = 'verse'
                     AND row_key = ?1 || '/' || ?2 || '/' || ?3 || '/' || ?4
                     AND (book = ?1 OR book IS NULL)
                     AND action IN ('create', 'update')
                   ORDER BY id DESC LIMIT 1) AS latest_source
           FROM verses
          WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4`,
      )
        .bind(book, v.chapter, v.verse, bibleVersion)
        .first<{
          content_json: string;
          plain_text: string | null;
          verse_end: number | null;
          version: number;
          updated_by: number | null;
          latest_source: string | null;
        }>();
      if (
        existing &&
        existing.content_json === v.contentJson &&
        (existing.plain_text ?? null) === (v.plainText ?? null) &&
        (existing.verse_end ?? null) === (v.verseEnd ?? null)
      ) {
        counts.skipped_noop++;
        continue;
      }
      // AI-only verse (updated_by set, latest content edit_log source is AI):
      // re-seed from master + reclaim to master-owned via a version-CAS UPDATE
      // (no `updated_by IS NULL` guard). A human edit landing first bumps version
      // → 0 rows → skipped_edited. Human-edited verses fall through to the
      // pristine UPDATE below, whose `updated_by IS NULL` guard skips them.
      const aiOnly =
        existing != null &&
        existing.updated_by != null &&
        isReimportableRow({
          updated_by: existing.updated_by,
          latestSource: existing.latest_source ?? null,
          deleted_at: null,
          kind: "verse",
        });
      if (aiOnly) {
        const upd = await env.DB.prepare(
          `UPDATE verses
              SET content_json = ?1, plain_text = ?2, verse_end = ?3,
                  updated_by = NULL, version = version + 1, updated_at = ?4
            WHERE book = ?5 AND chapter = ?6 AND verse = ?7 AND bible_version = ?8
              AND version = ?9`,
        )
          .bind(v.contentJson, v.plainText, v.verseEnd, now, book, v.chapter, v.verse, bibleVersion, existing!.version)
          .run();
        if ((upd.meta.changes ?? 0) > 0) {
          counts.reimported_ai++;
          await logEdit(
            env, "verse",
            `${book}/${v.chapter}/${v.verse}/${bibleVersion}`,
            book, userId, existing!.version, existing!.version + 1, "update",
            { plain_text: v.plainText, content: v.contentJson },
          );
        } else {
          counts.skipped_edited++;
        }
        continue;
      }
      const upd = await env.DB.prepare(
        `UPDATE verses
            SET content_json = ?1, plain_text = ?2, verse_end = ?3,
                version = version + 1, updated_at = ?4
          WHERE book = ?5 AND chapter = ?6 AND verse = ?7 AND bible_version = ?8
            AND updated_by IS NULL`,
      )
        .bind(v.contentJson, v.plainText, v.verseEnd, now, book, v.chapter, v.verse, bibleVersion)
        .run();
      if ((upd.meta.changes ?? 0) > 0) {
        counts.updated++;
        const got = await env.DB.prepare(
          `SELECT version FROM verses
            WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4`,
        )
          .bind(book, v.chapter, v.verse, bibleVersion)
          .first<{ version: number }>();
        if (got) {
          await logEdit(
            env, "verse",
            `${book}/${v.chapter}/${v.verse}/${bibleVersion}`,
            book, userId, got.version - 1, got.version, "update",
            { plain_text: v.plainText, content: v.contentJson },
          );
        }
      } else {
        counts.skipped_edited++;
      }
    } catch (e) {
      counts.errors.push(
        `verse ${bibleVersion} ${book} ${v.chapter}:${v.verse}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return counts;
}

// ── Audit ──────────────────────────────────────────────────────────────────

async function logEdit(
  env: Env,
  kind: "tn" | "tq" | "twl" | "verse",
  rowKey: string,
  book: string,
  userId: number | null,
  prevVersion: number | null,
  newVersion: number,
  action: "create" | "update",
  payload: unknown,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO edit_log
       (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(kind, rowKey, book, userId, prevVersion, newVersion, action, JSON.stringify(payload), REIMPORT_SOURCE)
    .run();
}

// ── Chunked, SHA-gated, diff-aware reimport (Workflow path) ─────────────────
//
// reimportBookFromDcs (above) runs in one call and is used by the HTTP route
// (client-supplied chapters) + first-time bootstrap. It is NOT safe inside a
// Cloudflare Workflow step for a large book — per-chapter re-parse + sequential
// D1 round-trips blow the 600 000 ms step limit (what failed on Isaiah). The
// functions below run the same row-level logic but:
//   1. skip a whole (book,resource) when its DCS file commit SHA is unchanged,
//   2. fetch each changed file once and stage it to R2,
//   3. process chapters in REIMPORT_CHAPTER_CHUNK-sized Workflow steps,
//   4. for TSV, skip chapters whose pristine content already matches DCS.
// No per-book lock is taken: a Workflow step REPLAYS on retry, so a held lock
// would self-deadlock; the pristine `WHERE updated_by IS NULL ...` UPDATE guard
// (unchanged) is the real protection against clobbering a concurrent edit.

interface StagedResource {
  resource: Resource;
  changed: boolean;        // false → SHA unchanged, DCS 404, or own-publish
  masterSha: string | null;
  r2Key: string | null;    // staged file location when changed
  // True when master's bytes were EXACTLY the render we last pushed, so
  // master's movement was the merge of our own export and there is no foreign
  // edit to merge — see ownPublish.ts and markOwnPublishConverged. Implies
  // `changed: false`, but for a completely different reason than a SHA match or
  // a 404, so it is reported separately (own_publish_converged).
  ownPublish?: boolean;
  // TSV resources only (issue #485, second P1 follow-up): true when this
  // staged file's fetch carried fetchDcsMasterText's independent completeness
  // proof — see fetchTsvMasterVerified and softDeleteRemovedTsvRows. Always
  // false for ult/ust (unused there; verses are never row-pruned by chapter
  // absence) and for any entry where changed is false (nothing staged).
  verifiedComplete: boolean;
  // Who moved master's file since `sync.sourceSha` (#540 item 1), measured here
  // because this is the only place in the nightly path that talks to DCS per
  // pair — and measured only for a resource that is actually being staged, so a
  // SHA-unchanged or own-publish resource costs nothing. Rides the plan's
  // `step.do` result into every chunk step, which is what keeps it one fetch per
  // pair per run rather than one per chunk.
  //
  // Absent on a plan replayed from a Workflow instance that started before this
  // shipped; masterMayHoldHumanEdit reads that absence as "a human may have",
  // which is the pre-existing behavior.
  lineage?: MasterLineageSummary | null;
}

interface ReimportPlan {
  maxChapter: number;
  entries: StagedResource[];
}

function freshPerResource(): Record<Resource, ReimportCounts> {
  return { ult: zeroCounts(), ust: zeroCounts(), tn: zeroCounts(), tq: zeroCounts(), twl: zeroCounts() };
}

function mergePerResource(
  into: Record<Resource, ReimportCounts>,
  from: Record<Resource, ReimportCounts>,
): void {
  for (const r of ALL_RESOURCES) addCounts(into[r], from[r]);
}

async function readStaged(env: Env, key: string): Promise<string | null> {
  const obj = await env.BLOBS.get(key);
  return obj ? await obj.text() : null;
}

// Upsert the per-(book,resource) sync watermark. `origin` is provenance only;
// only 'import'/'reimport' watermarks are written as skip gates.
//
// This union does NOT enumerate every value the column can hold:
// markOwnPublishConverged writes 'own_publish' via its own direct UPDATE (it
// must not touch source_sha's other fields the way this upsert does), and
// migration 0028's schema comment predates both that and 'reimport_withheld'.
// The column has no CHECK constraint and its only reader renders it as a raw
// string (admin.ts → AdminPanel's `origin:` caption), so this is a
// documentation gap rather than a correctness one.
export async function recordResourceSync(
  env: Env,
  book: string,
  resource: Resource,
  sha: string,
  origin: "import" | "reimport" | "export" | "reimport_withheld",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO book_resource_syncs (book, resource, source_sha, synced_at, origin)
     VALUES (?1, ?2, ?3, unixepoch(), ?4)
     ON CONFLICT(book, resource) DO UPDATE SET
       source_sha = excluded.source_sha,
       synced_at = excluded.synced_at,
       origin = excluded.origin`,
  )
    .bind(book, resource, sha, origin)
    .run();
}

// One (book, resource) sync row, including migration 0048's record of what the
// export last published. Read as ONE row rather than as separate
// storedResourceSha + pushed-render queries: planAndStageBookResources runs
// per resource inside the nightly Workflow step, and the whole reason that
// method is shaped the way it is is the Cloudflare subrequest budget (see the
// nightly-sync-subrequest-cap lesson in STATE.md) — this keeps the own-publish
// recognition free of any extra D1 round trip.
interface ResourceSyncState {
  sourceSha: string | null;
  pushedBlobSha: string | null;
  pushedReadAt: number | null;
  // P1.3: the edit_log id boundary (0050's pushed_edit_id) of the render
  // pushedBlobSha/pushedReadAt describe. Read from the SAME row snapshot as
  // pushedReadAt so, on recognition, markOwnPublishConverged can stamp
  // master_confirmed_edit_id from the same render pushedReadAt stamps
  // master_confirmed_at — the two can never drift to different renders.
  pushedEditId: number | null;
  /** Consecutive byte-comparison declines — see migration 0048's column doc. */
  declines: number;
}

// Reads columns added by migration 0048, so a failure is handled — but NARROWLY,
// and this is the important part.
//
// The hazard: if the code ships before its migration is applied (`wrangler deploy
// --env production` without `db:migrate:remote`, or a failed remote migration),
// this SELECT throws `no such column`. This repo has been bitten by exactly that
// shape before (0036 unapplied → /api/chapters/* 500s).
//
// The FIRST version of this guard returned an all-null state on any error, which
// was a worse bug than the one it prevented: `sourceSha: null` also disables the
// PRE-EXISTING SHA skip gate below, so during a migration lag every book would
// fully re-fetch and re-import every night — straight into the Cloudflare
// subrequest cap, which starves later books, leaves D1 stale, and lets the export
// render stale data over master. That is the exact incident class this PR exists
// to close, re-introduced through the back door.
//
// So: on failure, fall back to the pre-0048 single-column query. If THAT succeeds,
// the schema is genuinely behind — the SHA gate keeps working at full strength and
// only own-publish recognition goes inert until the migration lands. If it ALSO
// fails, this is not a schema problem but a real D1 fault, and the throw is left
// to propagate: on the nightly path that hands it to the wrapping `step.do` for
// retry-with-backoff (a transient fault should be retried, not silently degraded),
// and on the user path it surfaces as a failed pull, which is the pre-existing
// behavior for a broken database.
//
// Logged loudly either way, because silently-disabled recognition is how the
// original watermark bug survived for months.
async function resourceSyncState(env: Env, book: string, resource: Resource): Promise<ResourceSyncState> {
  try {
    const row = await env.DB.prepare(
      `SELECT source_sha, pushed_blob_sha, pushed_read_at, pushed_edit_id, own_publish_declines
         FROM book_resource_syncs WHERE book = ?1 AND resource = ?2`,
    )
      .bind(book, resource)
      .first<{
        source_sha: string | null;
        pushed_blob_sha: string | null;
        pushed_read_at: number | null;
        pushed_edit_id: number | null;
        own_publish_declines: number | null;
      }>();
    return {
      sourceSha: row?.source_sha ?? null,
      pushedBlobSha: row?.pushed_blob_sha ?? null,
      pushedReadAt: row?.pushed_read_at ?? null,
      pushedEditId: row?.pushed_edit_id ?? null,
      declines: row?.own_publish_declines ?? 0,
    };
  } catch (e) {
    console.error("reimport sync-state read failed; retrying without 0050's pushed_edit_id", {
      book,
      resource,
      error: e instanceof Error ? e.message : String(e),
    });
    // 0050 may lag 0048 (deploy raced its migration). Retry the 0048-era read so
    // own-publish recognition stays ON — only the PRECISE boundary degrades to
    // null (reconstruction falls back to the timestamp). A missing 0050 column
    // must NOT disable the AMOS-revert fix 0048 provides: turning recognition off
    // fleet-wide is exactly the failure this whole area exists to prevent, so it
    // is reserved for the case where even the 0048 columns are absent.
    try {
      const row = await env.DB.prepare(
        `SELECT source_sha, pushed_blob_sha, pushed_read_at, own_publish_declines
           FROM book_resource_syncs WHERE book = ?1 AND resource = ?2`,
      )
        .bind(book, resource)
        .first<{
          source_sha: string | null;
          pushed_blob_sha: string | null;
          pushed_read_at: number | null;
          own_publish_declines: number | null;
        }>();
      console.error("reimport: migration 0050 appears unapplied — precise merge boundary OFF (timestamp fallback), own-publish recognition intact", {
        book,
        resource,
      });
      return {
        sourceSha: row?.source_sha ?? null,
        pushedBlobSha: row?.pushed_blob_sha ?? null,
        pushedReadAt: row?.pushed_read_at ?? null,
        pushedEditId: null,
        declines: row?.own_publish_declines ?? 0,
      };
    } catch (e2) {
      console.error("reimport sync-state 0048 read also failed; retrying source_sha only", {
        book,
        resource,
        error: e2 instanceof Error ? e2.message : String(e2),
      });
      // Even the 0048 columns are gone — a genuinely behind schema (or a real D1
      // fault, in which case storedResourceSha throws and propagates to the
      // step.do retry / failed request, NOT a fleet-wide full reimport). SHA gate
      // stays intact; only own-publish recognition goes off until the migration
      // lands.
      const sourceSha = await storedResourceSha(env, book, resource);
      console.error("reimport: migration 0048/0050 appears unapplied — own-publish recognition is OFF, SHA gate intact", {
        book,
        resource,
      });
      return { sourceSha, pushedBlobSha: null, pushedReadAt: null, pushedEditId: null, declines: 0 };
    }
  }
}

// Same maintainer the other reimport/export alerts target — see
// verseMergeConflicts.ts's ALERT_USERNAME and exportWorkflow.ts's
// EXPORT_ALERT_USERNAME, both local copies for the same reason. Keep in sync.
const OWN_PUBLISH_ALERT_USERNAME = "deferredreward";

// Consecutive declines before we raise a banner. Three, not one: a single decline
// is the ordinary healthy case (a real Door43 edit, or our branch simply hasn't
// merged yet), and even two in a row is unremarkable for an actively-edited book.
// Three consecutive nights where the comparison had something real to compare
// against and still differed is the point where "the merge is rewriting our bytes,
// so this whole fix is inert" becomes worth a human's attention.
const OWN_PUBLISH_INERT_THRESHOLD = 3;

// The ONE place both entry paths run the byte comparison, so the nightly cron and
// the admin "Pull from Door43" route cannot drift apart on how recognition is
// decided or accounted for. What each does with the verdict still differs, and
// deliberately (see the call sites) — this owns the decision, not the response.
//
// Also owns the decline bookkeeping that makes the fix's own inertness visible:
// a `content_differs` verdict increments the counter and, at the threshold, raises
// a banner. A recognition resets the counter for free, inside the watermark UPDATE.
async function recognizePushedRender(
  env: Env,
  book: string,
  resource: Resource,
  raw: string,
  sync: ResourceSyncState,
): Promise<OwnPublishResult> {
  // Warm-up short-circuit: with nothing recorded to compare against the verdict is
  // fixed regardless of the bytes, so don't hash a whole book file to learn it.
  if (!sync.pushedBlobSha) return { recognized: false, readAt: null, reason: "no_pushed_render" };

  const own = recognizeOwnPublish({
    masterBlobSha: await gitBlobShaOrNull(raw),
    pushedBlobSha: sync.pushedBlobSha,
    pushedReadAt: sync.pushedReadAt,
  });

  // Only `content_differs` counts. The other declines mean the comparison never
  // really ran (unhashable master, half-written row), and counting "we couldn't
  // measure" as "we measured a difference" is the absent-measurement-as-evidence
  // mistake this codebase has a standing rule against.
  if (own.reason === "content_differs") {
    await noteOwnPublishDecline(env, book, resource, sync);
  }
  return own;
}

// Increment the consecutive-decline counter and, on crossing the threshold, raise
// the banner. Best-effort throughout: this is observability, and it must never
// fail a sync that is otherwise doing its job correctly.
async function noteOwnPublishDecline(
  env: Env,
  book: string,
  resource: Resource,
  sync: ResourceSyncState,
): Promise<void> {
  const next = (sync.declines ?? 0) + 1;
  try {
    await env.DB.prepare(
      `UPDATE book_resource_syncs SET own_publish_declines = ?3 WHERE book = ?1 AND resource = ?2`,
    )
      .bind(book, resource, next)
      .run();
  } catch (e) {
    console.error("reimport own-publish decline counter failed", {
      book,
      resource,
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  console.log("reimport own-publish declined: master differs from our last render", {
    book,
    resource,
    consecutiveDeclines: next,
  });
  if (next === OWN_PUBLISH_INERT_THRESHOLD) await raiseOwnPublishInertAlert(env, book, resource, next, sync);
}

// Banner for "recognition keeps declining." Fires ONCE, on the run that crosses
// the threshold (`next === THRESHOLD`, not `>=`), so a book that stays in this
// state doesn't rewrite the alert every night; the counter keeps climbing and a
// single match clears it.
//
// The wording states ONLY what was measured. Two explanations fit these
// observations and this code cannot tell them apart: continuous out-of-band Door43
// editing (benign, expected for an actively-worked file) or Door43's merge
// rewriting the bytes we pushed (which makes this entire fix inert and lets the
// nightly reverts continue silently). Asserting either would repeat the mistake
// this repo has a standing lesson about, so the message names both and gives the
// one comparison that separates them.
// Banner for issue #427's withhold. This one NEEDS an alert in a way the
// lock-held withholds do not, and the difference is the whole reason it exists:
// a chapter lock clears when the AI job finishes, so that withhold releases
// itself overnight. Before option 1 shipped, a reissued tombstone did not: it
// blocked EVERY run, forever, until a human acted — the soft-deleted row keeps
// its (book, id) slot forever, master keeps carrying that id, and every
// subsequent night re-stages the file (the SHA gate cannot skip it — the
// watermark was never advanced), re-drops the same rows, and re-withholds.
//
// Issue #427's option 1 (reclaim a reissued id) has now SHIPPED — see the
// tombstone branch of applyTsvRows and the "Batch the reclaims" write site —
// and runs automatically, in the SAME run a reissued tombstone is first
// detected, so the common case this alert used to describe no longer produces
// a `tombstone_blocked` count at all: master's row lands, reclaimed, same
// night. `tombstone_blocked` now fires ONLY for the residual: a reclaim
// attempt that LOST the version-CAS race against a concurrent writer touching
// the SAME tombstoned row between the read and the write. Unlike the pre-fix
// permanent freeze, that is expected to self-heal on the NEXT sync once the
// race that caused it has resolved — but "usually self-heals" is not the same
// as "guaranteed to clear silently," so this alert still fires for it.
// `conflict_skipped` (the OTHER half of this alert — an INSERT-path race
// against a row the in-memory diff never saw) is unrelated to option 1 and
// keeps its original semantics and its original "does not clear on its own"
// framing.
//
// The freeze itself is still the correct fail-safe direction while either
// count is nonzero — exporting instead would render a D1 that is short of
// master back over master, deleting master's rows, which is the original 1CH
// failure — but a freeze nobody is told about is not safe, it is just quiet.
// The existing freshness-gate banner (exportWorkflow.ts's recordStaleSkipAlert)
// fires too, and its advice — "re-run the sync, then re-export" — cannot
// possibly work for the conflict_skipped half, because re-running the sync
// re-encounters the same collision. So this alert names the measured cause and
// the rows, and gives a remedy that can actually clear it.
//
// The wording states only what the code measured: the counters, and the sampled
// rows themselves. It does NOT claim which of the two situations produced any
// given `tombstone_blocked` row (an id genuinely re-minted for a new row, versus
// a maintainer re-anchoring the Reference of a row we had deleted) — the
// reference test cannot separate those, and asserting either would repeat the
// mistake this repo has a standing lesson about. That ambiguity now drives an
// actual reclaim WRITE rather than merely a freeze — see isReissuedTombstone's
// KNOWN FALSE POSITIVE note in reimportClassify.ts for what that means.

// #540 item 2's scale alarm. A handful of kept-over-Door43 rows is the policy
// working; a book-full of them has the shape of every incident this area exists
// to prevent — and unlike a refusal, this outcome PUBLISHES over Door43 rather
// than holding. See isKeptOverDoor43AtScale for why it alerts instead of
// freezing.
//
// Claims only the measurement: how many rows, in which (book, resource), and
// what the walk actually found. It does not say whether a human edited Door43 —
// the walk sees commits, not intent.
async function raiseKeptOverDoor43Alert(
  env: Env,
  book: string,
  resource: Resource,
  kept: number,
): Promise<void> {
  const source = `reimport_kept_over_door43:${book}:${resource}`;
  const res = resource.toUpperCase();
  const message =
    `Benjamin — tonight's Door43 sync kept the app's version over Door43's on ${kept} ${book} ${res} ` +
    `row(s)/verse(s). For each one, both sides had changed since the last confirmed publish AND every ` +
    `Door43 commit to that file since then came from Bible Editor's own export or the unfoldingWord bot ` +
    `account — no commit from a Door43 editor's own account was found. That is the intended policy ` +
    `(AI-written content on Door43 does not overwrite a later app edit), but at this many rows it is ` +
    `worth a look before the next export writes them to Door43: the same count would appear if the commit ` +
    `classification were wrong — a second bot identity, or a rewritten history on Door43. Each affected ` +
    `row is flagged in the app for review, and the verses are in ${book}'s merge-review banner.`;
  try {
    await env.DB.prepare(`DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`)
      .bind(OWN_PUBLISH_ALERT_USERNAME, source)
      .run();
    await env.DB.prepare(
      `INSERT INTO system_alerts (username, severity, source, message, link_url) VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(OWN_PUBLISH_ALERT_USERNAME, "warning", source, message, null)
      .run();
  } catch (e) {
    // Best-effort, like every other alert helper here: a failed banner must
    // never fail the reimport, and this one gates nothing.
    console.error("reimport kept-over-Door43 alert failed", {
      book,
      resource,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// `overridden` (issue #473 option A): the caller granted allowIdBlocked for
// this exact resource, so the watermark was recorded and tonight's export
// WILL publish. This is a materially different message from the ordinary
// withhold below — it must not say "will NOT export until this is cleared"
// when the opposite just happened. See idBlockedOverrideAllowed /
// shouldRecordResourceSync's idBlockedOverride doc comment.
async function raiseTombstoneBlockAlert(
  env: Env,
  book: string,
  resource: Resource,
  counts: ReimportCounts,
  overridden: boolean = false,
): Promise<void> {
  const blocked = counts.tombstone_blocked ?? 0;
  const conflicts = counts.conflict_skipped ?? 0;
  const samples = counts.blocked_samples ?? [];
  const source = `reimport_id_blocked:${book}:${resource}`;
  const shown = samples.slice(0, 10);
  const more = blocked + conflicts - shown.length;
  const message = overridden
    ? `Benjamin — the ID-blocked watermark withhold for ${book} ${resource.toUpperCase()} was force-released ` +
      `by explicit request (allowIdBlocked). ${blocked + conflicts} row(s) whose IDs are still held in our ` +
      `database by soft-deleted rows were NOT imported and are still MISSING from the app — Door43 still ` +
      `carries them, and tonight's export WILL delete them from master, because the sync watermark was ` +
      `recorded anyway. Affected: ${shown.join(" | ")}${more > 0 ? ` (and ${more} more)` : ""}. If this was ` +
      `not a deliberate, verified reissue, restore the soft-deleted row(s) before the next export runs.`
    : `Benjamin — tonight's Door43 sync could not import ${blocked + conflicts} ${book} ` +
      `${resource.toUpperCase()} row(s) because their IDs are still held in our database by ` +
      `soft-deleted rows (a deleted row keeps its ID for that book permanently). Those rows are ` +
      `MISSING from the app, so ${book} ${resource.toUpperCase()} has been left marked out of sync and ` +
      `will NOT export to Door43 until this is cleared — otherwise the export would delete those same ` +
      `rows from Door43. ` +
      (blocked > 0
        ? `${blocked} lost the automatic reclaim's version-CAS race against a concurrent writer on the ` +
          `same deleted row (usually clears on its own next sync, once that race resolves)`
        : "") +
      (blocked > 0 && conflicts > 0 ? "; " : "") +
      (conflicts > 0 ? `${conflicts} refused by the database as an ID already in use` : "") +
      `. Affected: ${shown.join(" | ")}${more > 0 ? ` (and ${more} more)` : ""}. ` +
      (conflicts > 0
        ? `The ID-already-in-use row(s) do NOT clear on their own — the next sync hits the same collision; ` +
          `give the affected row(s) a different ID on Door43. `
        : "") +
      (blocked > 0
        ? `The reclaim-race row(s) above should resolve automatically; if this persists across multiple ` +
          `nights for the same row, something is wrong with the automatic reclaim (GitHub issue #427, ` +
          `option 1) and it needs a human look.`
        : "") +
      ` An explicit-override escape hatch exists (allowIdBlocked on POST /api/exports/run) for a ` +
      `verified-genuine reissue — see GitHub issue #473.`;
  try {
    await env.DB.prepare(`DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`)
      .bind(OWN_PUBLISH_ALERT_USERNAME, source)
      .run();
    await env.DB.prepare(
      `INSERT INTO system_alerts (username, severity, source, message, link_url) VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(OWN_PUBLISH_ALERT_USERNAME, overridden ? "warning" : "error", source, message, null)
      .run();
  } catch (e) {
    // Best-effort, exactly like every other alert helper here: a failed banner
    // must never fail the reimport. The withhold itself already happened.
    console.error("reimport tombstone-block alert failed", {
      book,
      resource,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// Clears a resource's reimport_id_blocked alert (raiseTombstoneBlockAlert)
// once its sync actually succeeds and a watermark is recorded. The alert's
// own text promises the reclaim-race half of the count "usually clears on
// its own next sync" — but until this function existed, the ONLY place that
// DELETE ran was inside raiseTombstoneBlockAlert itself, which fires only
// while the resource is STILL withheld. A resource that recovers next run
// never calls it again, so a resolved alert stayed active in the banner
// forever, falsely claiming the resource was still out of sync (Codex review
// on PR #506, round 3). Called from the sync-success branch in
// runChunkedReimport, immediately after recordResourceSync lands — see
// clearTombstoneBlockAlertForTest for the reimportJourney.test.mjs coverage.
// Best-effort like every other alert helper here: a failed cleanup must
// never fail the reimport, and clearing an alert that doesn't exist (the
// common case — most resources never had one) is a harmless no-op DELETE.
async function clearTombstoneBlockAlert(env: Env, book: string, resource: Resource): Promise<void> {
  const source = `reimport_id_blocked:${book}:${resource}`;
  try {
    await env.DB.prepare(`DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`)
      .bind(OWN_PUBLISH_ALERT_USERNAME, source)
      .run();
  } catch (e) {
    console.error("reimport tombstone-block alert clear failed", {
      book,
      resource,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function raiseOwnPublishInertAlert(
  env: Env,
  book: string,
  resource: Resource,
  declines: number,
  sync: ResourceSyncState,
): Promise<void> {
  const source = `own_publish_inert:${book}:${resource}`;
  const message =
    `Benjamin — for ${declines} syncs in a row, Door43's ${book} ${resource.toUpperCase()} file has differed from ` +
    `the exact bytes our export last pushed (our blob ${(sync.pushedBlobSha ?? "none").slice(0, 12)}). ` +
    `Two things produce this and the sync cannot tell them apart: someone is editing that file on Door43 ` +
    `between every run (normal for an actively-edited book), or Door43's validate-and-merge job is rewriting ` +
    `our file when it merges — the second would mean the fix that stops the nightly sync reverting editor ` +
    `work is silently doing nothing for this file. To tell them apart, compare Door43's current file against ` +
    `our last push: \`git hash-object\` the file from master and check it against that blob sha. ` +
    `This clears itself the first time they match.`;
  try {
    await env.DB.prepare(`DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`)
      .bind(OWN_PUBLISH_ALERT_USERNAME, source)
      .run();
    await env.DB.prepare(
      `INSERT INTO system_alerts (username, severity, source, message, link_url) VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(OWN_PUBLISH_ALERT_USERNAME, "warning", source, message, null)
      .run();
  } catch (e) {
    console.error("reimport own-publish inert alert failed", {
      book,
      resource,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// Master's current bytes for this (book, resource) ARE the render we last
// pushed: master moved only because our own `-be-` branch merged. Advance the
// merge ancestor cutoff (0045's master_confirmed_at) to that render's D1-read
// time, and record master's commit SHA as this resource's sync watermark.
//
// Both halves are load-bearing and must happen together:
//   - master_confirmed_at is what makes the NEXT genuine foreign edit
//     attributable (verseMerge.ts). Advanced with MAX(), never backwards, for
//     the same reason exportWorkflow.ts's stampMasterConfirmed uses MAX (FIX 7
//     there): overlapping runs can arrive out of order, and a watermark moved
//     backwards turns a master that never moved into an `adopt_conflict`.
//   - source_sha must be recorded even though we are SKIPPING this resource's
//     row work, because the export's freshness gate (checkMasterFreshness)
//     compares master's SHA against it. Leaving it behind would make tonight's
//     export report `master_ahead` and skip the book with an `export_stale`
//     alert — a converged resource would freeze its own export. `masterSha`
//     null (the SHA lookup failed) leaves the stored value untouched via
//     COALESCE rather than writing a null over a real watermark.
//
// This deliberately does NOT consult the watermark-withholding gates that the
// reimport-sync step applies — shouldRecordResourceSync's locked-chapter check
// (the EZK 40 lesson: "a watermark must not certify data it didn't apply") or
// #444's `apply_incomplete` (an adoption batch that threw or lost its CAS race).
// That is sound here rather than an oversight, and for one reason that covers
// both: every one of those gates exists because SOME WRITE WE ATTEMPTED did not
// land, leaving D1 behind master. This branch attempts no writes at all. Master's
// whole-file bytes are our own render of the whole book, so master demonstrably
// holds nothing D1 lacks — there is no chapter, locked or not, and no adoption,
// failed or otherwise, whose content we failed to apply. D1 may be AHEAD of
// master (app edits since pushed_read_at), which is the normal state and is what
// tonight's export is for.
//
// UPDATE-only, never INSERT, for exactly the reason stampMasterConfirmed gives:
// `origin` is NOT NULL with no default (migration 0028). A row is guaranteed to
// exist here anyway — this path is only reachable when pushed_blob_sha is
// non-null, and only the export writes that, onto an existing row.
//
// Returns whether the write actually landed. Callers MUST NOT report a stamp they
// didn't get: a 0-row UPDATE (row deleted between the read and here, or the
// statement failing) would otherwise leave master_confirmed_at stuck while the
// run reported "converged" — the same invisible-failure shape as the bug this
// fixes, repeating silently every night. The caller still skips the resource's
// row work on a failed stamp (nothing on master needs importing either way, so
// skipping cannot lose data); what it must not do is claim the watermark moved.
//
// Idempotent, which matters because the nightly caller sits inside a retried
// Workflow step: MAX()/COALESCE() make a re-run a no-op, and if a retry declines
// where the first attempt recognized (master moved in between), the
// already-advanced watermark is still truthful — master did hold that render at
// first-attempt time.
async function markOwnPublishConverged(
  env: Env,
  book: string,
  resource: Resource,
  readAt: number,
  // P1.3: 0050's pushed_edit_id from the SAME sync snapshot readAt (=
  // pushed_read_at) came from, so master_confirmed_edit_id is advanced from the
  // identical render master_confirmed_at is. null (warm-up / empty edit_log)
  // leaves the boundary untouched -> reconstruction falls back to the timestamp.
  pushedEditId: number | null,
  masterSha: string | null,
): Promise<boolean> {
  try {
    const result = await env.DB.prepare(
      `UPDATE book_resource_syncs
          SET master_confirmed_at = MAX(COALESCE(master_confirmed_at, 0), ?3),
              -- P1.3: shadow master_confirmed_at with the precise id boundary of
              -- the SAME recognized render — but ONLY when this render is the
              -- newest (?3 >= the stored master_confirmed_at). Without that gate a
              -- delayed OLDER recognition arriving while master_confirmed_edit_id
              -- is still NULL (warm-up) would advance the id to the old render's
              -- boundary while the timestamp keeps the newer render's value, so the
              -- two would describe DIFFERENT renders and reconstruction (which
              -- prefers the id) would fold too old an ancestor. The non-null guard
              -- also stops a null from coercing this to a bogus 0.
              master_confirmed_edit_id =
                CASE WHEN ?5 IS NOT NULL AND ?3 >= COALESCE(master_confirmed_at, 0)
                     THEN MAX(COALESCE(master_confirmed_edit_id, 0), ?5)
                     ELSE master_confirmed_edit_id END,
              source_sha = COALESCE(?4, source_sha),
              synced_at = unixepoch(),
              -- Claim authorship of the watermark only when this call actually
              -- WROTE one. On the admin-pull path masterSha is null, so source_sha
              -- is untouched and overwriting 'reimport' with 'own_publish' would
              -- misreport which run established the watermark the admin panel
              -- shows.
              origin = CASE WHEN ?4 IS NOT NULL THEN 'own_publish' ELSE origin END,
              -- Free reset of the inertness detector: a match is exactly the
              -- evidence that recognition is working for this (book, resource).
              own_publish_declines = 0
        WHERE book = ?1 AND resource = ?2`,
    )
      .bind(book, resource, readAt, masterSha, pushedEditId)
      .run();
    if ((result.meta?.changes ?? 0) === 0) {
      console.error("reimport own-publish stamp changed no rows; watermark NOT advanced", {
        book,
        resource,
        readAt,
      });
      return false;
    }
    // Clear any standing inertness banner — the counter is back to 0, so the
    // banner's premise ("keeps differing") is no longer true. Best-effort.
    try {
      await env.DB.prepare(`DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`)
        .bind(OWN_PUBLISH_ALERT_USERNAME, `own_publish_inert:${book}:${resource}`)
        .run();
    } catch {
      /* the banner is stale, not wrong-headed; never fail a good sync over it */
    }
    return true;
  } catch (e) {
    console.error("reimport own-publish stamp failed; watermark NOT advanced", {
      book,
      resource,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

export async function storedResourceSha(env: Env, book: string, resource: Resource): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT source_sha FROM book_resource_syncs WHERE book = ?1 AND resource = ?2`,
  )
    .bind(book, resource)
    .first<{ source_sha: string | null }>();
  return row?.source_sha ?? null;
}

// Sentinel SHA that can never equal a real git commit SHA. Written by
// recordWithheldSyncIfAbsent below when a (book, resource) has NO existing
// watermark row and this run is withholding the stamp (a locked chapter —
// see shouldRecordResourceSync). Consequences, both intentional:
//   - checkMasterFreshness (exportWorkflow.ts) compares this sentinel against
//     master's real SHA, which never matches → returns `master_ahead` instead
//     of the current `no_watermark` (which returns ok:true and bypasses the
//     freshness gate entirely) → the export honestly skips with `export_stale`.
//   - planAndStageBookResources's SHA skip-gate (`fileCommitSha === stored`)
//     also never matches this sentinel → the file is re-fetched and staged
//     again next night, which is the desired retry.
// A real SHA recorded later via recordResourceSync's normal upsert overwrites
// this sentinel with no special handling — same UPSERT, no code path cares
// which sha was there before.
const WITHHELD_SYNC_SENTINEL_SHA = "withheld";

// Guarantee the freshness gate has SOMETHING to compare against for a
// (book, resource) whose watermark stamp we're withholding this run. Without
// this, a book with no `book_resource_syncs` row at all (seeded imports whose
// fetch-time SHA came back null — see bookImport.ts; or scripts/import-book.mjs,
// which never writes one) sees withholding change nothing: checkMasterFreshness
// reports `no_watermark` (ok:true) either way, and the export proceeds on
// stale D1 data indefinitely — the EZK 40 outcome this branch exists to
// prevent, just reached from "no watermark" instead of "stale watermark".
//
// Deliberately a no-op when a row already exists (real OR previously
// withheld) — see storedResourceSha's contract: an older real SHA already
// yields `master_ahead` on its own, which is correct and prints a genuine
// "synced" SHA in the alert; overwriting it here would throw that useful
// information away for no benefit.
export async function recordWithheldSyncIfAbsent(env: Env, book: string, resource: Resource): Promise<void> {
  const existing = await storedResourceSha(env, book, resource);
  if (existing) return;
  await recordResourceSync(env, book, resource, WITHHELD_SYNC_SENTINEL_SHA, "reimport_withheld");
}

// Comparable-field signature for a normalized TSV row. MUST cover exactly the
// columns applyTsvRows' no-op check compares (same fields, same null
// normalization) — note sort_order is NOT in the signature; applyTsvRows checks
// it separately — so a signature + sort_order match is equivalent to a no-op.
function tsvRowSignature(kind: TsvKind, r: ParsedTsvRow): string {
  const f =
    kind === "tn"
      ? [r.refRaw, r.chapter, r.verse, r.tags ?? null, r.support_reference ?? null, r.quote ?? null, r.occurrence ?? null, r.note ?? null]
      : kind === "tq"
        ? [r.refRaw, r.chapter, r.verse, r.tags ?? null, r.quote ?? null, r.occurrence ?? null, r.question ?? null, r.response ?? null]
        : [r.refRaw, r.chapter, r.verse, r.tags ?? null, r.orig_words ?? null, r.occurrence ?? null, r.tw_link ?? null];
  return JSON.stringify(f);
}

const TSV_STORED_COLS: Record<TsvKind, string> = {
  tn: "ref_raw, chapter, verse, tags, support_reference, quote, occurrence, note",
  tq: "ref_raw, chapter, verse, tags, quote, occurrence, question, response",
  twl: "ref_raw, chapter, verse, tags, orig_words, occurrence, tw_link",
};

// Build a ParsedTsvRow from a stored D1 row so it yields the same signature an
// incoming TSV row would.
function storedTsvRowToParsed(kind: TsvKind, row: Record<string, unknown>): ParsedTsvRow {
  const base: ParsedTsvRow = {
    id: String(row.id),
    refRaw: (row.ref_raw as string | null) ?? "",
    chapter: Number(row.chapter),
    verse: Number(row.verse),
    occurrence: (row.occurrence as number | null) ?? null,
    tags: (row.tags as string | null) ?? null,
  };
  if (kind === "tn") {
    base.support_reference = (row.support_reference as string | null) ?? null;
    base.quote = (row.quote as string | null) ?? null;
    base.note = (row.note as string | null) ?? null;
  } else if (kind === "tq") {
    base.quote = (row.quote as string | null) ?? null;
    base.question = (row.question as string | null) ?? null;
    base.response = (row.response as string | null) ?? null;
  } else {
    base.orig_words = (row.orig_words as string | null) ?? null;
    base.tw_link = (row.tw_link as string | null) ?? null;
  }
  return base;
}

// Chapters whose pristine D1 content differs from the incoming DCS TSV. A
// chapter is "unchanged" (skippable) ONLY when its incoming {id → signature}
// map equals its stored-pristine map exactly AND every live D1 id in the
// chapter is still present in the incoming file (see the liveIds pass below).
// Detects add/change/delete and id moves; errs toward "changed" whenever an
// edited (non-pristine) row is present (excluded from the stored map → chapter
// re-runs, edited row skipped harmlessly). A perf filter — it can never skip a
// real update.
//
// Issue #485: the pristine-only comparison above is blind to a master-side
// deletion of an AI-only row (updated_by set, latest edit_log source =
// ai_pipeline — softDeleteRemovedTsvRows's own header explains why that row is
// still prunable). Such a row is excluded from BOTH the incoming map (master
// dropped it) and the stored-pristine map (it was never pristine), so the two
// maps can still match exactly and the chapter reads as "unchanged" — the
// prune that depends on `changed` then never runs for that chapter, and the
// row lives on in D1 to be re-exported to master every night, silently
// reverting the deletion forever. The liveIds pass below closes that hole: it
// reads every LIVE (non-tombstoned) id in the chapter — pristine, AI-only, and
// human-edited alike — and flags the chapter as changed if any of those ids is
// absent from the incoming file, regardless of whether that id ever
// contributed to the pristine signature comparison. Flagging on a missing
// human-edited id is harmless — softDeleteRemovedTsvRows's own
// isReimportableRow check refuses to prune it — so this only ever widens
// "changed", never narrows it.
export async function changedTsvChapters(
  env: Env,
  book: string,
  kind: TsvKind,
  rawTsv: string,
): Promise<Set<number>> {
  const pristine =
    kind === "tn"
      ? `updated_by IS NULL AND deleted_at IS NULL AND trashed_at IS NULL AND preserve = 0 AND hint = 0`
      : `updated_by IS NULL AND deleted_at IS NULL`;
  // Mirrors softDeleteRemovedTsvRows' selectProtections: every row eligible
  // for pruning consideration (pristine OR non-pristine), excluding rows
  // already tombstoned/trashed/preserved/hinted — those aren't "live" and
  // their absence from the incoming file is expected, not a deletion to catch.
  const live =
    kind === "tn"
      ? `deleted_at IS NULL AND trashed_at IS NULL AND preserve = 0 AND hint = 0`
      : `deleted_at IS NULL`;

  // Chapter 0 (refParts("front:intro") in importParsers.ts) is a real,
  // syncable chapter — a book-level intro TN/TQ/TWL row — NOT a sentinel to
  // exclude. The old `< 1` guard here excluded it from both maps, so a
  // chapter-0 row could never be seen as "changed" and this diff gate never
  // planned it for reimport: the export pushes D1's chapter-0 rows to master
  // every night, but a hand-edit made directly on master never came back,
  // reverted forever (a DCS maintainer's front:intro edits survived 0/2
  // nights). `< 0` keeps the defensive floor (parseTsvRow/refParts never
  // actually yields negative, but a malformed ref still shouldn't crash this)
  // while letting chapter 0 flow through like any other chapter.
  const incoming = new Map<number, Map<string, string>>();
  for (const r of parseTsv(rawTsv).rows) {
    const p = parseTsvRow(r, kind);
    if (!p || p.chapter < 0) continue;
    let m = incoming.get(p.chapter);
    if (!m) incoming.set(p.chapter, (m = new Map()));
    m.set(p.id, tsvRowSignature(kind, p));
  }

  const stored = new Map<number, Map<string, string>>();
  const res = await env.DB.prepare(
    `SELECT id, ${TSV_STORED_COLS[kind]} FROM ${kind}_rows WHERE book = ?1 AND ${pristine}`,
  )
    .bind(book)
    .all<Record<string, unknown>>();
  for (const row of res.results) {
    const p = storedTsvRowToParsed(kind, row);
    if (p.chapter < 0) continue;
    let m = stored.get(p.chapter);
    if (!m) stored.set(p.chapter, (m = new Map()));
    m.set(p.id, tsvRowSignature(kind, p));
  }

  // Second, wider read: every live id per chapter (not just pristine), so an
  // AI-only (or human-edited) row's id is still visible to this gate even
  // though it's excluded from the pristine signature maps above. See the
  // issue #485 note on this function.
  const liveIds = new Map<number, Set<string>>();
  const liveRes = await env.DB.prepare(
    `SELECT id, chapter FROM ${kind}_rows WHERE book = ?1 AND ${live}`,
  )
    .bind(book)
    .all<{ id: string; chapter: number }>();
  for (const row of liveRes.results ?? []) {
    const ch = Number(row.chapter);
    if (ch < 0) continue;
    let s = liveIds.get(ch);
    if (!s) liveIds.set(ch, (s = new Set()));
    s.add(String(row.id));
  }

  const changed = new Set<number>();
  for (const ch of new Set<number>([...incoming.keys(), ...stored.keys(), ...liveIds.keys()])) {
    const a = incoming.get(ch) ?? new Map<string, string>();
    const b = stored.get(ch) ?? new Map<string, string>();
    let same = a.size === b.size;
    if (same) {
      for (const [id, sig] of a) {
        if (b.get(id) !== sig) { same = false; break; }
      }
    }
    // A live D1 id (pristine or not) that master no longer carries is always a
    // change, even when the pristine-only comparison above already agreed —
    // this is the additive check that catches an AI-only row's deletion.
    if (same) {
      for (const id of liveIds.get(ch) ?? []) {
        if (!a.has(id)) { same = false; break; }
      }
    }
    if (!same) changed.add(ch);
  }
  return changed;
}

// Soft-delete rows no HUMAN owns that master no longer carries, so the nightly
// export can't resurrect an out-of-band deletion. Mirrors pipelineImport.ts
// deleteUnkeptTns and the app's DELETE handler shape (rows.ts): set
// deleted_at, bump version, audit a 'delete'. "No human owns it" spans both
// pristine (updated_by IS NULL) AND AI-only rows (updated_by set but the latest
// content edit_log source is ai_pipeline) — the same isReimportableRow rule the
// apply path uses, so a row the AI wrote and master later dropped is pruned
// instead of lingering and re-exporting (the apply/prune consistency the
// reimported_ai fix would otherwise miss). Conservative on every axis: only
// chapters the incoming file covers (a chapter master emptied entirely also
// counts as "covered" when it still holds a live D1 row AND this fetch carried
// a positive, independent completeness proof — see `verifiedComplete` and the
// coverage extension inside, the issue #485 P1 follow-ups) AND the diff gate
// flagged as changed (a deletion always flags its chapter), never under an
// active pipeline lock, and the WRITE re-asserts version-CAS + the
// deleted/trashed/preserve/hint protections (NOT updated_by IS NULL — an
// AI-only row carries the starter's id, exactly as deleteUnkeptTns notes) so a
// human edit landing after the SELECT bumps version → 0 rows → skipped.
// updated_by → NULL reclaims the tombstone to reimport-owned. The id
// comparison is against the WHOLE file's id set so a row the update path just
// moved to another chapter isn't mistaken for removed.
async function softDeleteRemovedTsvRows(
  env: Env,
  book: string,
  kind: TsvKind,
  rawTsv: string,
  candidateChapters: number[],
  // Second P1 follow-up (codex re-review of b826dcb): true only when the caller's
  // rawTsv came from fetchTsvMasterVerified with an independent positive
  // completeness proof (see there). Gates the coveredChapters widening below —
  // without it, tsvFetchLooksTruncated's loss-percentage heuristic alone is not
  // enough to trust "absent from the body" as "master emptied this chapter".
  verifiedComplete: boolean,
): Promise<{ deleted: number; skippedLocked: number }> {
  const incomingIds = new Set<string>();
  const coveredChapters = new Set<number>();
  for (const r of parseTsv(rawTsv).rows) {
    const p = parseTsvRow(r, kind);
    if (!p) continue;
    incomingIds.add(p.id);
    // >= 0, not >= 1: chapter 0 (refParts("front:intro")) is a real chapter
    // whose deletions must prune too — see changedTsvChapters above for the
    // one-way-sync bug this is the delete-side half of.
    if (p.chapter >= 0) coveredChapters.add(p.chapter);
  }
  // Defensive: an empty or garbled file must never sweep a book clean.
  if (incomingIds.size === 0) return { deleted: 0, skippedLocked: 0 };

  // SELECT filters the human-owned protections that are stable columns
  // (deleted/trashed/preserve/hint) but NOT updated_by — an AI-only row carries
  // the starter's id yet is still prunable. latest_source separates AI-only from
  // a human edit (isReimportableRow decides). The WRITE guard below re-asserts
  // the same protections + version-CAS (deleteUnkeptTns pattern).
  const selectProtections =
    kind === "tn"
      ? `deleted_at IS NULL AND trashed_at IS NULL AND preserve = 0 AND hint = 0`
      : `deleted_at IS NULL`;

  // Issue #485 P1 follow-up (codex review on PR #501): a chapter master
  // emptied COMPLETELY — zero incoming rows for that (book, kind, chapter) —
  // never lands in coveredChapters above, so it was skipped by the loop below
  // even after changedTsvChapters' liveIds pass correctly flagged it as
  // changed (this is exactly what happens when the deleted AI-only row was
  // the LAST row in its chapter). That left issue #485 half-fixed: the common
  // case (chapter keeps other rows) prunes correctly, but a fully-emptied
  // chapter's deletion still got resurrected every night.
  //
  // SECOND P1 follow-up (codex re-review of b826dcb): the original version of
  // this extension trusted "the caller already ran tsvFetchLooksTruncated" as
  // sufficient proof a body-absent chapter was genuinely emptied. It is not —
  // tsvFetchLooksTruncated/isCatastrophicTsvShrink is a LOSS-PERCENTAGE
  // heuristic (rejects >50% loss vs live D1, and no-ops entirely below
  // SHRINK_GUARD_MIN_LIVE), not a positive completeness guarantee. A partial
  // fetch that happens to pass that heuristic (e.g. 60 of 100 rows, or any
  // book under the small-file floor) would still widen coveredChapters over
  // chapters the partial body simply never reached, and the prune would then
  // tombstone every pristine/AI-owned row in them — the review's exact
  // "blast radius" finding. So this extension now ALSO requires
  // `verifiedComplete`: true only when the caller's rawTsv came from
  // fetchTsvMasterVerified with fetchDcsMasterText's independent Gitea
  // contents-API byte-count cross-check actually available for this fetch
  // (see fetchTsvMasterVerified above and PR #502 / issue #494). That is a
  // POSITIVE proof the body is the whole file, not a loss-percentage guess.
  //
  // Without `verifiedComplete`, coveredChapters falls back to the original
  // conservative behavior (only chapters with rows actually present in the
  // incoming body) — correct but conservative, matching pre-b826dcb
  // behavior for that fetch: a chapter master genuinely emptied is missed
  // until a verified-complete fetch catches it, rather than risking pruning a
  // chapter an unverified partial fetch merely failed to mention.
  //
  // When verified, extend coverage to every chapter that currently holds a
  // LIVE D1 row for this (book, kind): that is the only shape of
  // "flagged-changed but empty-in-incoming" this prune ever needs to reach —
  // a chapter with no live rows has nothing to prune regardless. Read as ONE
  // batched DISTINCT-chapter query (not one query per candidate chapter) so
  // the subrequest cost stays flat no matter how many chapters
  // candidateChapters spans — postExport's runReimport call passes the WHOLE
  // book's chapter range on every run.
  if (verifiedComplete) {
    const liveChaptersRes = await env.DB.prepare(
      `SELECT DISTINCT chapter FROM ${kind}_rows WHERE book = ?1 AND ${selectProtections}`,
    )
      .bind(book)
      .all<{ chapter: number }>();
    for (const row of liveChaptersRes.results ?? []) {
      const ch = Number(row.chapter);
      if (ch >= 0) coveredChapters.add(ch);
    }
  }

  const writeGuard =
    kind === "tn"
      ? `deleted_at IS NULL AND trashed_at IS NULL AND preserve = 0 AND hint = 0 AND version = ?4`
      : `deleted_at IS NULL AND version = ?4`;
  const now = Math.floor(Date.now() / 1000);
  let deleted = 0;
  let skippedLocked = 0;
  for (const ch of candidateChapters) {
    if (!coveredChapters.has(ch)) continue;
    if (await activePipelineForChapter(env, book, ch)) {
      skippedLocked++;
      continue;
    }
    const rs = await env.DB.prepare(
      `SELECT id, version, updated_by,
              (SELECT source FROM edit_log
                 WHERE kind = ?3 AND row_key = ${kind}_rows.id
                   AND (book = ?1 OR book IS NULL)
                   AND action IN ('create', 'update')
                 ORDER BY id DESC LIMIT 1) AS latest_source
         FROM ${kind}_rows WHERE book = ?1 AND chapter = ?2 AND ${selectProtections}`,
    )
      .bind(book, ch, kind)
      .all<{ id: string; version: number; updated_by: number | null; latest_source: string | null }>();
    const targets = (rs.results ?? []).filter(
      (r) =>
        !incomingIds.has(r.id) &&
        isReimportableRow({
          updated_by: r.updated_by,
          latestSource: r.latest_source ?? null,
          deleted_at: null,
          trashed_at: null,
          preserve: 0,
          hint: 0,
          kind,
        }),
    );
    for (const t of targets) {
      // updated_by → NULL reclaims the tombstone to reimport-owned; version-CAS
      // (?4) + the re-asserted protections abort if a human touched the row
      // between the SELECT and here (bumps version → 0 rows changed).
      const upd = await env.DB.prepare(
        `UPDATE ${kind}_rows
            SET deleted_at = ?1, updated_by = NULL, version = version + 1, updated_at = ?1
          WHERE id = ?2 AND book = ?3 AND ${writeGuard}`,
      )
        .bind(now, t.id, book, t.version)
        .run();
      if (!upd.meta.changes) continue;
      deleted++;
      await env.DB.prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
         VALUES (?1, ?2, ?3, NULL, ?4, ?5, 'delete', ?6)`,
      )
        .bind(kind, t.id, book, t.version, t.version + 1, REIMPORT_SOURCE)
        .run();
    }
  }
  return { deleted, skippedLocked };
}

// Issue #427, option 3: sweep a tombstone whose id no longer appears ANYWHERE
// in master's file for this book — pure dead weight. Mutually exclusive with
// applyTsvRows' tombstone branch above by construction: that branch only ever
// leaves a row tombstoned when master DOES still carry the id (same
// reference: a pending delete not yet exported, deliberately left dead;
// different reference: reissued, and RECLAIMED rather than left dead). An id
// absent from master's file entirely is neither of those — it's a slot
// nothing will ever again read the delete-preservation semantics for.
//
// Hard-deletes rather than another soft delete: the row is ALREADY a
// tombstone, invisible to every reader, so there is nothing left to preserve
// by keeping the row around — only the (book, id) primary key it still
// occupies. If master ever reissues this exact id later, it lands via the
// ordinary INSERT path (tryInsertTsvRow) and gets a fresh 'create' edit_log
// entry that carries every field — the same "later create resets every
// field" property boundHistoryToLastCreate and foldTsvBase already rely on
// for a reclaimed slot (see rowHistoryBoundary.ts) — so no special fold
// boundary is needed for a swept-then-reissued id either.
//
// Conservative on two axes, because a hard delete can't be un-swept the way a
// soft delete can:
//  - `verifiedComplete` gate, same reasoning as softDeleteRemovedTsvRows'
//    coverage widening just above: an id merely missing from a partial or
//    truncated body is not proof master dropped it — tsvFetchLooksTruncated
//    is a loss-percentage heuristic, not a positive completeness guarantee.
//    Every caller of this function already ran the truncation gate before
//    `rawTsv` reaches here (planAndStageBookResources / runReimport null out
//    a truncated fetch before it's ever staged or applied), so this is
//    defense in depth, not the only guard.
//  - TOMBSTONE_SWEEP_GRACE_SECONDS: only a tombstone at least this old is
//    swept, so a row THIS SAME run's prune pass (softDeleteRemovedTsvRows)
//    just tombstoned is never purged in the same breath — it gets a full
//    retention window during which a bug in that prune could still be caught
//    before the row becomes unrecoverable.
const TOMBSTONE_SWEEP_GRACE_SECONDS = 7 * 24 * 60 * 60;

async function sweepObsoleteTombstones(
  env: Env,
  book: string,
  kind: TsvKind,
  rawTsv: string,
  verifiedComplete: boolean,
): Promise<{ swept: number }> {
  if (!verifiedComplete) return { swept: 0 };
  const incomingIds = new Set<string>();
  for (const r of parseTsv(rawTsv).rows) {
    const p = parseTsvRow(r, kind);
    if (p) incomingIds.add(p.id);
  }
  // Defensive, mirrors softDeleteRemovedTsvRows: an empty/garbled file must
  // never be read as "master dropped everything".
  if (incomingIds.size === 0) return { swept: 0 };

  const cutoff = Math.floor(Date.now() / 1000) - TOMBSTONE_SWEEP_GRACE_SECONDS;
  const rs = await env.DB.prepare(
    `SELECT id, version FROM ${kind}_rows WHERE book = ?1 AND deleted_at IS NOT NULL AND deleted_at < ?2`,
  )
    .bind(book, cutoff)
    .all<{ id: string; version: number }>();
  const targets = (rs.results ?? []).filter((r) => !incomingIds.has(String(r.id)));
  if (targets.length === 0) return { swept: 0 };

  let swept = 0;
  // Each row costs two statements (delete + gated log), same halving as the
  // reclaim batch above, for the same reason: stay under D1's per-batch
  // statement cap.
  const SWEEP_PAIR_BATCH = Math.floor(WRITE_BATCH / 2);
  for (let i = 0; i < targets.length; i += SWEEP_PAIR_BATCH) {
    const slice = targets.slice(i, i + SWEEP_PAIR_BATCH);
    const stmts: D1PreparedStatement[] = [];
    for (const t of slice) {
      stmts.push(
        // Compare-and-set on BOTH scan conditions, not just "still a
        // tombstone": between the SELECT above and this DELETE, a concurrent
        // reclaim could clear deleted_at and a fresh delete could re-set it,
        // and a bare `deleted_at IS NOT NULL` would then hard-delete a
        // BRAND-NEW tombstone — bypassing the grace period entirely and
        // auditing a stale version. Re-asserting `deleted_at < cutoff` and
        // `version = <scanned>` makes the row we delete provably the row we
        // scanned; anything changed since simply matches 0 rows, which the
        // changes() gate below already handles as "lost a race".
        env.DB.prepare(
          `DELETE FROM ${kind}_rows
             WHERE book = ?1 AND id = ?2
               AND deleted_at IS NOT NULL AND deleted_at < ?3
               AND version = ?4`,
        ).bind(book, t.id, cutoff, t.version),
        // SQL-`changes()`-gated, same idiom as gatedLogEditStmt: only audits a
        // sweep that actually landed a row's worth of DELETE — never a
        // phantom row for one that lost a race (e.g. a concurrent
        // resurrect/reclaim clearing deleted_at first, which makes the
        // DELETE above match 0 rows).
        env.DB.prepare(
          `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
           SELECT ?1, ?2, ?3, NULL, ?4, NULL, 'tombstone_swept', ?5
            WHERE changes() > 0`,
        ).bind(kind, t.id, book, t.version, REIMPORT_SOURCE),
      );
    }
    try {
      const results = await env.DB.batch(stmts);
      slice.forEach((_t, j) => {
        if ((results[j * 2]?.meta.changes ?? 0) > 0) swept++;
      });
    } catch (e) {
      console.warn("reimport: tombstone sweep batch failed", {
        book,
        kind,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { swept };
}

// SHA-gate each requested resource and stage the changed ones to R2. Returns
// the book's chapter extent + a manifest the chunk steps read from.
async function planAndStageBookResources(
  env: Env,
  book: string,
  resources: Resource[],
  instanceId: string,
): Promise<ReimportPlan> {
  const maxRow = await env.DB
    .prepare(`SELECT MAX(chapter) AS m FROM verses WHERE book = ?1`)
    .bind(book)
    .first<{ m: number | null }>();
  const maxChapter = maxRow?.m ?? 0;
  if (maxChapter < 1) return { maxChapter, entries: [] };

  const entries: StagedResource[] = [];
  for (const resource of resources) {
    const file = dcsResourceFile(book, resource);
    if (!file) { entries.push({ resource, changed: false, masterSha: null, r2Key: null, verifiedComplete: false }); continue; }

    const masterSha = await fileCommitSha(env, file.repo, file.path);
    const sync = await resourceSyncState(env, book, resource);
    // Skip ONLY on a positive SHA match (fail-open: null/unknown → reimport).
    if (masterSha && sync.sourceSha && masterSha === sync.sourceSha) {
      entries.push({ resource, changed: false, masterSha, r2Key: null, verifiedComplete: false });
      continue;
    }

    // TSV resources go through fetchTsvMasterVerified (issue #485, second P1
    // follow-up) so softDeleteRemovedTsvRows can know whether THIS fetch
    // carried fetchDcsMasterText's independent completeness proof — see
    // fetchTsvMasterVerified and softDeleteRemovedTsvRows. ULT/UST stay on
    // plain fetchText: verses are never row-pruned by chapter absence.
    // Both branches pin to `masterSha` — the exact commit SHA the SHA-gate
    // check just above already resolved for this (book, resource) — rather
    // than re-resolving "master"'s current tip independently inside the
    // fetch. See fetchTsvMasterVerified's third-P1-follow-up comment and
    // dcsRawUrl in dcsSources.ts. `masterSha` can be null (fileCommitSha
    // failed transiently); both calls fall back to their unpinned defaults in
    // that case, same as before this fix.
    const isTsv = resource === "tn" || resource === "tq" || resource === "twl";
    let raw: string | null;
    let verifiedComplete = false;
    if (isTsv) {
      const fetched = await fetchTsvMasterVerified(env, file.repo, file.path, masterSha ?? undefined);
      raw = fetched.raw;
      verifiedComplete = fetched.verifiedComplete;
    } else {
      raw = await fetchText(dcsRawUrl(env, file.repo, file.path, masterSha ?? undefined));
    }
    if (raw == null) {
      // DCS 404 / fetch error → nothing to import, no watermark.
      entries.push({ resource, changed: false, masterSha: null, r2Key: null, verifiedComplete: false });
      continue;
    }

    // Own-publish recognition — the AMOS revert fix. Master's file SHA moved,
    // but if its BYTES are exactly the render we last pushed, master moved
    // because OUR `-be-` branch merged, not because anyone edited master. There
    // is then nothing foreign to merge: advance the merge ancestor cutoff to
    // that render's D1-read time, record master's SHA so the export's freshness
    // gate still passes, and skip this resource's row work entirely. Without
    // this, the per-verse merge reads our own merged export as a foreign edit
    // and `adopt_conflict` overwrites every app edit made since (verseMerge.ts
    // step 6). See ownPublish.ts for the full incident and the fail-safe
    // argument; recognition can only ever DECLINE into the pre-existing merge.
    //
    // Skipping is right for the TSV resources too, and for the same reason, not
    // by accident: #444's three-way merge for edited tn/tq/twl rows exists to
    // adopt FOREIGN Door43 edits into rows a translator has touched. When
    // master's bytes are byte-for-byte our own last render, there is no foreign
    // edit in that file to adopt — running the merge could only re-adjudicate our
    // own content. The watermark stamped just below is what that merge reads as
    // its ancestor, so this both skips tonight's no-op and repairs the
    // attribution for the next night that DOES carry a real Door43 edit.
    //
    // Placed BEFORE the truncation gate below deliberately: an exact whole-file
    // byte match against our own render is strictly stronger evidence of
    // completeness than that gate's row-count heuristic, and running first
    // saves its D1 count query on a converged resource.
    const own = await recognizePushedRender(env, book, resource, raw, sync);
    if (own.recognized) {
      const stamped = await markOwnPublishConverged(env, book, resource, own.readAt, sync.pushedEditId, masterSha);
      console.log("reimport recognized master's movement as our own publish", {
        book,
        resource,
        masterSha,
        confirmedAt: own.readAt,
        stamped,
      });
      // `ownPublish` is reported only when the stamp actually landed — see
      // markOwnPublishConverged's contract. The resource is skipped either way
      // (master holds our own render, so there is nothing to import), but a run
      // must not report a watermark advance it did not get.
      entries.push({ resource, changed: false, masterSha, r2Key: null, ownPublish: stamped, verifiedComplete: false });
      continue;
    }
    if (own.reason === "content_differs") {
      // How we find out whether this fix is actually working in prod. A decline
      // here is EITHER the correct answer (a genuine foreign commit on master,
      // which is what the three-way merge is for) OR the one way this fix could
      // be quietly inert: if the DCS validate-and-merge Action rewrites the file
      // on merge — reformatting, re-encoding, normalizing line endings — master's
      // bytes would never equal ours and recognition would never fire, with no
      // symptom other than the AMOS reverts continuing. The two are
      // indistinguishable from inside this function, so log the fact rather than
      // assert a cause (standing rule: an alert may only state what it measured).
      // `wrangler tail | grep own-publish` across a few nights separates them:
      // all-declines on books nobody edits on Door43 means the bytes are being
      // rewritten and the recognition needs to move to a normalized comparison.
      console.log("reimport own-publish declined: master differs from our last render", {
        book,
        resource,
        masterSha,
      });
    }

    // Completeness gate (TSV only). A truncated body must NOT be staged or get a
    // watermark — otherwise it prunes the book AND certifies it "in sync",
    // hiding the damage (the HAB tn incident). masterSha:null here is critical:
    // the reimport-sync step only stamps watermarks for entries with a masterSha.
    if (isTsv && (await tsvFetchLooksTruncated(env, book, resource, raw))) {
      entries.push({ resource, changed: false, masterSha: null, r2Key: null, verifiedComplete: false });
      continue;
    }
    // Master's file moved, and it was not our own render coming back — so
    // SOMEONE moved it, and both merges are about to need to know who (#540
    // item 1). This is the one point in the nightly path that talks to DCS per
    // pair, so the walk happens here, once, and rides the plan into every chunk
    // step. The extra D1 read buys the correct boundary: the walk must start
    // where the merge's ancestor sits (`master_confirmed_at`), not at
    // `sync.sourceSha`, which this very function is about to move past it.
    const lineage = await loadMasterLineage(
      env,
      book,
      resource,
      (await getMasterConfirmedAt(env, book, resource)).confirmedAt,
    );
    const r2Key = `reimport-stage/${instanceId}/${book}/${resource}`;
    await env.BLOBS.put(r2Key, raw);
    entries.push({ resource, changed: true, masterSha, r2Key, verifiedComplete, lineage });
  }
  return { maxChapter, entries };
}

// Reimport one chapter range from staged files. Reads each staged file once,
// then loops chapters. TSV chapters absent from changedTsv[kind] are skipped.
async function reimportStagedChunk(
  env: Env,
  book: string,
  startChapter: number,
  endChapter: number,
  staged: StagedResource[],
  changedTsv: Partial<Record<TsvKind, number[]>>,
  userId: number | null,
): Promise<Record<Resource, ReimportCounts>> {
  const perResource = freshPerResource();

  // Read + parse each staged file ONCE for the whole chunk (not per chapter).
  // The old per-chapter calls re-parsed the entire book each time (usfm.toJSON
  // / parseTsv), which tripped the per-step CPU limit on large books.
  const rawByResource: Partial<Record<Resource, string>> = {};
  for (const e of staged) {
    if (!e.changed || !e.r2Key) continue;
    const raw = await readStaged(env, e.r2Key);
    if (raw != null) rawByResource[e.resource] = raw;
  }

  // USFM: one parse of the chunk range per version, grouped by chapter.
  const versesByChapter: Partial<Record<"ult" | "ust", Map<number, VerseExtract[]>>> = {};
  for (const resource of ["ult", "ust"] as const) {
    const raw = rawByResource[resource];
    if (!raw) continue;
    const byCh = new Map<number, VerseExtract[]>();
    for (const ve of extractVersesForRange(raw, startChapter, endChapter)) {
      let arr = byCh.get(ve.chapter);
      if (!arr) byCh.set(ve.chapter, (arr = []));
      arr.push(ve);
    }
    versesByChapter[resource] = byCh;
  }

  // TSV: one parse per kind, grouped by chapter (within the chunk range).
  // No chapter-0 special case needed here: this range filter is generic on
  // whatever [startChapter, endChapter] the caller passes, and
  // runChunkedReimport's first chunk now passes startChapter=0 (see
  // reimportChunkBoundaries) so a front:intro row (chapter 0) already falls
  // inside the range without touching this comparison.
  const rowsByChapter: Partial<Record<TsvKind, Map<number, ParsedTsvRow[]>>> = {};
  for (const kind of ["tn", "tq", "twl"] as TsvKind[]) {
    const raw = rawByResource[kind];
    if (!raw) continue;
    const byCh = new Map<number, ParsedTsvRow[]>();
    for (const r of parseTsv(raw).rows) {
      const p = parseTsvRow(r, kind);
      if (!p || p.chapter < startChapter || p.chapter > endChapter) continue;
      let arr = byCh.get(p.chapter);
      if (!arr) byCh.set(p.chapter, (arr = []));
      arr.push(p);
    }
    rowsByChapter[kind] = byCh;
  }

  const changedSets: Partial<Record<TsvKind, Set<number>>> = {};
  for (const k of ["tn", "tq", "twl"] as TsvKind[]) {
    if (changedTsv[k]) changedSets[k] = new Set(changedTsv[k]);
  }

  // FIX 1 (hoist): read the verse-merge ancestor cutoff ONCE per resource for
  // this whole chunk step, not once per chapter — see getMasterConfirmedAt.
  // Up to 2 reads per step (ult + ust), down from up to ~18 (REIMPORT_CHAPTER_
  // CHUNK=8 chapters, +1 for chapter 0 on the first chunk, × 2 resources).
  // The lineage rides in on the plan (#540 item 1) — measured ONCE per pair at
  // stage time, not re-fetched per chunk, which is what keeps this at one Gitea
  // walk per (book, resource) per night. `?? null` is not a coercion of a
  // measured value: an entry from a plan staged before this shipped simply has
  // no field, and null means "nobody looked", which is the protective answer.
  const lineageOf = (resource: Resource): MasterLineageSummary | null =>
    staged.find((e) => e.resource === resource)?.lineage ?? null;
  const withLineage = (cutoff: MergeCutoff | null, resource: Resource): MergeCutoff | null =>
    cutoff == null ? null : { ...cutoff, lineage: lineageOf(resource) };

  const masterConfirmedAtUlt = withLineage(
    versesByChapter.ult ? await getMasterConfirmedAt(env, book, "ult") : null,
    "ult",
  );
  const masterConfirmedAtUst = withLineage(
    versesByChapter.ust ? await getMasterConfirmedAt(env, book, "ust") : null,
    "ust",
  );
  // Same hoist for the TSV three-way merge ancestor cutoffs — once per chunk
  // step, read only for a kind that actually has rows staged this chunk.
  const masterConfirmedAtTsv: Record<TsvKind, MergeCutoff | null> = {
    tn: withLineage(rowsByChapter.tn ? await getMasterConfirmedAt(env, book, "tn") : null, "tn"),
    tq: withLineage(rowsByChapter.tq ? await getMasterConfirmedAt(env, book, "tq") : null, "tq"),
    twl: withLineage(rowsByChapter.twl ? await getMasterConfirmedAt(env, book, "twl") : null, "twl"),
  };

  for (let chapter = startChapter; chapter <= endChapter; chapter++) {
    const lock = await activePipelineForChapter(env, book, chapter);
    if (lock) {
      for (const e of staged) {
        if (!e.changed) continue;
        perResource[e.resource].skipped_locked++;
        // chapters_locked gates the sync watermark (shouldRecordResourceSync)
        // — it must be truthful, or a lock on a chapter with no real work for
        // a given resource would stall that resource's watermark for nothing
        // (over-withholding: up to 5 export_stale alerts/night for 1 locked
        // chapter). For the TSV kinds we can check EXACTLY what the row loop
        // below would have done: it skips a chapter when `changedSets[kind]`
        // exists and doesn't contain the chapter (line ~1968's `continue`).
        // Mirror that condition here — increment only when this kind actually
        // had work in the locked chapter.
        //
        // ult/ust are deliberately left unconditional (fail-safe): unlike a
        // TSV kind's precomputed changed-chapter set, "did this chapter have
        // any verses to write" isn't available here as an equally exact
        // check, and the safe direction on uncertainty is to withhold, not
        // to stamp.
        if (e.resource === "ult" || e.resource === "ust") {
          perResource[e.resource].chapters_locked++;
          continue;
        }
        const set = changedSets[e.resource as TsvKind];
        if (!set || set.has(chapter)) perResource[e.resource].chapters_locked++;
      }
      continue;
    }
    for (const kind of ["tn", "tq", "twl"] as TsvKind[]) {
      const byCh = rowsByChapter[kind];
      if (!byCh) continue;
      const set = changedSets[kind];
      if (set && !set.has(chapter)) continue;  // chapter unchanged — skip the row loop
      addCounts(perResource[kind], await applyTsvRows(env, book, kind, byCh.get(chapter) ?? [], userId, masterConfirmedAtTsv[kind]));
    }
    // broadcastLaneReopens: false — this is the nightly chunked path
    // (reimportStagedChunk). WS messages are hints (CLAUDE.md) and nobody
    // has a tab open at 05:30 UTC, so the live-tab notification is skipped
    // entirely here; the checkoff-reopening DELETE still runs regardless.
    // See applyVerseRows's parameter doc.
    if (versesByChapter.ult) {
      addCounts(
        perResource.ult,
        await applyVerseRows(
          env, book, "ULT", versesByChapter.ult.get(chapter) ?? [], userId, masterConfirmedAtUlt, false,
        ),
      );
    }
    if (versesByChapter.ust) {
      addCounts(
        perResource.ust,
        await applyVerseRows(
          env, book, "UST", versesByChapter.ust.get(chapter) ?? [], userId, masterConfirmedAtUst, false,
        ),
      );
    }
  }
  return perResource;
}

// Orchestrate a chunked, SHA-gated, diff-aware reimport of one book as a series
// of Workflow steps. Lock-free (see section header). Returns aggregate counts.
export async function runChunkedReimport(
  env: Env,
  step: WorkflowStep,
  book: string,
  instanceId: string,
  resources: Resource[],
  // FIX H: `mergeRefusalOverrideResource` — when set, isSystemicMergeRefusal
  // is forced open for exactly this ONE resource (never wholesale — see
  // reimportSyncGate.ts's mergeRefusalOverrideAllowed, which the caller
  // (exportWorkflow.ts) uses to compute this, gated on the run naming
  // exactly one book AND one resource). Undefined/omitted preserves the
  // pre-existing behavior for every cron path.
  // Issue #473 option A: `idBlockedOverrideResource` — when set, the
  // conflict_skipped/tombstone_blocked half of shouldRecordResourceSync is
  // forced open for exactly this ONE resource, computed the same narrow way
  // by exportWorkflow.ts's idBlockedOverrideAllowed. Undefined/omitted
  // preserves the pre-existing behavior for every cron path.
  opts: { chunk?: number; mergeRefusalOverrideResource?: Resource; idBlockedOverrideResource?: Resource } = {},
): Promise<ReimportResult> {
  const chunkSize = opts.chunk ?? REIMPORT_CHAPTER_CHUNK;

  const plan = await step.do(
    `reimport-fetch-${book}`,
    { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
    async () => planAndStageBookResources(env, book, resources, instanceId),
  );

  // Own-publish recognition already ran inside planAndStageBookResources (it
  // needs master's fetched bytes, which only exist there) and already advanced
  // the watermark + source_sha for each converged resource. All that is left
  // here is to REPORT it — and that has to happen before the early return
  // below, because "every changed resource turned out to be our own publish" is
  // the single most common shape of this fix firing: `changed` is then empty and
  // an unadorned emptyResult would report the night as "nothing happened".
  const perResource = freshPerResource();
  for (const e of plan.entries) {
    if (e.ownPublish) perResource[e.resource].own_publish_converged++;
  }

  const changed = plan.entries.filter((e) => e.changed);
  if (plan.maxChapter < 1 || changed.length === 0) {
    const totals = zeroCounts();
    for (const r of ALL_RESOURCES) addCounts(totals, perResource[r]);
    return { book, perResource, totals };
  }

  // Per-changed-TSV: which chapters actually differ (so chunks skip the rest).
  const changedTsv = await step.do(`reimport-tsvgate-${book}`, async () => {
    const out: Partial<Record<TsvKind, number[]>> = {};
    for (const e of changed) {
      if (e.resource === "ult" || e.resource === "ust" || !e.r2Key) continue;
      const raw = await readStaged(env, e.r2Key);
      if (raw == null) continue;
      out[e.resource] = [...(await changedTsvChapters(env, book, e.resource, raw))];
    }
    return out;
  });

  for (const { start, end } of reimportChunkBoundaries(plan.maxChapter, chunkSize)) {
    const counts = await step.do(
      `reimport-${book}-ch${start}-${end}`,
      { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
      async () => reimportStagedChunk(env, book, start, end, changed, changedTsv, null),
    );
    mergePerResource(perResource, counts);
  }

  // FIX 4: fire the verse-merge-conflict banner once per (book, resource) for
  // this whole run, not once per chunk — a per-chunk DELETE-then-INSERT alert
  // would have the last chunk's alert erase every earlier chunk's (see
  // raiseVerseMergeConflictAlert's own comment). It derives its content by
  // reading verse_merge_conflicts directly, so it also reports conflicts that
  // survived from an earlier run.
  await step.do(`reimport-mergealert-${book}`, async () => {
    for (const e of changed) {
      if (e.resource !== "ult" && e.resource !== "ust") continue;
      await raiseVerseMergeConflictAlert(env, book, e.resource, {
        recordingFailed: perResource[e.resource].merge_record_failed === true,
        noBaseCount: perResource[e.resource].merge_no_base,
        noBaseRefs: perResource[e.resource].merge_no_base_refs,
        noBaseEditorRefs: perResource[e.resource].merge_no_base_editor_refs,
      });
    }
  });

  // After applying each changed TSV file, soft-delete pristine rows whose ids
  // master no longer carries — otherwise the next export branch resurrects
  // out-of-band deletions. See softDeleteRemovedTsvRows for the guardrails.
  // Runs before the staged-R2 cleanup step so the file is still readable.
  for (const e of changed) {
    const kind = e.resource;
    if (kind === "ult" || kind === "ust" || !e.r2Key) continue;
    const chs = changedTsv[kind];
    if (!chs || chs.length === 0) continue;
    const r2Key = e.r2Key;
    const verifiedComplete = e.verifiedComplete;
    const res = await step.do(`reimport-prune-${book}-${kind}`, async () => {
      const raw = await readStaged(env, r2Key);
      if (raw == null) return { deleted: 0, skippedLocked: 0 };
      const res = await softDeleteRemovedTsvRows(env, book, kind, raw, chs, verifiedComplete);
      if (res.deleted > 0 || res.skippedLocked > 0) {
        console.log("reimport pruned rows removed on master", { book, resource: kind, ...res });
      }
      return res;
    });
    // Feed the prune's own lock skips into the watermark gate (FIX A / the
    // prune-phase half of shouldRecordResourceSync) — this step runs LATER
    // than the chunk-apply steps above, so a lock that starts after those
    // steps finish but is still held here is invisible to chapters_locked.
    if (res.skippedLocked > 0) perResource[kind].prune_locked += res.skippedLocked;
  }

  // Issue #427, option 3: sweep tombstones whose id no longer appears
  // anywhere in master's file — see sweepObsoleteTombstones's header for the
  // disjointness argument with the prune loop above (that loop tombstones a
  // row master no longer carries; this one hard-deletes a tombstone that was
  // ALREADY dead and stayed unclaimed). Deliberately NOT gated on
  // changedTsv[kind] the way the prune loop is: an old, otherwise-quiet
  // chapter can still hold a tombstone worth sweeping even when nothing in it
  // changed tonight — the file only needs to have been re-fetched this run to
  // prove the id's absence, which `e.r2Key` already tells us it was.
  for (const e of changed) {
    const kind = e.resource;
    if (kind === "ult" || kind === "ust" || !e.r2Key) continue;
    const r2Key = e.r2Key;
    const verifiedComplete = e.verifiedComplete;
    const res = await step.do(`reimport-tombsweep-${book}-${kind}`, async () => {
      const raw = await readStaged(env, r2Key);
      if (raw == null) return { swept: 0 };
      return sweepObsoleteTombstones(env, book, kind, raw, verifiedComplete);
    });
    if (res.swept > 0) {
      console.log("reimport swept obsolete tombstones (id absent from master entirely)", {
        book,
        resource: kind,
        swept: res.swept,
      });
    }
  }

  // Canonical TWL order: recompute the ULT-position ordering for the book now
  // that this run's ULT + twl changes are applied. The export step canonicalizes
  // too, but a twl file whose content didn't change is freshness-skipped at
  // export — so an upstream ULT re-alignment (twl file untouched) would otherwise
  // never re-sequence twl in D1. Idempotent (empty diff when already canonical);
  // positional metadata only. Runs only when this night touched twl or ult.
  if (changed.some((e) => e.resource === "twl" || e.resource === "ult")) {
    const r = await step.do(`reimport-twlorder-${book}`, async () => ({
      reordered: await canonicalizeTwlOrder(env, book),
    }));
    perResource.twl.twl_reordered += r.reordered;
  }

  // Record fetch-time SHAs for resources that ran (so a later night can skip)
  // — EXCEPT for a resource with chapters_locked > 0. A watermark must not
  // certify data it didn't apply (the same principle as the truncated-fetch
  // completeness gate in planAndStageBookResources above, for the HAB tn
  // incident): if a chapter was skipped this run because a pipeline job held
  // its lock, that resource's D1 rows for that chapter are stale even though
  // the rest of the book is current. Stamping the watermark anyway is exactly
  // what happened to EZK 40 UST — D1 stayed on a 2026-06-10 revision while
  // the watermark certified the book "in sync at master's SHA" after
  // bp-assistant pushed an entirely new chapter 40 on 2026-08-01. The nightly
  // export's freshness gate (checkMasterFreshness) trusted that stamp and
  // rendered the stale chapter over master's new one; only the alignment-
  // shrink backstop caught it, and it reported a misleading word-level
  // "align_loss" alert instead of the real "different revision" problem.
  //
  // Withholding the stamp here means the next export's freshness gate sees
  // `master_ahead` and skips the export with an honest `export_stale` alert
  // naming the book, instead of exporting stale data. If a chapter stayed
  // locked forever the book would never export — that is fail-safe (better
  // than reverting master), and it stays visible via the export_stale alert
  // rather than silently certifying stale data. (The stuck-lock root cause is
  // separately fixed in PR #393.)
  await step.do(`reimport-sync-${book}`, async () => {
    let recorded = 0;
    const withheld: string[] = [];
    for (const e of changed) {
      // FINDING 1: consult the gate BEFORE the masterSha check, not after. A
      // resource can be staged `changed: true` with `masterSha: null`
      // (planAndStageBookResources: fetchText() succeeded but fileCommitSha()
      // returned null) even when work for it was skipped this run for a held
      // chapter lock. The old order did `if (!e.masterSha) continue;` first,
      // so that case fell through this loop entirely — no stamp (fine), but
      // also no withheld sentinel written. For a (book, resource) with no
      // existing watermark row, checkMasterFreshness then returns
      // `{ ok: true, detail: "no_watermark" }` and the export proceeds,
      // pushing the stale locked-chapter data over master. An unknown
      // masterSha must never be allowed to skip past the withholding — only
      // a resource that both PASSES the gate and has a real masterSha may be
      // recorded as synced.
      // FIX 7: withhold the watermark once this run's alignment-refused
      // verses for this resource look systemic (>= SYSTEMIC_MERGE_REFUSAL_
      // THRESHOLD), same direction as the existing chapters_locked/
      // prune_locked gates — a maintainer's work is being reverted at scale,
      // so tonight's export must not run against it. Consulted alongside the
      // existing gate (either firing withholds), never instead of it.
      // FIX H: the override, when the caller granted it for exactly this
      // resource, forces isSystemicMergeRefusal open for this run only — see
      // opts.mergeRefusalOverrideResource's doc above.
      const refusalOverride = opts.mergeRefusalOverrideResource === e.resource;
      const systemicRefusals = isSystemicMergeRefusal(
        perResource[e.resource].merge_refused ?? 0,
        undefined,
        refusalOverride,
      );
      // #540 item 2's scale alarm, raised OUTSIDE the withhold branch below and
      // gating nothing: keeping the app's version at scale does not make the
      // resource unsafe to export — it makes it worth a human's eye BEFORE the
      // export publishes those rows to Door43. See isKeptOverDoor43AtScale.
      if (isKeptOverDoor43AtScale(perResource[e.resource].merge_kept_ai ?? 0)) {
        await raiseKeptOverDoor43Alert(env, book, e.resource, perResource[e.resource].merge_kept_ai ?? 0);
      }
      // FIX 1: withhold the watermark when this run's merge-conflict
      // recording failed for this resource (applyVerseRows step 6b —
      // recordVerseMergeConflicts returned false, so the whole adoption
      // write batch was skipped in step 7). Without this, nothing stopped
      // master's SHA from being stamped anyway: tonight's export would then
      // render D1's un-adopted content back over master (reverting the
      // maintainer's correction — the exact 1CH-shaped revert this PR
      // exists to fix), and the SHA watermark would make the NEXT run's
      // planAndStageBookResources skip this resource entirely (its
      // fileCommitSha === stored check matches), so there would never be a
      // retry. See applyVerseRows's FIX 1 comment at the `masterAdoptions`
      // skip site for the other half of this fix.
      const mergeRecordFailed = perResource[e.resource].merge_record_failed === true;
      // Withhold when a correctness-bearing adoption WRITE threw this run
      // (apply_incomplete) — verse master-adoption / source-attr reconcile /
      // TSV three-way merge. D1 is stale for those rows; stamping would certify
      // it in-sync and the export would revert master with no retry (Codex's
      // failed-adoption-write gate). Sibling to the other withhold conditions.
      const applyIncomplete = perResource[e.resource].apply_incomplete === true;
      // Issue #427: master rows this run dropped because a tombstone (or any
      // other holder) already owns their (book, id) primary key. Folded into
      // shouldRecordResourceSync rather than checked separately here, so the
      // aggregation-laundering guard (counts_incomplete) covers them too.
      // Issue #473 option A: the override, when the caller granted it for
      // exactly this resource, forces shouldRecordResourceSync's
      // conflict_skipped/tombstone_blocked check open for this run only — see
      // opts.idBlockedOverrideResource's doc above. It never touches the OTHER
      // three withhold conditions on this line (systemicRefusals,
      // mergeRecordFailed, applyIncomplete stay unconditional).
      const idBlockedOverride = opts.idBlockedOverrideResource === e.resource;
      const dropped =
        (perResource[e.resource].conflict_skipped ?? 0) + (perResource[e.resource].tombstone_blocked ?? 0);
      if (
        !shouldRecordResourceSync(perResource[e.resource], idBlockedOverride) ||
        systemicRefusals ||
        mergeRecordFailed ||
        applyIncomplete
      ) {
        withheld.push(e.resource);
        if (dropped > 0) {
          await raiseTombstoneBlockAlert(env, book, e.resource, perResource[e.resource]);
        }
        // FIX B: a book whose (book, resource) has NO existing watermark row
        // (e.g. seeded by scripts/import-book.mjs, or whose import-time SHA
        // fetch returned null — bookImport.ts) would otherwise have withholding
        // change nothing — checkMasterFreshness still reports `no_watermark`
        // (ok:true) and the export proceeds on stale data indefinitely. Write a
        // sentinel that can never match a real master SHA so the freshness gate
        // has something to refuse against. No-op when a real (or previously
        // withheld) row already exists — see recordWithheldSyncIfAbsent.
        await recordWithheldSyncIfAbsent(env, book, e.resource);
        continue;
      }
      if (!e.masterSha) continue;
      await recordResourceSync(env, book, e.resource, e.masterSha, "reimport");
      recorded++;
      // Issue #473 option A: the override let a nonzero drop count through to
      // a recorded sync above — raise the distinct "force-released, Door43
      // will lose these rows" alert instead of clearing it. Ordered AFTER
      // recordResourceSync (so the durable record reflects what actually
      // happened) and INSTEAD OF clearTombstoneBlockAlert below (which would
      // otherwise immediately delete the very alert this just wrote — both
      // share the same `reimport_id_blocked:${book}:${resource}` source).
      if (idBlockedOverride && dropped > 0) {
        await raiseTombstoneBlockAlert(env, book, e.resource, perResource[e.resource], true);
        continue;
      }
      // The resource just synced cleanly (it reached here, so it was NOT
      // withheld above) — clear any stale reimport_id_blocked alert from a
      // past run's tombstone_blocked/conflict_skipped count. See
      // clearTombstoneBlockAlert's doc comment for why this can't live inside
      // raiseTombstoneBlockAlert itself.
      await clearTombstoneBlockAlert(env, book, e.resource);
    }
    if (withheld.length) {
      // Not always "chapter lock held" any more — also fires for systemic
      // alignment refusals and for a merge-conflict recording failure (FIX 1).
      console.log("reimport withheld sync watermark", { book, withheld });
    }
    return { recorded, withheld };
  });

  // Best-effort cleanup of staged R2 objects.
  await step.do(`reimport-cleanup-${book}`, async () => {
    let cleaned = 0;
    for (const e of changed) {
      if (e.r2Key) { try { await env.BLOBS.delete(e.r2Key); cleaned++; } catch { /* best-effort */ } }
    }
    return { cleaned };
  });

  const totals = zeroCounts();
  for (const r of ALL_RESOURCES) addCounts(totals, perResource[r]);
  return { book, perResource, totals };
}
