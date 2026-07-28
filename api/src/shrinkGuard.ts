// Truncated-fetch completeness policy for the DCS→D1 reimport.
//
// fetchText's declared-length check is blind to a response that omits
// Content-Length (HAB's raw endpoint), so a partial body can slip through. A
// truncated TSV parses to far fewer rows than the book actually holds — the
// signal the reimport uses to reject the body before it can stage, stamp a
// watermark, or prune. This module is the pure decision (no D1 / no fetch) so it
// can be regression-tested in isolation; bookReimport.ts wraps it with the row
// counts. See the HAB tn truncated-prune incident (2026-06-23/24): a ~1-row body
// soft-deleted 559 pristine rows while the watermark certified the book "in
// sync."
//
// Only sizeable books, only a >=50% drop trips it: a genuine edit never does,
// and a real large deletion bails too and waits for a human — the correct trade
// for "never silently delete a book." (softDeleteRemovedTsvRows already bails on
// a 0-row file; this covers the near-empty-but-nonzero case the incident hit.)
export const SHRINK_GUARD_MIN_LIVE = 20;
export const SHRINK_GUARD_RATIO = 0.5;

export function isCatastrophicTsvShrink(liveRows: number, incomingRows: number): boolean {
  if (liveRows < SHRINK_GUARD_MIN_LIVE) return false;
  return incomingRows < liveRows * SHRINK_GUARD_RATIO;
}

// Whether an `allowShrink` request may override the EXPORT shrink guard (a
// different guard from isCatastrophicTsvShrink above — see exportWorkflow's
// checkTsvShrink). The export guard cannot tell a truncated D1 load from a
// translator deliberately deleting rows, so a human who has verified the
// deletion needs a way through. Deliberately narrow: only a run naming exactly
// ONE book and ONE resource qualifies. Every cron path omits both, so the
// nightly can never disable the guard wholesale — the property that keeps this
// override from becoming the hole the guard was built to plug. Pure so the
// negative cases are regression-testable without a Workflow context.
export function shrinkOverrideAllowed(
  params: { allowShrink?: boolean; book?: string; resource?: string },
  resolvedBookCount: number,
): boolean {
  if (params.allowShrink !== true) return false;
  if (!params.book || !params.resource) return false;
  return resolvedBookCount === 1;
}
