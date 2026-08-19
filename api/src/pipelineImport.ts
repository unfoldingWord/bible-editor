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
  curlifyText,
  curlifyVerseObjects,
  extractPlainText,
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
import { newRowId, isValidRowId, coerceRowId, deriveAltRowId } from "./rowId.ts";
import { tnContentKey } from "./tnDedup.ts";
import { requiredOccurrence } from "./occurrenceRule.ts";
import {
  IMPORT_CLAIM_STALE_SECONDS,
  shouldTouchClaim,
  tnSweepScope,
  shouldAbortApply,
  shouldCheckCancel,
  CANCEL_CHECK_INTERVAL_SECONDS,
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
  // True when a deliberate stop (force stop or cancel) landed while this
  // apply was in flight and the apply stopped at a batch boundary. Distinct
  // from claimLost: no other
  // poll owns this import, the work simply must not continue. The caller
  // MUST NOT finalize, must not enqueue the follow-up chain, and must not
  // broadcast a completion. Issue #402.
  aborted?: boolean;
  abortState?: string | null;
  abortErrorKind?: string | null;
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

// tnPayload / tqPayload are exported for the direct regression tests in
// pipelineImport.test.mjs, which assert on the quote-curling below (JER 32/33,
// NUM 26:53 prod forensics — straight quotes in AI-generated note prose).
// Not intended as a public API beyond that — same rationale as
// deleteUnkeptTns / maybeTouchClaim.
export function tnPayload(book: string, refRaw: string, row: Record<string, string>) {
  const [ch, v] = refParts(refRaw);
  const occRaw = row["Occurrence"];
  const parsedOcc = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
  const quote = row["Quote"] || null;
  // Hold the AI to the same Occurrence invariant as the editor. Unlike
  // bookImport/bookReimport — which round-trip DCS master and must preserve its
  // blanks verbatim — this payload is freshly generated content, so a blank or
  // illegal Occurrence here is a defect to fix at ingest, not history to keep.
  // Without this, a proposed note carrying a Gateway-Language quote and no
  // Occurrence lands exactly the row shape prod tn JER 37:5 `bfyt` has been
  // holding all of JER TN's export with. See occurrenceRule.ts.
  const occurrence = requiredOccurrence("tn", quote, parsedOcc) ?? parsedOcc;
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
      quote,
      occurrence,
      // Collapse bp-assistant's double-space-after-punctuation artifact so the
      // stored note matches DCS master's normalized form (see
      // normalizeNoteWhitespace) — both apply paths (applyTnInsert and the hint
      // expansion) and the edit_log audit read this same staged note. Curl
      // straight quotes with the SAME contextual rule verse text ingest uses
      // (curlifyText, not tsvFormat.ts's educateQuotes — see the module
      // comment above curlifyVerseObjects in importParsers.ts for why the two
      // ingest paths must share one rule) so an AI-authored note never lands
      // with straight ' / " and never disagrees with an AI-authored verse
      // curled in the same run.
      note: row["Note"] ? curlifyText(normalizeNoteWhitespace(row["Note"])) : null,
    },
  };
}

