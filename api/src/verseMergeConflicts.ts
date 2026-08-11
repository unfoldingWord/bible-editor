// Durable record + banner alert for a nightly sync merge that needs human
// review (see verseMerge.ts / bookReimport.ts's applyVerseRows). Backed by
// verse_merge_conflicts (migration 0044), which is per-verse INSERT ... ON
// CONFLICT DO UPDATE — deliberately NOT the replace-all-per-(book,resource)
// pattern alignment_attention/export_reverts use, because a conflict must
// survive until a human resolves it, not just until the next export runs.
// Cleared by verses.ts's PATCH route when a human next saves the conflicting
// verse.
//
// Three action values land here (the migration's own comment only documents
// two — it predates the "adopt" case below, and per this task's ownership
// split that comment/CHECK can't be widened from here; report it instead):
//   'adopt'                  — master moved, we didn't. No human judgment
//                              needed; recorded purely as an audit trail so
//                              every overwrite of human-owned text has a
//                              recovery pointer (the version it replaced).
//   'adopt_conflict'         — both D1 and master moved since the last
//                              published ancestor; master won, and the
//                              overwritten D1 edit may need recovery.
//   'keep_alignment_refused' — adopting master's edit would have lost
//                              alignment on words neither side touched, so D1
//                              was kept instead and a human should look.
// The banner alert (raiseVerseMergeConflictAlert) filters to only the latter
// two — a clean 'adopt' needs nobody's attention, so it stays in the table
// (audit trail) but never in the count a human sees.
//
// overwritten_version is the D1 `verses.version` that was replaced (or, for
// keep_alignment_refused, the version that was NOT overwritten but is flagged
// for review) — the old text is recoverable from that verse's version
// history (GET /api/verses/.../history) at that version.

import { Hono } from "hono";
import type { Env } from "./index";
import { requireAuth } from "./auth";

// Same maintainer the export alerts target (exportWorkflow.ts's
// EXPORT_ALERT_USERNAME) — that file is owned by a concurrent change, so this
// is a local copy rather than an import. Keep in sync if it ever changes.
const ALERT_USERNAME = "deferredreward";

export interface VerseMergeConflictRow {
  chapter: number;
  verse: number;
  action: string;
  reason: string;
  /**
   * The D1 version holding the text this sync replaced — where a human finds it
   * in that verse's version history. Null when nothing was replaced (a refusal
   * kept D1 as-is), so it must never be presented as a recovery pointer then.
   */
  overwrittenVersion: number | null;
  alignment: { beforeAligned: number; afterAligned: number; lostWords: string[] } | null | undefined;
}

const WRITE_BATCH = 90;

