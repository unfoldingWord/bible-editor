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
import { classifyReimportRow, isReimportableRow } from "./reimportClassify";
import { shouldRecordResourceSync } from "./reimportSyncGate";
import { computeTwlSortOrderUpdates } from "./twlCanonicalOrder";
import { applyTwlSortOrderUpdates } from "./twlSortOrderApply";
import { loadTwTitles } from "./twTitles";
import { loadTwlOrderLocks } from "./twlOrderLocks";
import type { TwlRow, VerseRow } from "./types";

export type Resource = "ult" | "ust" | "tn" | "tq" | "twl";

export const ALL_RESOURCES: readonly Resource[] = ["ult", "ust", "tn", "tq", "twl"];

// Chapters per Workflow step in the chunked reimport. Sized so even the largest
// book (Psalms, 150 ch) stays well under Cloudflare's 600 000 ms per-step limit
// that the old whole-book reimport blew on Isaiah. In steady state the
// per-resource SHA gate skips unchanged files entirely, so this rarely bites.
export const REIMPORT_CHAPTER_CHUNK = 8;

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
      const c = await reimportVersesForChapter(env, book, chapter, ultRaw, "ULT", userId);
      addCounts(perResource.ult, c);
    }
    if (want.has("ust") && ustRaw) {
      const c = await reimportVersesForChapter(env, book, chapter, ustRaw, "UST", userId);
      addCounts(perResource.ust, c);
    }
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
      counts.skipped_edited++;
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

  return counts;
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
): Promise<ReimportCounts> {
  return applyVerseRows(env, book, bibleVersion, extractVersesForRange(rawUsfm, chapter, chapter), userId);
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
  const existingRs = await env.DB.prepare(
    `SELECT chapter, verse, content_json, plain_text, verse_end, version, updated_by,
            (SELECT source FROM edit_log
               WHERE kind = 'verse'
                 AND row_key = ?1 || '/' || chapter || '/' || verse || '/' || ?2
                 AND (book = ?1 OR book IS NULL)
                 AND action IN ('create', 'update')
               ORDER BY id DESC LIMIT 1) AS latest_source
       FROM verses
      WHERE book = ?1 AND bible_version = ?2 AND chapter IN (${chPlaceholders})`,
  )
    .bind(book, bibleVersion, ...chapters)
    .all<{
      chapter: number;
      verse: number;
      content_json: string;
      plain_text: string | null;
      verse_end: number | null;
      version: number;
      updated_by: number | null;
      latest_source: string | null;
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
      // Genuinely human-edited verse: the translator owns the target text +
      // grouping, so we never overwrite the verse. BUT the original-language
      // source attributes on its `\zaln-s` milestones (x-content/x-lemma/x-morph)
      // are SOURCE-owned, not translator-owned — reconcile just those from master
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

  const incoming = new Map<number, Map<string, string>>();
  for (const r of parseTsv(rawTsv).rows) {
    const p = parseTsvRow(r, kind);
    if (!p || p.chapter < 1) continue;
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
    if (p.chapter < 1) continue;
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
    if (p.chapter >= 1) coveredChapters.add(p.chapter);
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
    if (versesByChapter.ult) {
      addCounts(perResource.ult, await applyVerseRows(env, book, "ULT", versesByChapter.ult.get(chapter) ?? [], userId));
    }
    if (versesByChapter.ust) {
      addCounts(perResource.ust, await applyVerseRows(env, book, "UST", versesByChapter.ust.get(chapter) ?? [], userId));
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
  opts: { chunk?: number } = {},
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
  for (let start = 1; start <= plan.maxChapter; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, plan.maxChapter);
    const counts = await step.do(
      `reimport-${book}-ch${start}-${end}`,
      { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
      async () => reimportStagedChunk(env, book, start, end, changed, changedTsv, null),
    );
    mergePerResource(perResource, counts);
  }

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
      if (!shouldRecordResourceSync(perResource[e.resource])) {
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
      console.log("reimport withheld sync watermark (chapter lock held)", { book, withheld });
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
