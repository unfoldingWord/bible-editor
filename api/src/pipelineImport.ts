// Pulls a done pipeline_jobs row's output[] from Door43, parses each file,
// and stages the rows into pending_imports for translator review (Phase 2).
//
// Called from the GET /api/pipelines/:jobId handler when the upstream poll
// surfaces state='done' for the first time. Idempotent on re-poll: a complete-
// staging marker (pipeline_jobs.staged_at) short-circuits the parse once the
// full proposal set has landed; an incomplete prior attempt is restaged.

import type { Env } from "./index";
import {
  collectSourceWords,
  extractVersesForRange,
  dropDuplicateSourceMilestones,
  healReplacementChars,
  normalizeNoteWhitespace,
  parseTsv,
  recomputeTargetOccurrences,
  refParts,
  stripOrphanAlignmentMarkers,
  type SourceWord,
  type VerseExtract,
} from "./importParsers.ts";
import { canonizeAlignmentSource } from "./canonizeHebrew.ts";
import { NT_BOOKS } from "./dcsSources.ts";
import { newRowId, isValidRowId } from "./rowId.ts";
import { tnContentKey } from "./tnDedup.ts";
import {
  IMPORT_CLAIM_STALE_SECONDS,
  shouldTouchClaim,
  tnSweepScope,
} from "./pipelineImportClaim.ts";

interface OutputEntry {
  type?: string;
  repo?: string;
  branch?: string;
  path?: string;
  rawUrl?: string;
  prNumber?: number;
  mergedAt?: string;
  commitSha?: string;
}

export interface ImportContext {
  jobId: string;
  pipelineType: "generate" | "notes" | "tqs" | string;
  book: string;
  startChapter: number;
  endChapter: number;
}

export interface ImportResult {
  inserted: number;
  byKind: { tn: number; tq: number; verse: number };
  skipped: string[];           // human-readable reasons (one per output entry skipped)
  applied?: ApplyResult;
  // True when a concurrent poll already owns this import (the CAS claim was
  // lost). The caller MUST NOT finalize the job on this result — the owning
  // poll writes output_json when it completes. See pollPipelineJob.
  claimLost?: boolean;
}

// Classify a single output[] entry into the resource kind we know how to
// parse. Returns null for entries we don't recognize — those get surfaced
// in result.skipped and the job is otherwise marked imported.
type Classification =
  | { kind: "verse"; bibleVersion: "ULT" | "UST"; format: "usfm" }
  | { kind: "tn"; format: "tsv" }
  | { kind: "tq"; format: "tsv" }
  | { kind: "unknown" };

function classify(entry: OutputEntry): Classification {
  const repo = (entry.repo ?? "").toLowerCase();
  // Trailing match — repo strings look like "unfoldingWord/en_ult" or sometimes
  // just "en_ult"; either way the last path segment is what we want.
  const tail = repo.split("/").pop() ?? "";
  if (tail.endsWith("en_ult")) return { kind: "verse", bibleVersion: "ULT", format: "usfm" };
  if (tail.endsWith("en_ust")) return { kind: "verse", bibleVersion: "UST", format: "usfm" };
  if (tail.endsWith("en_tn")) return { kind: "tn", format: "tsv" };
  if (tail.endsWith("en_tq")) return { kind: "tq", format: "tsv" };
  return { kind: "unknown" };
}

async function fetchText(rawUrl: string): Promise<string> {
  const r = await fetch(rawUrl);
  if (!r.ok) {
    throw new Error(`fetch ${rawUrl} -> ${r.status}`);
  }
  return await r.text();
}

interface StagedRow {
  kind: "tn" | "tq" | "verse";
  chapter: number;
  verse: number;
  bibleVersion: string | null;
  payload: Record<string, unknown>;
}

function tnPayload(book: string, refRaw: string, row: Record<string, string>) {
  const [ch, v] = refParts(refRaw);
  const occRaw = row["Occurrence"];
  const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
  return {
    chapter: ch,
    verse: v,
    payload: {
      id: row["ID"] || null,
      book,
      chapter: ch,
      verse: v,
      ref_raw: refRaw,
      tags: row["Tags"] || null,
      support_reference: row["SupportReference"] || null,
      quote: row["Quote"] || null,
      occurrence,
      // Collapse bp-assistant's double-space-after-punctuation artifact so the
      // stored note matches DCS master's normalized form (see
      // normalizeNoteWhitespace) — both apply paths (applyTnInsert and the hint
      // expansion) and the edit_log audit read this same staged note.
      note: row["Note"] ? normalizeNoteWhitespace(row["Note"]) : null,
    },
  };
}

function tqPayload(book: string, refRaw: string, row: Record<string, string>) {
  const [ch, v] = refParts(refRaw);
  const occRaw = row["Occurrence"];
  const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
  return {
    chapter: ch,
    verse: v,
    payload: {
      id: row["ID"] || null,
      book,
      chapter: ch,
      verse: v,
      ref_raw: refRaw,
      tags: row["Tags"] || null,
      quote: row["Quote"] || null,
      occurrence,
      question: row["Question"] || null,
      response: row["Response"] || null,
    },
  };
}

function versePayload(book: string, bibleVersion: "ULT" | "UST", v: VerseExtract) {
  return {
    book,
    chapter: v.chapter,
    verse: v.verse,
    verse_end: v.verseEnd,
    bible_version: bibleVersion,
    content_json: v.contentJson,
    plain_text: v.plainText,
  };
}

async function parseOutputEntry(
  ctx: ImportContext,
  entry: OutputEntry,
): Promise<{ staged: StagedRow[]; skipReason?: string }> {
  if (!entry.rawUrl) return { staged: [], skipReason: "missing rawUrl" };
  const cls = classify(entry);
  if (cls.kind === "unknown") {
    return { staged: [], skipReason: `unrecognized repo: ${entry.repo ?? "(none)"}` };
  }

  const raw = await fetchText(entry.rawUrl);
  const staged: StagedRow[] = [];

  if (cls.format === "tsv") {
    const { rows } = parseTsv(raw);
    for (const row of rows) {
      const refRaw = row["Reference"];
      if (!refRaw) continue;
      const [ch] = refParts(refRaw);
      if (ch < ctx.startChapter || ch > ctx.endChapter) continue;
      const built = cls.kind === "tn"
        ? tnPayload(ctx.book, refRaw, row)
        : tqPayload(ctx.book, refRaw, row);
      staged.push({
        kind: cls.kind,
        chapter: built.chapter,
        verse: built.verse,
        bibleVersion: null,
        payload: built.payload,
      });
    }
    return { staged };
  }

  // USFM
  const verses = extractVersesForRange(raw, ctx.startChapter, ctx.endChapter);
  for (const v of verses) {
    staged.push({
      kind: "verse",
      chapter: v.chapter,
      verse: v.verse,
      bibleVersion: cls.bibleVersion,
      payload: versePayload(ctx.book, cls.bibleVersion, v),
    });
  }
  return { staged };
}

