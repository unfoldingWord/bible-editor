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
//                              is narrowed to an explicit combination of
//                              wording / punctuation / alignment axes when
//                              those visible axes actually differ (issues
//                              #633 / #788). Legacy both_changed remains
//                              readable as wording + alignment; punctuation is
//                              claimed only by the new explicit reasons.
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
// 'keep_ai_master' (#540 item 2) used to land here as a sixth action — both
// sides moved, but a COMPLETE lineage walk found no Door43 editor's commit
// behind master's, so the app edit won. Issue #749 stopped recording it: it
// takes nothing from Door43 and the next export publishes the kept version, so
// there was nothing for the banner to ask of anyone, yet the row sat there until
// a human edited or dismissed the verse. bookReimport.ts no longer pushes it and
// retireVerseKeptAiMasterFlags (below) retires the standing rows. This mirrors
// #703, which retired the TSV side's `merge_kept` review flag for the same
// outcome.
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
import { effectiveBookLock } from "./bookLock.ts";
import {
  alertMessageCarriesNoBaseWarning,
  buildEditorLookupQuery,
  buildGroupedRefsClause,
  buildMergeConflictGuidance,
  EDITOR_LOOKUP_CHUNK,
  groupNoBaseVersesByEditor,
  groupOverwrittenVersesByEditor,
  type NoBaseVerseRef,
  type OverwrittenVerseRef,
} from "./verseMergeEditorAlerts.ts";
import {
  CONFIRM_ADOPTED_CONFLICT_SQL,
  DELETE_LOST_ADOPTION_CONFLICT_SQL,
  CLEAR_CONFLICT_ONLY_ALERTS_BY_SOURCE_SQL,
  CLEAR_CONFLICT_ONLY_ALERTS_BY_USER_SQL,
  RESOLVE_CONFLICT_ONLY_ALERTS_BY_SOURCE_SQL,
  RESOLVE_CONFLICT_ONLY_ALERTS_BY_USER_SQL,
  RESOLVE_CONVERGED_VERSE_MERGE_CONFLICT_SQL,
  RESTORE_LOST_ADOPTION_CONFLICT_SQL,
  RETIRE_KEPT_AI_MASTER_CONFLICTS_FOR_PAIR_SQL,
  SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL,
  SELECT_PRIOR_VERSE_MERGE_CONFLICTS_SQL,
  SELECT_STANDING_KEPT_AI_MASTER_CONFLICT_PAIRS_SQL,
  UPSERT_VERSE_MERGE_CONFLICT_SQL,
} from "./verseMergeConflictSql.ts";
import {
  activeReviewAlertUsernames,
  reconcileReviewAlert,
  resolveReviewAlert,
  reviewConditionKey,
  reviewConditionState,
  verseMergeEditorConditionKey,
} from "./reviewAlerts.ts";

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
   * comment). It is reset to the run's timestamp in exactly two cases: a
   * resolved row reactivated by a landed overwrite (CONFIRM_ADOPTED_CONFLICT_SQL,
   * issue #996), and an unresolved audit-only row ('adopt' /
   * 'adopt_no_visible_change') promoted to adopt_conflict (the upsert, issue
   * #1124). Both start a new streak nobody has been alerted about. Optional: only populated on the ALERT READ path
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

/**
 * Issue #1132: a verse_merge_conflicts row as it stood just before a
 * speculative upsert touched it (SELECT_PRIOR_VERSE_MERGE_CONFLICTS_SQL).
 * `alignment` is the stored JSON text, put back byte for byte.
 */
export interface PriorVerseMergeConflict {
  chapter: number;
  verse: number;
  action: string;
  reason: string;
  overwritten_version: number | null;
  alignment: string | null;
  detected_at: number;
  last_recorded_at: number | null;
  recorded_generation: number;
}

/** "chapter:verse" → the prior row, or null when the upsert created it. */
export type PriorVerseMergeConflicts = Map<string, PriorVerseMergeConflict | null>;

const conflictRefKey = (chapter: number, verse: number): string => `${chapter}:${verse}`;

// Best-effort, batched per-verse upsert. Returns early (true — nothing failed,
// there was just nothing to do) on an empty list so a quiet sync (the
// overwhelming common case) never touches the table — in particular it never
// erases a still-unresolved conflict from an earlier run.
//
// ON CONFLICT (book, resource, chapter, verse) DO UPDATE, NOT INSERT OR
// REPLACE: a REPLACE deletes-then-reinserts, which mints a new `id` and resets
// `detected_at` on every re-detection of the SAME still-unresolved conflict —
// making "how long has this been sitting unresolved" unrecoverable. The
// DO UPDATE preserves the original `detected_at` (its SET keeps the stored
// value, except for an unresolved audit-only row promoted to adopt_conflict,
// issue #1124). It does NOT blindly refresh the other columns to this run's values —
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
//
// Issue #1132: pass `prior` to capture each touched row's state from just
// before its upsert, for deleteLostAdoptionConflicts to put back on a lost
// race. The capture is a SELECT at the head of each slice's batch(), so it is
// atomic with the upserts and costs no extra subrequest (91 statements per
// batch, under D1's 100). A ref maps to its prior row, or to null when the
// upsert created it. A ref already in the map keeps its first capture. A ref
// is left out when its slice failed or the batch returned no rows for the
// SELECT, and the cleanup then falls back to the plain delete.
export async function recordVerseMergeConflicts(
  env: Env,
  book: string,
  resource: string,
  bibleVersion: string,
  rows: VerseMergeConflictRow[],
  now: number,
  prior?: PriorVerseMergeConflicts,
): Promise<boolean> {
  if (rows.length === 0) return true;
  // A ref listed twice gets two upserts (two generation bumps), so the
  // restore's `prior + 1` guard could never match it. bookReimport.ts keeps
  // content and structure flags on disjoint verses, so this should not occur;
  // if it does, the ref is left out of `prior` and the cleanup uses the delete.
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const r of rows) {
    const k = conflictRefKey(r.chapter, r.verse);
    if (seen.has(k)) repeated.add(k);
    seen.add(k);
  }
  if (prior && repeated.size > 0) {
    console.warn("verseMergeConflicts: ref recorded twice in one call; its lost-race cleanup will delete, not restore", {
      book, resource, refs: [...repeated],
    });
  }
  try {
    for (let i = 0; i < rows.length; i += WRITE_BATCH) {
      const slice = rows.slice(i, i + WRITE_BATCH);
      const capture = prior
        ? [env.DB.prepare(SELECT_PRIOR_VERSE_MERGE_CONFLICTS_SQL)
            .bind(book, resource, JSON.stringify(slice.map((r) => conflictRefKey(r.chapter, r.verse))))]
        : [];
      const results = await env.DB.batch([
        ...capture,
        ...slice.map((r) =>
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
      ]);
      const captured = prior ? (results[0] as D1Result<PriorVerseMergeConflict> | undefined)?.results : undefined;
      if (prior && Array.isArray(captured)) {
        const found = new Map(captured.map((p) => [conflictRefKey(p.chapter, p.verse), p]));
        for (const r of slice) {
          const k = conflictRefKey(r.chapter, r.verse);
          if (!prior.has(k) && !repeated.has(k)) prior.set(k, found.get(k) ?? null);
        }
      }
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
//
// `now` is this run's timestamp (the same one recordVerseMergeConflicts got):
// a row reactivated from resolved takes it as its new detected_at (issue #996),
// and each ref's overwrittenVersion / alignment as its new recovery pointer and
// snapshot (issue #1112). See CONFIRM_ADOPTED_CONFLICT_SQL.
export async function confirmAdoptedConflicts(
  env: Env,
  book: string,
  resource: string,
  refs: Array<Pick<VerseMergeConflictRow, "chapter" | "verse" | "overwrittenVersion" | "alignment">>,
  now: number,
): Promise<void> {
  if (refs.length === 0) return;
  try {
    for (let i = 0; i < refs.length; i += WRITE_BATCH) {
      const slice = refs.slice(i, i + WRITE_BATCH);
      await env.DB.batch(
        slice.map((r) =>
          env.DB.prepare(CONFIRM_ADOPTED_CONFLICT_SQL).bind(
            book,
            resource,
            r.chapter,
            r.verse,
            now,
            r.overwrittenVersion,
            r.alignment ? JSON.stringify(r.alignment) : null,
          ),
        ),
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
//
// Issue #1132: with `prior` (the map recordVerseMergeConflicts filled in the
// same run), a row that existed before tonight's upsert is RESTORED to that
// state (RESTORE_LOST_ADOPTION_CONFLICT_SQL) instead of deleted, so an earlier
// night's unreviewed alert survives a lost race and a resolved row does not
// keep tonight's pointer. Only a row this run created (prior null) is deleted.
//
// `runStartedAt` (seconds) is when this logical run began, stable across
// Workflow step retries. A captured row whose last_recorded_at is at or after
// it was written earlier in THIS run, by an attempt that died after its upsert
// and before its CAS, so the capture holds that attempt's speculative state,
// not the real prior one. Restoring it would keep tonight's unlanded pointer,
// so such a row (and a ref with no capture at all) gets the plain delete, the
// pre-#1132 behavior. Defaults to `now`: a caller with no retries has no
// earlier attempt to account for.
export async function deleteLostAdoptionConflicts(
  env: Env,
  book: string,
  resource: string,
  refs: Array<{ chapter: number; verse: number }>,
  now: number,
  prior?: PriorVerseMergeConflicts,
  runStartedAt: number = now,
): Promise<void> {
  if (refs.length === 0) return;
  try {
    for (let i = 0; i < refs.length; i += WRITE_BATCH) {
      const slice = refs.slice(i, i + WRITE_BATCH);
      await env.DB.batch(
        slice.map((r) => {
          const p = prior?.get(conflictRefKey(r.chapter, r.verse));
          if (p && (p.last_recorded_at == null || p.last_recorded_at < runStartedAt)) {
            return env.DB.prepare(RESTORE_LOST_ADOPTION_CONFLICT_SQL).bind(
              book, resource, r.chapter, r.verse, now, p.recorded_generation,
              p.action, p.reason, p.overwritten_version, p.alignment, p.detected_at, p.last_recorded_at,
            );
          }
          return env.DB.prepare(DELETE_LOST_ADOPTION_CONFLICT_SQL).bind(book, resource, r.chapter, r.verse, now);
        }),
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

// Issue #789. Called from bookReimport.ts's applyVerseRows once per call,
// with the (chapter, verse) refs THIS run measured as `keep_converged` /
// `keep_master_unchanged` for this (book, resource) — computeVerseMerge's two
// clean outcomes, which never mint or re-record a verse_merge_conflicts row
// (see RESOLVE_CONVERGED_VERSE_MERGE_CONFLICT_SQL's doc comment). Resolving
// these INSIDE the same run that measured the convergence, rather than a
// periodic sweep like retireVerseKeptAiMasterFlags below, means the banner
// clears on the very next reimport instead of waiting for a separate sweep to
// notice.
//
// Reads this (book, resource)'s open backlog of the three kept-D1 actions
// ONCE — the same SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL
// raiseVerseMergeConflictAlert derives the banner from, so "is there anything
// to resolve" costs one cheap, indexed read regardless of how many verses
// converged this call — and intersects it against `convergedRefs` in memory,
// so the UPDATE below only ever runs for a verse ACTUALLY carrying an open
// row. Deliberately NOT one speculative UPDATE per converged verse: on a
// typical night the vast majority of a book's verses are
// keep_converged/keep_master_unchanged (nothing changed), and firing a no-op
// write per verse would spend D1 subrequests for nothing (see WRITE_BATCH's
// header on the nightly-sync subrequest cap this file and bookReimport.ts
// both guard).
//
// Best-effort, like every other write in this file — a failure here must
// never fail the reimport that measured the convergence; the next run's
// backlog read just finds the same standing rows and tries again.
export async function resolveConvergedVerseMergeConflicts(
  env: Env,
  book: string,
  resource: string,
  convergedRefs: Array<{ chapter: number; verse: number }>,
): Promise<{ resolved: number }> {
  if (convergedRefs.length === 0) return { resolved: 0 };
  try {
    const rs = await env.DB.prepare(SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL)
      .bind(book, resource)
      .all<{ chapter: number; verse: number; action: string; recorded_generation: number }>();
    const backlog = new Map(
      (rs.results ?? [])
        .filter(
          (r) =>
            r.action === "keep_alignment_refused" ||
            r.action === "source_attr_divergent" ||
            r.action === "keep_local_structure",
        )
        .map((r) => [
          `${r.chapter}:${r.verse}`,
          { action: r.action, generation: Number(r.recorded_generation ?? 0) },
        ] as const),
    );
    if (backlog.size === 0) return { resolved: 0 };
    const toResolve = convergedRefs
      .map((r) => ({ ...r, conflict: backlog.get(`${r.chapter}:${r.verse}`) }))
      .filter((r): r is typeof r & { conflict: { action: string; generation: number } } => r.conflict != null);
    if (toResolve.length === 0) return { resolved: 0 };
    const now = Math.floor(Date.now() / 1000);
    let resolved = 0;
    for (let i = 0; i < toResolve.length; i += WRITE_BATCH) {
      const slice = toResolve.slice(i, i + WRITE_BATCH);
      const results = await env.DB.batch(
        slice.map((r) =>
          env.DB.prepare(RESOLVE_CONVERGED_VERSE_MERGE_CONFLICT_SQL).bind(
            now, book, resource, r.chapter, r.verse, r.conflict.action, r.conflict.generation,
          ),
        ),
      );
      for (const r of results) resolved += r?.meta?.changes ?? 0;
    }
    if (resolved > 0) {
      // Same shape as #760: retiring rows alone leaves the MATERIALIZED
      // system_alerts banner stale until raiseVerseMergeConflictAlert next
      // re-derives it — this re-checks (inside its own DELETE) whether any
      // OTHER alertable conflict still justifies the banner before clearing.
      await clearResolvedConflictBannerIfLast(env, book, resource);
      console.log("verse merge conflict(s) resolved on convergence", { book, resource, resolved });
    }
    return { resolved };
  } catch (e) {
    console.error("verseMergeConflicts: resolve-on-convergence failed", {
      book,
      resource,
      error: e instanceof Error ? e.message : String(e),
    });
    return { resolved: 0 };
  }
}

// A SHA-unchanged resource normally never reaches applyVerseRows. An active
// kept-D1 backlog is the narrow exception: #789 must remeasure those verses or
// rows created before the fix can remain active forever behind the fast path.
// Let query failures throw so the Workflow retries instead of treating an
// unreadable backlog as empty and silently skipping it.
export async function activeKeptVerseMergeConflictRefs(
  env: Env,
  book: string,
  resource: string,
): Promise<Array<{ chapter: number; verse: number }>> {
  const rs = await env.DB.prepare(SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL)
    .bind(book, resource)
    .all<{ chapter: number; verse: number; action: string }>();
  return (rs.results ?? [])
    .filter(
      (r) =>
        r.action === "keep_alignment_refused" ||
        r.action === "source_attr_divergent" ||
        r.action === "keep_local_structure",
    )
    .map((r) => ({ chapter: Number(r.chapter), verse: Number(r.verse) }));
}

// Issue #749, the verse analogue of bookReimport.ts's retireMergeKeptFlags
// (#703). Retires every STANDING 'keep_ai_master' row so the "Sync flagged N
// verse(s)" banner stops carrying an outcome nobody can act on: nothing was
// taken from Door43, and the next export publishes the kept version. The action
// is no longer recorded at all (see applyVerseRows), so what this clears is pure
// backlog — prod on 2026-09-09 held 37 such rows across EZK ULT/UST and JER ULT,
// the oldest standing three weeks.
//
// D1-only, no Door43 walk: every row this touches was minted on a COMPLETE
// lineage walk that found no Door43 editor's commit behind master's side, so the
// mint itself was the measurement that justifies the clear (the same argument
// retireMergeKeptFlags rests on).
//
// One statement, no batching — see RETIRE_KEPT_AI_MASTER_CONFLICTS_SQL for why
// that is enough here and why, unlike the TSV side, no separate audit-log row is
// written: the retired row survives with `resolved_at` set and `resolved_by`
// NULL, and that pair IS the audit trail (a human resolve always carries a
// non-null resolved_by).
//
// Issue #760 (#754 P1 follow-up): retiring the ROWS is not enough — the
// "Sync flagged N verse(s)" banner is a MATERIALIZED system_alerts row, only
// re-derived by raiseVerseMergeConflictAlert, which this sweep does not call
// (it runs for every (book, resource) pair, including ones this run never
// reimported and whose Door43 SHA is unchanged). Left alone, a resource whose
// only standing conflicts were keep_ai_master keeps its banner up forever
// even though nothing behind it is actionable anymore. So: read the distinct
// (book, resource) pairs this retire is about to touch BEFORE the UPDATE,
// then run clearResolvedConflictBannerIfLast for each — it re-checks (inside
// its own DELETE) whether any OTHER alertable conflict still justifies the
// banner, so a pair that also carries a live adopt_conflict/
// keep_alignment_refused/source_attr_divergent/keep_local_structure row, or a
// keep_no_base warning, correctly keeps its banner up.
//
// Best-effort, like every other write in this file — EXCEPT for the pair
// lookup below, which must fail CLOSED rather than open (Codex review on
// #761). The rows-vs-banner ordering the rest of this function relies on
// (read the pairs, THEN retire) is unrecoverable if it runs backwards: the
// retire UPDATE stamps resolved_at on every standing row, and the pairs
// SELECT filters resolved_at IS NULL — so a transient failure that let the
// UPDATE run anyway with an empty pairs list would retire the rows, skip
// their banner clears, and then never find those (now-resolved) rows again
// on any later night. That reproduces the exact #760 symptom, permanently.
// So: if the lookup itself fails, stop before the UPDATE runs at all — the
// rows stay standing, and the NEXT sweep retries the whole thing (lookup +
// retire + clear) against them, same as if nothing had happened tonight.
//
// Each pair's scoped retire and its banner clears then commit as ONE atomic D1
// batch PER PAIR (see the body): all-or-nothing per pair, so a failure leaves
// that pair's rows STANDING and it retries next sweep rather than stranding a
// resolved row whose banner never came down. Per pair, not one global batch, so
// the statement count stays under D1's 100-per-batch cap however large the
// backlog grows. Still non-fatal to the export that follows — a thrown batch is
// caught and logged per pair, not rethrown. Idempotent — a night with nothing
// standing reads zero pairs, retires nothing, clears nothing.
export async function retireVerseKeptAiMasterFlags(env: Env): Promise<{ cleared: number }> {
  const now = Math.floor(Date.now() / 1000);
  let pairs: Array<{ book: string; resource: string }>;
  try {
    const rs = await env.DB.prepare(SELECT_STANDING_KEPT_AI_MASTER_CONFLICT_PAIRS_SQL).all<{
      book: string;
      resource: string;
    }>();
    pairs = rs.results ?? [];
  } catch (e) {
    console.error("verse keep_ai_master retire: pair lookup failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    // Fail CLOSED: do not run the retire UPDATE this run. Leaving the rows
    // standing means the next sweep sees them again and can complete the
    // pair-lookup + retire + banner-clear sequence properly.
    return { cleared: 0 };
  }
  // Retire each pair in its OWN atomic D1 batch: [that pair's scoped retire,
  // ...that pair's banner clears]. The atomicity is the fix for the window
  // Codex flagged on the first pass of this PR — previously the retire UPDATE
  // committed on its own and the clears ran afterwards, so a crash (or a clear
  // that failed and was swallowed) between the two left the rows
  // resolved_at-stamped but their banners still up, and NO later sweep could
  // find them again (the pairs SELECT filters resolved_at IS NULL),
  // reproducing the exact #760 stuck-banner symptom permanently. Committing a
  // pair's retire and clears together means either both land or neither does,
  // and a pair that fails is left STANDING to retry next sweep.
  //
  // Why PER PAIR rather than one global batch (2nd-pass Codex review): a single
  // batch of the global retire + every pair's DELETEs is unbounded and can
  // breach D1's 100-statement cap once enough pairs (or per-username fan-out
  // DELETEs) accumulate — and an over-cap batch fails and then retries the same
  // oversized batch forever, retiring nothing. One small batch per pair keeps
  // every batch well under the cap and, as a bonus, isolates a failing pair
  // from the rest instead of stranding the whole sweep.
  //
  // Order within each batch is immaterial to correctness: keep_ai_master is
  // NOT one of SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL's actions, so each clear's
  // `NOT EXISTS (... active alertable conflict ...)` guard does not depend on
  // the retire having stamped these rows first. A pair that still carries a
  // real adopt_conflict / keep_* row keeps its banner (the DELETE matches
  // nothing), exactly as before.
  let cleared = 0;
  for (const { book, resource } of pairs) {
    try {
      // resolvedBannerClearStmts's reads are inside the try so a transient read
      // failure leaves THIS pair standing (retried next sweep) without retiring
      // it — never a resolved row whose banner never came down.
      const clearStmts = await resolvedBannerClearStmts(env, book, resource);
      const batch = await env.DB.batch([
        env.DB.prepare(RETIRE_KEPT_AI_MASTER_CONFLICTS_FOR_PAIR_SQL).bind(now, book, resource),
        ...clearStmts,
      ]);
      cleared += batch[0]?.meta?.changes ?? 0;
    } catch (e) {
      // Best-effort per pair: leave this pair standing and keep going, so one
      // pair's transient failure neither retires it without clearing its banner
      // nor aborts the other pairs (or the export that follows).
      console.error("verse keep_ai_master retire: pair failed, left standing for next sweep", {
        book,
        resource,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (cleared > 0) console.log("verse keep_ai_master retire", { cleared });
  return { cleared };
}

// The banner-clear DELETE retireVerseKeptAiMasterFlags folds into its atomic
// retire batch, decided from the same reads clearResolvedConflictBannerIfLast
// makes but RETURNED rather than executed, so it commits in one transaction with
// the retire UPDATE. Skip the pair entirely when another alertable conflict
// still justifies the banner, or when every undismissed alert still carries a
// keep_no_base warning; otherwise return exactly ONE source-wide DELETE. That
// DELETE re-asserts the "no active alertable conflict" predicate in SQL (so a
// reimport landing between these reads and the batch cannot have its fresh
// banner wrongly cleared) AND excludes keep_no_base messages in SQL — so it is
// safe even when some undismissed alerts still carry a no-base warning, which is
// why this returns one statement rather than the per-username fan-out
// clearResolvedConflictBannerIfLast still uses (this path runs inside a bounded
// D1 batch; that one runs statements individually — see the P2 note below).
async function resolvedBannerClearStmts(
  env: Env,
  book: string,
  resource: string,
): Promise<D1PreparedStatement[]> {
  const source = `verse_merge_conflict:${book}:${resource}`;
  const active = await env.DB.prepare(SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL).bind(book, resource).all();
  if ((active.results?.length ?? 0) > 0) return []; // other conflicts still justify the banner
  // Preserve the pre-0066 rolling-deploy path: the retire batch must still be
  // usable while the alert columns have not reached this D1 instance.
  let transitionsAvailable = true;
  try {
    await env.DB.prepare(`SELECT resolved_at FROM system_alerts LIMIT 0`).all();
  } catch (error) {
    if (!/no such column|has no column named/i.test(error instanceof Error ? error.message : String(error))) throw error;
    transitionsAvailable = false;
  }
  const alerts = await env.DB.prepare(
    transitionsAvailable
      ? `SELECT username, message FROM system_alerts WHERE source = ?1 AND resolved_at IS NULL`
      : `SELECT username, message FROM system_alerts WHERE source = ?1 AND dismissed_at IS NULL`,
  )
    .bind(source)
    .all<{ username: string; message: string }>();
  const toClear = (alerts.results ?? []).filter((a) => !alertMessageCarriesNoBaseWarning(a.message));
  if (toClear.length === 0) return []; // nothing standing, or every row still carries keep_no_base
  // One source-wide DELETE, always. It now excludes keep_no_base messages in SQL
  // (see CLEAR_CONFLICT_ONLY_ALERTS_BY_SOURCE_SQL), so it is safe even when some
  // undismissed alerts still carry a no-base warning — no need to fan out to a
  // per-username DELETE to spare them. That pins this pair's retire batch at two
  // statements (the retire UPDATE + this one clear) however many editors have
  // conflict alerts for the source, so it can never breach D1's 100-statement
  // batch cap (#761 3rd-pass Codex review P2: a single high-fan-out pair — one
  // no-base alert plus 100+ conflict-only alerts — previously emitted 100+
  // per-username DELETEs, and the over-cap batch failed then retried the same
  // oversized batch every sweep, so the pair never cleared).
  return [
    env.DB.prepare(transitionsAvailable ? RESOLVE_CONFLICT_ONLY_ALERTS_BY_SOURCE_SQL : CLEAR_CONFLICT_ONLY_ALERTS_BY_SOURCE_SQL).bind(source, book, resource),
  ];
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
    let alerts: { results?: Array<{ username: string; message: string }> };
    try {
      alerts = await env.DB.prepare(
        `SELECT username, message FROM system_alerts WHERE source = ?1 AND resolved_at IS NULL`,
      )
        .bind(source)
        .all();
    } catch (error) {
      // A rolling deploy can invoke this best-effort cleanup before 0066.
      if (!/no such column|has no column named/i.test(error instanceof Error ? error.message : String(error))) throw error;
      alerts = await env.DB.prepare(
        `SELECT username, message FROM system_alerts WHERE source = ?1 AND dismissed_at IS NULL`,
      )
        .bind(source)
        .all();
    }
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
      try {
        await env.DB.prepare(RESOLVE_CONFLICT_ONLY_ALERTS_BY_SOURCE_SQL).bind(source, book, resource).run();
      } catch (error) {
        if (!/no such column|has no column named/i.test(error instanceof Error ? error.message : String(error))) throw error;
        await env.DB.prepare(CLEAR_CONFLICT_ONLY_ALERTS_BY_SOURCE_SQL).bind(source, book, resource).run();
      }
      return;
    }
    for (const a of toClear) {
      try {
        await env.DB.prepare(RESOLVE_CONFLICT_ONLY_ALERTS_BY_USER_SQL).bind(a.username, source, book, resource).run();
      } catch (error) {
        if (!/no such column|has no column named/i.test(error instanceof Error ? error.message : String(error))) throw error;
        await env.DB.prepare(CLEAR_CONFLICT_ONLY_ALERTS_BY_USER_SQL).bind(a.username, source, book, resource).run();
      }
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
  // `bookLocked` (issues #1006, #1110): the export skips this book+resource as
  // the alert is raised, so neither the no-base sentence nor the kept-row
  // sentences may warn that tonight's export will write. Either the known
  // value or a reader; the reader runs only when the alert has a sentence
  // that depends on the lock, so a run with none spends no D1 read on it.
  // `lockRefresh` (#1129): set by refreshVerseMergeAlertsAfterLockChange. A
  // recipient whose standing alert was dismissed is left alone unless this
  // rebuild changes the lock wording of their own alert, judged from the rows
  // this raise read rather than an earlier read by the caller.
  opts: {
    recordingFailed?: boolean;
    noBaseCount?: number;
    noBaseRefs?: string[];
    bookLocked?: boolean | (() => Promise<boolean>);
    noBaseEditorRefs?: NoBaseVerseRef[];
    observedAt?: number;
    lockRefresh?: boolean;
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
      await resolveReviewAlert(env, source, undefined, undefined, opts.observedAt);
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
  // Per-outcome guidance, classified by ACTION — refined, for 'adopt_conflict'
  // only, by whether overwritten_version is null (issue #981: the #539 no-op
  // guard keeps a pointer-less adopt_conflict row around, and that is not an
  // overwrite) — see buildMergeConflictGuidance. Pulled into that pure helper
  // so the split is unit-testable without an Env, and so a refusal or a
  // source-attr divergence can never be miscounted as an overwrite.
  // Issues #1006 / #1110: whether the no-base and kept-row sentences use the
  // locked-book wording. The lock is read only when one of them is present. A
  // failed read falls back to the unlocked wording, the one that asks someone
  // to act, and never fails the alert.
  const hasNoBase = (opts.noBaseCount ?? 0) > 0;
  const hasKept = rows.some(rowWordingDependsOnLock);
  let bookLocked = false;
  let lockReadFailed = false;
  if (hasNoBase || hasKept) {
    try {
      bookLocked = typeof opts.bookLocked === "function" ? await opts.bookLocked() : opts.bookLocked === true;
    } catch (e) {
      lockReadFailed = true;
      console.error("verseMergeConflicts: lock read failed; using the unlocked wording", {
        book,
        resource,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const noBaseLockedWording = bookLocked && hasNoBase;
  const keptLockedWording = bookLocked && hasKept;
  const guidance = buildMergeConflictGuidance(rows, {
    recordingFailed: opts.recordingFailed,
    noBaseCount: opts.noBaseCount,
    noBaseRefs: opts.noBaseRefs,
    noBaseBookLocked: noBaseLockedWording,
    bookLocked: keptLockedWording,
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
      // Issue #996: dates each ref in the editor's message ("first flagged").
      detectedAt: r.detectedAt,
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
  const perEditorNoBase = groupNoBaseVersesByEditor(
    book,
    resource,
    noBaseEditorRefs,
    usernameByKey,
    noBaseLockedWording,
  );

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

  // The condition is the measured set of adjudication-needed rows, not the
  // prose/count formatting. Sort every collection so traversal order and
  // capped display samples cannot create a new alert transition.
  const condition = reviewConditionKey(
    "verse_merge_conflict",
    { book, resource },
    {
      rows: rows
        .map((r) => ({
          chapter: r.chapter,
          verse: r.verse,
          action: r.action,
          reason: r.reason,
          overwrittenVersion: r.overwrittenVersion,
        }))
        .sort((a, b) => `${a.chapter}:${a.verse}:${a.action}:${a.reason}`.localeCompare(`${b.chapter}:${b.verse}:${b.action}:${b.reason}`)),
      noBase: noBaseEditorRefs
        .map((r) => ({ chapter: r.chapter, verse: r.verse, version: r.version }))
        .sort((a, b) => `${a.chapter}:${a.verse}`.localeCompare(`${b.chapter}:${b.verse}`)),
      noBaseCount: opts.noBaseCount ?? 0,
      recordingFailed: Boolean(opts.recordingFailed),
      // Issue #1006: the locked wording ("ask an admin") and the unlocked one
      // ("tonight's export will overwrite") are different conditions, so a
      // dismissed locked alert cannot hide the warning after an unlock. Added
      // only when locked, so unlocked keys match the ones already stored.
      ...(noBaseLockedWording ? { noBaseBookLocked: true } : {}),
      // Issue #1110: the same for the kept-row sentences.
      ...(keptLockedWording ? { keptBookLocked: true } : {}),
    },
  );
  const conditionForUser = (username: string): string => {
    if (username === ALERT_USERNAME) return condition;
    const refs = [perEditor.get(username)?.refs ?? [], perEditorNoBase.get(username)?.refs ?? []]
      .flat()
      .sort();
    return verseMergeEditorConditionKey(
      book,
      resource,
      username,
      refs,
      noBaseLockedWording && perEditorNoBase.has(username),
    );
  };

  // #1129: on a lock refresh, whether each recipient's own alert carries a
  // sentence whose wording the lock changes, and whether it uses the locked
  // wording now. The admin's alert depends on the lock through the no-base and
  // kept-row sentences; an editor's only through their no-base verses (an
  // overwrite with a pointer reads the same either way).
  const lockWordingFor = (username: string): { depends: boolean; locked: boolean } =>
    username === ALERT_USERNAME
      ? { depends: hasNoBase || hasKept, locked: noBaseLockedWording || keptLockedWording }
      : { depends: perEditorNoBase.has(username), locked: noBaseLockedWording && perEditorNoBase.has(username) };

  try {
    // #1129: a lock refresh rebuilds from the live rows, which a save can have
    // shrunk since the refresh decided to call this. For a recipient who
    // dismissed their alert, a rebuild mints a new key and brings it back, so
    // it is written only when the lock wording of that recipient's own alert
    // changes. Undismissed alerts are rebuilt as always.
    const keepDismissed = new Set<string>();
    if (opts.lockRefresh) {
      const standing = await env.DB.prepare(
        `SELECT username, condition_key, dismissed_at FROM system_alerts
          WHERE source = ?1 AND resolved_at IS NULL ORDER BY id DESC`,
      )
        .bind(source)
        .all<{ username: string; condition_key: string | null; dismissed_at: number | null }>();
      const latest = new Map<string, { condition_key: string | null; dismissed_at: number | null }>();
      for (const r of standing.results ?? []) if (!latest.has(r.username)) latest.set(r.username, r);
      for (const username of desired.keys()) {
        const row = latest.get(username);
        if (row?.dismissed_at == null) continue;
        const want = lockWordingFor(username);
        // #1129 review B1: a failed lock read falls back to the unlocked
        // wording, which is a guess. Do not bring back a dismissed alert on a
        // lock this raise could not read; undismissed ones keep the fallback.
        if (
          !want.depends ||
          lockReadFailed ||
          want.locked === storedLockWording(book, resource, username, row.condition_key)
        ) {
          keepDismissed.add(username);
        }
      }
    }
    for (const [username, msg] of desired) {
      if (keepDismissed.has(username)) continue;
      await reconcileReviewAlert(env, {
        username,
        source,
        conditionKey: conditionForUser(username),
        message: msg,
        severity: "warning",
        observedAt: opts.observedAt,
      });
    }
    // Fan-out recipients whose conflicts resolved are transitioned too;
    // dismissed standing rows are marked resolved as well, so a later
    // recurrence can mint a fresh transition without resurrecting this one.
    // A recording failure makes the known rows an undercount: emit the
    // explicit incomplete-report warning above, but never infer that an
    // omitted recipient's condition resolved.
    if (!opts.recordingFailed) {
      const desiredUsers = new Set(desired.keys());
      for (const username of await activeReviewAlertUsernames(env, source)) {
        if (!desiredUsers.has(username)) await resolveReviewAlert(env, source, undefined, username, opts.observedAt);
      }
    }
  } catch (e) {
    console.error("verseMergeConflicts: alert write failed", {
      book,
      resource,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// Issue #1110: a row whose alert sentence says an export will write over Door43
// and so changes on a locked book: the kept rows, and an adopt_conflict with no
// overwritten version (#981). An overwrite with a pointer reads the same either
// way.
function rowWordingDependsOnLock(r: { action: string; overwrittenVersion: number | null }): boolean {
  return (
    r.action === "keep_alignment_refused" ||
    r.action === "source_attr_divergent" ||
    r.action === "keep_local_structure" ||
    (r.action === "adopt_conflict" && r.overwrittenVersion == null)
  );
}

// #1129: whether a stored verse-merge alert key says its alert uses the locked
// wording. The raise adds a lock flag to the key whenever it does. An editor's
// key carries only noBaseBookLocked (verseMergeEditorConditionKey); kept rows
// never reach an editor's alert, so a keptBookLocked there is ignored.
function storedLockWording(book: string, resource: string, username: string, key: string | null): boolean {
  if (username === ALERT_USERNAME) {
    const state = reviewConditionState(key, "verse_merge_conflict", { book, resource }) as
      | { noBaseBookLocked?: unknown; keptBookLocked?: unknown }
      | undefined;
    return state?.noBaseBookLocked === true || state?.keptBookLocked === true;
  }
  const state = reviewConditionState(key, "verse_merge_conflict_editor", { book, resource, username }) as
    | { noBaseBookLocked?: unknown }
    | undefined;
  return state?.noBaseBookLocked === true;
}

// Issue #1110: re-derive a book's standing verse-merge alerts when an admin
// locks or unlocks it (bookImport.ts's PUT/DELETE /:book/lock). The lock used
// to be read only when a reimport raised the alert, and a reimport returns
// before the alert path when Door43's file is unchanged, so after an unlock a
// locked alert ("the export skips it") kept standing, and a dismissed one
// stayed dismissed, while the first export after the unlock wrote over
// Door43's version of those verses.
//
// The adjudicated verses come from verse_merge_conflicts as usual. keep_no_base
// verses write no row: between reimports the only record of them is the
// standing admin alert's condition key (raiseVerseMergeConflictAlert stores the
// uncapped verse list, with versions, and the count there), so that is what
// this re-raises them from. Only a (book, resource) with a standing admin alert
// is touched; nothing standing means nothing to re-word. A legacy alert with no
// parseable key, or one from a run whose recording failed (its table rows may
// be incomplete), is left for the next reimport rather than re-derived from
// partial facts. Best-effort: callers run this after the lock has landed.
//
// It re-words the stored measurement rather than taking a new one, so it
// re-raises at that measurement's own observation time, not now: a reimport
// that started before the lock change and raises after it carries a later
// observation, and must still win (reconcileReviewAlert drops any observation
// older than one already stored).
//
// It takes no lock value from its caller on purpose (#1110 review): a lock and
// an unlock in quick succession run two of these after their responses, and
// they can finish out of order. Each reads the effective lock itself, and
// (#1118 item 3) checks again after every write: a pass re-words only when the
// stored wording disagrees with the lock it just read, so a refresh stops only
// once the wording matches the lock as read after its own last write. A stale
// write from an older refresh is followed by that refresh's next pass, which
// corrects it. A pass whose raise changed nothing (a failed write, or an
// observation reconcileReviewAlert dropped) also stops the refresh. The pass
// cap bounds a lock that keeps flipping, and also saves or reimports that keep
// changing the alert's rows (#1129: the warning says which one it saw).
const LOCK_REFRESH_MAX_PASSES = 4;

export async function refreshVerseMergeAlertsAfterLockChange(env: Env, book: string): Promise<void> {
  for (const resource of ["ult", "ust"]) {
    // Every lock read this refresh made, a failed one as "failed", so the cap
    // warning can say whether the lock changed, could not be read, or was
    // never read (#1129 review A2).
    const lockReads: Array<boolean | "failed"> = [];
    const lockedNow = async (): Promise<boolean> => {
      try {
        const locked = (await effectiveBookLock(env, book)) != null;
        lockReads.push(locked);
        return locked;
      } catch (e) {
        lockReads.push("failed");
        // Rethrown so the raise knows the read failed (#1129 review B1): it
        // logs, falls back to the unlocked wording for undismissed alerts, and
        // leaves dismissed ones alone.
        throw e;
      }
    };
    try {
      let settled = false;
      for (let pass = 0; pass < LOCK_REFRESH_MAX_PASSES && !settled; pass++) {
        settled = !(await rewordVerseMergeAlertForLock(env, book, resource, lockedNow));
      }
      if (!settled) {
        const why = lockReads.includes("failed")
          ? "the lock could not be read during the alert refresh, so the wording may not match it"
          : new Set(lockReads).size > 1
            ? "the lock kept changing during the alert refresh"
            : lockReads.length === 0
              ? "the alert's rows kept changing during the alert refresh (saves or a reimport; the lock was not read, since nothing in the alert depends on it)"
              : "the alert's rows kept changing during the alert refresh (saves or a reimport; the lock read the same each time)";
        console.warn(`verseMergeConflicts: ${why}; left for the next change`, { book, resource });
      }
    } catch (e) {
      console.error("verseMergeConflicts: lock-change alert refresh failed", {
        book,
        resource,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

// One pass of refreshVerseMergeAlertsAfterLockChange: true when it re-raised
// the alert AND a standing alert for the source changed (the caller then
// checks again), false when there was nothing to re-word or the raise wrote
// nothing.
const STANDING_VERSE_MERGE_ALERTS_SQL = `SELECT id, username, condition_key, condition_observed_at, dismissed_at FROM system_alerts
      WHERE source = ?1 AND resolved_at IS NULL
      ORDER BY id DESC`;

async function rewordVerseMergeAlertForLock(
  env: Env,
  book: string,
  resource: string,
  lockedNow: () => Promise<boolean>,
): Promise<boolean> {
  const source = `verse_merge_conflict:${book}:${resource}`;
  type Standing = {
    id: number;
    username: string;
    condition_key: string | null;
    condition_observed_at: number | null;
    dismissed_at: number | null;
  };
  const readStanding = async (): Promise<Standing[]> =>
    (await env.DB.prepare(STANDING_VERSE_MERGE_ALERTS_SQL).bind(source).all<Standing>()).results ?? [];
  const before = await readStanding();
  const standing = before.find((r) => r.username === ALERT_USERNAME);
  if (!standing) return false;
  const state = reviewConditionState(standing.condition_key, "verse_merge_conflict", { book, resource }) as
    | {
        noBase?: unknown;
        noBaseCount?: unknown;
        recordingFailed?: unknown;
        rows?: unknown;
        noBaseBookLocked?: unknown;
        keptBookLocked?: unknown;
      }
    | undefined;
  const noBase = Array.isArray(state?.noBase) ? (state.noBase as NoBaseVerseRef[]) : null;
  if (
    standing.condition_observed_at == null ||
    !state ||
    state.recordingFailed !== false ||
    typeof state.noBaseCount !== "number" ||
    !noBase ||
    !Array.isArray(state.rows) ||
    !noBase.every((r) => Number.isInteger(r?.chapter) && Number.isInteger(r?.verse) && Number.isInteger(r?.version))
  ) {
    console.warn("verseMergeConflicts: lock change left an alert it cannot re-derive", { book, resource });
    return false;
  }
  // Whether the alert would carry a lock-dependent sentence if raised now,
  // judged from the LIVE rows (#1118 item 2). The stored rows are not a safe
  // stand-in: a save can resolve a row during the day, and a chunked reimport
  // can record rows and then fail before its raise step. This read only spares
  // the raise when nothing can change; the raise re-checks each dismissed
  // alert against the rows it reads itself (#1129 item 1).
  const live = await env.DB.prepare(SELECT_ACTIVE_ALERTABLE_CONFLICTS_SQL)
    .bind(book, resource)
    .all<{ action: string; overwritten_version: number | null }>();
  const dependsOnLock =
    state.noBaseCount > 0 ||
    (live.results ?? []).some((r) =>
      rowWordingDependsOnLock({ action: r.action, overwrittenVersion: r.overwritten_version }),
    );
  // #1110 round 2, #1118 item 2: a re-raise rebuilds the alert from the live
  // rows, so once rows were resolved since the last reimport it mints a new
  // key. For a DISMISSED alert that brings back what people dismissed, so it
  // is re-raised only when something live still depends on the lock and the
  // wording it stands under is wrong for the lock now. An undismissed alert
  // is always rebuilt from the live rows, as before #1118: it then stops
  // listing rows a save resolved, and stops naming a lock that is gone. An
  // identical rebuild leaves the stored key as it was, which ends the refresh.
  // #1129: the raise makes that call per recipient (lockRefresh). This only
  // skips the raise when every standing alert is dismissed and nothing depends
  // on the lock: an editor's wording depends on it only through no-base
  // verses, which make the admin's depend on it too, so the raise would keep
  // them all. Whether a dismissed editor's wording matches the lock needs the
  // editor lookup, so that is left to the raise (#1129 review A1).
  if (before.every((r) => r.dismissed_at != null) && !dependsOnLock) return false;
  const ordered = [...noBase].sort((a, b) => a.chapter - b.chapter || a.verse - b.verse);
  await raiseVerseMergeConflictAlert(env, book, resource, {
    recordingFailed: false,
    noBaseCount: state.noBaseCount,
    noBaseRefs: ordered.map((r) => `${r.chapter}:${r.verse}`),
    noBaseEditorRefs: ordered.map((r) => ({ chapter: r.chapter, verse: r.verse, version: r.version })),
    // #1129: the raise reads the lock itself, once, and only if the rows it
    // read carry a lock-dependent sentence, so the wording matches those rows.
    bookLocked: lockedNow,
    observedAt: standing.condition_observed_at,
    lockRefresh: true,
  });
  // The raise is best-effort and can write nothing (a failed write, an
  // observation reconcileReviewAlert drops as older, or only dismissed alerts
  // it kept). Report a change only if a standing alert actually moved, so the
  // caller does not repeat a pass that cannot land.
  const fingerprint = (rows: Standing[]) => JSON.stringify(rows.map((r) => [r.id, r.condition_key]));
  return fingerprint(await readStanding()) !== fingerprint(before);
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
      // re-detection of the same still-unresolved conflict; reset only when a
      // resolved row is reactivated (#996) or an unresolved audit-only row is
      // promoted to adopt_conflict (#1124) — see
      // VerseMergeConflictRow.detectedAt's doc comment), so the in-app
      // merge-review banner can show it per verse without a prod D1 query.
      detectedAt: r.detected_at,
    };
  });
  return c.json({ conflicts });
});
