// Durable record + banner for the stale-base gate (issue #639). See
// staleBaseGate.ts for what is measured and why; this file only persists the
// outcome and makes it visible.
//
// Two halves, both required by the issue: a counter alone is invisible outside
// `wrangler tail` (exportWorkflow.ts discards reimport counters — the #609
// precedent), so a refusal writes a queryable row AND raises a banner.

import type { Env } from "./index";
import type { StaleBaseHold } from "./staleBaseGate";
import { planSystemAlertWrites, type ExistingAlertState } from "./verseMergeEditorAlerts";

// Same single recipient every other book-level reimport banner in this codebase
// uses (bookReimport.ts's OWN_PUBLISH_ALERT_USERNAME,
// verseMergeConflicts.ts's ALERT_USERNAME). This condition is an operator
// concern — a whole book's file on Door43 needs a decision — not a per-verse
// one attributable to the translator who last touched a row.
const ALERT_USERNAME = "deferredreward";

export function staleBaseAlertSource(book: string, resource: string): string {
  return `reimport_stale_base:${book}:${resource}`;
}

// UPSERT, never INSERT OR REPLACE: replacing would reset detected_at and mint a
// new id, losing "when did we first refuse this revision". Mirrors
// verseMergeConflictSql.ts's shape and its stickiness rule — a re-detection
// updates the evidence and the recency stamp, and pointedly does NOT touch
// resolved_at / resolved_by. A human's release survives every subsequent
// re-detection of the SAME revision; a different revision is a different row.
export const UPSERT_STALE_BASE_HOLD_SQL = `
  INSERT INTO stale_base_holds
    (book, resource, master_sha, previous_sha, incoming_tc_export_at,
     previous_tc_export_at, synced_at, reason, detected_at, last_recorded_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
  ON CONFLICT (book, resource, master_sha) DO UPDATE SET
    previous_sha = excluded.previous_sha,
    incoming_tc_export_at = excluded.incoming_tc_export_at,
    previous_tc_export_at = excluded.previous_tc_export_at,
    synced_at = excluded.synced_at,
    reason = excluded.reason,
    last_recorded_at = excluded.last_recorded_at`;

// Release every still-active hold for a (book, resource). Called when the pair
// syncs cleanly — i.e. master no longer presents the stale replacement, either
// because someone repaired it upstream or because the offending revision was
// superseded. Self-releasing on repair is the primary exit from this gate; see
// recordStaleBaseHold's header for why that matters.
export const RELEASE_STALE_BASE_HOLDS_SQL = `
  UPDATE stale_base_holds
     SET resolved_at = ?3
   WHERE book = ?1 AND resource = ?2 AND resolved_at IS NULL`;

/**
 * Write (or refresh) the durable record for one refused revision.
 *
 * Best-effort in the same sense as recordVerseMergeConflicts' caller: a failure
 * here must not fail the reimport, but it IS reported, because a silent record
 * failure would leave the watermark withheld with nothing explaining why.
 */