// Top-level entry. Three phases:
//   0. CLAIM — atomically take the single-applier slot for this job so two
//      concurrent pollers (the */5 cron and a translator's open tab polling
//      GET /api/pipelines/:jobId) can't both run the destructive apply. The
//      loser no-ops. See migration 0035 — before this guard, interleaved
//      concurrent applies wiped/doubled ISA 48 en_tn (2026-06-30).
//   1. STAGE — fetch each rawUrl, parse, INSERT into pending_imports.
//      Idempotent on the pipeline_jobs.staged_at marker, written only after
//      the last chunk commits; a partial prior stage is dropped and redone.
//   2. APPLY — for every unresolved pending_imports row, mutate the live
//      tn_rows / tq_rows / verses tables and mark accepted_at.
//      Idempotent at the per-row level (accepted_at IS NULL filter) plus
//      the TN-delete phase, which only targets unkept rows.
//
// Throws on hard errors (Door43 fetch failure, malformed input, batch error).
// Callers should NOT mark output_json in pipeline_jobs unless this resolves
// successfully — that's how the next poll re-runs apply after a partial
// failure.
export async function importJobOutput(
  env: Env,
  job: ImportContext,
  outputs: OutputEntry[],
): Promise<ImportResult> {
  // Atomic single-applier claim. The predicate mirrors mayClaimImport, but is
  // enforced in one CAS UPDATE so a concurrent racer that read the same
  // pre-apply state can't also win: exactly one UPDATE reports changes=1.
  // RETURNING echoes back the EXACT value this UPDATE just wrote, so the
  // heartbeat below can seed its "last-known owned value" from the row
  // itself rather than assuming it matches Math.floor(Date.now()/1000) (worker
  // clock vs D1's unixepoch() could in principle skew).
  const claim = await env.DB.prepare(
    `UPDATE pipeline_jobs SET import_claimed_at = unixepoch()
      WHERE job_id = ?1
        AND (import_claimed_at IS NULL OR import_claimed_at < unixepoch() - ?2)
      RETURNING import_claimed_at`,
  )
    .bind(job.jobId, IMPORT_CLAIM_STALE_SECONDS)
    .run<{ import_claimed_at: number }>();
  if ((claim.meta.changes ?? 0) === 0) {
    // Another poll already owns the import — do nothing rather than run a
    // second, interleaving delete/insert pass. Flag claimLost so the caller
    // does NOT finalize the job: the owning poll may still be mid-apply, and
    // writing output_json here would mark the import complete prematurely
    // (and, if the owner then fails, suppress the retry).
    return {
      inserted: 0,
      byKind: { tn: 0, tq: 0, verse: 0 },
      skipped: ["import already claimed by a concurrent poll"],
      claimLost: true,
    };
  }
  // Heartbeat state shared across staging + apply so one long apply pass
  // (DAN 11 ran ~12 minutes) keeps its claim fresh and is never re-claimed by
  // a concurrent poller mid-flight. lastTouchedAt starts at the claim UPDATE
  // above (this instant), so the first heartbeat fires ~CLAIM_TOUCH_INTERVAL_
  // SECONDS later rather than immediately. ownedClaimedAt is the exact value
  // this pass just wrote (read back via RETURNING, not assumed) — every
  // heartbeat CASes against it so a heartbeat can never silently steal the
  // claim back from a legitimate new owner (see maybeTouchClaim).
  const ownedClaimedAt = claim.results?.[0]?.import_claimed_at;
  const heartbeat: ClaimHeartbeat = {
    lastTouchedAt: Math.floor(Date.now() / 1000),
    // Falling back to "now" would only ever be exercised if RETURNING somehow
    // echoed no row despite meta.changes > 0 — not expected under D1/SQLite
    // semantics, but a hard failure here would abort an apply that in fact
    // holds the claim, so this stays a soft (documented) fallback rather than
    // a thrown error.
    ownedClaimedAt: ownedClaimedAt ?? Math.floor(Date.now() / 1000),
    lost: false,
  };
  try {
    const stageResult = await stageJobOutput(env, job, outputs, heartbeat);
    const applyResult = await applyJobOutput(env, job, heartbeat);
    return { ...stageResult, applied: applyResult };
  } catch (err) {
    // Release the slot so the caller's one-retry path (pollPipelineJob holds
    // state at 'running' on the first failure) can re-import. Staging keys its
    // own idempotency on staged_at and apply is per-row idempotent, so the
    // retry resumes rather than duplicating.
    //
    // CAS'd on the claim we own, for the same reason the heartbeat is: if this
    // pass already lost the lease to a legitimate new owner (heartbeat.lost) and
    // THEN threw for any unrelated reason, a blind `SET import_claimed_at = NULL
    // WHERE job_id = ?1` would clear the NEW owner's claim mid-apply, letting a
    // third poller claim and interleave — the exact corruption the single-applier
    // guard exists to prevent. Matching on the owned value means a stolen lease
    // leaves the release a no-op (0 changes) and the new owner keeps its claim.
    await env.DB.prepare(
      `UPDATE pipeline_jobs SET import_claimed_at = NULL
        WHERE job_id = ?1 AND import_claimed_at = ?2`,
    )
      .bind(job.jobId, heartbeat.ownedClaimedAt)
      .run();
    throw err;
  }
}

// Mutable heartbeat clock threaded through staging + apply. Both phases of one
// apply pass share it so the pass touches the claim at most once per
// CLAIM_TOUCH_INTERVAL_SECONDS combined, not once per phase.
//
// ownedClaimedAt / lost make the heartbeat a real compare-and-swap lease
// rather than a blind re-stamp. Three independent reviews (a first-pass code
// review, this PR's own honesty ledger, and a Codex review) all flagged the
// original unconditional `UPDATE ... SET import_claimed_at = unixepoch()
// WHERE job_id = ?1`: if this pass stalled long enough for its claim to go
// stale, another poller legitimately re-claims, and THEN this pass wakes and
// heartbeats, the unconditional write would silently stamp over the new
// owner's lease. That doesn't itself create the double-apply (two applies are
// already running by that point), but it masks and prolongs it and defeats
// the staleness detection that would otherwise expose it. See
// touchImportClaim / maybeTouchClaim below for the fix.
export interface ClaimHeartbeat {
  lastTouchedAt: number;
  // The import_claimed_at value this pass last confirmed it owns. Seeded from
  // the RETURNING clause of the initial CAS claim in importJobOutput (the
  // exact row value, not assumed), and updated from RETURNING again on every
  // successful heartbeat — never computed independently, so it can't drift
  // from what's actually in the row.
  ownedClaimedAt: number;
  // Set once a heartbeat's CAS fails (another poller took the lease). Once
  // true, maybeTouchClaim stops issuing further heartbeat writes for the rest
  // of this pass — see the comment there for why it must NOT throw/abort.
  lost: boolean;
}

// CAS re-stamp of pipeline_jobs.import_claimed_at: only succeeds if the row
// still holds the value this pass last confirmed it owns
// (`expectedClaimedAt`). RETURNING echoes the exact new value on success, so
// the caller's stored "owned" value never drifts from the row. Deliberately
// has no effect on IMPORT_CLAIM_STALE_SECONDS: if the worker dies, no further
// heartbeat fires, and the claim goes stale on schedule for crash recovery.
// See pipelineImportClaim.ts.
async function touchImportClaim(
  env: Env,
  jobId: string,
  expectedClaimedAt: number,
): Promise<{ changes: number; newClaimedAt: number | null }> {
  const res = await env.DB
    .prepare(
      `UPDATE pipeline_jobs SET import_claimed_at = unixepoch()
        WHERE job_id = ?1 AND import_claimed_at = ?2
        RETURNING import_claimed_at`,
    )
    .bind(jobId, expectedClaimedAt)
    .run<{ import_claimed_at: number }>();
  return {
    changes: res.meta.changes ?? 0,
    newClaimedAt: res.results?.[0]?.import_claimed_at ?? null,
  };
}

