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
// most two rows outlive the retention window, PLUS up to seven more for the
// #573 pending-ancestor classes (item 3 below):
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
//   3. The newest pre-watermark row of EACH pending-ancestor ACTION CLASS,
//      per verse (issue #573 part 2): 'restore', 'restore_master_verse',
//      'normalize-source-occurrences', 'normalize-align-order',
//      'heal-replacement-chars', 'heal-export-align-loss',
//      'remove-doubled-q1'. docs/sync-attribution-handoff.md (~line 200)
//      flags these as candidate merge-ancestor material — several are
//      precisely "what master last held" records — pending a payload-shape
//      review (#548) that hasn't happened yet. This branch is PURE
//      RETENTION-SIDE INSURANCE: it does not make today's merge treat any
//      of these actions as an ancestor (base_payload in bookReimport.ts
//      still reads only 'create'/'update'/'baseline' — that's #548's call,
//      untouched here) — it only keeps the newest exemplar of each class
//      alive long enough for #548 to look at it before the sweep forecloses
//      the option. Grouped by (row_key, action), not row_key alone: the
//      review needs one example of EVERY class, not just whichever class
//      happens to have the newest row for a given verse. Prod holds 543
//      such rows total (11 restore, 238 restore_master_verse, 115
//      normalize-source-occurrences, 94 normalize-align-order, 69
//      heal-replacement-chars, 12 heal-export-align-loss, ~4
//      remove-doubled-q1 — the last not currently written by any script but
//      still exempted per the issue), so at most seven extra rows per verse
//      is negligible.
//
// WHY (b), NOT (a), FOR THE MERGE'S OTHER TWO INPUTS (issue #573 part 1).
// `applyVerseRows` (bookReimport.ts) reads two more things from edit_log
// besides base_payload: `human_edit_after_export` (an EXISTS over
// post-boundary, source-IS-NULL, non-baseline rows) and `latest_source` (the
// source of the newest create/update at ANY time). Unlike item 1's ancestor
// — one specific, precisely-identified row — the set of rows that could
// someday matter to either of these is UNBOUNDED and only knowable
// retroactively: any post-boundary source-IS-NULL row might someday be the
// "human edit since export" that decides a merge, and the boundary itself
// keeps moving forward every time an export succeeds, so "shield the right
// ones" has no fixed target to freeze. Trying to shield that anyway risks
// two failure modes worse than the one it prevents: silently changing merge
// semantics (a shielded row surviving past its natural lifetime can start
// being read as evidence in a merge nobody re-examined), or growing the
// exempt set without bound as more edits accumulate behind a stalled
// boundary. Both inputs go blind only when a book+resource's watermark
// (`master_confirmed_at`) itself stalls for 180 days — a locked/published
// book whose export never advances it is the concrete case — which is
// exactly the kind of thing a human should be told about and asked to fix
// (unblock the export, or otherwise re-confirm the watermark) BEFORE any
// data is at risk, not something this code should try to silently paper
// over by guessing which rows matter. So issue #573 takes the loud,
// human-actionable path: `raiseEditLogSweepBoundaryAlerts` below alarms on
// any book+resource whose boundary is aging toward the 180-day cutoff, with
// enough runway (`EDIT_LOG_SWEEP_ALARM_MARGIN_SECONDS`) for someone to
// intervene — e.g. by getting that book's export unstuck — before the sweep
// could ever touch a row `human_edit_after_export` or `latest_source` would
// have needed. This is a deliberate accept-and-alarm decision, not a gap:
// nothing has been lost the day this alarm first fires (severity 'warning',
// not 'error'), and the measured baseline (2026-08-19: edit_log spans 93
// days, well under the 166-day alarm threshold) means it starts silent.
//
// Everything else older than the cutoff is deleted exactly as before —
// post-watermark rows, books/resources with no watermark at all, every
// non-verse kind, and every verse-kind action not covered by items 1-3
// above. (The TSV merge also folds edit_log for its ancestors, but it is
// built to degrade gracefully when patches age out — see tsvMerge.test.mjs's
// "create aged out" cases — so it is deliberately not exempted here.)
//
// SQL shape notes:
//   - The exempt set is an UNCORRELATED subquery: computed once per sweep,
//     never re-evaluated per candidate row (a correlated NOT EXISTS over the
//     whole table per row is the shape to avoid on D1).
//   - Cost (measured via EXPLAIN QUERY PLAN on the real schema): each of the
//     three branches walks the kind='verse' slice of edit_log via the
//     edit_log_row (kind=…) index, filtering `created_at < ?1` as a residual —
//     so the fixed cost is three index walks of the verse rows (one per
//     branch), NOT just the deletion candidates. The per-row brs join runs
//     only for rows passing the WHERE (today: zero, since nothing is past
//     retention). At prod's current ~360k rows this is well inside D1's
//     statement budget hourly; if the table grows an order of magnitude, a
//     (kind, action, created_at) index is the cheap fix.
//   - The candidate-scoped filter (`el.created_at < ?1`) can exempt a row
//     that is not the GLOBAL newest-under-boundary (when the true newest is
//     still younger than the cutoff) — a harmless overkeep: the row the
//     merge picks survives either way (young rows are never candidates), and
//     the overkept row is reclaimed by a later sweep once a newer
//     pre-boundary row ages past the cutoff. Exempt survivors themselves
//     remain candidates forever (at most two rows per verse from branches
//     1-2, plus up to seven more from branch 3 — one per pending-ancestor
//     action class actually present on that verse), so the steady-state
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
         UNION ALL
         -- (3) issue #573 part 2: the newest pre-watermark row of EACH
         -- pending-ancestor action class, per verse — see this file's header
         -- ("WHAT IS EXEMPT", item 3) for why. Same shape as branch (2)
         -- above (same join, same always-timestamp boundary — none of these
         -- actions carry a chronological id either, so there is no id-boundary
         -- variant to consider), except grouped by (row_key, action) so a
         -- verse with rows in more than one of these classes keeps one
         -- exemplar of EACH, not just whichever is newest overall.
         SELECT keep_id FROM (
           SELECT el.id AS keep_id, MAX(el.created_at)
             FROM edit_log el
             JOIN book_resource_syncs brs
               ON el.row_key LIKE brs.book || '/%/' || upper(brs.resource)
              AND (el.book = brs.book OR el.book IS NULL)
              AND brs.resource IN ('ult', 'ust')
            WHERE el.kind = 'verse'
              AND el.action IN (
                    'restore', 'restore_master_verse', 'normalize-source-occurrences',
                    'normalize-align-order', 'heal-replacement-chars',
                    'heal-export-align-loss', 'remove-doubled-q1'
                  )
              AND el.created_at < ?1
              AND brs.master_confirmed_at IS NOT NULL
              AND el.created_at < brs.master_confirmed_at
            GROUP BY el.row_key, el.action
         )
       )
     )`;

// ---------------------------------------------------------------------------
// Issue #573 part 1: alarm on a stalling master-confirmed boundary. See the
// "WHY (b), NOT (a)" section of the header comment above for the decision
// this implements — no rows are shielded here, only a human is warned.

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