export async function recordStaleBaseHold(env: Env, hold: StaleBaseHold, reason: string, now: number): Promise<boolean> {
  try {
    await env.DB.prepare(UPSERT_STALE_BASE_HOLD_SQL)
      .bind(
        hold.book,
        hold.resource,
        hold.masterSha,
        hold.previousSha,
        hold.incomingTcExportAt,
        hold.previousTcExportAt,
        hold.syncedAt,
        reason,
        now,
      )
      .run();
    return true;
  } catch (e) {
    console.error("stale-base hold record failed", {
      book: hold.book,
      resource: hold.resource,
      masterSha: hold.masterSha,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

const iso = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);

/** The banner text. Extracted so the test can assert stickiness on byte-identity. */
export function staleBaseAlertMessage(hold: StaleBaseHold, recordFailed: boolean, overridden = false): string {
  const res = hold.resource.toUpperCase();
  // Force-released variant. Deliberately a different sentence, not a suffix on
  // the refusal text: the outcome is the opposite one, and an operator scanning
  // banners must not read "REFUSED" on a run that adopted. Same source key, so
  // it REPLACES the refusal banner rather than sitting beside it.
  if (overridden) {
    return (
      `Benjamin — ${hold.book} ${res} was FORCE-RELEASED past the stale-base gate on your instruction, and ` +
      `master's file (${hold.masterSha.slice(0, 8)}) was adopted into the app. That file is a translationCore ` +
      `re-export from a ${iso(hold.incomingTcExportAt)} snapshot, older than the ${iso(hold.syncedAt)} state the app ` +
      `had synced from master (${hold.previousSha.slice(0, 8)}). Anything that landed on master in between is now ` +
      `gone from the app for this resource, and the next export will publish that to Door43. If that was not what ` +
      `you meant, restore from the affected verses' history before the next export runs.` +
      (recordFailed ? ` (The durable record of this override could not be written — see the logs.)` : ``)
    );
  }
  // F4: every measurement here is per (book, RESOURCE) — book_resource_syncs is
  // keyed that way and only this resource's file was refused. Say "resource", not
  // "book": 2CH UST is unaffected by a 2CH ULT refusal and an operator must not
  // read this as the whole book being frozen.
  //
  // F3: the remedies below are the two that ACTUALLY release, and no others.
  // "Re-apply the newer work on top of the stale export" is deliberately NOT
  // offered — it leaves the stale translationCore stamp in place, so the gate
  // re-measures the same conjunction tomorrow and re-holds forever. That is
  // precisely the shape the override exists for.
  return (
    `Benjamin — the nightly sync REFUSED ${hold.book} ${res} from Door43 and did not update the app. ` +
    `Master's file (${hold.masterSha.slice(0, 8)}) was re-exported from translationCore against a ` +
    `${iso(hold.incomingTcExportAt)} snapshot, which is older than the ${iso(hold.syncedAt)} state the app ` +
    `last synced from master (${hold.previousSha.slice(0, 8)}, exported ${iso(hold.previousTcExportAt)}). ` +
    `Adopting it would have reverted every change made on master in between, and tonight's export would have ` +
    `republished the revert. Nothing was overwritten, and only ${hold.book} ${res} is held — other resources ` +
    `for this book are unaffected. ` +
    `Two things release it. (1) Revert that merge on master, so the file goes back to carrying its previous ` +
    `translationCore stamp — the next nightly then clears this by itself, with no action here. ` +
    `(2) If the file on master is actually correct and you want it adopted as-is, force-release it: run an ` +
    `export for exactly this book and resource with allowStaleBase, which adopts master and republishes it. ` +
    `Re-applying the newer work ON TOP of the stale export does NOT release it — the stale stamp stays, so ` +
    `this refusal simply repeats tomorrow.` +
    (recordFailed ? ` (The durable record of this refusal could not be written — see the logs.)` : ``)
  );
}

/**
 * Raise the banner for a refused revision.
 *
 * Routed through planSystemAlertWrites rather than the older
 * delete-undismissed-then-insert shape (raiseTombstoneBlockAlert et al) so
 * dismissal is STICKY: a byte-identical message plans no writes at all, which
 * means dismissing this banner keeps it dismissed for as long as the condition
 * is unchanged, instead of resurrecting it every single night. The condition is
 * durable by construction here — the watermark is withheld, so the same
 * revision re-fires nightly until master is repaired — which is exactly the
 * situation where a nightly resurrection would train an operator to ignore the
 * banner. The message only changes when the underlying revision or its
 * measurements change, and then it SHOULD reappear.
 */
export async function raiseStaleBaseHoldAlert(
  env: Env,
  hold: StaleBaseHold,
  recordFailed: boolean,
  overridden = false,
): Promise<void> {
  const source = staleBaseAlertSource(hold.book, hold.resource);
  try {
    const rs = await env.DB.prepare(`SELECT username, message, dismissed_at FROM system_alerts WHERE source = ?1`)
      .bind(source)
      .all<{ username: string; message: string; dismissed_at: number | null }>();
    const existing = new Map<string, ExistingAlertState>(
      (rs.results ?? []).map((r): [string, ExistingAlertState] => [
        r.username,
        { message: r.message, dismissedAt: r.dismissed_at },
      ]),
    );
    const desired = new Map<string, string>([[ALERT_USERNAME, staleBaseAlertMessage(hold, recordFailed, overridden)]]);
    const { toDelete, toInsert } = planSystemAlertWrites(existing, desired);
    const stmts = [
      ...toDelete.map((u) =>
        env.DB.prepare(`DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`).bind(u, source),
      ),
      ...toInsert.map(({ username, message }) =>
        env.DB.prepare(
          `INSERT INTO system_alerts (username, severity, source, message, link_url) VALUES (?1, ?2, ?3, ?4, ?5)`,
        ).bind(username, "error", source, message, null),
      ),
    ];
    if (stmts.length) await env.DB.batch(stmts);
  } catch (e) {
    console.error("stale-base hold alert failed", {
      book: hold.book,
      resource: hold.resource,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Clear the banner and release the holds for a (book, resource) that just
 * synced cleanly.
 *
 * Lives OUTSIDE raiseStaleBaseHoldAlert for the reason clearTombstoneBlockAlert
 * documents: the raise only runs while the resource is still held, so a
 * recovered resource would never reach a clear nested inside it and the banner
 * would sit stale forever.
 *
 * The DELETE is scoped to `dismissed_at IS NULL`, matching every other alert
 * clear here — a dismissed row is a record of what a human saw and is never
 * removed on their behalf.
 */
export async function clearStaleBaseHold(env: Env, book: string, resource: string, now: number): Promise<void> {
  const source = staleBaseAlertSource(book, resource);
  // F8: two SEPARATE statements, deliberately NOT one env.DB.batch().
  //
  // A D1 batch is one transaction. Batched together, a throw on the
  // stale_base_holds UPDATE — the deploy-before-migration case, where the table
  // does not exist yet — rolls back the system_alerts DELETE with it, so a
  // banner whose condition has genuinely cleared would keep sitting on the
  // dashboard for the whole migration-lag window. The two writes have no
  // atomicity requirement between them (releasing a row and dropping a banner
  // are independently correct), so they must not share a transaction's failure.
  try {
    await env.DB.prepare(`DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`)
      .bind(ALERT_USERNAME, source)
      .run();
  } catch (e) {
    console.error("stale-base banner clear failed", { book, resource, error: e instanceof Error ? e.message : String(e) });
  }
  try {
    await env.DB.prepare(RELEASE_STALE_BASE_HOLDS_SQL).bind(book, resource, now).run();
  } catch (e) {
    console.error("stale-base hold release failed", { book, resource, error: e instanceof Error ? e.message : String(e) });
  }
}