// Rate-limited wrapper: only issues the D1 write when shouldTouchClaim says
// enough time has passed since the last touch, so a chunked loop costs at most
// one extra write per CLAIM_TOUCH_INTERVAL_SECONDS, not one per chunk.
// Exported for the fake-DB regression tests in pipelineImport.test.mjs, which
// drive the lease-takeover path directly — same rationale as deleteUnkeptTns.
export async function maybeTouchClaim(
  env: Env,
  jobId: string,
  hb: ClaimHeartbeat,
): Promise<void> {
  if (hb.lost) return; // Already lost the lease; stop hammering D1 for it.
  const now = Math.floor(Date.now() / 1000);
  if (!shouldTouchClaim(hb.lastTouchedAt, now)) return;
  const { changes, newClaimedAt } = await touchImportClaim(env, jobId, hb.ownedClaimedAt);
  if (changes === 0) {
    // The CAS failed: the row's import_claimed_at no longer matches what this
    // pass last confirmed it owns, meaning the claim went stale and another
    // poller has ALREADY legitimately re-claimed it. Mark lost and stop
    // heartbeating — but deliberately do NOT throw or abort the apply here.
    // A throw would propagate out of applyJobOutput/stageJobOutput into
    // importJobOutput's catch, whose cleanup runs
    // `UPDATE pipeline_jobs SET import_claimed_at = NULL WHERE job_id = ?1`
    // unconditionally — that would erase the NEW owner's claim, handing the
    // slot back to nobody (or a third racer) and making the corruption this
    // whole claim mechanism exists to prevent worse, not better. Letting this
    // pass's remaining writes finish is the safer failure mode; the resolved-
    // pairs exclusion in tnSweepScope is what actually protects data once two
    // applies are concurrently live, not this heartbeat.
    hb.lost = true;
    console.error("pipeline apply: import claim lease lost to another poller mid-flight", {
      jobId,
    });
    return;
  }
  hb.lastTouchedAt = now;
  // Track the row's actual new value, not `now` — they're expected to match,
  // but reading it back keeps this pass's belief pinned to reality rather
  // than a locally-computed guess that could quietly diverge from the row.
  hb.ownedClaimedAt = newClaimedAt ?? hb.ownedClaimedAt;
}

