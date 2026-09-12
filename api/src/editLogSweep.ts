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

// ---------------------------------------------------------------------------
// Issue #573 part 1 (kept per #611, recovered from the closed PR #594): alarm
// on a stalling master-confirmed boundary.
//
// This is a SEPARATE concern from everything above. The WHAT IS EXEMPT
// shields (items 1-8) are what actually keep a stalled boundary's rows
// recoverable — that is the reason this file exists, and they cover both of
// the merge inputs a stall could otherwise starve (latest_source,
// human_edit_after_export) plus the pending-ancestor action classes. Being
// shielded is not the same as being healthy, though: a `master_confirmed_at`
// that stops advancing means a book+resource's export is STUCK — a lock, a
// jammed `-be-` branch, a published/frozen book — and nothing shielded here
// tells anyone that is happening. Concrete precedent that stalls persist for
// months without anyone noticing: STATE.md's JER ULT export blocked since
// 2026-07-31, and docs/triggered-export-merge.md's NUM ult/ust unmerged since
// June 6. This alarm exists to close that visibility gap. It shields no rows
// and changes no merge behavior; it only warns a human that the boundary has
// stopped moving, while there is still runway before EDIT_LOG_SWEEP_SQL's
// retention window would start to bite.

import type { Env } from "./index";
import { planSystemAlertWrites, type ExistingAlertState } from "./verseMergeEditorAlerts.ts";

// How much runway to alarm with, ahead of the point a stalled boundary's
// own age would put it at risk from EDIT_LOG_SWEEP_SQL (i.e. before ANY row
// created right at the boundary would already be old enough to sweep). Two
// weeks is enough time for someone to notice the alert, diagnose why a
// book+resource's export stopped advancing master_confirmed_at (a lock, a
// stuck `-be-` branch, a published/frozen book), and fix it — while staying
// well clear of 0 days' notice.
export const EDIT_LOG_SWEEP_ALARM_MARGIN_SECONDS = 14 * 86400;

// The admin target for this alarm — same fixed username every other
// non-per-user system alert in this codebase uses (verseMergeConflicts.ts's
// ALERT_USERNAME, bookReimport.ts's OWN_PUBLISH_ALERT_USERNAME). A local
// copy rather than an import for the same reason those two give: each file
// that needs it is owned by a potentially-concurrent change, so importing
// across them just to save one string invites an unrelated merge conflict.
const ALARM_ALERT_USERNAME = "deferredreward";

// Every alert this alarm writes shares this source prefix (see
// raiseEditLogSweepBoundaryAlerts for why the whole prefix, not just one
// exact source, is cleared each run).
const ALARM_SOURCE_PREFIX = "edit_log_sweep_boundary_stale";

function alarmSource(book: string, resource: string): string {
  return `${ALARM_SOURCE_PREFIX}:${book}:${resource}`;
}

// The exact SQL text for finding at-risk boundaries, exported (not just used
// inline below) so editLogSweep.test.mjs can run this literal query against
// real SQLite — same "export the exact query" reasoning EDIT_LOG_SWEEP_SQL
// itself documents at the top of this file.
//
// ?1 — the alarm threshold as unix seconds: a book+resource alarms once its
// master_confirmed_at is older than this. Bound once by the caller as
// `now - (EDIT_LOG_RETENTION_SECONDS - EDIT_LOG_SWEEP_ALARM_MARGIN_SECONDS)`
// — i.e. EDIT_LOG_SWEEP_ALARM_MARGIN_SECONDS of runway before the boundary's
// own age would reach EDIT_LOG_RETENTION_SECONDS. Scoped to 'ult'/'ust' —
// the only resources the verse merge (and therefore human_edit_after_export
// / latest_source) ever reads; tn/tq/twl watermark rows are irrelevant here.
export const EDIT_LOG_SWEEP_ALARM_QUERY_SQL = `
  SELECT book, resource, master_confirmed_at
    FROM book_resource_syncs
   WHERE resource IN ('ult', 'ust')
     AND master_confirmed_at IS NOT NULL
     AND master_confirmed_at < ?1
   ORDER BY master_confirmed_at ASC`;

export interface StaleSweepBoundary {
  book: string;
  resource: string;
  masterConfirmedAt: number;
  /** Whole days of runway left before the boundary's age reaches EDIT_LOG_RETENTION_SECONDS. Never negative — a boundary already past the retention window clamps to 0 ("no runway left"), not a misleading negative count. */
  daysRemaining: number;
}

// Pure translation of one query row into the alarm's own units, split out
// so the day-math is unit-testable without D1.
export function toStaleSweepBoundary(
  row: { book: string; resource: string; master_confirmed_at: number },
  now: number,
): StaleSweepBoundary {
  const ageSeconds = now - row.master_confirmed_at;
  const remainingSeconds = EDIT_LOG_RETENTION_SECONDS - ageSeconds;
  return {
    book: row.book,
    resource: row.resource,
    masterConfirmedAt: row.master_confirmed_at,
    daysRemaining: Math.max(0, Math.floor(remainingSeconds / 86400)),
  };
}

export async function findStaleSweepBoundaries(env: Env, now: number): Promise<StaleSweepBoundary[]> {
  const threshold = now - (EDIT_LOG_RETENTION_SECONDS - EDIT_LOG_SWEEP_ALARM_MARGIN_SECONDS);
  const rs = await env.DB.prepare(EDIT_LOG_SWEEP_ALARM_QUERY_SQL)
    .bind(threshold)
    .all<{ book: string; resource: string; master_confirmed_at: number }>();
  return (rs.results ?? []).map((r) => toStaleSweepBoundary(r, now));
}

