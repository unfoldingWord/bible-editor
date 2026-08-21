// The hourly edit_log retention sweep's DELETE, extracted from index.ts's
// scheduled() so the literal SQL is unit-testable against real SQLite
// (editLogSweep.test.mjs) — the same "export the exact query" pattern
// verseMergeEditorAlerts.ts's buildEditorLookupQuery uses, and for the same
// reason: a hand-duplicated copy in a test could drift from what production
// runs while still passing its own tests.
//
// WHY THE SWEEP MUST EXEMPT ANYTHING (issue #537). The Door43→D1 three-way
// verse merge reconstructs its ancestor from edit_log: the newest
// kind='verse' 'create'/'update' row at or before the book+resource's
// master-confirmed boundary (bookReimport.ts's base_payload sub-select —
// `id <= master_confirmed_edit_id`, falling back to
// `created_at < master_confirmed_at` during migration 0050's warm-up). A
// plain age-based DELETE eventually removes the last row predating a book's
// watermark, and once that happens the verse is PERMANENTLY unadjudicable:
// every future Door43-side edit to it reads as "no ancestor → keep D1" and
// is written over by the next export, forever. Unlike a NULL watermark
// (#450, healed organically by own-publish recognition), nothing heals this
// — time makes it strictly worse.
//
// As of the 2026-08-19 prod measurement the sweep has never deleted a row
// (edit_log spanned 93 days against the 180-day retention), so this is a
// shield installed before the hazard goes live, not a repair.
//
// WHAT IS EXEMPT — per verse (row_key = BOOK/chapter/verse/RESOURCE), at
// most two rows outlive the retention window:
//   1. The row today's merge picks as the ancestor: the newest
//      'create'/'update' at/before the same boundary the merge itself cuts
//      on (id boundary when stamped, timestamp watermark otherwise).
//   2. The newest pre-watermark 'baseline' row, by created_at.
//      pipelineImport.ts writes these holding the pre-AI content with
//      created_at deliberately BACK-DATED to that content's own timestamp —
//      which makes them the rows MOST at risk from an age-based sweep (a
//      baseline can be "older than 180 days" the moment it is inserted) —
//      and the #537 corpus inventory found them to be the recoverable
//      ancestor for 186 of the 190 then-unadjudicable verses (recovery plan:
//      docs/sync-attribution-handoff.md, #548). Sheltering them costs at
//      most one row per verse and keeps that plan viable. Bounded by
//      created_at, never id: a back-dated row's id is not chronological
//      with its content.
//
// Everything else older than the cutoff is deleted exactly as before —
// post-watermark rows, books/resources with no watermark at all, and every
// non-verse kind. (The TSV merge also folds edit_log for its ancestors, but
// it is built to degrade gracefully when patches age out — see
// tsvMerge.test.mjs's "create aged out" cases — so it is deliberately not
// exempted here.)
//
// SQL shape notes:
//   - The exempt set is an UNCORRELATED subquery: computed once per sweep,
//     never re-evaluated per candidate row (a correlated NOT EXISTS over the
//     whole table per row is the shape to avoid on D1).
//   - Cost (measured via EXPLAIN QUERY PLAN on the real schema): each branch
//     walks the kind='verse' slice of edit_log via the edit_log_row (kind=…)
//     index, filtering `created_at < ?1` as a residual — so the fixed cost is
//     one index walk of the verse rows, NOT just the deletion candidates. The
//     per-row brs join runs only for rows passing the WHERE (today: zero,
//     since nothing is past retention). At prod's current ~360k rows this is
//     well inside D1's statement budget hourly; if the table grows an order
//     of magnitude, a (kind, action, created_at) index is the cheap fix.
//   - The candidate-scoped filter (`el.created_at < ?1`) can exempt a row
//     that is not the GLOBAL newest-under-boundary (when the true newest is
//     still younger than the cutoff) — a harmless overkeep: the row the
//     merge picks survives either way (young rows are never candidates), and
//     the overkept row is reclaimed by a later sweep once a newer
//     pre-boundary row ages past the cutoff. Exempt survivors themselves
//     remain candidates forever (at most two rows per verse), so the
//     steady-state exempt set is bounded by corpus size, not by time.
//   - The join recovers (book, resource) from row_key by pattern
//     (`BOOK/%/RESOURCE`) — anchored both ends, and book codes / resource
//     names carry no LIKE metacharacters — plus the merge's own book
//     predicate (`book = ?1 OR book IS NULL`): a row whose book column
//     contradicts its row_key is one the merge would skip, so the shield
//     must not exempt it in place of the row the merge would read. NULL-book
//     legacy rows (pre-0017) are accepted by both, deliberately. brs is
//     restricted to the two verse resources; tn/tq/twl watermark rows can
//     never match a verse row_key anyway.
//   - The NOT IN list is NULL-free (no NULL-poisoning of the outer
//     predicate): MAX(el.id) over a group is never NULL, and the baseline
//     branch selects a concrete el.id.
//   - The baseline branch leans on SQLite's bare-column-with-MAX guarantee
//     (the ungrouped el.id comes from a row where MAX(el.created_at)
//     occurs) — D1 is SQLite, where that behavior is documented.

export const EDIT_LOG_RETENTION_SECONDS = 180 * 86400;

// ?1 — the retention cutoff as unix seconds; rows strictly older are
// deletion candidates. Bound once by the caller (index.ts computes
// now - EDIT_LOG_RETENTION_SECONDS) so the outer DELETE and the exempt
// subquery are guaranteed to cut at the same instant.
export const EDIT_LOG_SWEEP_SQL = `
  DELETE FROM edit_log
   WHERE created_at < ?1
     AND id NOT IN (
       SELECT keep_id FROM (
         -- (1) today's merge ancestor: newest surviving 'create'/'update' at
         -- or before the precise id boundary, or before the timestamp
         -- watermark while master_confirmed_edit_id is still warming up —
         -- the exact cut bookReimport.ts's base_payload sub-select makes.
         SELECT MAX(el.id) AS keep_id
           FROM edit_log el
           JOIN book_resource_syncs brs
             ON el.row_key LIKE brs.book || '/%/' || upper(brs.resource)
            AND (el.book = brs.book OR el.book IS NULL)
            AND brs.resource IN ('ult', 'ust')
          WHERE el.kind = 'verse'
            AND el.action IN ('create', 'update')
            AND el.created_at < ?1
            AND ((brs.master_confirmed_edit_id IS NOT NULL
                    AND el.id <= brs.master_confirmed_edit_id)
              OR (brs.master_confirmed_edit_id IS NULL
                    AND brs.master_confirmed_at IS NOT NULL
                    AND el.created_at < brs.master_confirmed_at))
          GROUP BY el.row_key
         UNION ALL
         -- (2) the newest pre-watermark 'baseline' payload, by content time
         -- (created_at is back-dated on these; id order means nothing).
         SELECT keep_id FROM (
           SELECT el.id AS keep_id, MAX(el.created_at)
             FROM edit_log el
             JOIN book_resource_syncs brs
               ON el.row_key LIKE brs.book || '/%/' || upper(brs.resource)
              AND (el.book = brs.book OR el.book IS NULL)
              AND brs.resource IN ('ult', 'ust')
            WHERE el.kind = 'verse'
              AND el.action = 'baseline'
              AND el.created_at < ?1
              AND brs.master_confirmed_at IS NOT NULL
              AND el.created_at < brs.master_confirmed_at
            GROUP BY el.row_key
         )
       )
     )`;