async function stageJobOutput(
  env: Env,
  job: ImportContext,
  outputs: OutputEntry[],
  heartbeat: ClaimHeartbeat,
): Promise<ImportResult> {
  // Idempotency guard: staged_at is written ONLY after the final chunk below
  // commits, so it — not the mere existence of a pending_imports row — is the
  // authoritative "full proposal set is present" signal. Staging spans many
  // D1 batch() calls (each atomic, the whole loop is not), so a mid-chunk
  // crash leaves a PARTIAL set; keying idempotency on row-existence would let
  // the retry apply that partial set and mark the job imported. See migration
  // 0030. With the marker set, apply picks up any still-unresolved rows.
  const marker = await env.DB.prepare(
    `SELECT staged_at FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(job.jobId)
    .first<{ staged_at: number | null }>();
  if (marker?.staged_at != null) {
    return { inserted: 0, byKind: { tn: 0, tq: 0, verse: 0 }, skipped: ["already staged"] };
  }

  // No complete-staging marker: either this is the first run, or a prior
  // attempt died mid-chunk. Drop any partial, still-unresolved rows from that
  // dead attempt and restage from scratch so apply never runs against a
  // partial set. (Apply runs AFTER staging in importJobOutput, so for this job
  // nothing is accepted yet; the accepted/rejected filter is belt-and-
  // suspenders against a translator resolving a partial row in the retry gap.)
  await env.DB.prepare(
    `DELETE FROM pending_imports
      WHERE job_id = ?1 AND accepted_at IS NULL AND rejected_at IS NULL`,
  )
    .bind(job.jobId)
    .run();

  const skipped: string[] = [];
  const allStaged: StagedRow[] = [];
  for (const entry of outputs) {
    const { staged, skipReason } = await parseOutputEntry(job, entry);
    if (skipReason) skipped.push(skipReason);
    allStaged.push(...staged);
  }

  // Batch insert in chunks. D1 batch() caps at 100 statements per call.
  const stmt = env.DB.prepare(
    `INSERT INTO pending_imports
       (job_id, kind, book, chapter, verse, bible_version, payload_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  );

  const CHUNK = 100;
  let inserted = 0;
  const byKind = { tn: 0, tq: 0, verse: 0 };
  for (let i = 0; i < allStaged.length; i += CHUNK) {
    const chunk = allStaged.slice(i, i + CHUNK);
    await env.DB.batch(
      chunk.map((s) =>
        stmt.bind(
          job.jobId,
          s.kind,
          job.book,
          s.chapter,
          s.verse,
          s.bibleVersion,
          JSON.stringify(s.payload),
        ),
      ),
    );
    inserted += chunk.length;
    for (const s of chunk) byKind[s.kind] += 1;
    await maybeTouchClaim(env, job.jobId, heartbeat);
  }

  // Mark staging complete only after the last chunk committed (also covers the
  // zero-row case — staging is then vacuously complete). Any throw above leaves
  // staged_at NULL; importJobOutput's caller leaves output_json NULL on throw,
  // so the next poll re-enters here and restages cleanly.
  await env.DB.prepare(
    `UPDATE pipeline_jobs SET staged_at = unixepoch() WHERE job_id = ?1`,
  )
    .bind(job.jobId)
    .run();

  return { inserted, byKind, skipped };
}

// ── Apply phase ───────────────────────────────────────────────────────────

export interface ApplyResult {
  tnDeleted: number;
  tnCreated: number;
  tnHintExpanded: number;
  // Insert proposals dropped because an identical-content note already exists
  // live in scope (defense-in-depth content-dedup — see the loop below).
  tnSkippedDup: number;
  tqCreated: number;
  tqUpdated: number;
  verseUpdated: number;
  // Distinct chapters that actually received a write, so the caller can fan out
  // one "chapter is stale" hint per changed chapter (not one per row).
  affectedChapters: number[];
}

export interface PendingImportRow {
  id: number;
  kind: "tn" | "tq" | "verse";
  book: string;
  chapter: number;
  verse: number;
  bible_version: string | null;
  payload_json: string;
}

const AI_SOURCE = "ai_pipeline";

// Row-id grammar + validation now live in rowId.ts (ROW_ID_RE / isValidRowId),
// shared with the reimport's coerceRowId guard. bp-assistant normally emits a
// valid id for every TN row (hinted or not), and it's what gets pushed to
// master; preserving it keeps D1 and master ids in lockstep. Only a malformed id
// (the occasional incomplete emit) is replaced with a freshly minted one below.

async function applyJobOutput(
  env: Env,
  job: ImportContext,
  heartbeat: ClaimHeartbeat,
): Promise<ApplyResult> {
  // Look up the pipeline-starter's user id — every audit and updated_by
  // write is attributed to them, matching the contract that says the run
  // was triggered on their behalf.
  const starter = await env.DB.prepare(
    `SELECT user_id FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(job.jobId)
    .first<{ user_id: number }>();
  if (!starter) throw new Error(`apply: pipeline_jobs row not found for ${job.jobId}`);
  const userId = starter.user_id;

  // All unresolved proposals for this job, in stable order so retries do
  // the same work in the same sequence.
  const rs = await env.DB.prepare(
    `SELECT id, kind, book, chapter, verse, bible_version, payload_json
       FROM pending_imports
      WHERE job_id = ?1
        AND accepted_at IS NULL AND rejected_at IS NULL
      ORDER BY kind, chapter, verse, id`,
  )
    .bind(job.jobId)
    .all<PendingImportRow>();
  const rows = rs.results ?? [];

  const tnProposals = rows.filter((r) => r.kind === "tn");
  const tqProposals = rows.filter((r) => r.kind === "tq");
  const verseProposals = rows.filter((r) => r.kind === "verse");

  const result: ApplyResult = {
    tnDeleted: 0,
    tnCreated: 0,
    tnHintExpanded: 0,
    tnSkippedDup: 0,
    tqCreated: 0,
    tqUpdated: 0,
    verseUpdated: 0,
    affectedChapters: [],
  };

  // Chapters that saw an actual write — populated at each mutation point below
  // and returned so the caller can hint open tabs once per changed chapter.
  const affected = new Set<number>();

  // TN delete phase: only fires when this job produced TN proposals AND
  // there are unkept TNs in scope. Idempotent — re-running finds none left.
  if (tnProposals.length > 0) {
    result.tnDeleted = await deleteUnkeptTns(env, job, userId, tnProposals, heartbeat);
    // A delete mutates whatever chapters this job re-proposed TN for; those are
    // exactly the chapters carried by tnProposals.
    if (result.tnDeleted > 0) for (const p of tnProposals) affected.add(p.chapter);
  }

  // Content-dedup claim set (defense-in-depth, layered ON TOP of the AI-aware
  // sweep above). Seeded from the rows that SURVIVED the delete phase — kept
  // notes (preserve/hint/human-edited) plus, if the sweep ever fails to clear a
  // prior AI run, its leftovers — so a proposal whose exact content already
  // exists live is dropped instead of inserted as a duplicate. tnContentKey is
  // the same id-independent identity key the reimport's Guard 2 uses (includes
  // occurrence; excludes id/sort_order/tags). Grown as we insert so two
  // identical proposals in one file also collapse. This is the last line of
  // defense against the re-run doubling (ISA 36/41): even if the sweep misses a
  // row, its content key blocks the second copy.
  const claimedTnKeys = new Set<string>();
  if (tnProposals.length > 0) {
    const live = await env.DB.prepare(
      `SELECT chapter, verse, occurrence, support_reference, quote, note
         FROM tn_rows
        WHERE book = ?1 AND chapter BETWEEN ?2 AND ?3 AND deleted_at IS NULL`,
    )
      .bind(job.book, job.startChapter, job.endChapter)
      .all<{
        chapter: number;
        verse: number;
        occurrence: number | null;
        support_reference: string | null;
        quote: string | null;
        note: string | null;
      }>();
    for (const r of live.results ?? []) claimedTnKeys.add(tnContentKey(r));
  }

  // sort_order assignment. Proposals arrive ordered (chapter, verse, id) where
  // id is the staging order = the AI file's row order, so a per-verse counter
  // reproduces the source file order on export. For TN we seed each verse's
  // counter from the MAX sort_order of the rows that SURVIVED the delete phase
  // (preserve=1 / hint=1 / translator-edited), so freshly minted AI notes
  // append after the translator's kept notes rather than colliding with them.
  // For TQ there's no delete/preserve concept — every run fully reorders the
  // verse to match the file — so its counters start from zero.
  const tnBases = await maxSortOrderPerVerse(env, "tn_rows", job);
  const tnCounters = new Map<number, number>();
  const tqCounters = new Map<number, number>();
  const verseKey = (p: PendingImportRow) => p.chapter * 100000 + p.verse;

  for (const p of tnProposals) {
    // Heartbeat FIRST, before any per-proposal work or `continue` path. Both
    // the hint-expansion and content-dedup-skip branches below `continue`
    // before reaching the touch call that used to sit at the bottom of this
    // loop — a run dominated by skip-path proposals (DAN 11-scale: ~150
    // proposals x ~4.5s/proposal ~= 11 minutes) would then heartbeat ZERO
    // times, blowing past IMPORT_CLAIM_STALE_SECONDS (600s) and letting a
    // concurrent poller win the CAS mid-flight — reopening the interleaved-
    // applier corruption the single-applier claim exists to prevent. Placing
    // it first means every iteration heartbeats regardless of which path it
    // takes.
    await maybeTouchClaim(env, job.jobId, heartbeat);
    // Hint expansion: if the AI's proposed id matches a queued hint stub in
    // this job's scope, UPDATE that row in place instead of minting a new
    // one. The hint's rowId round-trips through bp-assistant as the TSV ID
    // column — see docs/bp-assistant-tn-hints-contract.md. The stub keeps the
    // sort_order it was created with (it's a surviving row, already folded
    // into tnBases), so we don't consume a counter slot for it.
    // Content key of this proposal — computed up front so a hint expansion can
    // claim it too (the expanded stub now carries this content live, so a later
    // identical insert proposal in the same run must be suppressed).
    const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
    const contentKey = tnContentKey({
      chapter: p.chapter,
      verse: p.verse,
      occurrence: (payload.occurrence as number | null | undefined) ?? null,
      support_reference: (payload.support_reference as string | null | undefined) ?? null,
      quote: (payload.quote as string | null | undefined) ?? null,
      note: (payload.note as string | null | undefined) ?? null,
    });

    const expanded = await applyTnHintExpansionIfMatch(env, p, job, userId);
    if (expanded) {
      claimedTnKeys.add(contentKey);
      affected.add(p.chapter);
      result.tnHintExpanded += 1;
      continue;
    }
    // Drop a proposal whose exact content already exists live in scope (a kept
    // note, an expanded hint, or a prior-AI row the sweep somehow missed). Keyed
    // on content, not id, so the fresh id bp-assistant mints each run can't
    // sneak a duplicate past. A genuinely new/changed note has a different key
    // and still inserts.
    if (claimedTnKeys.has(contentKey)) {
      // Resolve the proposal so it doesn't linger as an unreviewed item in the
      // pending-imports review endpoint — the note it proposes already exists,
      // so accepting (without inserting) is the truthful resolution.
      await env.DB.prepare(
        `UPDATE pending_imports SET accepted_at = unixepoch(), accepted_by = ?2 WHERE id = ?1`,
      )
        .bind(p.id, userId)
        .run();
      result.tnSkippedDup += 1;
      continue;
    }
    claimedTnKeys.add(contentKey);
    const k = verseKey(p);
    const sortOrder = (tnCounters.get(k) ?? tnBases.get(k) ?? 0) + 100;
    tnCounters.set(k, sortOrder);
    await applyTnInsert(env, p, userId, sortOrder);
    affected.add(p.chapter);
    result.tnCreated += 1;
  }

  for (const p of tqProposals) {
    const k = verseKey(p);
    const sortOrder = (tqCounters.get(k) ?? 0) + 100;
    tqCounters.set(k, sortOrder);
    const action = await applyTqUpsert(env, p, userId, sortOrder);
    affected.add(p.chapter);
    if (action === "created") result.tqCreated += 1;
    else result.tqUpdated += 1;
    await maybeTouchClaim(env, job.jobId, heartbeat);
  }

  // Preload the book's UHB/UGNT source words once (a single query — cap-safe)
  // so each verse's alignment canonize + U+FFFD heal read from memory instead
  // of issuing a per-verse D1 read (a whole-book generate would otherwise blow
  // the ~1000-subrequest budget). Empty map when there are no verse proposals.
  const uhbWordsByVerse =
    verseProposals.length > 0
      ? await loadUhbSourceWords(env, job)
      : new Map<number, SourceWord[]>();

  for (const p of verseProposals) {
    await applyVerseUpdate(env, p, userId, uhbWordsByVerse);
    affected.add(p.chapter);
    result.verseUpdated += 1;
    await maybeTouchClaim(env, job.jobId, heartbeat);
  }

  result.affectedChapters = [...affected].sort((a, b) => a - b);
  return result;
}

// Highest sort_order currently stored per (chapter, verse) in scope. Used to
// seed AI insert counters so new rows append after surviving rows in a verse.
// Run AFTER the TN delete phase so swept rows don't inflate the base.
async function maxSortOrderPerVerse(
  env: Env,
  table: "tn_rows" | "tq_rows",
  job: ImportContext,
): Promise<Map<number, number>> {
  const rs = await env.DB.prepare(
    `SELECT chapter, verse, MAX(sort_order) AS mx FROM ${table}
      WHERE book = ?1 AND chapter BETWEEN ?2 AND ?3 AND deleted_at IS NULL
      GROUP BY chapter, verse`,
  )
    .bind(job.book, job.startChapter, job.endChapter)
    .all<{ chapter: number; verse: number; mx: number | null }>();
  const m = new Map<number, number>();
  for (const r of rs.results ?? []) {
    if (r.mx != null) m.set(r.chapter * 100000 + r.verse, r.mx);
  }
  return m;
}

// Exported for the fake-DB regression test in pipelineImport.test.mjs, which
// asserts on the SQL/binding this function actually generates — see the DAN
// 11 tests there. Not intended as a public API beyond that.
export async function deleteUnkeptTns(
  env: Env,
  job: ImportContext,
  userId: number,
  tnProposals: PendingImportRow[],
  heartbeat: ClaimHeartbeat,
): Promise<number> {
  // Identify which rows we're about to delete so the audit row can carry
  // the right pre-deletion version. A bulk UPDATE would lose that fidelity.
  // preserve=1 rows are translator-marked "keep through AI runs"; hint=1
  // rows are stubs queued for in-place expansion by the AI — both must
  // survive the sweep.
  //
  // Two classes are swept: (a) pristine rows the AI never touched
  // (updated_by IS NULL — the original bootstrap/reimport notes), and (b) the
  // PRIOR AI run's own output. applyTnInsert stamps updated_by = the pipeline
  // starter on every note it creates, so a re-run's notes are NOT pristine and
  // a plain `updated_by IS NULL` sweep would skip them — leaving them in place
  // while the re-run inserts a full fresh set, DOUBLING every note (ISA 36/41,
  // 2026-06). Class (b) is identified by the most-recent CONTENT-bearing
  // edit_log entry (action IN create/update) still being source 'ai_pipeline'.
  // The action filter matters: /preserve/hint/trash toggles write NULL-source
  // audit rows (rows.ts), so an AI note that was preserved-then-unpreserved
  // would otherwise look human-owned (its LATEST audit row is 'unpreserve',
  // source NULL) and dodge the sweep forever. A real human content edit writes
  // action 'update' source NULL, and a hint expansion writes 'hint_expansion'
  // — both correctly take the latest content action off 'ai_pipeline', so an
  // edited / hint-owned note is protected. The reimport never rewrites an AI
  // row (its UPDATE/prune are updated_by-IS-NULL gated), so the content source
  // stays 'ai_pipeline' reliably.
  //
  // trashed_at IS NULL: a trashed AI note is left alone — the content-dedup
  // claim set below (seeded from deleted_at IS NULL rows, which includes
  // trashed) suppresses the AI's re-proposal of it, so it stays trashed.
  // Sweeping it instead would delete it and let the re-insert RESURRECT it
  // un-trashed against the user's intent.
  // Scope the sweep to the (chapter, verse) pairs THIS PASS is actually about
  // to apply — the unresolved tnProposals it was just handed — NOT every verse
  // the job has ever produced a proposal for. A resumed apply's `pending_imports`
  // SELECT (in applyJobOutput) is already filtered to accepted_at IS NULL AND
  // rejected_at IS NULL, i.e. only what's left to apply; scoping the sweep to
  // the job-wide EXISTS-against-pending_imports (any row ever staged for this
  // job, resolved or not) let a resumed pass's sweep re-cover verses the FIRST
  // pass already applied and resolved, deleting that pass's just-inserted
  // notes. DAN 11 tn, en_tn, 2026-08-03: 160 proposals; the first apply pass
  // inserted rows across the full verse range and died mid-run before
  // resolving every proposal; the resumed pass's job-wide sweep matched every
  // verse the job ever proposed for, deleted 121 of the first pass's
  // already-applied notes, and only re-inserted the 39 still-unresolved
  // proposals — the chapter went from 131 live notes to 39, with verses 1-31
  // emptied entirely. Scoping to tnSweepScope(tnProposals, resolvedPairs)
  // instead means a verse this pass isn't touching is left alone, whatever a
  // PRIOR pass did to it. Match on BOTH chapter and verse: a job may span
  // multiple chapters (endChapter > startChapter is a valid range), and
  // scoping by verse number alone would let a proposal for ch2:v1 make
  // ch1:v1 eligible for deletion.
  // Defense-in-depth alongside the single-applier claim in importJobOutput
  // (Fix 2 in this same PR) — that claim now also gets heartbeated so a live
  // apply pass is never re-claimed mid-flight in the first place; this sweep
  // scoping is what limits the blast radius if that ever regresses. See the
  // DAN 11 regression test for tnSweepScope in pipelineImport.test.mjs — do
  // NOT widen this back to a job-wide scope.
  //
  // CLOSED: the straddled-verse class flagged by Codex review against the
  // first version of this fix. applyTnInsert resolves each proposal
  // atomically (its own D1 batch), and tnProposals is processed in
  // `ORDER BY kind, chapter, verse, id` order (see the SELECT in
  // applyJobOutput), so a mid-run death can leave ONE verse straddled — some
  // of its proposals already inserted+resolved, the rest still unresolved.
  // Scoping the sweep by unresolved proposals alone would still re-cover that
  // straddled verse (its remaining proposals are still unresolved) and delete
  // what the first pass already inserted there. Fixed by excluding any verse
  // that ALREADY has an accepted proposal for this job from the sweep scope
  // entirely — see tnSweepScope's `resolvedPairs` parameter. The sweep runs
  // once, before any inserts in this pass; if a verse already has an accepted
  // proposal, an earlier pass already completed delete-then-insert work there,
  // and re-sweeping it now can only destroy that work. Traced against both
  // crash shapes:
  //   - Pass 1 died BEFORE sweeping verse V: no accepted proposals for V yet
  //     -> V stays in scope -> sweep + insert all of V. Unchanged, correct.
  //   - Pass 1 swept V and accepted 2 of 3 proposals, then died: V now has an
  //     accepted proposal -> V excluded from scope -> pass 2 leaves V's rows
  //     alone and inserts only the 3rd. V ends with all 3 notes instead of
  //     losing the 2 already-accepted ones. This is the case Codex flagged.
  // Trade-off, deliberate (see tnSweepScope for the full rationale): an
  // excluded verse's not-yet-deleted prior-run/pristine notes survive (mildly
  // stale) instead of being deleted — consistent with this module's existing
  // philosophy, and strictly better than deleting accepted notes. Content-
  // dedup (`claimedTnKeys` in applyJobOutput) prevents the remainder inserts
  // from duplicating whatever survives.
  const resolved = await env.DB.prepare(
    `SELECT DISTINCT chapter, verse FROM pending_imports
      WHERE job_id = ?1 AND kind = 'tn' AND accepted_at IS NOT NULL`,
  )
    .bind(job.jobId)
    .all<{ chapter: number; verse: number }>();
  const pairs = tnSweepScope(tnProposals, resolved.results ?? []);
  if (pairs.length === 0) return 0;

  // D1 caps bound parameters at 100 per statement. This query already binds 4
  // fixed params (book, startChapter, endChapter, AI_SOURCE) before the pair
  // params, so the chunk size must leave room: 4 + 2*CHUNK_PAIRS <= 100.
  // 40 pairs -> 84 total, comfortable headroom below the cap.
  const CHUNK_PAIRS = 40;
  const list: { id: string; version: number }[] = [];
  for (let i = 0; i < pairs.length; i += CHUNK_PAIRS) {
    const slice = pairs.slice(i, i + CHUNK_PAIRS);
    const pairClauses = slice
      .map((_, idx) => `(t.chapter = ?${5 + idx * 2} AND t.verse = ?${6 + idx * 2})`)
      .join(" OR ");
    const pairParams = slice.flatMap((pair) => [pair.chapter, pair.verse]);
    const rs = await env.DB.prepare(
      `SELECT id, version FROM tn_rows t
        WHERE book = ?1 AND chapter BETWEEN ?2 AND ?3
          AND deleted_at IS NULL AND trashed_at IS NULL
          AND preserve = 0 AND hint = 0
          AND (${pairClauses})
          AND (
            updated_by IS NULL
            OR (
              SELECT source FROM edit_log
                WHERE kind = 'tn' AND row_key = t.id
                  AND (book = t.book OR book IS NULL)
                  AND action IN ('create', 'update')
                ORDER BY id DESC LIMIT 1
            ) = ?4
          )`,
    )
      .bind(job.book, job.startChapter, job.endChapter, AI_SOURCE, ...pairParams)
      .all<{ id: string; version: number }>();
    list.push(...(rs.results ?? []));
    await maybeTouchClaim(env, job.jobId, heartbeat);
  }
  if (list.length === 0) return 0;

  const now = Math.floor(Date.now() / 1000);
  const CHUNK = 25; // 2 statements per row + headroom
  let deleted = 0;
  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    const stmts = [];
    for (const t of slice) {
      stmts.push(
        env.DB
          .prepare(
            // Re-assert the safety predicate at write time, not just in the
            // SELECT above: TN edits are allowed mid-pipeline (rows.ts), so a
            // change landing between the SELECT and this UPDATE must ABORT the
            // delete. A translator content edit bumps version — caught by the
            // version-CAS (`version = ?5`); a preserve/hint toggle is caught by
            // re-asserting `preserve = 0 AND hint = 0`; a trash toggle does NOT
            // bump version (rows.ts setTnTrashed), so it needs its own
            // `trashed_at IS NULL` re-assertion. (We can't re-use the old
            // `updated_by IS NULL` guard: a swept PRIOR-AI row already carries
            // the starter's updated_by, so that clause would abort every
            // legitimate AI-output delete.) Composite-key scoped so a
            // colliding-id row in another book is never touched.
            `UPDATE tn_rows
               SET deleted_at = ?1, version = version + 1,
                   updated_at = ?1, updated_by = ?2
             WHERE id = ?3 AND book = ?4 AND deleted_at IS NULL
               AND trashed_at IS NULL AND preserve = 0 AND hint = 0 AND version = ?5`,
          )
          .bind(now, userId, t.id, job.book, t.version),
        env.DB
          .prepare(
            // Audit only if the UPDATE above actually tombstoned this row in
            // THIS batch (D1 runs batch statements sequentially on one
            // connection, so this SELECT sees the prior UPDATE's effect). A
            // delete the pristine guard aborted writes no edit_log row.
            `INSERT INTO edit_log
               (kind, row_key, book, user_id, prev_version, new_version, action, source)
             SELECT 'tn', ?1, ?2, ?3, ?4, ?5, 'delete', ?6
              WHERE EXISTS (
                SELECT 1 FROM tn_rows
                 WHERE id = ?1 AND book = ?2
                   AND deleted_at = ?7 AND updated_by = ?3
              )`,
          )
          .bind(t.id, job.book, userId, t.version, t.version + 1, AI_SOURCE, now),
      );
    }
    const res = await env.DB.batch(stmts);
    // UPDATE results sit at even indices (update, audit, update, audit, ...).
    // Count only rows the guard actually deleted.
    for (let j = 0; j < res.length; j += 2) {
      deleted += res[j]?.meta?.changes ?? 0;
    }
    await maybeTouchClaim(env, job.jobId, heartbeat);
  }
  return deleted;
}

// Per-revision source label for hint expansions. Distinct from AI_SOURCE so
// the row's AI chip (keyed on latest_source === 'ai_pipeline' in chapters.ts)
// stays off — standing authorship of a hinted note's existence is the human
// who created the stub, even though this specific revision was written by
// the AI. The history dialog can render this label however it likes.
const HINT_EXPANSION_SOURCE = "hint_expansion";

// Returns true if the proposal was applied as a hint expansion (UPDATE in
// place against an existing hint=1 stub), false if there's no match and the
// caller should fall through to applyTnInsert. Scoped to the job's chapter
// range so an id collision outside that range (vanishingly rare with 4-char
// random ids, but possible) doesn't accidentally clobber an unrelated row.
async function applyTnHintExpansionIfMatch(
  env: Env,
  p: PendingImportRow,
  job: ImportContext,
  userId: number,
): Promise<boolean> {
  const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
  const proposedId = typeof payload.id === "string" ? payload.id : null;
  if (!proposedId) return false;

  const stub = await env.DB.prepare(
    `SELECT id, version FROM tn_rows
      WHERE id = ?1 AND hint = 1 AND deleted_at IS NULL
        AND book = ?2 AND chapter BETWEEN ?3 AND ?4`,
  )
    .bind(proposedId, job.book, job.startChapter, job.endChapter)
    .first<{ id: string; version: number }>();
  if (!stub) return false;

  const now = Math.floor(Date.now() / 1000);
  const newVersion = stub.version + 1;
  const res = await env.DB.batch([
    env.DB
      .prepare(
        // Update content; clear hint so the row stops being queued for
        // future runs. Leave preserve and updated_by alone — the row's
        // standing authorship stays with whoever created the stub, and
        // any prior preserve intent survives the expansion.
        //
        // CAS-guarded: `hint = 1` and `version = ?` must STILL hold at write
        // time. TN edits are allowed mid-pipeline (rows.ts), so between the
        // SELECT above and here a translator may (a) un-queue the hint
        // (hint -> 0, which does NOT bump version — caught by `hint = 1`) or
        // (b) edit the stub's content (bumps version + sets updated_by —
        // caught by `version = stub.version`). Either way the expansion must
        // abort rather than clobber the user's change. NOTE: we deliberately
        // do NOT guard on `updated_by IS NULL` — a human-created hint stub
        // already carries the creator's id (createRow sets updated_by), so
        // that predicate would abort every legitimate expansion.
        // book-scoped so a colliding stub id in another book isn't clobbered.
        `UPDATE tn_rows
            SET quote = ?1,
                support_reference = ?2,
                note = ?3,
                occurrence = ?4,
                ref_raw = COALESCE(?5, ref_raw),
                tags = ?6,
                hint = 0,
                version = version + 1,
                updated_at = ?7
          WHERE id = ?8 AND book = ?9 AND deleted_at IS NULL
            AND hint = 1 AND version = ?10`,
      )
      .bind(
        (payload.quote as string | null | undefined) ?? null,
        (payload.support_reference as string | null | undefined) ?? null,
        (payload.note as string | null | undefined) ?? null,
        (payload.occurrence as number | null | undefined) ?? null,
        (payload.ref_raw as string | null | undefined) ?? null,
        (payload.tags as string | null | undefined) ?? null,
        now,
        stub.id,
        job.book,
        stub.version,
      ),
    env.DB
      .prepare(
        // Audit row, gated on the CAS having WON: the post-update fingerprint
        // (new version + hint cleared + our updated_at) is present only if the
        // UPDATE above actually fired. A lost CAS writes neither audit nor
        // accept. AI wrote this revision, but with the hint_expansion label so
        // the row-level AI chip stays off.
        `INSERT INTO edit_log
           (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
         SELECT 'tn', ?1, ?2, ?3, ?4, ?5, 'update', ?6, ?7
          WHERE EXISTS (
            SELECT 1 FROM tn_rows
             WHERE id = ?1 AND book = ?2
               AND version = ?5 AND hint = 0 AND updated_at = ?8
          )`,
      )
      .bind(
        stub.id,
        job.book,
        userId,
        stub.version,
        newVersion,
        JSON.stringify(payload),
        HINT_EXPANSION_SOURCE,
        now,
      ),
    env.DB
      .prepare(
        // Mark the proposal accepted only if the CAS won (same fingerprint).
        // On a lost CAS this stays unresolved and the caller falls through to
        // applyTnInsert below, materializing the AI note as a fresh row
        // instead of dropping it.
        `UPDATE pending_imports
            SET accepted_at = unixepoch(), accepted_by = ?2
          WHERE id = ?1 AND EXISTS (
            SELECT 1 FROM tn_rows
             WHERE id = ?3 AND book = ?4
               AND version = ?5 AND hint = 0 AND updated_at = ?6
          )`,
      )
      .bind(p.id, userId, stub.id, job.book, newVersion, now),
  ]);
  // CAS won iff the UPDATE changed a row. On a lost CAS return false so the
  // caller materializes the proposal via applyTnInsert (its proposed id now
  // PK-collides with the concurrently-edited stub, so it retries to a fresh
  // id) — the translator's edit survives and the AI note isn't lost.
  return (res[0]?.meta?.changes ?? 0) > 0;
}

async function applyTnInsert(
  env: Env,
  p: PendingImportRow,
  userId: number,
  sortOrder: number,
): Promise<void> {
  const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
  const insertCols = [
    "id",
    "book",
    "chapter",
    "verse",
    "ref_raw",
    "tags",
    "support_reference",
    "quote",
    "occurrence",
    "note",
    "updated_by",
    "sort_order",
  ];

  // PRESERVE bp-assistant's proposed id. It's the SAME id that lands on master,
  // so keeping it lets the nightly reimport recognize this row instead of
  // re-adding a divergent-id copy of the same note — the TN duplication bug
  // (each AI-generated note ending up doubled). Only mint a fresh id when the
  // proposed one is malformed (bp-assistant occasionally emits an id that fails
  // the 4-char [a-z][a-z0-9]{3} format — usually a first char that isn't [a-z])
  // or when it actually PK-collides; attempt 0 uses the proposed id, later
  // attempts mint. TQ already preserves its proposed id (insertTqAtId).
  const proposedId =
    typeof payload.id === "string" && isValidRowId(payload.id) ? payload.id : null;
  let id = "";
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    id = attempt === 0 && proposedId ? proposedId : newRowId();
    const values: unknown[] = [
      id,
      payload.book ?? null,
      payload.chapter ?? null,
      payload.verse ?? null,
      payload.ref_raw ?? null,
      payload.tags ?? null,
      payload.support_reference ?? null,
      payload.quote ?? null,
      payload.occurrence ?? null,
      payload.note ?? null,
      userId,
      sortOrder,
    ];
    try {
      await env.DB.batch([
        env.DB
          .prepare(
            `INSERT INTO tn_rows (${insertCols.join(", ")})
             VALUES (${insertCols.map((_, i) => `?${i + 1}`).join(", ")})`,
          )
          .bind(...values),
        env.DB
          .prepare(
            `INSERT INTO edit_log
               (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
             VALUES ('tn', ?1, ?2, ?3, NULL, 1, 'create', ?4, ?5)`,
          )
          .bind(id, p.book, userId, JSON.stringify(payload), AI_SOURCE),
        env.DB
          .prepare(
            `UPDATE pending_imports
                SET accepted_at = unixepoch(), accepted_by = ?2
              WHERE id = ?1`,
          )
          .bind(p.id, userId),
      ]);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/UNIQUE|PRIMARY KEY/i.test(msg)) throw e;
    }
  }
  if (lastErr) throw new Error(`tn id collision exhausted after 8 attempts`);
}

async function applyTqUpsert(
  env: Env,
  p: PendingImportRow,
  userId: number,
  sortOrder: number,
): Promise<"created" | "updated"> {
  const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
  const proposedId = typeof payload.id === "string" && payload.id.length > 0 ? payload.id : null;

  if (proposedId) {
    // Try update first. Book-scoped to match the composite PK — a colliding
    // proposed id in another book is a "not found here", not a stale match.
    const existing = await env.DB.prepare(
      `SELECT version FROM tq_rows WHERE id = ?1 AND book = ?2 AND deleted_at IS NULL`,
    )
      .bind(proposedId, p.book)
      .first<{ version: number }>();
    if (existing) {
      const newVersion = existing.version + 1;
      const now = Math.floor(Date.now() / 1000);
      const patch = {
        ref_raw: payload.ref_raw ?? null,
        tags: payload.tags ?? null,
        quote: payload.quote ?? null,
        occurrence: payload.occurrence ?? null,
        question: payload.question ?? null,
        response: payload.response ?? null,
      };
      await env.DB.batch([
        env.DB
          .prepare(
            // sort_order is refreshed too: TQ has no preserve/keep semantics —
            // each run fully reorders the verse to match the incoming file.
            `UPDATE tq_rows
                SET ref_raw = ?1, tags = ?2, quote = ?3, occurrence = ?4,
                    question = ?5, response = ?6, sort_order = ?7,
                    version = version + 1, updated_at = ?8, updated_by = ?9
              WHERE id = ?10 AND book = ?11 AND deleted_at IS NULL`,
          )
          .bind(
            patch.ref_raw,
            patch.tags,
            patch.quote,
            patch.occurrence,
            patch.question,
            patch.response,
            sortOrder,
            now,
            userId,
            proposedId,
            p.book,
          ),
        env.DB
          .prepare(
            `INSERT INTO edit_log
               (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
             VALUES ('tq', ?1, ?2, ?3, ?4, ?5, 'update', ?6, ?7)`,
          )
          .bind(proposedId, p.book, userId, existing.version, newVersion, JSON.stringify(patch), AI_SOURCE),
        env.DB
          .prepare(
            `UPDATE pending_imports SET accepted_at = unixepoch(), accepted_by = ?2 WHERE id = ?1`,
          )
          .bind(p.id, userId),
      ]);
      return "updated";
    }
  }

  // New row — proposedId either absent or not in tq_rows. Use it as the
  // sticky id when present (preserves AI-side correlation); otherwise mint
  // a fresh id with the same retry pattern as TN insert.
  if (proposedId) {
    await insertTqAtId(env, p, payload, proposedId, userId, sortOrder);
  } else {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const fresh = newRowId();
      try {
        await insertTqAtId(env, p, payload, fresh, userId, sortOrder);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (!/UNIQUE|PRIMARY KEY/i.test(msg)) throw e;
      }
    }
    if (lastErr) throw new Error(`tq id collision exhausted after 8 attempts`);
  }
  return "created";
}

async function insertTqAtId(
  env: Env,
  p: PendingImportRow,
  payload: Record<string, unknown>,
  id: string,
  userId: number,
  sortOrder: number,
): Promise<void> {
  const cols = ["id", "book", "chapter", "verse", "ref_raw", "tags", "quote", "occurrence", "question", "response", "updated_by", "sort_order"];
  const values = [
    id,
    payload.book ?? null,
    payload.chapter ?? null,
    payload.verse ?? null,
    payload.ref_raw ?? null,
    payload.tags ?? null,
    payload.quote ?? null,
    payload.occurrence ?? null,
    payload.question ?? null,
    payload.response ?? null,
    userId,
    sortOrder,
  ];
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO tq_rows (${cols.join(", ")})
         VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`,
      )
      .bind(...values),
    env.DB
      .prepare(
        `INSERT INTO edit_log
           (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
         VALUES ('tq', ?1, ?2, ?3, NULL, 1, 'create', ?4, ?5)`,
      )
      .bind(id, p.book, userId, JSON.stringify(payload), AI_SOURCE),
    env.DB
      .prepare(
        `UPDATE pending_imports SET accepted_at = unixepoch(), accepted_by = ?2 WHERE id = ?1`,
      )
      .bind(p.id, userId),
  ]);
}

// Load every UHB/UGNT source verse in the job's chapter range in ONE query and
// index its `\w` source words by verse. Used to canonize alignment source attrs
// (and heal U+FFFD) against the exact source without a per-verse D1 read.
async function loadUhbSourceWords(
  env: Env,
  job: ImportContext,
): Promise<Map<number, SourceWord[]>> {
  const srcVersion = NT_BOOKS.has(job.book) ? "UGNT" : "UHB";
  const rs = await env.DB.prepare(
    `SELECT chapter, verse, content_json FROM verses
      WHERE book = ?1 AND chapter BETWEEN ?2 AND ?3 AND bible_version = ?4`,
  )
    .bind(job.book, job.startChapter, job.endChapter, srcVersion)
    .all<{ chapter: number; verse: number; content_json: string }>();
  const map = new Map<number, SourceWord[]>();
  for (const r of rs.results ?? []) {
    try {
      const vo = (JSON.parse(r.content_json) as { verseObjects?: unknown[] }).verseObjects ?? [];
      map.set(r.chapter * 100000 + r.verse, collectSourceWords(vo));
    } catch {
      /* skip an unparseable source verse — canonize/heal then no-op for it */
    }
  }
  return map;
}

// Source words for a target verse, unioned across a verse bridge (verse_end) so
// a bridged ULT/UST verse can match source words from every verse it spans.
function sourceWordsForRange(
  map: Map<number, SourceWord[]>,
  chapter: number,
  verse: number,
  verseEnd: number | null,
): SourceWord[] {
  const end = verseEnd != null && verseEnd >= verse ? verseEnd : verse;
  if (end === verse) return map.get(chapter * 100000 + verse) ?? [];
  const out: SourceWord[] = [];
  for (let v = verse; v <= end; v++) {
    const ws = map.get(chapter * 100000 + v);
    if (ws) out.push(...ws);
  }
  return out;
}

async function applyVerseUpdate(
  env: Env,
  p: PendingImportRow,
  userId: number,
  uhbWordsByVerse: Map<number, SourceWord[]>,
): Promise<void> {
  const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
  const book = String(payload.book ?? p.book);
  const chapter = Number(payload.chapter ?? p.chapter);
  const verse = Number(payload.verse ?? p.verse);
  const verseEndRaw = payload.verse_end;
  const verseEnd =
    typeof verseEndRaw === "number" && Number.isFinite(verseEndRaw) ? verseEndRaw : null;
  const uhbWords = sourceWordsForRange(uhbWordsByVerse, chapter, verse, verseEnd);
  const bibleVersion = String(payload.bible_version ?? p.bible_version ?? "");
  let contentJson = String(payload.content_json ?? "");
  const plainText = (payload.plain_text as string | null) ?? null;
  const rowKey = `${book}/${chapter}/${verse}/${bibleVersion}`;

  // Self-heal target `\w` occurrence numbering before the AI-applied alignment
  // lands in D1. The bot can emit colliding/`occurrences="1"` data; recomputing
  // from document position keeps note-highlight / colors / quote-builder correct
  // and the DCS export valid. No-op on clean output; source text left untouched.
  if (bibleVersion === "ULT" || bibleVersion === "UST") {
    try {
      const parsed = JSON.parse(contentJson) as { verseObjects?: unknown[] };
      if (Array.isArray(parsed?.verseObjects)) {
        // Drop AI-mangled orphan `\zaln-e` end-markers / bare "-e" junk before
        // recompute, so the cleaned tree lands in D1 (and exports clean). See
        // stripOrphanAlignmentMarkers — MIC 6:10 UST.
        parsed.verseObjects = stripOrphanAlignmentMarkers(parsed.verseObjects);
        // Collapse any `\zaln-s` compound that wraps the same source token twice
        // (the doubled-source defect, e.g. JER 31:33 `אֶת אֶת בֵּית`) before it
        // lands in D1 / exports. No-op on clean output; source text untouched.
        parsed.verseObjects = dropDuplicateSourceMilestones(parsed.verseObjects);
        // Canonize `\zaln-s` source attrs (x-content / x-lemma) to the exact UHB
        // bytes — fixing combining-mark order and dropped joiners the AI aligner
        // emits — so stored + exported Hebrew matches the source and downstream
        // nfc() compares become no-ops. Structure-preserving; no-op when nothing
        // matches or the source verse wasn't loaded. See canonizeHebrew.ts.
        canonizeAlignmentSource(parsed.verseObjects, uhbWords);
        recomputeTargetOccurrences(parsed.verseObjects);
        contentJson = JSON.stringify(parsed);
      }
    } catch {
      /* leave contentJson as-is if it isn't parseable JSON */
    }
  }

  // Heal AI-mangled U+FFFD in `\zaln-s` source attributes (the generator can emit
  // garbled multi-byte Hebrew, e.g. וּזְה❖❖בָם for "gold") before it lands in D1
  // — otherwise it shows as a broken aligner card and exports the garble to DCS.
  // Reconstruct from the parallel UHB/UGNT row; gated on the rare defect, and
  // structure-preserving so no word unaligns. See healReplacementChars.
  if ((bibleVersion === "ULT" || bibleVersion === "UST") && contentJson.includes("�")) {
    try {
      const parsed = JSON.parse(contentJson) as { verseObjects?: unknown[] };
      // Reuse the preloaded source words (same UHB/UGNT verse, now union of the
      // bridge range) instead of a per-verse read — see loadUhbSourceWords.
      const report = healReplacementChars(parsed.verseObjects ?? [], uhbWords);
      if (report.repaired.length > 0) contentJson = JSON.stringify(parsed);
      if (report.unrepaired.length > 0) {
        console.warn("pipeline apply: unrepaired U+FFFD in alignment source attrs", {
          book,
          chapter,
          verse,
          bibleVersion,
          unrepaired: report.unrepaired,
        });
      }
    } catch {
      /* leave contentJson as-is if anything is unparseable */
    }
  }

  // Pull the outgoing row too (not just its version): the AI write overwrites
  // content_json, so this is our one chance to preserve the PRE-AI state ("v0")
  // for verse history — see the guarded baseline insert below.
  const existing = await env.DB.prepare(
    `SELECT version, content_json, plain_text, updated_at FROM verses
      WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4`,
  )
    .bind(book, chapter, verse, bibleVersion)
    .first<{ version: number; content_json: string; plain_text: string | null; updated_at: number }>();

  const now = Math.floor(Date.now() / 1000);
  if (existing) {
    const newVersion = existing.version + 1;
    await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE verses
              SET content_json = ?1, plain_text = ?2, verse_end = ?3,
                  version = version + 1, updated_at = ?4, updated_by = ?5
            WHERE book = ?6 AND chapter = ?7 AND verse = ?8 AND bible_version = ?9`,
        )
        .bind(contentJson, plainText, verseEnd, now, userId, book, chapter, verse, bibleVersion),
      // Preserve the pre-AI content as a baseline at its own version, so verse
      // history can restore the state before the AI ran. Guarded: only when that
      // version was never logged (i.e. the original bootstrap import), so repeat
      // AI runs / prior edits — which already logged their content — don't
      // duplicate it. created_at carries the outgoing row's own timestamp.
      env.DB
        .prepare(
          `INSERT INTO edit_log
             (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source, created_at)
           SELECT 'verse', ?1, ?2, NULL, NULL, ?3, 'baseline', ?4, NULL, ?5
            WHERE NOT EXISTS (
              SELECT 1 FROM edit_log WHERE kind = 'verse' AND row_key = ?1 AND new_version = ?3
            )`,
        )
        .bind(
          rowKey,
          book,
          existing.version,
          JSON.stringify({ plain_text: existing.plain_text, content: existing.content_json }),
          existing.updated_at,
        ),
      // The AI version itself: log full content (not just plain_text) so it is
      // restorable — this is the alignment-bearing base translators edit from.
      env.DB
        .prepare(
          `INSERT INTO edit_log
             (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
           VALUES ('verse', ?1, ?2, ?3, ?4, ?5, 'update', ?6, ?7)`,
        )
        .bind(rowKey, book, userId, existing.version, newVersion, JSON.stringify({ plain_text: plainText, content: contentJson }), AI_SOURCE),
      env.DB
        .prepare(
          `UPDATE pending_imports SET accepted_at = unixepoch(), accepted_by = ?2 WHERE id = ?1`,
        )
        .bind(p.id, userId),
    ]);
    return;
  }

  // The verse should exist from the initial book import; this branch is the
  // defensive case where the seed missed something. Insert as a brand-new row.
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, content_json, plain_text, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(book, chapter, verse, verseEnd, bibleVersion, contentJson, plainText, userId),
    env.DB
      .prepare(
        `INSERT INTO edit_log
           (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
         VALUES ('verse', ?1, ?2, ?3, NULL, 1, 'create', ?4, ?5)`,
      )
      .bind(rowKey, book, userId, JSON.stringify({ plain_text: plainText, content: contentJson }), AI_SOURCE),
    env.DB
      .prepare(
        `UPDATE pending_imports SET accepted_at = unixepoch(), accepted_by = ?2 WHERE id = ?1`,
      )
      .bind(p.id, userId),
  ]);
}
