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
// Incompleteness reaches this gate by two distinct routes, and both must
// withhold:
//   1. Raw absence — the direct `undefined` check above/below, for a counts
//      object read straight off a single Workflow step result.
//   2. Aggregated-and-coerced — `perResource[resource]` is the running total
//      across every chunk this run (see mergePerResource/addCounts in
//      bookReimport.ts). Once a legacy/replayed chunk missing these fields is
//      folded in via `?? 0`, the absence itself is gone from the aggregate —
//      it reads as a present zero. addCounts records that loss separately on
//      `counts_incomplete`, which is checked here so the aggregate can still
//      withhold even though its own chapters_locked/prune_locked fields are
//      individually present and zero.
//
// Deliberately NOT gated on `skipped_locked`: that counter is overloaded —
// besides the chapter-lock skip, it is ALSO incremented by the row-level prune
// path, a different and much less severe situation that must NOT withhold the
// watermark on its own. Only `chapters_locked` and `prune_locked` (plus the
// `counts_incomplete` taint they can leave behind after aggregation) gate this
// decision.
//
// Pure (no D1) so it's regression-testable without a Workflow context — see
// shrinkGuard.ts for the same pattern.
export function shouldRecordResourceSync(counts: {
  chapters_locked?: number;
  prune_locked?: number;
  counts_incomplete?: boolean;
}): boolean {
  if (counts.chapters_locked === undefined || counts.prune_locked === undefined) return false;
  if (counts.counts_incomplete === true) return false;
  return counts.chapters_locked === 0 && counts.prune_locked === 0;
}

// ── Systemic alignment-refusal gate (verseMerge.ts's "keep_alignment_refused") ──
//
// A `keep_alignment_refused` verse means the nightly Door43->D1 merge
// declined to adopt master's out-of-band edit because doing so would have
// lost alignment on words neither side touched (see verseMerge.ts). Refusing
// is per-verse and cheap — but declining to adopt does NOT stop tonight's
// export from rendering D1's (unchanged) content back over master, which is
// the exact revert the 1CH incident was about, just now with a banner
// instead of silence.
//
// Decision (owner's call, not re-litigated here): a SMALL number of refusals
// for one (book, resource) is fine — the per-verse verse_merge_conflicts
// alert (see verseMergeConflicts.ts) gives a human what they need, and the
// export proceeds normally. Once the count looks SYSTEMIC, a maintainer's
// work is being reverted at scale — the same shape as the original bug, just
// caught instead of silent — so the export must be held back entirely for
// that resource: the caller withholds the (book, resource) watermark, which
// makes checkMasterFreshness (exportWorkflow.ts) report `master_ahead` and
// skip tonight's export with an honest `export_stale` alert, instead of
// re-triggering the same refusals night after night.
//
// Pure (no D1) so it's regression-testable without a Workflow context — see
// shouldRecordResourceSync above for the same convention. Deliberately a
// SIBLING to shouldRecordResourceSync rather than a parameter folded into it:
// the two gates test independent conditions (lock-held vs refusal-scale) and
// either firing must withhold — see reimportSyncGate.test.mjs's interaction
// cases and the call site in bookReimport.ts's `reimport-sync-${book}` step.
export const SYSTEMIC_MERGE_REFUSAL_THRESHOLD = 5;

// FIX H: a refusal is currently unresolvable through the app — saving the
// flagged verse clears its verse_lane_checks/verse_merge_conflicts row but
// does not make D1 equal master, so the NEXT sync recomputes the identical
// refusal and the freeze persists indefinitely. `override` is the escape
// hatch, in the spirit of the export shrink guard's `allowShrink`
// (shrinkGuard.ts's shrinkOverrideAllowed): a human who has verified the
// refused verses by hand can force this gate open for one run. Plumbed from
// POST /api/exports/run's `allowMergeRefusal` param (exports.ts) through
// ExportParams (exportWorkflow.ts) into runChunkedReimport's opts, gated the
// same narrow way allowShrink is — only when the run names exactly one book
// AND one resource, so no cron path can ever disable this wholesale. See
// mergeRefusalOverrideAllowed below.
export function isSystemicMergeRefusal(
  refusedCount: number,
  threshold: number = SYSTEMIC_MERGE_REFUSAL_THRESHOLD,
  override: boolean = false,
): boolean {
  if (override) return false;
  return refusedCount >= threshold;
}

// Whether an `allowMergeRefusal` request may override the systemic-refusal
// gate above, for THIS specific resource. Mirrors shrinkOverrideAllowed's
// shape and rationale exactly (shrinkGuard.ts): deliberately narrow — only a
// run naming exactly ONE book and ONE resource qualifies, and the override
// only applies to that named resource (never silently to a resource the
// caller didn't ask to unblock). Every cron path omits book/resource, so the
// nightly can never disable this gate wholesale.
export function mergeRefusalOverrideAllowed(
  params: { allowMergeRefusal?: boolean; book?: string; resource?: string },
  resolvedBookCount: number,
  resolvedResourceCount: number,
  resourceBeingChecked: string,
): boolean {
  if (params.allowMergeRefusal !== true) return false;
  if (!params.book || !params.resource) return false;
  if (params.resource !== resourceBeingChecked) return false;
  return resolvedBookCount === 1 && resolvedResourceCount === 1;
}
