// Pure decision: should the nightly reimport stamp the (book, resource) sync
// watermark (book_resource_syncs) for this run's counts? A watermark must not
// certify data it didn't apply — the same principle as the truncated-fetch
// completeness gate in shrinkGuard.ts / bookReimport.ts's planAndStageBookResources
// (the HAB tn incident).
//
// NO — withhold the stamp — iff any chapter was skipped this run because an
// active AI pipeline job held its lock (chapters_locked > 0): the rest of the
// book may be current, but that chapter's D1 rows for this resource were never
// actually refreshed, so stamping "in sync at master's SHA" would be a lie for
// that chapter. This is exactly what happened to EZK 40 UST: D1 stayed on a
// 2026-06-10 revision while the watermark certified the book in sync after
// bp-assistant pushed an entirely new chapter 40 to master on 2026-08-01. The
// nightly export's freshness gate trusted the stamp and rendered the stale
// chapter over master's new one.
//
// Deliberately NOT gated on `skipped_locked`: that counter is overloaded —
// besides the chapter-lock skip, it is ALSO incremented by the row-level prune
// path (softDeleteRemovedTsvRows skipping a locked row), a different and much
// less severe situation that must NOT withhold the watermark. Only
// `chapters_locked` (incremented at the two chapter-lock sites in
// bookReimport.ts) gates this decision.
//
// Pure (no D1) so it's regression-testable without a Workflow context — see
// shrinkGuard.ts for the same pattern.
export function shouldRecordResourceSync(counts: { chapters_locked: number }): boolean {
  return counts.chapters_locked === 0;
}