// Best-effort, batched per-verse upsert. Returns early (true — nothing failed,
// there was just nothing to do) on an empty list so a quiet sync (the
// overwhelming common case) never touches the table — in particular it never
// erases a still-unresolved conflict from an earlier run.
//
// ON CONFLICT (book, resource, chapter, verse) DO UPDATE, NOT INSERT OR
// REPLACE: a REPLACE deletes-then-reinserts, which mints a new `id` and resets
// `detected_at` on every re-detection of the SAME still-unresolved conflict —
// making "how long has this been sitting unresolved" unrecoverable. The
// DO UPDATE preserves the original `detected_at` (it's simply not in the SET
// list) while still refreshing action/reason/overwritten_version/alignment to
// this run's values.
//
// Returns false (and logs) when the write fails, so a caller can fold that
// into a counter (see bookReimport.ts's ReimportCounts.merge_record_failed)
// instead of an unconditional counter claiming "recorded durably" when it
// wasn't — the honest-return precedent this follows is exportWorkflow.ts's
// recordExportReverts.
export async function recordVerseMergeConflicts(
  env: Env,
  book: string,
  resource: string,
  rows: VerseMergeConflictRow[],
): Promise<boolean> {
  if (rows.length === 0) return true;
  try {
    for (let i = 0; i < rows.length; i += WRITE_BATCH) {
      const slice = rows.slice(i, i + WRITE_BATCH);
      await env.DB.batch(
        slice.map((r) =>
          env.DB.prepare(
            `INSERT INTO verse_merge_conflicts
               (book, resource, chapter, verse, action, reason, overwritten_version, alignment, detected_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, unixepoch())
             ON CONFLICT (book, resource, chapter, verse) DO UPDATE SET
               action = excluded.action,
               reason = excluded.reason,
               overwritten_version = excluded.overwritten_version,
               alignment = excluded.alignment`,
          ).bind(
            book,
            resource,
            r.chapter,
            r.verse,
            r.action,
            r.reason,
            r.overwrittenVersion,
            r.alignment ? JSON.stringify(r.alignment) : null,
          ),
        ),
      );
    }
    return true;
  } catch (e) {
    console.error("verseMergeConflicts: record failed", {
      book,
      resource,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

// Delete conflict rows for adoptions whose version-CAS write did NOT land
// (see bookReimport.ts's applyVerseRows step 6b/7b): the row was written
// speculatively BEFORE the CAS batch so a mid-batch failure can't erase
// evidence of an overwrite that DID happen, but once the write is confirmed
// lost (a human wrote the verse first), nothing was overwritten and the row
// would misdirect a reviewer to a version that still holds their current
// text. Scoped to action IN ('adopt', 'adopt_conflict') — a
// 'keep_alignment_refused' row never attempts a write, so it is never a
// candidate for this cleanup. Best-effort: a delete failure just leaves a
// spurious flag (the documented failure-mode inversion this whole ordering
// exists to produce), never a silently lost one.
export async function deleteLostAdoptionConflicts(
  env: Env,
  book: string,
  resource: string,
  refs: Array<{ chapter: number; verse: number }>,
): Promise<void> {
  if (refs.length === 0) return;
  try {
    for (let i = 0; i < refs.length; i += WRITE_BATCH) {
      const slice = refs.slice(i, i + WRITE_BATCH);
      await env.DB.batch(
        slice.map((r) =>
          env.DB.prepare(
            `DELETE FROM verse_merge_conflicts
              WHERE book = ?1 AND resource = ?2 AND chapter = ?3 AND verse = ?4
                AND action IN ('adopt', 'adopt_conflict')`,
          ).bind(book, resource, r.chapter, r.verse),
        ),
      );
    }
  } catch (e) {
    console.error("verseMergeConflicts: delete-lost-adoption failed", {
      book,
      resource,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

interface StoredConflictRow {
  chapter: number;
  verse: number;
  action: string;
  reason: string;
  overwritten_version: number | null;
  alignment: string | null;
}

// Banner alert (system_alerts) naming the count, the reason breakdown, and
// the first 10 refs, plus the plain-English recovery hint. Same shape as
// ExportWorkflow.writeAlert (delete-undismissed-then-insert), best-effort.
//
// FIX 4: fires once per (book, resource) for a WHOLE run (see the call sites
// in bookReimport.ts's runReimport / runChunkedReimport — never per-chapter,
// which used to let chapter N's DELETE-then-INSERT erase chapter N-1's
// alert). Content is derived by reading verse_merge_conflicts directly — the
// single source of truth — rather than taking rows as a parameter, so it is
// inherently book-wide and also reports conflicts that survived from an
// earlier run. Filtered to 'adopt_conflict' | 'keep_alignment_refused' only:
// a clean 'adopt' needs no human judgment (see this file's header), and a
// 174-verse 1CH-scale event would otherwise produce a 174-item banner.
export async function raiseVerseMergeConflictAlert(
  env: Env,
  book: string,
  resource: string,
  // FIX G: `noBaseCount` — this run's tally of `keep_no_base` verses (the
  // ancestor aged past edit_log's 180-day sweep, so attribution was
  // impossible and D1 was kept, same as before verseMerge.ts existed).
  // Threaded through the same way `recordingFailed` is: the caller reads it
  // off perResource[resource].merge_no_base (bookReimport.ts) and passes it
  // here so the ONE place a human sees this table's story can say so.
  opts: { recordingFailed?: boolean; noBaseCount?: number } = {},
): Promise<void> {
  const source = `verse_merge_conflict:${book}:${resource}`;
  // FIX E: this read must not be able to fail the whole reimport. It used to
  // sit outside any try/catch, so a table-missing error (e.g. an unmigrated
  // deploy) would propagate out of this best-effort alert helper and fail a
  // user-triggered re-import after real work had already landed. Log and
  // return — same fail-open discipline as every other D1 call in this file.
  let rs: { results?: StoredConflictRow[] };
  try {
    rs = await env.DB.prepare(
      `SELECT chapter, verse, action, reason, overwritten_version, alignment
         FROM verse_merge_conflicts
        WHERE book = ?1 AND resource = ?2 AND action IN ('adopt_conflict', 'keep_alignment_refused')
        ORDER BY chapter ASC, verse ASC`,
    )
      .bind(book, resource)
      .all<StoredConflictRow>();
  } catch (e) {
    console.error("verseMergeConflicts: alert read failed", {
      book,
      resource,
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  const rows: VerseMergeConflictRow[] = (rs.results ?? []).map((r) => {
    let alignment: VerseMergeConflictRow["alignment"] = null;
    if (r.alignment) {
      try {
        alignment = JSON.parse(r.alignment);
      } catch {
        alignment = null; // a malformed stored value must not break the alert
      }
    }
    return {
      chapter: r.chapter,
      verse: r.verse,
      action: r.action,
      reason: r.reason,
      overwrittenVersion: r.overwritten_version,
      alignment,
    };
  });

  // FIX 5: a recording failure this run means the table (and therefore this
  // query) may be missing rows — say so explicitly rather than silently
  // treating "recording failed" the same as "nothing to report". Still write
  // the alert even when rows.length is 0 in this case: an undercounted 0 is
  // not the same claim as a genuinely clean run.
  // FIX G: same reasoning for `noBaseCount` — a `keep_no_base` verse is
  // counted but lives in no table row (nothing WAS adjudicated, so there is
  // nothing to record) and appeared in no alert before this fix. Clearing
  // the banner on a "0 conflict rows" run would erase the one place a human
  // could learn that tonight's export will still overwrite those verses.
  if (rows.length === 0 && !opts.recordingFailed && !opts.noBaseCount) {
    try {
      await env.DB.prepare(`DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`)
        .bind(ALERT_USERNAME, source)
        .run();
    } catch (e) {
      console.error("verseMergeConflicts: alert clear failed", {
        book,
        resource,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return;
  }

  const reasonCounts = new Map<string, number>();
  for (const r of rows) reasonCounts.set(r.reason, (reasonCounts.get(r.reason) ?? 0) + 1);
  const reasonBreakdown = [...reasonCounts.entries()].map(([reason, n]) => `${n} ${reason}`).join(", ") || "none";
  // FIX 6: include the version in each listed ref (e.g. "12:4@v7") so the
  // recovery instruction below is self-sufficient instead of pointing at "the
  // version number recorded for it" without ever stating one.
  const refs = rows
    .slice(0, 10)
    .map((r) => `${r.chapter}:${r.verse}${r.overwrittenVersion != null ? `@v${r.overwrittenVersion}` : ""}`)
    .join(", ");
  const more = rows.length > 10 ? `; +${rows.length - 10} more` : "";
  // The two outcomes need different instructions, so say which is which rather
  // than emitting one hint that is wrong for half the rows.
  const overwritten = rows.filter((r) => r.overwrittenVersion != null).length;
  const kept = rows.length - overwritten;
  const guidance = [
    overwritten > 0
      ? `${overwritten} took Door43's version over the editor's — the replaced text is still in that verse's ` +
        `version history, at the version number given after @v in its ref above.`
      : "",
    kept > 0
      ? `${kept} kept the editor's version because adopting Door43's would have cost alignment — Door43's ` +
        `change has NOT been taken, so tonight's export will still write over it until someone resolves it.`
      : "",
    opts.recordingFailed
      ? "NOTE: at least one merge-conflict recording failed to write to verse_merge_conflicts this run " +
        "(see worker logs) — this table and count may be missing rows from tonight's sync."
      : "",
    // FIX G: keep_no_base verses could not be adjudicated at all (their
    // edit_log history aged past the 180-day retention sweep, so no ancestor
    // is recoverable) — they behave exactly like the original 1CH bug: a
    // Door43-side change to them is silently overwritten by tonight's
    // export, with no per-verse row to point at because nothing was ever
    // attributable.
    opts.noBaseCount
      ? `${opts.noBaseCount} verse(s) could not be adjudicated because their edit history has aged out (no ` +
        `recoverable ancestor) — a Door43-side change to them will still be overwritten by tonight's export.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const refsClause = rows.length > 0 ? ` Refs: ${refs}${more}.` : "";
  // FIX I: this fires from both the nightly cron and the user-triggered
  // POST /:book/reimport route (runReimport calls this too), so "Nightly
  // sync" overclaimed the trigger on the latter — say "sync" without a
  // schedule. It also used to assert "Door43 and the editor both changed"
  // unconditionally, which is only true for the `both_changed` reason; a
  // `keep_alignment_refused` row can carry reason `unparseable` (one side
  // simply failed to parse — we don't know whether both sides changed) or
  // `alignment_shrink` (master changed, D1 didn't). Drop the blanket claim;
  // reasonBreakdown plus the per-outcome `guidance` below already say what
  // was actually measured for each row.
  const message =
    `Sync flagged ${rows.length} verse(s) in ${book} ${resource.toUpperCase()} for review ` +
    `(${reasonBreakdown}).${refsClause} ${guidance}`;
  try {
    await env.DB.prepare(`DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`)
      .bind(ALERT_USERNAME, source)
      .run();
    await env.DB.prepare(
      `INSERT INTO system_alerts (username, severity, source, message, link_url)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(ALERT_USERNAME, "warning", source, message, null)
      .run();
  } catch (e) {
    console.error("verseMergeConflicts: alert write failed", {
      book,
      resource,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

interface VerseMergeConflictRecord {
  resource: string;
  chapter: number;
  verse: number;
  action: string;
  reason: string;
  overwritten_version: number | null;
  alignment: string | null;
}

export const verseMergeConflicts = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string };
}>();

verseMergeConflicts.use("*", requireAuth);

// GET /api/verse-merge-conflicts/:book — the read side, so this table isn't
// write-only like export_reverts. Modelled on alignmentAttention.ts.
verseMergeConflicts.get("/:book", async (c) => {
  const book = c.req.param("book");
  // resource is part of the key — a book carries independent ULT and UST
  // conflicts, and omitting it would make the two indistinguishable.
  const rs = await c.env.DB.prepare(
    `SELECT resource, chapter, verse, action, reason, overwritten_version, alignment
       FROM verse_merge_conflicts
      WHERE book = ?1
      ORDER BY chapter ASC, verse ASC, resource ASC`,
  )
    .bind(book)
    .all<VerseMergeConflictRecord>();
  const conflicts = (rs.results ?? []).map((r) => {
    let alignment: unknown = null;
    if (r.alignment) {
      try {
        alignment = JSON.parse(r.alignment);
      } catch {
        // A malformed alignment value must not break the whole endpoint.
        alignment = null;
      }
    }
    return {
      resource: r.resource,
      chapter: r.chapter,
      verse: r.verse,
      action: r.action,
      reason: r.reason,
      overwrittenVersion: r.overwritten_version,
      alignment,
    };
  });
  return c.json({ conflicts });
});
