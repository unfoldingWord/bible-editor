// Pure decision: should the nightly reimport stamp the (book, resource) sync
// watermark (book_resource_syncs) for this run's counts? A watermark must not
// certify data it didn't apply — the same principle as the truncated-fetch
// completeness gate in shrinkGuard.ts / bookReimport.ts's planAndStageBookResources
// (the HAB tn incident).
//
// NO — withhold the stamp — iff EITHER of two phases skipped work this run
// because an active AI pipeline job held a chapter lock:
//
//   1. `chapters_locked` — the chunk-apply steps (reimportStagedChunk) skipped
//      a chapter that had real work for this resource. This is the EZK 40 UST
//      case: D1 stayed on a 2026-06-10 revision while the watermark certified
//      the book in sync after bp-assistant pushed an entirely new chapter 40
//      to master on 2026-08-01. The nightly export's freshness gate trusted
//      the stamp and rendered the stale chapter over master's new one.
//
//   2. `prune_locked` — the LATER reimport-prune-* step (softDeleteRemovedTsvRows)
//      hit a lock still held during pruning, even though the earlier chunk-apply
//      step for that same chapter saw no lock (chapters_locked stayed 0). A job
//      that starts between the two steps is invisible to `chapters_locked` alone,
//      but the row-deletion side of this resource's sync is still incomplete for
//      that chapter — stamping the watermark would be just as much a lie.
//
// A counts object is treated as fail-safe (withhold) whenever either field is
// entirely ABSENT (`undefined`) rather than a real, present `0` — this is the
// legacy/malformed case: a Workflow instance that began running before this
// fix shipped replays its memoized `step.do` results verbatim on resume, so
// mid-flight it can hand this function an object that simply never had
// `chapters_locked` / `prune_locked` in the first place. Note this is a
// presence check, NOT a `?? 0` coercion on the read — `?? 0` would turn that
// same "field absent" case into "field present and zero" and stamp the
// watermark for data we have no actual evidence is current (zero-and-stamp,
// the wrong direction). Coercion belongs in addCounts (see there), which
// exists to keep the aggregate counters numeric for logging, not to launder
// an absent field into a green light here. The direction on ambiguity is:
// withhold is safe (worst case, a delayed export retry); stamp is not (it can
// certify stale data as current). See reimportSyncGate.test.mjs.
//
// Deliberately NOT gated on `skipped_locked`: that counter is overloaded —
// besides the chapter-lock skip, it is ALSO incremented by the row-level prune
// path, a different and much less severe situation that must NOT withhold the
// watermark on its own. Only `chapters_locked` and `prune_locked` gate this
// decision.
//
// Pure (no D1) so it's regression-testable without a Workflow context — see
// shrinkGuard.ts for the same pattern.
export function shouldRecordResourceSync(counts: {
  chapters_locked?: number;
  prune_locked?: number;
}): boolean {
  if (counts.chapters_locked === undefined || counts.prune_locked === undefined) return false;
  return counts.chapters_locked === 0 && counts.prune_locked === 0;
}