// The message must stay BYTE-STABLE for as long as the condition persists, or
// the dismissal stickiness this alarm reuses planSystemAlertWrites for (see
// that function's header, and the block comment below) is silently defeated:
// its only dismissal shield is an equality test on the message text, so a
// message carrying "hasn't advanced in N day(s)" or "N day(s) of runway left"
// reads as fresh content on the very next daily run — N ticks by one while
// `masterConfirmedAt` does not — and a dismissed alert gets reinserted
// undismissed alongside its dismissed copy every single day until the boundary
// heals.
//
// Both facts are therefore stated as the FIXED dates they derive from.
// `masterConfirmedAt` is frozen while the boundary is stale (that IS the
// staleness condition), so both dates hold still across runs. No information is
// lost: an absolute deadline is what the reader acts on anyway, and elapsed
// days are the difference between the stated date and today.
function boundaryMessage(s: StaleSweepBoundary): string {
  const res = s.resource.toUpperCase();
  const day = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString().slice(0, 10);
  return (
    `Benjamin — ${s.book} ${res}'s master-confirmed export watermark hasn't advanced since ` +
    `${day(s.masterConfirmedAt)}. ` +
    `The edit_log retention sweep (180 days) is heading toward this boundary: once the boundary itself ` +
    `is older than 180 days, a translator's post-boundary edit to ${s.book} ${res} could age out before ` +
    `the nightly Door43 merge ever sees it, and the merge could then silently adopt master over that edit ` +
    `(see issue #573). That boundary passes 180 days on ` +
    `${day(s.masterConfirmedAt + EDIT_LOG_RETENTION_SECONDS)} — after that date the runway is gone. ` +
    `Nothing has been lost yet — this ` +
    `is early warning. Find out why ${s.book} ${res}'s export stopped advancing the watermark (a lock, a ` +
    `stuck -be- branch, a published/frozen book) and unblock it.`
  );
}

// Writes (or refreshes) one system_alerts row per stale book+resource, and
// clears any previously-alerted book+resource that is no longer stale (its
// export got unstuck, or a fresh export re-confirmed the watermark) so the
// alarm doesn't outlive the condition it's reporting.
//
// Unlike every single-source alert helper elsewhere in this codebase
// (postExport.ts, bookReimport.ts's raise*Alert helpers), this alarm can
// name a VARYING SET of sources across runs — a book+resource only has a
// row while it's actually stale — so a plain "delete the one exact source,
// then unconditionally insert" would reintroduce the exact dismissal bug
// verseMergeConflicts.ts's raiseVerseMergeConflictAlert was fixed for
// (2026-08-14 six-angle review, "dismissal stickiness" — see
// verseMergeEditorAlerts.ts's header): every run re-deriving its desired
// state from scratch and unconditionally deleting+reinserting means a human
// who dismisses the alert sees it reappear THE VERY NEXT RUN, because the
// dismissed row is untouched (dismissed_at IS NOT NULL) but a fresh
// undismissed one gets inserted right alongside it regardless. Reusing
// planSystemAlertWrites here (keyed on `source` instead of `username` — the
// function only cares that its map key is a stable identity, not what it
// represents) gets the same fix for free: a dismissed row with
// byte-identical content is left alone, an undismissed row is only
// replaced when its content actually changed, and a source that dropped
// out of `desired` (its boundary healed) has its undismissed row cleared
// while any dismissed copy is kept as history.
//
// Best-effort, like every other alert helper in this codebase: a failure
// here must never break the caller's cron tick.
export async function raiseEditLogSweepBoundaryAlerts(env: Env, now: number = Math.floor(Date.now() / 1000)): Promise<void> {
  try {
    const stale = await findStaleSweepBoundaries(env, now);
    const desired = new Map<string, string>(stale.map((s) => [alarmSource(s.book, s.resource), boundaryMessage(s)]));

    const existingRs = await env.DB.prepare(
      `SELECT source, message, dismissed_at FROM system_alerts
        WHERE username = ?1 AND source LIKE ?2 || ':%'`,
    )
      .bind(ALARM_ALERT_USERNAME, ALARM_SOURCE_PREFIX)
      .all<{ source: string; message: string; dismissed_at: number | null }>();
    const existing = new Map<string, ExistingAlertState>(
      (existingRs.results ?? []).map((r) => [r.source, { message: r.message, dismissedAt: r.dismissed_at }]),
    );

    const { toDelete, toInsert } = planSystemAlertWrites(existing, desired);
    if (toDelete.length === 0 && toInsert.length === 0) return;

    // Fold delete+insert into ONE batch (same reasoning as
    // raiseVerseMergeConflictAlert's own FIX for this exact shape: a
    // transient failure between a bare DELETE and a separate INSERT batch
    // could delete an alert and never replace it).
    const stmts = [
      ...toDelete.map((source) =>
        env.DB
          .prepare(`DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`)
          .bind(ALARM_ALERT_USERNAME, source),
      ),
      ...toInsert.map(({ username: source, message }) =>
        env.DB
          .prepare(
            `INSERT INTO system_alerts (username, severity, source, message, link_url)
             VALUES (?1, 'warning', ?2, ?3, NULL)`,
          )
          .bind(ALARM_ALERT_USERNAME, source, message),
      ),
    ];
    // Small by construction (bounded by book x {ult,ust}, well under 200
    // possible sources total, and only the changed subset lands here), but
    // batch anyway — same discipline every other multi-row writer in this
    // codebase follows (verseMergeConflicts.ts / bookReimport.ts's WRITE_BATCH).
    const WRITE_BATCH = 90;
    for (let i = 0; i < stmts.length; i += WRITE_BATCH) {
      await env.DB.batch(stmts.slice(i, i + WRITE_BATCH));
    }
  } catch (e) {
    console.error("edit_log sweep boundary alarm failed", e instanceof Error ? e.message : String(e));
  }
}
