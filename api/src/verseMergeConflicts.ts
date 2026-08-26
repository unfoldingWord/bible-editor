// Durable record + banner alert for a nightly sync merge that needs human
// review (see verseMerge.ts / bookReimport.ts's applyVerseRows). Backed by
// verse_merge_conflicts (migration 0044), which is per-verse INSERT ... ON
// CONFLICT DO UPDATE — deliberately NOT the replace-all-per-(book,resource)
// pattern alignment_attention/export_reverts use, because a conflict must
// survive until a human resolves it, not just until the next export runs.
// Marked resolved (resolved_at/resolved_by, migration 0049) by verses.ts's
// PATCH route when a human next saves the conflicting verse — the row itself
// is kept for the audit trail; "active" readers filter WHERE resolved_at IS
// NULL. A SERVER-SIDE re-detection can also reactivate a resolved row, but
// only via the two-phase protocol in recordVerseMergeConflicts /
// confirmAdoptedConflicts below — see UPSERT_VERSE_MERGE_CONFLICT_SQL's doc
// comment in verseMergeConflictSql.ts for why a single eager clear is unsafe.
//
// Three action values land here (the migration's header comment,
// 0044_verse_merge_conflicts.sql, already documents all three — only its
// inline `action`/`reason` COLUMN comments lagged behind and are fixed
// alongside this pass. There is no CHECK constraint on `action`, so a
// future merge outcome doesn't need a migration to become recordable):
//   'adopt'                  — master moved, we didn't. No human judgment
//                              needed; recorded purely as an audit trail so
//                              every overwrite of human-owned text has a
//                              recovery pointer (the version it replaced).
//   'adopt_conflict'         — both D1 and master moved since the last
//                              published ancestor; master won, and the
//                              overwritten D1 edit may need recovery. Reason
//                              may be narrowed to both_changed_wording /
//                              both_changed_alignment / both_changed when the
//                              visible axes actually differ (issue #633).
//   'adopt_no_visible_change'— both sides moved by stableKey, but plain text
//                              and alignment groups match (issue #633). Audit
//                              trail only — excluded from banners like 'adopt'.
//   'keep_alignment_refused' — adopting master's edit would have lost
//                              alignment on words neither side touched, so D1
//                              was kept instead and a human should look.
//   'source_attr_divergent'  — master carries a curated original-language
//                              source fix (x-content/x-lemma/x-morph on a
//                              `\zaln-s` milestone) for a verse a translator
//                              edited, but the same source word repeats in the
//                              verse (e.g. EZK 40's architectural terms) so the
//                              fix can't be placed unambiguously. D1 was kept;
//                              nothing was overwritten (overwritten_version
//                              NULL, like keep_alignment_refused). Surfaced so a
//                              human applies the source fix by hand before the
//                              nightly export reverts it on master. Recorded
//                              from bookReimport.ts's applyVerseRows edited-skip
//                              branch (reconcileSourceAttrsFromMaster's
//                              `divergent` report).
// The banner alert (raiseVerseMergeConflictAlert) filters to only the
// judgement-needed actions — a clean 'adopt' and an 'adopt_no_visible_change'
// need nobody's attention, so they stay in the table (audit trail) but never
// in the count a human sees.
//
// overwritten_version is the D1 `verses.version` that was replaced — the old
// text is recoverable from that verse's version history
// (GET /api/verses/.../history) at that version. It is **NULL for
// keep_alignment_refused**, because a refusal replaced nothing; presenting a
// pointer there would send a reviewer to text that was never overwritten.
// The upsert below enforces that invariant even when a row changes action
// between nights.

