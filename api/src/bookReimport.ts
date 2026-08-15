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
import { dcsUrls, dcsResourceFile, dcsRawUrl, fileCommitSha, fetchText, NT_BOOKS } from "./dcsSources";
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
  type EditedFieldMerge,
} from "./reimportClassify";
import { shouldRecordResourceSync, isSystemicMergeRefusal } from "./reimportSyncGate";
import { computeTwlSortOrderUpdates } from "./twlCanonicalOrder";
import { applyTwlSortOrderUpdates } from "./twlSortOrderApply";
import { loadTwTitles } from "./twTitles";
import { loadTwlOrderLocks } from "./twlOrderLocks";
import type { TwlRow, VerseRow, CheckLane } from "./types";
import { computeVerseMerge, type VerseMergeResult } from "./verseMerge.ts";
import { verseContentJsonFromPayload } from "./verseHistory.ts";
import { canonizeAlignmentSource } from "./canonizeHebrew.ts";
import {
  recordVerseMergeConflicts,
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
  // Verse whose content was adopted from master via computeVerseMerge — either
  // action "adopt" (master moved, we didn't) or "adopt_conflict" (both moved;
  // master won, flagged for review — see merge_conflicts). Incremented only
  // when the version-CAS write actually landed (see the master-adoption batch).
  // verses only. See verseMerge.ts / the 1CH incident this fixes.
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
  // recover. verses only.
  merge_conflicts: number;
  // Verse where computeVerseMerge returned "keep_alignment_refused" — master's
  // edit was NOT adopted because doing so would lose alignment on words
  // neither side touched. A subset of merge_conflicts (every refusal needs a
  // human) tracked separately so the reason breakdown is visible. verses only.
  merge_refused: number;
  // Verse where computeVerseMerge returned "keep_no_base" — no ancestor was
  // recoverable for this specific verse (edit_log aged past the 180-day
  // retention, or the verse has no edit_log row before book_resource_syncs.
  // master_confirmed_at). D1 is kept, matching the pre-existing safe default.
  // Only counted when this book+resource HAS a master_confirmed_at watermark
  // at all; a book/resource never positively confirmed in master skips the
  // merge entirely and counts nothing here. verses only.
  merge_no_base: number;
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
}

export interface ReimportResult {
  book: string;
  perResource: Record<Resource, ReimportCounts>;
  totals: ReimportCounts;
}