export function tqPayload(book: string, refRaw: string, row: Record<string, string>) {
  const [ch, v] = refParts(refRaw);
  const occRaw = row["Occurrence"];
  const parsedOcc = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
  const quote = row["Quote"] || null;
  // Same invariant as tnPayload above — see occurrenceRule.ts. tq's validator
  // permits a blank Occurrence, so in practice this only heals an
  // original-language quote or an out-of-range integer.
  const occurrence = requiredOccurrence("tq", quote, parsedOcc) ?? parsedOcc;
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
      quote,
      occurrence,
      // Curl straight quotes in AI-generated question/response prose — same
      // rationale (and same shared function) as tnPayload's note above.
      question: row["Question"] ? curlifyText(row["Question"]) : null,
      response: row["Response"] ? curlifyText(row["Response"]) : null,
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
  // Cancellation watch shared across staging + apply, mirroring the heartbeat
  // above but checking pipeline_jobs.state/error_kind instead of re-stamping
  // import_claimed_at. Seeded ONE FULL INTERVAL IN THE PAST (unlike the
  // heartbeat, which deliberately waits a full interval before its first
  // touch) so the FIRST checkpoint actually reads: a job that was already
  // force-stopped before this pass even started its apply must be caught on
  // the very first check, not CANCEL_CHECK_INTERVAL_SECONDS into the run. See
  // maybeCheckCancelled below.
  const cancel: CancelWatch = {
    lastCheckedAt: Math.floor(Date.now() / 1000) - CANCEL_CHECK_INTERVAL_SECONDS,
    aborted: false,
    abortState: null,
    abortErrorKind: null,
  };
  try {
    const stageResult = await stageJobOutput(env, job, outputs, heartbeat, cancel);
    // Staging itself can abort (see the CHUNK loop in stageJobOutput) — when it
    // does, skip apply entirely rather than running it against a possibly
    // incomplete pending_imports set.
    const applyResult = cancel.aborted ? undefined : await applyJobOutput(env, job, heartbeat, cancel);

    // Deliberate stop wins over an incidental lease loss below: it is the more
    // specific AND the more actionable outcome (keep-and-record + stamp the
    // job), whereas claimLost just means "some other poll owns this now."
    if (cancel.aborted) {
      // Record what was applied so the partial state is inspectable, and
      // release the claim in the same batch — CAS'd on the owned claim for the
      // identical reason the catch-path release below is (see that comment):
      // if this pass already lost its lease to a legitimate new owner, this
      // write must be a no-op rather than clobbering the new owner's claim or
      // stamping a summary the new owner's own apply will contradict.
      const summary = JSON.stringify({
        stage: { inserted: stageResult.inserted, byKind: stageResult.byKind },
        applied: applyResult ?? null,
        state: cancel.abortState,
        errorKind: cancel.abortErrorKind,
      });
      const abortBatchRes = await env.DB.batch([
        env.DB
          .prepare(
            `UPDATE pipeline_jobs SET import_aborted_at = unixepoch(), import_abort_summary = ?2
              WHERE job_id = ?1 AND import_claimed_at = ?3`,
          )
          .bind(job.jobId, summary, heartbeat.ownedClaimedAt),
        env.DB
          .prepare(
            `UPDATE pipeline_jobs SET import_claimed_at = NULL WHERE job_id = ?1 AND import_claimed_at = ?2`,
          )
          .bind(job.jobId, heartbeat.ownedClaimedAt),
      ]);
      // The CAS above is correct to keep (see the comment above it) — but if
      // the lease was already lost, both statements match zero rows and the
      // abort would otherwise be recorded nowhere while this function still
      // returns aborted: true. Surface that loudly rather than silently.
      if ((abortBatchRes[0]?.meta?.changes ?? 0) === 0) {
        console.error(
          "pipeline apply: abort record not written — lease no longer owned by this pass",
          {
            jobId: job.jobId,
            abortState: cancel.abortState,
            abortErrorKind: cancel.abortErrorKind,
            heartbeatLost: heartbeat.lost,
          },
        );
      }
      return {
        ...stageResult,
        applied: applyResult,
        aborted: true,
        abortState: cancel.abortState,
        abortErrorKind: cancel.abortErrorKind,
        skipped: [
          ...stageResult.skipped,
          `import aborted mid-apply: job went terminal (${cancel.abortState}${cancel.abortErrorKind ? "/" + cancel.abortErrorKind : ""})`,
        ],
      };
    }
    // Lease lost MID-FLIGHT (heartbeat CAS failed): another poll legitimately
    // re-claimed and may still be applying. Report it as claimLost so the caller
    // does NOT finalize — writing output_json / state='done' here would mark the
    // import complete while the new owner is still mid-apply, and would enqueue
    // the follow-up chain early. The caller already handles claimLost exactly
    // this way (pollPipelineJob), so this reuses that path rather than adding a
    // second one. Note the work this pass DID do is already committed and
    // per-row idempotent, so the owning poll resumes rather than duplicating.
    if (heartbeat.lost) {
      return {
        ...stageResult,
        applied: applyResult,
        claimLost: true,
        skipped: [...stageResult.skipped, "import lease lost mid-apply; a concurrent poll owns this import"],
      };
    }
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

// Mutable cancellation state threaded through staging + apply, mirroring
// ClaimHeartbeat's shape but answering a different question: not "is our
// claim still fresh" but "has the job itself gone terminal out from under us."
// See maybeCheckCancelled.
export interface CancelWatch {
  lastCheckedAt: number;
  aborted: boolean;
  abortState: string | null;
  abortErrorKind: string | null;
}

// Cooperative cancellation check called at batch boundaries throughout the
// stage/apply loops. Answers: has this job left every state under which an
// apply is legitimate (shouldAbortApply)? If so, every subsequent checkpoint
// in this pass returns true immediately (no further DB reads) and the calling
// loop stops issuing new writes — see the `break`/early-return call sites
// below. Policy is keep-and-record (#402): nothing already written is undone;
// this only prevents NEW writes past the point of detection, and
// importJobOutput stamps the job with what was applied so the partial result
// is inspectable.
//
// Rate-limited via shouldCheckCancel/CANCEL_CHECK_INTERVAL_SECONDS so a
// chunked loop pays for one cheap SELECT every ~15s, not one per proposal.
// `opts.force` bypasses that rate limit for the one checkpoint that must
// never be skipped — the pre-delete checkpoint in applyJobOutput (see FIX B
// there): CancelWatch.lastCheckedAt is seeded one interval in the past so the
// FIRST checkpoint of a pass reads, but stageJobOutput's own chunk-loop
// checkpoint consumes that seed, so if staging finishes in under
// CANCEL_CHECK_INTERVAL_SECONDS (the common single-chapter case) the
// pre-delete checkpoint would otherwise be rate-limited away and never read.
// `force` still short-circuits on `cw.aborted` first and still updates
// `cw.lastCheckedAt`, same as the rate-limited path.
// Exported for the fake-DB regression tests in pipelineImport.test.mjs, which
// drive it directly — same rationale as maybeTouchClaim.
export async function maybeCheckCancelled(
  env: Env,
  jobId: string,
  cw: CancelWatch,
  opts?: { force?: boolean },
): Promise<boolean> {
  if (cw.aborted) return true; // Already known — no DB read needed.
  const now = Math.floor(Date.now() / 1000);
  if (!opts?.force && !shouldCheckCancel(cw.lastCheckedAt, now)) return false;
  // Set BEFORE the read, same reasoning as the heartbeat's ownedClaimedAt
  // bookkeeping: a throwing or slow read must not produce a hot retry loop —
  // the next check still waits a full interval regardless of what this one did.
  cw.lastCheckedAt = now;
  let row: { state: string | null; error_kind: string | null } | null;
  try {
    row = await env.DB.prepare(
      `SELECT state, error_kind FROM pipeline_jobs WHERE job_id = ?1`,
    )
      .bind(jobId)
      .first<{ state: string | null; error_kind: string | null }>();
  } catch (err) {
    // Before this PR the apply issued no such read; a transient D1 read error
    // mid-apply must not throw out of applyJobOutput/stageJobOutput — that
    // would release the import claim and, on a job already carrying
    // error_kind='import_failed', make it terminal immediately, discarding a
    // completed run. This matches shouldAbortApply's own null-safety intent:
    // a failed read is not evidence the job went terminal. A cancellation
    // check exists ONLY to stop an apply early — it must never be able to
    // fail an apply it has no business failing.
    console.error("pipeline apply: cancellation check read failed; continuing the apply", {
      jobId,
      err,
    });
    return false;
  }
  // A missing row is not a terminal signal — applyJobOutput's own lookup
  // throws on a missing pipeline_jobs row elsewhere; this check simply no-ops
  // rather than inventing a second, weaker way to detect that case.
  if (!row) return false;
  if (shouldAbortApply(row.state, row.error_kind)) {
    cw.aborted = true;
    cw.abortState = row.state;
    cw.abortErrorKind = row.error_kind ?? null;
    console.error("pipeline apply: job went terminal mid-apply; stopping at batch boundary", {
      jobId,
      state: row.state,
      errorKind: row.error_kind,
    });
    return true;
  }
  return false;
}

async function stageJobOutput(
  env: Env,
  job: ImportContext,
  outputs: OutputEntry[],
  heartbeat: ClaimHeartbeat,
  cancel: CancelWatch,
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
    // #402: stop staging further chunks once the job has gone terminal
    // out from under us. cancel.aborted below gates the staged_at UPDATE, so
    // an aborted stage never gets marked complete — a resumed pass restages
    // from scratch rather than treating a partial set as the full one.
    if (await maybeCheckCancelled(env, job.jobId, cancel)) break;
  }

  // Mark staging complete only after the last chunk committed (also covers the
  // zero-row case — staging is then vacuously complete). Any throw above leaves
  // staged_at NULL; importJobOutput's caller leaves output_json NULL on throw,
  // so the next poll re-enters here and restages cleanly. Same reasoning now
  // covers an abort: staging is incomplete, so it must not be marked complete
  // (#402).
  if (!cancel.aborted) {
    await env.DB.prepare(
      `UPDATE pipeline_jobs SET staged_at = unixepoch() WHERE job_id = ?1`,
    )
      .bind(job.jobId)
      .run();
  } else {
    // An aborted stage can leave a PARTIAL pending_imports set (e.g. 100 of
    // 150 rows inserted before the chunk loop broke). The review endpoint,
    // GET /api/pending-imports (pendingImports.ts), filters only on
    // book/chapter/unresolved with NO job-state filter — without this delete,
    // a translator would see an arbitrary prefix of a stopped job's proposals
    // presented as a complete reviewable set, persisting until the nightly
    // cleanup. This DELETE is safe and is NOT a translator-data delete: these
    // are unapplied staging proposals only (never accepted or rejected), the
    // job is terminal so nothing will ever apply them, and this is the EXACT
    // SAME statement stageJobOutput already issues at its own top before
    // restaging — the only difference here is that a job which just went
    // terminal will never get a restaging attempt to run it for.
    await env.DB.prepare(
      `DELETE FROM pending_imports
        WHERE job_id = ?1 AND accepted_at IS NULL AND rejected_at IS NULL`,
    )
      .bind(job.jobId)
      .run();
  }

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
  cancel: CancelWatch,
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

  // #402 checkpoint, placed immediately BEFORE the delete phase rather than
  // inside it: deleteUnkeptTns's deletes are immediately followed by the
  // inserts that replace what they deleted, so stopping BETWEEN delete chunks
  // is the single worst outcome available here — notes gone, replacements
  // never written. Once this checkpoint passes, the delete phase and the TN
  // insert loop that replaces what it deleted both run to completion
  // unconditionally — see the comment above the TN insert loop below for why
  // that loop has no cancellation check of its own. For a notes run this
  // checkpoint is the ONLY stop point apply gets, so it is forced to bypass
  // the rate limit and always actually read (see maybeCheckCancelled's
  // `opts.force`) — a fresh, sub-15s single-chapter stage would otherwise
  // consume the rate-limit window and leave this checkpoint unable to fire.
  if (await maybeCheckCancelled(env, job.jobId, cancel, { force: true })) {
    result.affectedChapters = [...affected].sort((a, b) => a - b);
    return result;
  }

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
    // Normalize the LIVE row's note the same way tnPayload normalizes an
    // incoming proposal's note (curlifyText) before keying it. Without this,
    // a pre-fix straight-quote note that deleteUnkeptTns deliberately skips
    // (preserve=1 / hint=1) keeps a RAW key built from its stored straight
    // quotes, while a re-run's identical-content proposal is keyed from its
    // NOW-curled `payload.note` (see the contentKey build below) — the two
    // keys never match, so content-dedup silently fails to recognize the
    // duplicate and a second copy gets inserted. `quote` is deliberately left
    // untouched here, matching tnPayload — it must stay byte-exact for
    // occurrence matching.
    for (const r of live.results ?? []) {
      claimedTnKeys.add(tnContentKey({ ...r, note: r.note ? curlifyText(r.note) : r.note }));
    }
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

  // The TN delete phase above and this insert loop are two halves of ONE
  // replace: the deletes soft-deleted live notes and these inserts write
  // their replacements. An apply that stops between them leaves notes gone
  // and replacements never written — the DAN 11 shape — and unlike a crash it
  // is PERMANENT, because an aborted job is terminal and no later poll
  // re-enters (pollAllNonTerminal selects only running/paused_*, the GET
  // route short-circuits terminal jobs, and the nightly cleanup drops the
  // unresolved pending_imports within 24h).
  //
  // A prior version of this loop gated its checkpoint on
  // `tnInsertsCancellable = result.tnDeleted === 0`, reasoning that if the
  // delete phase destroyed nothing, there was nothing left to strand by
  // stopping. That signal is not trustworthy: deleteUnkeptTns's own SELECT
  // filters `deleted_at IS NULL` and the function is idempotent as a whole,
  // so a RESUMED pass whose predecessor already tombstoned rows and died
  // before writing their replacements also sees tnDeleted === 0 — the
  // predecessor's deletes are invisible to it, not absent. That resumed pass
  // would then wrongly re-enable cancellation and reopen exactly the DAN 11
  // shape this guard exists to prevent.
  //
  // There is no cheap predicate that reliably means "no unreplaced deletes
  // exist in scope for this job." So this loop has NO cancellation check at
  // all: it is uncancellable by design once the pre-delete checkpoint above
  // has passed. The stop point for a notes run is that checkpoint — made
  // reliable by forcing it past the rate limit (see `{ force: true }` above).

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
    // #402: deliberately NO cancellation checkpoint here — see the comment
    // above this loop. The TN insert loop always runs to completion.
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

  // #402: the TQ loop may only stop on a verse boundary. tqCounters starts at
  // zero per verse because each run fully REORDERS the verse to match the
  // incoming file (there's no delete/preserve concept for TQ). Breaking
  // mid-verse would leave the first N rows of that verse renumbered
  // 100, 200… while the untouched remainder keeps its OLD sort_order values
  // from the PREVIOUS run — which are ALSO 100, 200… — producing duplicate
  // sort_order within one verse and nondeterministic TQ ordering in the UI
  // and the TSV export. Proposals are already ordered (kind, chapter, verse,
  // id), so all of a verse's TQ proposals are contiguous; checking only when
  // the (chapter, verse) group changes means every verse ends up either
  // fully reordered or entirely untouched.
  let tqPrevKey: number | null = null;
  // Ids this pass has already written. Two distinct proposed ids can hash to
  // the same alternate (~1 in 786k per pair); without this, the second
  // proposal would find the first's brand-new row at the same chapter+verse,
  // read it as "mine from a previous run", and UPDATE over it — losing a
  // question silently. Proposal order is stable (ORDER BY kind, chapter, verse,
  // id), so which proposal wins the shared id is deterministic across re-runs
  // and each keeps landing on the same row. TN has the same idea in
  // claimedTnKeys, keyed on content rather than id.
  const claimedTqIds = new Set<string>();
  for (const p of tqProposals) {
    const k = verseKey(p);
    if (k !== tqPrevKey && (await maybeCheckCancelled(env, job.jobId, cancel))) break;
    tqPrevKey = k;
    const sortOrder = (tqCounters.get(k) ?? 0) + 100;
    tqCounters.set(k, sortOrder);
    const action = await applyTqUpsert(env, p, userId, sortOrder, claimedTqIds);
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

  // #402: same group-boundary rule as the TQ loop above, keyed on verseKey
  // (chapter+verse), NOT bible_version. A `generate` run stages ULT and UST
  // for the same reference — adjacent but separable in the ordering.
  // Aborting between them would leave a verse with a fresh AI-aligned ULT and
  // a stale UST (or vice versa); checking only at a verse-group boundary
  // ensures ULT+UST for one reference are never split.
  let versePrevKey: number | null = null;
  for (const p of verseProposals) {
    const k = verseKey(p);
    if (k !== versePrevKey && (await maybeCheckCancelled(env, job.jobId, cancel))) break;
    versePrevKey = k;
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
  claimedIds: Set<string>,
): Promise<"created" | "updated"> {
  const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
  const rawId = typeof payload.id === "string" && payload.id.length > 0 ? payload.id : null;

  // Candidate-id chain. Attempt 0 is bp-assistant's proposed id (coerced if it
  // violates the 4-char grammar); later attempts are DETERMINISTIC derivations
  // of it. Determinism is the point: when the preferred id can't be used it
  // stays unusable, so a re-run of this chapter walks the identical chain,
  // finds the row the previous run created, and updates it. Minting randomly
  // instead would insert a second copy of the same question on every re-run.
  const seedId = rawId ? coerceRowId(rawId) : null;

  for (let attempt = 0; attempt < 8; attempt++) {
    const id = seedId ? (attempt === 0 ? seedId : deriveAltRowId(seedId, attempt)) : newRowId();

    // Book-scoped to match the composite PK — a colliding id in another book is
    // a "not found here", not a stale match.
    const existing = await env.DB.prepare(
      `SELECT version, chapter, verse FROM tq_rows WHERE id = ?1 AND book = ?2 AND deleted_at IS NULL`,
    )
      .bind(id, p.book)
      .first<{ version: number; chapter: number; verse: number }>();
    if (existing) {
      // The id is live. Whether that row is OURS depends on where the candidate
      // came from, and guessing wrong overwrites someone else's question with
      // this one — silent loss, since the proposal is then marked accepted.
      //
      //   attempt 0 with a seed — the id bp-assistant asserts owns this row.
      //     Adopt it anywhere in this chapter; the update rewrites verse/ref_raw
      //     so a question moved within the chapter stays consistent. A match in
      //     a DIFFERENT chapter is a stale/reused id, not ours: TQ rows don't
      //     migrate between chapters, and adopting would rewrite an unrelated
      //     question while leaving it filed under its own chapter.
      //
      //   derived candidate (attempt >= 1) — not claimed by anyone; it's just
      //     the next free slot in this seed's deterministic chain. A live row
      //     here is ours ONLY if it's the row a previous run of this same chain
      //     created, which sits at this same chapter AND verse. Two different
      //     seeds can hash to the same alternate (~1 in 786k per pair); without
      //     the verse check the second proposal would UPDATE over the first.
      //
      //   no seed (random mint) — the candidate asserts nothing at all, so a
      //     live row is never ours. Step on. Without this, a random id that
      //     happens to hit a live row in this chapter silently overwrites it.
      //   ...and never a row THIS pass already wrote (claimedIds): that row
      //     belongs to an earlier proposal in this same run, not to a previous
      //     run of our chain, so adopting it would overwrite a question we just
      //     created. This is the same-verse case the chapter/verse check alone
      //     cannot separate.
      const isOurs =
        seedId !== null &&
        existing.chapter === p.chapter &&
        (attempt === 0 || existing.verse === p.verse) &&
        !claimedIds.has(id);
      if (!isOurs) continue;
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
            // `verse` is rewritten alongside ref_raw so a question the run
            // moved to another verse of this chapter can't end up filed under
            // its old verse while displaying the new reference.
            `UPDATE tq_rows
                SET ref_raw = ?1, tags = ?2, quote = ?3, occurrence = ?4,
                    question = ?5, response = ?6, sort_order = ?7, verse = ?8,
                    version = version + 1, updated_at = ?9, updated_by = ?10
              WHERE id = ?11 AND book = ?12 AND deleted_at IS NULL`,
          )
          .bind(
            patch.ref_raw,
            patch.tags,
            patch.quote,
            patch.occurrence,
            patch.question,
            patch.response,
            sortOrder,
            p.verse,
            now,
            userId,
            id,
            p.book,
          ),
        env.DB
          .prepare(
            `INSERT INTO edit_log
               (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
             VALUES ('tq', ?1, ?2, ?3, ?4, ?5, 'update', ?6, ?7)`,
          )
          // `verse` is written by the UPDATE above but was missing from the
          // logged patch, so edit_log recorded a NEW ref_raw beside a STALE
          // verse — an internally inconsistent snapshot. Version history
          // replays these payloads, and so does the sync's reference-ancestor
          // fold (tsvMerge.ts's foldTsvRefBase), where a torn reference is worse
          // than an absent one: absence withholds, wrongness can let an export
          // overwrite Door43. An audit row must record what was written.
          .bind(id, p.book, userId, existing.version, newVersion, JSON.stringify({ ...patch, verse: p.verse }), AI_SOURCE),
        env.DB
          .prepare(
            `UPDATE pending_imports SET accepted_at = unixepoch(), accepted_by = ?2 WHERE id = ?1`,
          )
          .bind(p.id, userId),
      ]);
      claimedIds.add(id);
      return "updated";
    }

    // No LIVE row at this id. It's either free, or held by a TOMBSTONE: the
    // lookup above filters `deleted_at IS NULL` while the constraint the insert
    // must satisfy is `PRIMARY KEY (book, id)`, which has no deleted_at
    // component — so a soft-deleted row is invisible here yet owns its slot
    // forever. Let the INSERT be the arbiter and step to the next candidate on
    // collision. Stepping (rather than reusing the slot) is deliberate:
    // overwriting a tombstone would silently resurrect a row a translator
    // deleted, into whatever verse the new proposal belongs to.
    //
    // (1CH 23:7 proposed `hoig`, held by a hand-deleted 1CH 5:4 question. The
    // previously unguarded insert threw out of applyJobOutput and killed the
    // whole job, twice, terminally.)
    try {
      await insertTqAtId(env, p, payload, id, userId, sortOrder);
      claimedIds.add(id);
      return "created";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/UNIQUE|PRIMARY KEY/i.test(msg)) throw e;
    }
  }
  throw new Error(
    `tq id collision exhausted after 8 attempts (book ${p.book}, ref ${p.chapter}:${p.verse}, proposed id ${rawId ?? "none"})`,
  );
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
  // book/chapter/verse come from the pending_imports row, NOT the payload.
  // `p.book` is the job's book and is what the caller's liveness lookup, the
  // (book, id) collision guard, and the edit_log row below all key on; taking
  // them from the payload instead would let a stray TSV cell insert the row
  // into a different (book, id) space than the one just checked, leaving the
  // audit row pointing at a row that doesn't exist there.
  const values = [
    id,
    p.book,
    p.chapter,
    p.verse,
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
  // Mutable: the AI-supplied value is the starting point, but every mutation
  // pass below that can change `.text` or drop/rewrite a node makes it stale
  // the moment it fires — see the re-derive after the ULT/UST self-heal block.
  let plainText = (payload.plain_text as string | null) ?? null;
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
        // Curl straight quotes bp-assistant wrote into verse text (JER 32/33,
        // NUM 26:53 prod forensics) before it lands in D1 / exports to master.
        // Structure-preserving — see curlifyVerseObjects: it only ever
        // reassigns a `.text` string, never a `\zaln-s` source attribute, so
        // this can't unalign a word or touch Hebrew/Greek. No-op on clean
        // output. MUST run BEFORE recomputeTargetOccurrences: curling can make
        // two `\w` nodes' text byte-identical (an already-curly "LORD’s" and an
        // AI-written straight "LORD's" both become "LORD’s"), and occurrence
        // numbering is keyed on exact text equality — recomputing first would
        // stamp the two as distinct occurrences of what are now the same word,
        // recreating the very `${text}|${occurrence}` collision that recompute
        // exists to prevent. Curling first means the recompute below always
        // sees the FINAL text.
        curlifyVerseObjects(parsed.verseObjects);
        recomputeTargetOccurrences(parsed.verseObjects);
        contentJson = JSON.stringify(parsed);
        // Re-derive plain_text from the FINAL corrected tree. Every pass
        // above can change what plain_text should read — curlifyVerseObjects
        // rewrites `.text`, stripOrphanAlignmentMarkers strips junk text,
        // dropDuplicateSourceMilestones can drop a duplicated wrapper — so
        // trusting the AI-supplied payload.plain_text past this point would
        // store it stale. A stale plain_text breaks FindReplaceOverlay /
        // source search (both match against plain_text) and, worse, makes
        // the next nightly bookReimport compare master's freshly-extracted
        // text against THIS stale value, see a false diff, and spuriously
        // re-seed the verse (resetting updated_by) every night. Cheap and
        // always correct to recompute unconditionally here rather than
        // tracking a changed-flag across five differently-shaped healers.
        plainText = extractPlainText(parsed);
      }
    } catch {
      /* leave contentJson/plainText as-is if it isn't parseable JSON */
    }
  }

  // Heal AI-mangled U+FFFD in `\zaln-s` source attributes (the generator can emit
  // garbled multi-byte Hebrew, e.g. וּזְה❖❖בָם for "gold") before it lands in D1
  // — otherwise it shows as a broken aligner card and exports the garble to DCS.
  // Reconstruct from the parallel UHB/UGNT row; gated on the rare defect, and
  // structure-preserving so no word unaligns. See healReplacementChars. Does
  // NOT re-derive plainText: it only ever reassigns a milestone's source
  // attribute string (x-content/x-lemma/x-morph), never a node's `.text`, so
  // plain_text (which concatenates `.text` only) cannot change here.
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
