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
// Branch (6) is the tn/tq/twl half, added by #653 — same hazard, different
// table: a TSV row whose create is its only recoverable ancestor loses that
// ancestor to age and becomes permanently unadjudicable.
//
// WHAT IS EXEMPT — per verse (row_key = BOOK/chapter/verse/RESOURCE), at
// most seven rows outlive the retention window:
//   1. The row today's merge picks as the ancestor: the newest
//      'create'/'update'/'bridge'/'split' at/before the same boundary the
//      merge itself cuts on (id boundary when stamped, timestamp watermark
//      otherwise). 'bridge'/'split' joined this list with issue #727 (PR
//      #731), when bookReimport.ts's base_payload sub-select started reading
//      them as content-bearing ancestor candidates.
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
//   3. issue #573 gap 1a — the GLOBAL newest 'create'/'update' row per verse,
//      with no boundary at all. bookReimport.ts's `latest_source` sub-select
//      reads exactly this row (no time filter). Without this exemption, once
//      every post-boundary create/update ages out, `latest_source` silently
//      falls back to (1)'s ancestor — which can be AI-authored — and a
//      verse a translator genuinely last touched can reclassify as
//      AI-reseedable.
//   4. issue #573 gap 1b — the newest POST-boundary row per verse with
//      `source IS NULL AND action <> 'baseline'`. bookReimport.ts's
//      `human_edit_after_export` probe is an EXISTS over exactly this set;
//      once every such row ages out (only reachable if a book/resource's
//      export boundary itself has stalled past 180 days — e.g. a locked or
//      published book that never re-exports) the EXISTS silently flips from
//      true to false, and a later reimport can read an undo-redo verse as
//      unedited-since-export and adopt master over it.
//   5. issue #573 gap 2 — the newest pre-watermark row per verse per action,
//      for each of #548's other candidate merge-ancestor action classes
//      (`restore`, `restore_master_verse`, `normalize-source-occurrences`,
//      `normalize-align-order`, `heal-replacement-chars`,
//      `heal-export-align-loss`, `remove-doubled-q1` — 543 rows corpus-wide
//      as of 2026-08-20). None of these is wired into the merge as an
//      ancestor yet — #548's payload-shape review of them is still open —
//      but exempting them from an irreversible DELETE now is cheap (at most
//      one row per verse per action present) and preserves the option;
//      deleting first and reviewing later would not.
//   7. issue #727/#728 (PR #731 review) — the GLOBAL newest 'bridge'/'split'
//      row per verse, no boundary. The reimport now reads this row in four
//      places: bookReimport.ts's `latest_source` (ownership — a human
//      bridging an AI-drafted verse takes it over), `structural_edit_id` /
//      `structural_edit_at` (verseStructure.ts's planner classifies a
//      bridge as LOCAL iff the newest structural row on its start key is
//      above the export boundary), the `start_before` ancestor fallback for
//      a bootstrap-imported start verse, and base_payload via (1). Without
//      this branch the reviewer's reproduction holds: an AI 'update' then a
//      human 'bridge', both exported and aged out — (1)/(3) keep the AI row,
//      (4) keeps nothing (the bridge is under the boundary), the bridge is
//      deleted, `latest_source` reads `ai_pipeline`, and the human-owned
//      bridge enters the wholesale AI-reseed path. The stalled-boundary
//      variant misclassifies instead: a local bridge followed by a local
//      content edit loses its 'bridge' row (the 'update' is (4)'s newest
//      human row), the planner reads the structure as exported, and master's
//      un-bridged shape is adopted over the translator's bridge.
//   8. issue #727 — the GLOBAL newest 'delete' row per verse, no boundary AND
//      no watermark join. Two readers: (a) verseBridge.ts's
//      verseVersionFloorSql takes MAX(COALESCE(new_version, prev_version))
//      over ALL of a key's rows so a recreated verse is minted strictly above
//      any version a stale `If-Match` could hold; a bootstrap-imported verse
//      absorbed by a bridge has a delete-only history (the import writes no
//      audit rows), so sweeping that one row collapses the floor to 0 and the
//      reimport's floor-0 INSERT re-mints version 1 — the exact hole #727
//      closed. (b) bookReimport.ts's master_moved_under_local_bridge check
//      reads the newest 'delete' payload (`{content, absorbed_into}`) as the
//      absorbed verse's ancestor. Both the bridge route's human delete
//      (source NULL) and step 7s's reimport delete (source 'dcs_reimport')
//      have this shape. No watermark join because (a) is a CAS-safety
//      invariant that does not depend on the book ever having exported, and
//      a delete row's prev_version is by construction >= every new_version
//      of the life it closed, so this one row carries the whole floor.
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
//     Re-measured after #603's ROW_NUMBER() fix: branches (2) and (5) still
//     walk the same edit_log_row (kind=…) index feeding the window sort, so
//     the added cost is a TEMP B-TREE sort of that same already-small row
//     set — not a new full-table pass.
//   - The candidate-scoped filter (`el.created_at < ?1`) can exempt a row
//     that is not the GLOBAL newest-under-boundary (when the true newest is
//     still younger than the cutoff) — a harmless overkeep: the row the
//     merge picks survives either way (young rows are never candidates), and
//     the overkept row is reclaimed by a later sweep once a newer
//     pre-boundary row ages past the cutoff. Exempt survivors themselves
//     remain candidates forever (at most seven rows per verse: ancestor,
//     baseline, global-newest-source, newest-post-boundary-human-edit,
//     newest-structural-edit, newest-delete, and one per #548
//     candidate-ancestor action class actually present), so the steady-state
//     exempt set is bounded by corpus size, not by time.
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
//   - Branches (2) and (5) break created_at ties on id (ROW_NUMBER() ...
//     ORDER BY created_at DESC, id DESC), matching bookReimport.ts's
//     base_payload order (`created_at DESC, id DESC`) — see issue #603. A
//     bare column beside MAX(created_at) picks from *a* row holding the
//     max, arbitrary on a tie; edit_log.created_at is whole seconds
//     (unixepoch()), so same-second writes of the same (row_key[, action])
//     are representable and did tie in practice (repair scripts emit one
//     row per verse from a single per-run timestamp constant, but two
//     scripts can race the same second).

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
         -- (1) today's merge ancestor: newest surviving
         -- 'create'/'update'/'bridge'/'split' at or before the precise id
         -- boundary, or before the timestamp watermark while
         -- master_confirmed_edit_id is still warming up — the exact action
         -- list and cut bookReimport.ts's base_payload sub-select makes
         -- (issue #727 added 'bridge'/'split' there).
         SELECT MAX(el.id) AS keep_id
           FROM edit_log el
           JOIN book_resource_syncs brs
             ON el.row_key LIKE brs.book || '/%/' || upper(brs.resource)
            AND (el.book = brs.book OR el.book IS NULL)
            AND brs.resource IN ('ult', 'ust')
          WHERE el.kind = 'verse'
            AND el.action IN ('create', 'update', 'bridge', 'split')
            AND el.created_at < ?1
            AND ((brs.master_confirmed_edit_id IS NOT NULL
                    AND el.id <= brs.master_confirmed_edit_id)
              OR (brs.master_confirmed_edit_id IS NULL
                    AND brs.master_confirmed_at IS NOT NULL
                    AND el.created_at < brs.master_confirmed_at))
          GROUP BY el.row_key
         UNION ALL
         -- (2) the newest pre-watermark 'baseline' payload, by content time
         -- (created_at is back-dated on these; id order only breaks ties
         -- within the same content second — see issue #603).
         SELECT keep_id FROM (
           SELECT el.id AS keep_id,
                  ROW_NUMBER() OVER (
                    PARTITION BY el.row_key
                    ORDER BY el.created_at DESC, el.id DESC
                  ) AS rn
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
         )
         WHERE rn = 1
         UNION ALL
         -- (3) issue #573 gap 1a: the GLOBAL newest 'create'/'update' row per
         -- verse, no boundary — protects bookReimport.ts's latest_source,
         -- which reads this row unconditionally. Still requires a watermark
         -- to exist (same as (1)/(2)): a book/resource that has never
         -- exported gets no shield at all, matching the rest of this file.
         SELECT MAX(el.id) AS keep_id
           FROM edit_log el
           JOIN book_resource_syncs brs
             ON el.row_key LIKE brs.book || '/%/' || upper(brs.resource)
            AND (el.book = brs.book OR el.book IS NULL)
            AND brs.resource IN ('ult', 'ust')
          WHERE el.kind = 'verse'
            AND el.action IN ('create', 'update')
            AND el.created_at < ?1
            AND (brs.master_confirmed_edit_id IS NOT NULL OR brs.master_confirmed_at IS NOT NULL)
          GROUP BY el.row_key
         UNION ALL
         -- (4) issue #573 gap 1b: the newest POST-boundary row per verse with
         -- source IS NULL and action <> 'baseline' — protects
         -- bookReimport.ts's human_edit_after_export EXISTS probe. Mirrors
         -- (1)'s boundary but inverted (id >, not id <=).
         SELECT MAX(el.id) AS keep_id
           FROM edit_log el
           JOIN book_resource_syncs brs
             ON el.row_key LIKE brs.book || '/%/' || upper(brs.resource)
            AND (el.book = brs.book OR el.book IS NULL)
            AND brs.resource IN ('ult', 'ust')
          WHERE el.kind = 'verse'
            AND el.source IS NULL
            AND el.action <> 'baseline'
            AND el.created_at < ?1
            AND ((brs.master_confirmed_edit_id IS NOT NULL
                    AND el.id > brs.master_confirmed_edit_id)
              OR (brs.master_confirmed_edit_id IS NULL
                    AND brs.master_confirmed_at IS NOT NULL
                    AND el.created_at >= brs.master_confirmed_at))
          GROUP BY el.row_key
         UNION ALL
         -- (5) issue #573 gap 2: the newest pre-watermark row per verse per
         -- action, for #548's other not-yet-wired candidate-ancestor action
         -- classes. Same shape as (2), partitioned by (row_key, action)
         -- instead of row_key alone so each present action class gets its
         -- own kept row rather than competing with the others.
         SELECT keep_id FROM (
           SELECT el.id AS keep_id,
                  ROW_NUMBER() OVER (
                    PARTITION BY el.row_key, el.action
                    ORDER BY el.created_at DESC, el.id DESC
                  ) AS rn
             FROM edit_log el
             JOIN book_resource_syncs brs
               ON el.row_key LIKE brs.book || '/%/' || upper(brs.resource)
              AND (el.book = brs.book OR el.book IS NULL)
              AND brs.resource IN ('ult', 'ust')
            WHERE el.kind = 'verse'
              AND el.action IN ('restore', 'restore_master_verse',
                'normalize-source-occurrences', 'normalize-align-order',
                'heal-replacement-chars', 'heal-export-align-loss',
                'remove-doubled-q1')
              AND el.created_at < ?1
              AND brs.master_confirmed_at IS NOT NULL
              AND el.created_at < brs.master_confirmed_at
         )
         WHERE rn = 1
         UNION ALL
         -- (6) issue #653: the newest book-known 'create' per LIVE tn/tq/twl
         -- row. bookReimport.ts's reconstructTsvBases now falls back to exactly
         -- this row when a row's bounded history is empty — which is the state
         -- of every row created after its book's export boundary froze. Those
         -- are the rows the fallback exists for, and their create is the ONLY
         -- ancestor they have: once it ages out, the row is permanently
         -- unadjudicable again and the recovery silently expires.
         --
         -- Unlike (1)-(5) this needs no watermark join: a TSV row_key is the
         -- row id (not BOOK/ch/verse/RESOURCE), the fold keys on (kind, book,
         -- row_key), and the fallback reads book-known entries only — a
         -- book-NULL row cannot be proven to belong to this row (ids are unique
         -- per (book, id) only) and is skipped by the fold, so sheltering one
         -- would cost a row and buy nothing. Restricted to rows still LIVE in
         -- their table, so a deleted row's history still ages out normally.
         SELECT MAX(el.id) AS keep_id
           FROM edit_log el
          WHERE el.kind IN ('tn', 'tq', 'twl')
            AND el.action = 'create'
            AND el.book IS NOT NULL
            AND el.created_at < ?1
            AND (
              (el.kind = 'tn' AND EXISTS (
                 SELECT 1 FROM tn_rows r WHERE r.id = el.row_key AND r.book = el.book AND r.deleted_at IS NULL))
              OR (el.kind = 'tq' AND EXISTS (
                 SELECT 1 FROM tq_rows r WHERE r.id = el.row_key AND r.book = el.book AND r.deleted_at IS NULL))
              OR (el.kind = 'twl' AND EXISTS (
                 SELECT 1 FROM twl_rows r WHERE r.id = el.row_key AND r.book = el.book AND r.deleted_at IS NULL))
            )
          GROUP BY el.kind, el.book, el.row_key
         UNION ALL
         -- (7) issue #727/#728: the GLOBAL newest 'bridge'/'split' row per
         -- verse, no boundary — the row bookReimport.ts reads as
         -- structural_edit_id/structural_edit_at (structure planner), as the
         -- newest content row for latest_source together with (3), and as the
         -- start_before ancestor fallback. Same watermark join as (3): the
         -- planner has no boundary to classify against without one.
         SELECT MAX(el.id) AS keep_id
           FROM edit_log el
           JOIN book_resource_syncs brs
             ON el.row_key LIKE brs.book || '/%/' || upper(brs.resource)
            AND (el.book = brs.book OR el.book IS NULL)
            AND brs.resource IN ('ult', 'ust')
          WHERE el.kind = 'verse'
            AND el.action IN ('bridge', 'split')
            AND el.created_at < ?1
            AND (brs.master_confirmed_edit_id IS NOT NULL OR brs.master_confirmed_at IS NOT NULL)
          GROUP BY el.row_key
         UNION ALL
         -- (8) issue #727: the GLOBAL newest 'delete' row per verse — the
         -- version floor verseVersionFloorSql folds (prev_version of the
         -- absorbed verse; new_version is NULL on these rows) and the absorbed
         -- verse's ancestor for master_moved_under_local_bridge. Deliberately
         -- NO watermark join: the floor is a CAS-safety invariant on every
         -- recreation path, exported book or not, and the row_key alone
         -- identifies the verse. Bounded at one row per verse key ever
         -- deleted.
         SELECT MAX(el.id) AS keep_id
           FROM edit_log el
          WHERE el.kind = 'verse'
            AND el.action = 'delete'
            AND el.created_at < ?1
          GROUP BY el.row_key
       )
     )`;