const REIMPORT_SOURCE = "dcs_reimport";

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
    resurrected: 0,
    source_attr_reconciled: 0,
    source_attr_divergent: 0,
    twl_reordered: 0,
    merge_adopted: 0,
    merge_conflicts: 0,
    merge_refused: 0,
    merge_no_base: 0,
    merge_unavailable: 0,
    merge_cosmetic_ignored: 0,
    merge_record_failed: false,
    dcs_404: 0,
    errors: [],
    counts_incomplete: false,
  };
}

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
  const incomplete =
    from.chapters_locked === undefined || from.prune_locked === undefined;
  into.counts_incomplete = Boolean(into.counts_incomplete || from.counts_incomplete || incomplete);
  into.chapters_locked += from.chapters_locked ?? 0;
  into.prune_locked += from.prune_locked ?? 0;
  into.skipped_noop += from.skipped_noop;
  into.skipped_dup += from.skipped_dup;
  into.resurrected += from.resurrected;
  into.source_attr_reconciled += from.source_attr_reconciled;
  into.source_attr_divergent += from.source_attr_divergent;
  into.twl_reordered += from.twl_reordered;
  into.merge_adopted += from.merge_adopted ?? 0;
  into.merge_conflicts += from.merge_conflicts ?? 0;
  into.merge_refused += from.merge_refused ?? 0;
  into.merge_no_base += from.merge_no_base ?? 0;
  into.merge_unavailable += from.merge_unavailable ?? 0;
  into.merge_cosmetic_ignored += from.merge_cosmetic_ignored ?? 0;
  into.merge_record_failed = Boolean(into.merge_record_failed || from.merge_record_failed);
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
  let [ultRaw, ustRaw, tnRaw, tqRaw, twlRaw] = await Promise.all([
    want.has("ult") ? fetchText(urls.ult) : Promise.resolve(null),
    want.has("ust") ? fetchText(urls.ust) : Promise.resolve(null),
    want.has("tn") ? fetchText(urls.tn) : Promise.resolve(null),
    want.has("tq") ? fetchText(urls.tq) : Promise.resolve(null),
    want.has("twl") ? fetchText(urls.twl) : Promise.resolve(null),
  ]);

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

  // FIX 1 (hoist): read the verse-merge ancestor cutoff ONCE per (book,
  // resource) for this whole run, not once per chapter — see
  // getMasterConfirmedAt. 2 reads total for this run (ult + ust), down from
  // one per chapter.
  const masterConfirmedAtUlt = want.has("ult") && ultRaw ? await getMasterConfirmedAt(env, book, "ult") : null;
  const masterConfirmedAtUst = want.has("ust") && ustRaw ? await getMasterConfirmedAt(env, book, "ust") : null;

  for (const chapter of chapters) {
    const lock = await activePipelineForChapter(env, book, chapter);
    if (lock) {
      for (const r of resources) {
        perResource[r].skipped_locked++;
        perResource[r].chapters_locked++;
      }
      continue;
    }

    if (want.has("tn") && tnRaw) {
      const c = await reimportTsvForChapter(env, book, chapter, tnRaw, "tn", userId);
      addCounts(perResource.tn, c);
    }
    if (want.has("tq") && tqRaw) {
      const c = await reimportTsvForChapter(env, book, chapter, tqRaw, "tq", userId);
      addCounts(perResource.tq, c);
    }
    if (want.has("twl") && twlRaw) {
      const c = await reimportTsvForChapter(env, book, chapter, twlRaw, "twl", userId);
      addCounts(perResource.twl, c);
    }
    if (want.has("ult") && ultRaw) {
      const c = await reimportVersesForChapter(env, book, chapter, ultRaw, "ULT", userId, masterConfirmedAtUlt);
      addCounts(perResource.ult, c);
    }
    if (want.has("ust") && ustRaw) {
      const c = await reimportVersesForChapter(env, book, chapter, ustRaw, "UST", userId, masterConfirmedAtUst);
      addCounts(perResource.ust, c);
    }
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
    });
  }
  if (want.has("ust")) {
    await raiseVerseMergeConflictAlert(env, book, "ust", {
      recordingFailed: perResource.ust.merge_record_failed === true,
      noBaseCount: perResource.ust.merge_no_base,
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
  for (const kind of ["tn", "tq", "twl"] as TsvKind[]) {
    const raw = tsvRawByKind[kind];
    if (!want.has(kind) || !raw) continue;
    try {
      const res = await softDeleteRemovedTsvRows(env, book, kind, raw, chapters);
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
// by rowsForChapter (the reimport row loop) and changedTsvChapters (the diff
// gate) so the two agree exactly on field normalization — otherwise the gate
// could mis-classify a chapter as unchanged. Returns null for a row with no ID.
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

function rowsForChapter(raw: string, kind: TsvKind, chapter: number): ParsedTsvRow[] {
  const { rows } = parseTsv(raw);
  const out: ParsedTsvRow[] = [];
  for (const r of rows) {
    const parsed = parseTsvRow(r, kind);
    if (!parsed || parsed.chapter !== chapter) continue;
    out.push(parsed);
  }
  return out;
}

// One UPDATE per pristine row, plus one INSERT-OR-IGNORE per row to seed
// any DCS-new entries. We don't batch into env.DB.batch() because the per-
// row "did anything change?" signal comes from meta.changes, and batch()
// reports aggregate counts only. Throughput is fine — a chapter's worth of
// tn rows is dozens, not thousands.
async function reimportTsvForChapter(
  env: Env,
  book: string,
  chapter: number,
  raw: string,
  kind: TsvKind,
  userId: number | null,
): Promise<ReimportCounts> {
  return applyTsvRows(env, book, kind, rowsForChapter(raw, kind, chapter), userId);
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
async function applyTsvRows(
  env: Env,
  book: string,
  kind: TsvKind,
  incoming: ParsedTsvRow[],
  userId: number | null,
): Promise<ReimportCounts> {
  const counts = zeroCounts();
  if (incoming.length === 0) return counts;
  const now = Math.floor(Date.now() / 1000);

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
      `SELECT id, ${TSV_STORED_COLS[kind]}, sort_order, ${pristineCols},
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
  // Rows classified "edited" (human-owned) that still have master-owned or
  // whitespace-only fields to sync in — see computeEditedFieldMerge. Written
  // in their own batch below WITHOUT touching updated_by; the row stays
  // human-owned. `id` is carried separately from `merge` for the write.
  const fieldMerges: Array<{ id: string; oldVersion: number; merge: EditedFieldMerge }> = [];
  for (let i = 0; i < incoming.length; i++) {
    const row = incoming[i];
    const sortOrder = nextSort(row.chapter, row.verse);
    const cur = existing.get(row.id);
    if (!cur) {
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
        if (await tryInsertTsvRow(env, book, kind, row, sortOrder)) {
          counts.inserted++;
          await logEdit(env, kind, row.id, book, userId, null, 1, "create", row);
        } else {
          counts.skipped_noop++; // raced — appeared concurrently
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
      } else {
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
      continue;
    }
    if (fate === "edited") {
      // The row is human-owned, but some columns never are (or aren't on this
      // kind) — see computeEditedFieldMerge. Compare D1's current values
      // against master's incoming ones; only tags/note/question/response can
      // ever qualify, and protections (deleted_at/trashed_at/preserve/hint)
      // block it outright regardless of field.
      const merge = computeEditedFieldMerge(
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
      if (merge) {
        fieldMerges.push({ id: row.id, oldVersion: Number(cur.version), merge });
      } else {
        counts.skipped_edited++;
      }
      continue;
    }
    if (fate === "update_ai") {
      aiReseeds.push({ row, sortOrder, oldVersion: Number(cur.version) });
      continue;
    }
    updates.push({ row, sortOrder, oldVersion: Number(cur.version) });
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

  // Batch the field-only merges on human-edited rows. Modeled directly on the
  // verse source-attr reconcile above (applyVerseRows step 4): version-CAS
  // UPDATE (`AND version = oldVersion`), the SAME protections isReimportableRow
  // checks re-asserted at write time (deleted_at/trashed_at/preserve/hint for
  // tn; deleted_at only for tq/twl), and updated_by is NEVER touched — the row
  // stays human-owned. A human PATCH landing between the read and this batch
  // bumps version → 0 rows changed → counted skipped_edited (no clobber, no
  // lost update). Audited as 'update' with only the merged fields as payload.
  for (let i = 0; i < fieldMerges.length; i += WRITE_BATCH) {
    const slice = fieldMerges.slice(i, i + WRITE_BATCH);
    try {
      const results = await env.DB.batch(
        slice.map((u) => buildTsvFieldMergeStmt(env, book, kind, u.id, u.merge, u.oldVersion, now)),
      );
      const logs: D1PreparedStatement[] = [];
      slice.forEach((u, j) => {
        if ((results[j]?.meta.changes ?? 0) > 0) {
          counts.merged_fields++;
          logs.push(logEditStmt(env, kind, u.id, book, userId, u.oldVersion, u.oldVersion + 1, "update", u.merge));
        } else {
          counts.skipped_edited++;
        }
      });
      if (logs.length) await env.DB.batch(logs);
    } catch (e) {
      counts.errors.push(`${kind} field-merge batch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return counts;
}

// Build (don't run) the field-only merge UPDATE for one edited TSV row, for
// env.DB.batch(). Only the columns present in `merge` are written (tags and/or
// note/question/response — see computeEditedFieldMerge); every other column,
// including sort_order, is left exactly as the human left it. version-CAS
// (`AND version = oldVersion`) is the concurrency guard — NOT `updated_by IS
// NULL` (the row IS human-owned) — and updated_by is never included in the
// SET, so the row stays attributed to that human. The same protections
// isReimportableRow checks are re-asserted in the WHERE clause so a delete/
// trash/preserve/hint change landing between the read and this batch also
// blocks the write rather than racing it.
function buildTsvFieldMergeStmt(
  env: Env,
  book: string,
  kind: TsvKind,
  id: string,
  merge: EditedFieldMerge,
  oldVersion: number,
  now: number,
): D1PreparedStatement {
  const cols = Object.keys(merge) as Array<keyof EditedFieldMerge>;
  const binds: unknown[] = [];
  let p = 1;
  const setClauses = cols.map((c) => {
    binds.push(merge[c] ?? null);
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

// Returns true if the row was inserted (was new), false if it already existed
// (caller falls through to the pristine UPDATE branch).
async function tryInsertTsvRow(
  env: Env,
  book: string,
  kind: TsvKind,
  row: ParsedTsvRow,
  sortOrder: number,
): Promise<boolean> {
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
    return (r.meta.changes ?? 0) > 0;
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
    return (r.meta.changes ?? 0) > 0;
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
  return (r.meta.changes ?? 0) > 0;
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
// exclusive with resurrect) is the AI-only re-seed: it DROPS the
// `updated_by IS NULL` guard (the row is AI-owned) and sets `updated_by = NULL`
// to reclaim it to master-owned — safety now rests on the version-CAS + the
// retained deleted_at/trashed_at/preserve/hint re-assertions. Bound-param
// positions are identical in all modes (the `= NULL` clauses carry no param), so
// the .bind() lists below are unchanged.
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
): D1PreparedStatement {
  const deletedGuard = resurrect ? "deleted_at IS NOT NULL" : "deleted_at IS NULL";
  const ownerGuard = reseedAi ? "" : "updated_by IS NULL AND ";
  const pristine =
    kind === "tn"
      ? `${ownerGuard}${deletedGuard} AND trashed_at IS NULL AND preserve = 0 AND hint = 0`
      : `${ownerGuard}${deletedGuard}`;
  const clearDeleted = resurrect ? "deleted_at = NULL, " : "";
  const clearOwner = reseedAi ? "updated_by = NULL, " : "";
  const newVersion = oldVersion + 1;
  if (kind === "tn") {
    return env.DB.prepare(
      `UPDATE tn_rows
          SET ${clearDeleted}${clearOwner}ref_raw = ?1, chapter = ?2, verse = ?3, tags = ?4,
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
          SET ${clearDeleted}${clearOwner}ref_raw = ?1, chapter = ?2, verse = ?3, tags = ?4,
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
        SET ${clearDeleted}${clearOwner}ref_raw = ?1, chapter = ?2, verse = ?3, tags = ?4,
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

// ── Verses (ULT / UST) ─────────────────────────────────────────────────────

async function reimportVersesForChapter(
  env: Env,
  book: string,
  chapter: number,
  rawUsfm: string,
  bibleVersion: "ULT" | "UST",
  userId: number | null,
  masterConfirmedAt: number | null,
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
    masterConfirmedAt,
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

// The verse-merge ancestor cutoff for one (book, resource): the watermark the
// export stamps ONLY when it has positively measured that our rendered output
// matches what master currently holds (book_resource_syncs.master_confirmed_at
// — a column the export half of this fix adds). This is NOT when we last
// pushed to a `-be-` branch: an unmerged branch push is routine here and is
// not proof master moved, and attributing against it was the root cause of
// the 1CH incident (see verseMerge.ts's header). NULL means "never positively
// confirmed" and callers MUST skip the merge entirely for that case — never
// treat "not yet confirmed" as "nothing changed" (identical in effect to a
// missing watermark row before this fix). Constant per (book, resource) for
// an entire reimport run, so callers read it ONCE per run/step rather than
// once per chapter — see the call sites in runReimport and
// reimportStagedChunk for where the hoisting lands.
async function getMasterConfirmedAt(env: Env, book: string, resource: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT master_confirmed_at FROM book_resource_syncs WHERE book = ?1 AND resource = ?2`,
  )
    .bind(book, resource)
    .first<{ master_confirmed_at: number | null }>();
  return row?.master_confirmed_at ?? null;
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
// current rows for these verses' chapters, an in-memory diff, then ONE atomic
// batch() of the INSERT/UPDATE writes interleaved with their edit_log rows.
// This collapses the old 2–5 D1 round-trips PER VERSE (insert-probe + select +
// update + version re-select + edit_log) into ~2 subrequests per call regardless
// of verse count — the fix for the nightly sync blowing the 10k-per-invocation
// subrequest budget on large books (PSA's ~5k ULT+UST verses alone exceeded it,
// starving every later book). content_json / plain_text / verse_end are stored
// byte-for-byte exactly as extractVersesForRange produced them; nothing about
// the USFM parse changes. The pristine guard (updated_by IS NULL) stays ON each
// UPDATE, so a translator edit landing between the read and the batch matches
// 0 rows — no clobber. On a batch error we fall back to the isolated per-row
// path so one bad verse can't sink the whole chapter.
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
  masterConfirmedAt: number | null,
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
  const lastExportAt = masterConfirmedAt;

  // The two merge-ancestor sub-selects are appended only when a watermark
  // exists, so a book/resource with no successful export ever pays no extra
  // read and behaves identically to before this change.
  const mergeCols =
    lastExportAt != null
      ? `,
            (SELECT payload_json FROM edit_log
               WHERE kind = 'verse'
                 AND row_key = ?1 || '/' || chapter || '/' || verse || '/' || ?2
                 AND (book = ?1 OR book IS NULL)
                 AND action IN ('create', 'update')
                 AND created_at < ?${chapters.length + 3}
               ORDER BY id DESC LIMIT 1) AS base_payload,
            EXISTS (
              SELECT 1 FROM edit_log
               WHERE kind = 'verse'
                 AND row_key = ?1 || '/' || chapter || '/' || verse || '/' || ?2
                 AND (book = ?1 OR book IS NULL)
                 AND source IS NULL
                 AND created_at >= ?${chapters.length + 3}
            ) AS human_edit_after_export`
      : "";
  const existingBind: unknown[] =
    lastExportAt != null ? [book, bibleVersion, ...chapters, lastExportAt] : [book, bibleVersion, ...chapters];
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

  // 2. Diff in memory. Stage a write (+ interleaved audit row) only for verses
  //    that are new or pristine-and-changed; count no-ops / edited rows straight
  //    from the read. inserted/updated are tallied tentatively and only folded
  //    into counts once the batch commits (so a fallback doesn't double-count).
  const stmts = [];
  const writes: VerseExtract[] = []; // candidates, for the per-row fallback
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
  // adoption ("adopt" | "adopt_conflict") plus every alignment refusal
  // ("keep_alignment_refused"). FIX 2: a clean "adopt" is included here too
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
  }> = [];
  let inserted = 0;
  let updated = 0;
  for (const v of verses) {
    const ex = existing.get(`${v.chapter}:${v.verse}`);
    const rowKey = `${book}/${v.chapter}/${v.verse}/${bibleVersion}`;
    if (!ex) {
      inserted++;
      writes.push(v);
      stmts.push(
        env.DB.prepare(
          `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT(book, chapter, verse, bible_version) DO NOTHING`,
        ).bind(book, v.chapter, v.verse, v.verseEnd, bibleVersion, v.contentJson, v.plainText),
        // Audit conditional on the INSERT actually landing: ON CONFLICT DO
        // NOTHING means a verse that already exists (created between our read
        // and this batch) inserts 0 rows — don't log a phantom restorable v1.
        env.DB.prepare(
          `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
           SELECT 'verse', ?1, ?2, ?3, NULL, 1, 'create', ?4, ?5
            WHERE changes() > 0`,
        ).bind(rowKey, book, userId, JSON.stringify({ plain_text: v.plainText, content: v.contentJson }), REIMPORT_SOURCE),
      );
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
        });
        if (merge.action === "keep_no_base") counts.merge_no_base++;
        if (merge.action === "keep_alignment_refused") counts.merge_refused++;
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
    updated++;
    writes.push(v);
    stmts.push(
      env.DB.prepare(
        `UPDATE verses
            SET content_json = ?1, plain_text = ?2, verse_end = ?3,
                version = version + 1, updated_at = ?4
          WHERE book = ?5 AND chapter = ?6 AND verse = ?7 AND bible_version = ?8
            AND updated_by IS NULL`,
      ).bind(v.contentJson, v.plainText, v.verseEnd, now, book, v.chapter, v.verse, bibleVersion),
      // Audit conditional on the UPDATE actually landing (mirrors verses.ts).
      // The UPDATE is guarded on `updated_by IS NULL`, so if an editor touched
      // this verse between our read and this batch the UPDATE matches 0 rows —
      // but the content we'd log never landed. An unconditional insert would
      // record a phantom restorable version carrying stale DCS content (and
      // could shadow the real ex.version+1 the editor just created). changes()
      // reflects the immediately-preceding UPDATE in this batch.
      env.DB.prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
         SELECT 'verse', ?1, ?2, ?3, ?4, ?5, 'update', ?6, ?7
          WHERE changes() > 0`,
      ).bind(rowKey, book, userId, ex.version, ex.version + 1, JSON.stringify({ plain_text: v.plainText, content: v.contentJson }), REIMPORT_SOURCE),
    );
  }

  // 3. One atomic batch for all pristine writes + their audit rows. On failure
  //    fall back to the isolated per-row path so one bad verse can't sink the
  //    chapter. (Edited-verse source-attr reconciles run in their own batch below
  //    — they're version-CAS-guarded, not updated_by-guarded, so they can't share
  //    this path's pristine semantics.)
  if (stmts.length > 0) {
    try {
      await env.DB.batch(stmts);
      counts.inserted += inserted;
      counts.updated += updated;
    } catch (e) {
      console.error("reimport verse batch failed; falling back per-row", {
        book,
        bibleVersion,
        chapters,
        error: e instanceof Error ? e.message : String(e),
      });
      addCounts(counts, await applyVerseRowsPerRow(env, book, bibleVersion, writes, userId));
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
    }));
    const recorded = await recordVerseMergeConflicts(env, book, resource, allConflictRows, now);
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
            counts.skipped_edited++;
          }
        });
        if (logs.length) await env.DB.batch(logs);
      } catch (e) {
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
  changed: boolean;        // false → SHA unchanged or DCS 404; skipped
  masterSha: string | null;
  r2Key: string | null;    // staged file location when changed
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

function emptyResult(book: string): ReimportResult {
  return { book, perResource: freshPerResource(), totals: zeroCounts() };
}

async function readStaged(env: Env, key: string): Promise<string | null> {
  const obj = await env.BLOBS.get(key);
  return obj ? await obj.text() : null;
}

// Upsert the per-(book,resource) sync watermark. `origin` is provenance only;
// only 'import'/'reimport' watermarks are written as skip gates.
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
// map equals its stored-pristine map exactly. Detects add/change/delete and id
// moves; errs toward "changed" whenever an edited (non-pristine) row is present
// (excluded from the stored map → chapter re-runs, edited row skipped
// harmlessly). A perf filter — it can never skip a real update.
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

  const changed = new Set<number>();
  for (const ch of new Set<number>([...incoming.keys(), ...stored.keys()])) {
    const a = incoming.get(ch) ?? new Map<string, string>();
    const b = stored.get(ch) ?? new Map<string, string>();
    if (a.size !== b.size) { changed.add(ch); continue; }
    let same = true;
    for (const [id, sig] of a) {
      if (b.get(id) !== sig) { same = false; break; }
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
// chapters the incoming file covers AND the diff gate flagged as changed (a
// deletion always flags its chapter), never under an active pipeline lock, and
// the WRITE re-asserts version-CAS + the deleted/trashed/preserve/hint
// protections (NOT updated_by IS NULL — an AI-only row carries the starter's id,
// exactly as deleteUnkeptTns notes) so a human edit landing after the SELECT
// bumps version → 0 rows → skipped. updated_by → NULL reclaims the tombstone to
// reimport-owned. The id comparison is against the WHOLE file's id set so a row
// the update path just moved to another chapter isn't mistaken for removed.
async function softDeleteRemovedTsvRows(
  env: Env,
  book: string,
  kind: TsvKind,
  rawTsv: string,
  candidateChapters: number[],
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
    if (!file) { entries.push({ resource, changed: false, masterSha: null, r2Key: null }); continue; }

    const masterSha = await fileCommitSha(env, file.repo, file.path);
    const stored = await storedResourceSha(env, book, resource);
    // Skip ONLY on a positive SHA match (fail-open: null/unknown → reimport).
    if (masterSha && stored && masterSha === stored) {
      entries.push({ resource, changed: false, masterSha, r2Key: null });
      continue;
    }

    const raw = await fetchText(dcsRawUrl(env, file.repo, file.path));
    if (raw == null) {
      // DCS 404 / fetch error → nothing to import, no watermark.
      entries.push({ resource, changed: false, masterSha: null, r2Key: null });
      continue;
    }
    // Completeness gate (TSV only). A truncated body must NOT be staged or get a
    // watermark — otherwise it prunes the book AND certifies it "in sync",
    // hiding the damage (the HAB tn incident). masterSha:null here is critical:
    // the reimport-sync step only stamps watermarks for entries with a masterSha.
    if (
      (resource === "tn" || resource === "tq" || resource === "twl") &&
      (await tsvFetchLooksTruncated(env, book, resource, raw))
    ) {
      entries.push({ resource, changed: false, masterSha: null, r2Key: null });
      continue;
    }
    const r2Key = `reimport-stage/${instanceId}/${book}/${resource}`;
    await env.BLOBS.put(r2Key, raw);
    entries.push({ resource, changed: true, masterSha, r2Key });
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
  const masterConfirmedAtUlt = versesByChapter.ult ? await getMasterConfirmedAt(env, book, "ult") : null;
  const masterConfirmedAtUst = versesByChapter.ust ? await getMasterConfirmedAt(env, book, "ust") : null;

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
      addCounts(perResource[kind], await applyTsvRows(env, book, kind, byCh.get(chapter) ?? [], userId));
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
  opts: { chunk?: number; mergeRefusalOverrideResource?: Resource } = {},
): Promise<ReimportResult> {
  const chunkSize = opts.chunk ?? REIMPORT_CHAPTER_CHUNK;

  const plan = await step.do(
    `reimport-fetch-${book}`,
    { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
    async () => planAndStageBookResources(env, book, resources, instanceId),
  );

  const changed = plan.entries.filter((e) => e.changed);
  if (plan.maxChapter < 1 || changed.length === 0) return emptyResult(book);

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

  const perResource = freshPerResource();
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
    const res = await step.do(`reimport-prune-${book}-${kind}`, async () => {
      const raw = await readStaged(env, r2Key);
      if (raw == null) return { deleted: 0, skippedLocked: 0 };
      const res = await softDeleteRemovedTsvRows(env, book, kind, raw, chs);
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
      if (!shouldRecordResourceSync(perResource[e.resource]) || systemicRefusals || mergeRecordFailed) {
        withheld.push(e.resource);
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