import { Hono } from "hono";
import type { Env } from "./index";
import { requireAuth } from "./auth";
import {
  alertMessageCarriesNoBaseWarning,
  buildEditorLookupQuery,
  buildGroupedRefsClause,
  buildMergeConflictGuidance,
  EDITOR_LOOKUP_CHUNK,
  groupNoBaseVersesByEditor,
  groupOverwrittenVersesByEditor,
  planSystemAlertWrites,
  type NoBaseVerseRef,
  type OverwrittenVerseRef,
} from "./verseMergeEditorAlerts.ts";
import {
  CONFIRM_ADOPTED_CONFLICT_SQL,
  DELETE_LOST_ADOPTION_CONFLICT_SQL,
  CLEAR_CONFLICT_ONLY_ALERTS_BY_SOURCE_SQL,
  CLEAR_CONFLICT_ONLY_ALERTS_BY_USER_SQL,
  SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL,
  UPSERT_VERSE_MERGE_CONFLICT_SQL,
} from "./verseMergeConflictSql.ts";

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
  /**
   * The verse's D1 `version` at the moment this row's action was detected
   * (bookReimport.ts's `ex.version`, read earlier in the same applyVerseRows
   * call). Used ONLY by the 'source_attr_divergent' / 'keep_alignment_refused'
   * reactivation carve-out (see UPSERT_VERSE_MERGE_CONFLICT_SQL) to withhold
   * reactivation when the verse changed between that read and this upsert
   * (issue #507) — irrelevant, and safely ignored, for every other action.
   * NULL falls back to the pre-#507 unconditional-reactivation behavior.
   */
  observedVersion: number | null;
  /**
   * `verse_merge_conflicts.detected_at` — the durable "first flagged" date
   * (issue #624), preserved across re-detections of the SAME still-unresolved
   * conflict by the upsert's ON CONFLICT DO UPDATE (see that statement's doc
   * comment). Optional: only populated on the ALERT READ path
   * (raiseVerseMergeConflictAlert), where it comes back from D1. It is not
   * read off THIS field on the write path: recordVerseMergeConflicts binds the
   * run's own timestamp into detected_at itself (`?9` in
   * UPSERT_VERSE_MERGE_CONFLICT_SQL, so one run stamps one value across every
   * row it inserts, rather than each row taking its own `unixepoch()`). So
   * this field stays absent on that path rather than forcing every writer to
   * pass a value the statement would ignore.
   */
  detectedAt?: number | null;
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
// list). It does NOT blindly refresh the other columns to this run's values —
// see the CASE expressions below, which refuse to downgrade a row still
// awaiting human judgement and keep `overwritten_version` consistent with the
// surviving action.
//
// Returns false (and logs) when the write fails, so a caller can fold that
// into a counter (see bookReimport.ts's ReimportCounts.merge_record_failed)
// instead of an unconditional counter claiming "recorded durably" when it
// wasn't — the honest-return precedent this follows is exportWorkflow.ts's
// recordExportReverts.
//
// SPECULATIVE half of two-phase reactivation (see
// UPSERT_VERSE_MERGE_CONFLICT_SQL's doc comment for the full "why" — this
// upsert runs BEFORE the master-adoption CAS batch even attempts its write,
// so it must never assume the write will land). It does NOT clear
// resolved_at/resolved_by — only confirmAdoptedConflicts (below), called
// after the CAS batch confirms which adoptions actually landed, does that.
//
// `now` is the caller's own Date.now()-derived timestamp (bookReimport.ts
// already computes one per applyVerseRows call) — bound as detected_at's
// value on INSERT and as last_recorded_at's value on every write, so
// deleteLostAdoptionConflicts (called later in the same run) can match rows
// touched by THIS run's speculative write by exact equality on
// last_recorded_at.
export async function recordVerseMergeConflicts(
  env: Env,
  book: string,
  resource: string,
  bibleVersion: string,
  rows: VerseMergeConflictRow[],
  now: number,
): Promise<boolean> {
  if (rows.length === 0) return true;
  try {
    for (let i = 0; i < rows.length; i += WRITE_BATCH) {
      const slice = rows.slice(i, i + WRITE_BATCH);
      await env.DB.batch(
        slice.map((r) =>
          env.DB.prepare(UPSERT_VERSE_MERGE_CONFLICT_SQL).bind(
            book,
            resource,
            r.chapter,
            r.verse,
            r.action,
            r.reason,
            r.overwrittenVersion,
            r.alignment ? JSON.stringify(r.alignment) : null,
            now,
            bibleVersion,
            r.observedVersion,
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

// CONFIRMING half of two-phase reactivation. Call this ONLY with refs whose
// master-adoption CAS write actually LANDED (bookReimport.ts's
// `landedAdoptions` / `adoptionsApplied`, computed after the CAS batch) —
// this is the ONLY place resolved_at/resolved_by are cleared for an
// adoption, and it is deliberately a SEPARATE step from the speculative
// upsert above so a lost CAS race never reactivates anything (see
// CONFIRM_ADOPTED_CONFLICT_SQL's doc comment). Best-effort: a failure here
// just leaves a row that stays resolved/dormant one run longer than it
// should — never a false-positive reactivation, which is the failure mode
// this two-phase split exists to prevent.
export async function confirmAdoptedConflicts(
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
        slice.map((r) => env.DB.prepare(CONFIRM_ADOPTED_CONFLICT_SQL).bind(book, resource, r.chapter, r.verse)),
      );
    }
  } catch (e) {
    console.error("verseMergeConflicts: confirm-adopted failed", {
      book,
      resource,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// Delete conflict rows for adoptions whose version-CAS write did NOT land
// (see bookReimport.ts's applyVerseRows step 6b/7b): the row was written
// speculatively BEFORE the CAS batch so a mid-batch failure can't erase
// evidence of an overwrite that DID happen, but once the write is confirmed
// lost (a human wrote the verse first), nothing was overwritten and the row
// would misdirect a reviewer to a version that still holds their current
// text. Best-effort: a delete failure just leaves a spurious flag (the
// documented failure-mode inversion this whole ordering exists to produce),
// never a silently lost one.
//
// `now` MUST be the exact same timestamp passed to this run's
// recordVerseMergeConflicts call (bookReimport.ts already computes one `now`
// per applyVerseRows invocation and reuses it for both) — see
// DELETE_LOST_ADOPTION_CONFLICT_SQL's doc comment for why this scoping
// (on last_recorded_at, not detected_at) exists: it protects a row's prior
// resolution (from an earlier night) from being wholesale deleted just
// because THIS run's separate speculative write happened to lose its CAS
// race, while still deleting a row that is provably this run's own
// speculative write and nothing else.
export async function deleteLostAdoptionConflicts(
  env: Env,
  book: string,
  resource: string,
  refs: Array<{ chapter: number; verse: number }>,
  now: number,
): Promise<void> {
  if (refs.length === 0) return;
  try {
    for (let i = 0; i < refs.length; i += WRITE_BATCH) {
      const slice = refs.slice(i, i + WRITE_BATCH);
      await env.DB.batch(
        slice.map((r) =>
          env.DB.prepare(DELETE_LOST_ADOPTION_CONFLICT_SQL).bind(book, resource, r.chapter, r.verse, now),
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
  detected_at: number;
}

// ---------------------------------------------------------------------------
// Editor fan-out (2026-08-14 prod audit fix). Until now the banner alert only
// ever reached ALERT_USERNAME (the admin) — all 19 live conflict alerts
// landed there and none reached the editors whose work was actually
// overwritten (bethoakes, pjoakes, Carolyn1970, Grant_Ailie…). An
// 'adopt_conflict' row means Door43's version replaced a human edit; this
// attributes the overwrite to the human who made that edit — the edit_log
// row that produced `overwritten_version` — and gives them their own alert,
// in addition to (not instead of) the admin's. The pure grouping logic lives
// in verseMergeEditorAlerts.ts (unit-tested there without D1); this is just
// the D1 orchestration around it.
// ---------------------------------------------------------------------------

// D1 orchestration: one JOIN query PER CHUNK of the run's overwrites — never
// N+1 per verse, but chunked at EDITOR_LOOKUP_CHUNK because D1 caps a
// prepared statement at 100 bind variables and this query binds `book` plus
// one key per verse. A "1CH-scale" run (this codebase's own history has one
// at 174 verses) would otherwise throw on the very run this fix exists for.
// Best-effort per chunk: a failure here must not affect the admin alert or
// the caller's control flow (mirrors every other read in this file).
async function lookupEditorUsernames(
  env: Env,
  book: string,
  resource: string,
  overwritten: OverwrittenVerseRef[],
): Promise<Map<string, string>> {
  const usernameByKey = new Map<string, string>();
  for (let i = 0; i < overwritten.length; i += EDITOR_LOOKUP_CHUNK) {
    const chunk = overwritten.slice(i, i + EDITOR_LOOKUP_CHUNK);
    const { sql, keys } = buildEditorLookupQuery(book, resource, chunk);
    try {
      const rs = await env.DB.prepare(sql)
        .bind(book, ...keys)
        .all<{ key: string; username: string }>();
      for (const r of rs.results ?? []) usernameByKey.set(r.key, r.username);
    } catch (e) {
      console.error("verseMergeConflicts: editor lookup failed", {
        book,
        resource,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return usernameByKey;
}

// Shared statement builder for "clear an UNDISMISSED alert" — the one
// invariant every clear in this function must respect: a dismissed row is
// never touched, or dismissing would be pointless (it would just come back
// undismissed on the next run). Parameterized by an optional `username` so
// the same helper covers both shapes this function needs: clearing every
// username at once for this source (nothing left to report — see the
// early-return branch below) and clearing one specific username (the
// per-user replan below, via planSystemAlertWrites).
function clearUndismissedAlertsStmt(env: Env, source: string, username?: string): D1PreparedStatement {
  if (username != null) {
    return env.DB.prepare(
      `DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
    ).bind(username, source);
  }
  return env.DB.prepare(`DELETE FROM system_alerts WHERE source = ?1 AND dismissed_at IS NULL`).bind(source);
}

// Issue #626: raiseVerseMergeConflictAlert only reruns from a reimport (the
// nightly cron or a user-triggered POST /:book/reimport), so a banner it
// wrote stays frozen at that run's content until the next one — up to a
// night, longer if the freshness gate skips that (book, resource). Meanwhile
// resolved_at is set independently, by verses.ts's PATCH route the moment a
// human re-saves the flagged verse. Nothing in between rewrote the banner,
// so it kept naming verses a human had already fixed — exactly when someone
// working the list was most likely to look at it.
//
// Called from verses.ts after a save resolves a conflict row, this clears
// the (book, resource) banner ONLY when that resolve was the LAST active
// alertable conflict outstanding — otherwise it leaves the banner alone.
// That is deliberate, not a shortcut: the caller here knows about the ONE
// verse it just resolved, not the resource's full remaining set, so
// rewriting the message from that single fact would risk trading a
// merely-stale count for an actively WRONG one (e.g. dropping a reason from
// the parenthetical breakdown that still has other rows). A partially-stale
// banner self-heals on the next sync; a fabricated count does not.
//
// keep_no_base is a second outstanding condition that lives ONLY in the
// banner message (noBaseCount at raise time — no verse_merge_conflicts row).
// Clearing by "zero active table rows" would erase that warning while the
// no-ancestor verses are still at risk of being overwritten on the next
// export. Per-username: drop conflict-only alerts; preserve any whose
// message still carries the keep_no_base fingerprint.
//
// Best-effort, like every other alert write in this file — called from
// waitUntil after the save has already landed, so a failure here must never
// surface as a save error.
export async function clearResolvedConflictBannerIfLast(env: Env, book: string, resource: string): Promise<void> {
  const source = `verse_merge_conflict:${book}:${resource}`;
  try {
    const rs = await env.DB.prepare(SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL).bind(book, resource).all();
    if ((rs.results?.length ?? 0) > 0) return; // other conflicts still outstanding — leave the banner for the next sync
    const alerts = await env.DB.prepare(
      `SELECT username, message FROM system_alerts WHERE source = ?1 AND dismissed_at IS NULL`,
    )
      .bind(source)
      .all<{ username: string; message: string }>();
    const toClear = (alerts.results ?? []).filter((a) => !alertMessageCarriesNoBaseWarning(a.message));
    if (toClear.length === 0) return; // nothing undismissed, or every row still carries keep_no_base
    // Prefer one source-wide clear when every undismissed row is conflict-only
    // (the common case). Fall back to per-username when a keep_no_base row
    // must stay. Both statements re-check "no active alertable conflicts"
    // inside the DELETE — see the constants' header for the reimport race that
    // guard closes. NOT clearUndismissedAlertsStmt: its other two call sites
    // are the raise/replan path, which deletes-then-reinserts precisely WHILE
    // conflicts are active, so the guard would make them no-ops.
    if (toClear.length === (alerts.results?.length ?? 0)) {
      await env.DB.prepare(CLEAR_CONFLICT_ONLY_ALERTS_BY_SOURCE_SQL).bind(source, book, resource).run();
      return;
    }
    for (const a of toClear) {
      await env.DB.prepare(CLEAR_CONFLICT_ONLY_ALERTS_BY_USER_SQL).bind(a.username, source, book, resource).run();
    }
  } catch (e) {
    console.error("verseMergeConflicts: resolved-banner clear failed", {
      book,
      resource,
      error: e instanceof Error ? e.message : String(e),
    });
  }
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
  // FIX G: `noBaseCount` — this run's tally of `keep_no_base` verses (no
  // ancestor survived from before the master-confirmed watermark, so
  // attribution was impossible and D1 was kept, same as before verseMerge.ts
  // existed). Threaded through the same way `recordingFailed` is: the caller
  // reads it off perResource[resource].merge_no_base (bookReimport.ts) and
  // passes it here so the ONE place a human sees this table's story can say so.
  // `noBaseRefs` (issue #537) is the matching capped sample of `chapter:verse`
  // refs — the count alone named no verse a human could go look at.
  // `noBaseEditorRefs` (issue #544) is the UNCAPPED list of the same verses,
  // each carrying its current D1 version so groupNoBaseVersesByEditor can
  // attribute it to the human who last edited it and give THEM their own
  // notice too — until this fix that warning reached only ALERT_USERNAME.
  opts: {
    recordingFailed?: boolean;
    noBaseCount?: number;
    noBaseRefs?: string[];
    noBaseEditorRefs?: NoBaseVerseRef[];
  } = {},
): Promise<void> {
  const source = `verse_merge_conflict:${book}:${resource}`;
  // FIX E: this read must not be able to fail the whole reimport. It used to
  // sit outside any try/catch, so a table-missing error (e.g. an unmigrated
  // deploy) would propagate out of this best-effort alert helper and fail a
  // user-triggered re-import after real work had already landed. Log and
  // return — same fail-open discipline as every other D1 call in this file.
  let rs: { results?: StoredConflictRow[] };
  try {
    rs = await env.DB.prepare(SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL)
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
      // This row is being read for display (the banner alert), not written —
      // observedVersion only matters to recordVerseMergeConflicts's writer.
      observedVersion: null,
      detectedAt: r.detected_at,
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
      // Clear by SOURCE, not just the admin's username: a still-undismissed
      // editor alert from an earlier run (see the editor fan-out below) named
      // by this same source must also disappear once this book+resource has
      // nothing left to report, or it would sit stale forever.
      await clearUndismissedAlertsStmt(env, source).run();
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
  // Per-outcome guidance, classified by ACTION (never by the nullable
  // overwritten_version pointer) — see buildMergeConflictGuidance. Pulled into
  // that pure helper so the three-way overwritten / kept-alignment /
  // kept-source-attr split is unit-testable without an Env, and so a refusal or
  // a source-attr divergence can never be miscounted as an overwrite.
  const guidance = buildMergeConflictGuidance(rows, {
    recordingFailed: opts.recordingFailed,
    noBaseCount: opts.noBaseCount,
    noBaseRefs: opts.noBaseRefs,
  });
  // Issue #624: each ref grouped under its own reason, each group carrying
  // the oldest detected_at in that reason as a plain "first flagged" date —
  // see buildGroupedRefsClause's header for why (the old flat "Refs: a, b,
  // c" left every ref unjoined to the reason it was flagged for). Includes
  // the version in each ref (e.g. "12:4@v7", FIX 6) so the recovery
  // instruction in `guidance` is self-sufficient.
  const refsClause = buildGroupedRefsClause(rows);
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
  // FIX 8: when there are zero adjudicated rows but noBaseCount > 0, the old
  // wording read "Sync flagged 0 verse(s) ... for review (none)." immediately
  // followed by guidance's "N verse(s) could not be adjudicated..." — the
  // lead sentence's "(none)" directly contradicted the sentence right after
  // it. Drop the now-meaningless reason breakdown when there's nothing to
  // break down, so the lead sentence says only what's true (0 adjudicated
  // conflicts) and lets `guidance` carry the noBaseCount story without
  // sounding like it's disagreeing with the sentence before it.
  const message =
    rows.length === 0
      ? `Sync flagged 0 verse(s) in ${book} ${resource.toUpperCase()} for adjudicated review.${guidance ? ` ${guidance}` : ""}`
      : `Sync flagged ${rows.length} verse(s) in ${book} ${resource.toUpperCase()} for review ` +
        `(${reasonBreakdown}).${refsClause} ${guidance}`;

  // Editor fan-out: attribute each 'adopt_conflict' overwrite to the human
  // whose edit it replaced (see this file's header block above) and give
  // them their own alert. `keep_alignment_refused` is excluded — a refusal
  // overwrote nothing, so there is no editor to notify.
  const overwrittenRefs: OverwrittenVerseRef[] = rows
    .filter(
      (r): r is VerseMergeConflictRow & { overwrittenVersion: number } =>
        r.action === "adopt_conflict" && r.overwrittenVersion != null,
    )
    .map((r) => ({
      chapter: r.chapter,
      verse: r.verse,
      overwrittenVersion: r.overwrittenVersion,
      reason: r.reason,
    }));
  // keep_no_base verses (issue #544): NOTHING was overwritten, but the same
  // human needs the same warning the admin gets — see groupNoBaseVersesByEditor's
  // header comment for why this reuses the overwritten-lookup machinery keyed
  // on the verse's CURRENT version rather than a replaced one. Folded into ONE
  // lookupEditorUsernames call with overwrittenRefs (rather than a second D1
  // round trip) — same chunking, same subrequest-budget discipline as the rest
  // of this file.
  const noBaseEditorRefs = opts.noBaseEditorRefs ?? [];
  const noBaseLookupRefs: OverwrittenVerseRef[] = noBaseEditorRefs.map((r) => ({
    chapter: r.chapter,
    verse: r.verse,
    overwrittenVersion: r.version,
  }));
  const usernameByKey = await lookupEditorUsernames(env, book, resource, [...overwrittenRefs, ...noBaseLookupRefs]);
  const perEditor = groupOverwrittenVersesByEditor(book, resource, overwrittenRefs, usernameByKey);
  const perEditorNoBase = groupNoBaseVersesByEditor(book, resource, noBaseEditorRefs, usernameByKey);

  // Combine per-editor content: an editor can appear in BOTH maps in the same
  // run (an overwritten verse elsewhere in the book, plus a keep_no_base verse
  // of their own) — system_alerts holds one row per (username, source), so
  // their two messages are concatenated rather than one clobbering the other.
  const editorMessages = new Map<string, string>();
  for (const [username, editor] of perEditor) editorMessages.set(username, editor.message);
  for (const [username, editor] of perEditorNoBase) {
    const existing = editorMessages.get(username);
    editorMessages.set(username, existing ? `${existing} ${editor.message}` : editor.message);
  }

  // The full desired state for this source: the admin's summary plus one
  // entry per affected editor.
  const desired = new Map<string, string>([[ALERT_USERNAME, message], ...editorMessages.entries()]);

  try {
    // Read the CURRENT state for this exact source (every username, any
    // dismissal state) so planSystemAlertWrites can tell "identical content
    // already dismissed — leave it" apart from "stale or changed — rewrite
    // it". Without this read, every run unconditionally deletes+reinserts,
    // which is exactly what made a dismissed alert reappear the very next
    // run (six-angle review DEFECT: "dismissal stickiness").
    const existingRs = await env.DB.prepare(
      `SELECT username, message, dismissed_at FROM system_alerts WHERE source = ?1`,
    )
      .bind(source)
      .all<{ username: string; message: string; dismissed_at: number | null }>();
    const existing = new Map(
      (existingRs.results ?? []).map((r) => [r.username, { message: r.message, dismissedAt: r.dismissed_at }]),
    );
    const { toDelete, toInsert } = planSystemAlertWrites(existing, desired);

    // FIX (six-angle review, item 5): fold every delete and insert this run
    // needs into ONE batch (chunked at WRITE_BATCH, same as every other
    // multi-row write in this file) instead of one bare DELETE followed by a
    // separate INSERT batch — the old two-call shape meant a transient
    // failure between them could delete an alert and never replace it.
    const stmts = [
      ...toDelete.map((username) => clearUndismissedAlertsStmt(env, source, username)),
      ...toInsert.map(({ username, message: msg }) =>
        env.DB
          .prepare(
            `INSERT INTO system_alerts (username, severity, source, message, link_url)
             VALUES (?1, ?2, ?3, ?4, ?5)`,
          )
          .bind(username, "warning", source, msg, null),
      ),
    ];
    for (let i = 0; i < stmts.length; i += WRITE_BATCH) {
      await env.DB.batch(stmts.slice(i, i + WRITE_BATCH));
    }
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
  detected_at: number;
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
  // resolved_at IS NULL: a verse a human has already re-saved (see verses.ts's
  // PATCH route) is no longer an ACTIVE conflict needing review — it stays in
  // the table for the audit trail (see the resolved_at column comment in
  // migration 0049) but must not keep showing up here as outstanding.
  const rs = await c.env.DB.prepare(
    `SELECT resource, chapter, verse, action, reason, overwritten_version, alignment, detected_at
       FROM verse_merge_conflicts
      WHERE book = ?1 AND resolved_at IS NULL
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
      // Issue #624: the durable "first flagged" date (never reset by
      // re-detection of the same still-unresolved conflict — see
      // VerseMergeConflictRow.detectedAt's doc comment), so the in-app
      // merge-review banner can show it per verse without a prod D1 query.
      detectedAt: r.detected_at,
    };
  });
  return c.json({ conflicts });
});
