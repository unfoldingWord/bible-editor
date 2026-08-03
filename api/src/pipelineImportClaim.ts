// Single-applier claim policy for AI-pipeline imports.
//
// Two pollers race to import a job the instant the bot flips it to 'done': the
// */5 cron (pollAllNonTerminal) and a translator's open tab hitting
// GET /api/pipelines/:jobId. Both gate the import on no_output_yet, read from a
// SELECT that predates the ~minute-long apply, and output_json (which clears
// that flag) is written only after the poll completes — so both can enter
// importJobOutput. Each apply's chapter-scoped deleteUnkeptTns then sweeps the
// OTHER apply's freshly-inserted AI rows, so their delete/insert phases
// interleave and corrupt the chapter (ISA 48 en_tn, 2026-06-30: vv.1–12 wiped,
// 13–22 doubled). importJobOutput claims the job by atomically stamping
// pipeline_jobs.import_claimed_at; the poller that loses the CAS no-ops.
//
// Leaf module (no imports) so the concurrency rule is unit-testable under
// `node --experimental-strip-types` — same pattern as shrinkGuard.ts.

// A claim left dangling by a hard Worker death (no JS throw to release it)
// becomes reclaimable by a later poll once older than this. Must comfortably
// exceed the longest real apply (a single-chapter notes apply runs ~1 min) so a
// still-running apply is never reclaimed out from under itself.
export const IMPORT_CLAIM_STALE_SECONDS = 600;

// Pure mirror of the atomic claim predicate in importJobOutput's
// `UPDATE ... WHERE` clause: a poller may take the import slot when it is
// unclaimed, or when the existing claim is older than the stale window (crash
// recovery). The production path enforces this in one CAS UPDATE rather than
// read-then-write, so two racing pollers can't both pass — this function
// documents and tests the rule, it is not the enforcement point.
export function mayClaimImport(
  currentClaim: number | null,
  now: number,
  staleSeconds: number = IMPORT_CLAIM_STALE_SECONDS,
): boolean {
  return currentClaim == null || currentClaim < now - staleSeconds;
}

// Scope the TN delete sweep (deleteUnkeptTns in pipelineImport.ts) to the
// (chapter, verse) pairs THIS apply pass is actually about to apply — not
// every verse the job ever proposed for. A resumed apply only re-selects the
// UNRESOLVED proposals (accepted_at IS NULL AND rejected_at IS NULL); if the
// prior pass already resolved some verses, those verses' notes must be left
// alone. Scoping the sweep to the whole job's `pending_imports` history
// (rather than to this pass's unresolved rows) let a resumed pass delete the
// first pass's freshly-inserted notes: DAN 11 tn, en_tn, 2026-08-03 — 160
// proposals, first pass inserted rows across verses 1-45, died before
// resolving all of them; the resumed pass's sweep covered every verse the job
// ever proposed for (1-45) and deleted 121 already-applied notes, leaving
// only the 39 the resumed pass itself re-applied. See the DAN 11 regression
// test in pipelineImport.test.mjs.
//
// `resolvedPairs` (required, not optional — a future caller must not be able
// to silently skip this) closes a second, narrower gap Codex review flagged
// against the fix above: a verse this job already has ACCEPTED proposals for
// must be excluded from the scope entirely, even though it may still also
// carry unresolved proposals in `proposals`. The sweep runs once, before any
// inserts in this apply pass; if a verse already has an accepted proposal,
// some EARLIER pass already ran delete-then-insert for that verse and
// completed at least part of the insert side. Re-sweeping it now can only
// destroy that already-accepted work. Traced against both crash shapes:
//   - Pass 1 died BEFORE sweeping verse V: V has no accepted proposals yet ->
//     stays in scope -> sweep + insert all of V. Unchanged, correct.
//   - Pass 1 swept V and accepted 2 of its 3 proposals, then died: V now has
//     an accepted proposal -> excluded from scope -> pass 2 leaves V's rows
//     alone and inserts only the 3rd, unresolved proposal. V ends with all 3
//     notes instead of losing the 2 already-accepted ones. This is the case
//     Codex flagged against the original fix (which scoped by unresolved
//     proposals alone and would still have re-swept V).
// Trade-off, deliberate: for an excluded verse, any prior-run or pristine note
// the first pass had not yet gotten to deleting survives (mildly stale)
// instead of being deleted. That's the same trade-off this module already
// makes elsewhere — a verse missing from the result "keeps its existing notes
// (mildly stale) instead of being emptied" — and mild staleness is strictly
// better than deleting accepted notes. The content-dedup claim set
// (`claimedTnKeys` in applyJobOutput) already prevents the remainder inserts
// from duplicating whatever survives on an excluded verse.
export function tnSweepScope(
  proposals: Array<{ chapter: number; verse: number }>,
  resolvedPairs: Array<{ chapter: number; verse: number }>,
): Array<{ chapter: number; verse: number }> {
  const resolvedKeys = new Set(resolvedPairs.map((p) => `${p.chapter}/${p.verse}`));
  const seen = new Set<string>();
  const pairs: Array<{ chapter: number; verse: number }> = [];
  for (const p of proposals) {
    const key = `${p.chapter}/${p.verse}`;
    if (seen.has(key) || resolvedKeys.has(key)) continue;
    seen.add(key);
    pairs.push({ chapter: p.chapter, verse: p.verse });
  }
  pairs.sort((a, b) => a.chapter - b.chapter || a.verse - b.verse);
  return pairs;
}

// How often importJobOutput's apply loops refresh pipeline_jobs.import_claimed_at
// while a single apply pass is still running. A long-running apply (DAN 11's
// took ~12 minutes) must not be re-claimed by a concurrent poller mid-flight —
// see IMPORT_CLAIM_STALE_SECONDS above. The heartbeat keeps a LIVE apply's claim
// fresh; it must NOT run once the worker has died (a throw, a crash, a killed
// isolate) so the stale window still reclaims a genuinely dead claim for crash
// recovery. Kept well below IMPORT_CLAIM_STALE_SECONDS so a live apply is
// re-stamped several times before the window would otherwise expire.
export const CLAIM_TOUCH_INTERVAL_SECONDS = 60;

// Pure rate-limit predicate for the heartbeat: should the apply loop issue
// another `UPDATE pipeline_jobs SET import_claimed_at = ...` right now, given
// when it last did so. Kept separate from the D1 write (touchImportClaim in
// pipelineImport.ts) so the throttling rule is unit-testable without a D1
// harness.
export function shouldTouchClaim(
  lastTouchedAt: number,
  now: number,
  intervalSeconds: number = CLAIM_TOUCH_INTERVAL_SECONDS,
): boolean {
  return now - lastTouchedAt >= intervalSeconds;
}
