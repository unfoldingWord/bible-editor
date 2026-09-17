// Persist + read WHY the nightly reimport withheld a (book, resource) sync
// watermark (issue #829), and turn the persisted reason into the export_stale
// banner's remedy text. See reimportSyncGate.ts's computeWithholdReason for
// where the reason is measured, and bookReimport.ts's `reimport-sync-${book}`
// step for where it is recorded/cleared.

import type { Env } from "./index";
import type { WithholdReason } from "./reimportSyncGate";

export interface SyncWithhold {
  book: string;
  resource: string;
  reason: WithholdReason;
  count: number;
  occurredAt: number;
  runId: string;
}

const UPSERT_SQL = `
  INSERT INTO sync_withholds (book, resource, reason, count, occurred_at, run_id)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  ON CONFLICT (book, resource) DO UPDATE SET
    reason = excluded.reason,
    count = excluded.count,
    occurred_at = excluded.occurred_at,
    run_id = excluded.run_id`;

/**
 * Best-effort, like every other durable-record write beside this run's
 * withhold gate (recordStaleBaseHold, recordVerseMergeConflicts): a failure
 * here must not fail the reimport. It IS logged loudly, because a silent
 * failure leaves recordStaleSkipAlert with nothing to read and no way to tell
 * "no reason was measured" from "the reason failed to persist".
 *
 * `runId`: exportWorkflow.ts's `instanceId` for the Workflow instance this
 * reimport step is running inside — see readSyncWithhold's doc for why this
 * is required, not optional.
 */
export async function recordSyncWithhold(
  env: Env,
  book: string,
  resource: string,
  reason: WithholdReason,
  count: number,
  occurredAt: number,
  runId: string,
): Promise<boolean> {
  try {
    await env.DB.prepare(UPSERT_SQL).bind(book, resource, reason, count, occurredAt, runId).run();
    return true;
  } catch (e) {
    console.error("sync withhold record failed", {
      book,
      resource,
      reason,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Release the row for a (book, resource) that just synced cleanly. Mirrors
 * clearStaleBaseHold / clearTombstoneBlockAlert's "the pair is no longer held"
 * shape — called only once recordResourceSync has actually stamped a fresh
 * watermark, never from the `!e.masterSha` short-circuit (nothing was measured
 * there, so any standing reason is not yet known to be stale).
 */
export async function clearSyncWithhold(env: Env, book: string, resource: string): Promise<void> {
  try {
    await env.DB.prepare(`DELETE FROM sync_withholds WHERE book = ?1 AND resource = ?2`).bind(book, resource).run();
  } catch (e) {
    console.error("sync withhold clear failed", { book, resource, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Read the withhold reason for a (book, resource) — but ONLY if it was
 * recorded by THIS run. `runId` must be the caller's own
 * exportWorkflow.ts `instanceId`; a row whose `run_id` doesn't match is a
 * PREVIOUS run's leftover, not this run's measurement, and is treated
 * exactly like no row at all.
 *
 * This generation guard exists because recordSyncWithhold/clearSyncWithhold
 * only run from the reimport-sync step's per-resource loop — a resource this
 * run's reimport never reaches that loop for (a stale-base hold decided at
 * STAGING time before the resource is even staged, or the whole book's
 * reimport throwing and never running the sync step at all) leaves a prior
 * run's row untouched. Without this check, tonight's export_stale banner
 * could name YESTERDAY's cause as though it were measured tonight — the
 * exact "asserts an unmeasured cause" failure #829 exists to end, just moved
 * one layer down. See #836 for widening computeWithholdReason itself to
 * cover the staging-time stale-base path.
 */
export async function readSyncWithhold(env: Env, book: string, resource: string, runId: string): Promise<SyncWithhold | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT reason, count, occurred_at, run_id FROM sync_withholds WHERE book = ?1 AND resource = ?2`,
    )
      .bind(book, resource)
      .first<{ reason: string; count: number; occurred_at: number; run_id: string }>();
    if (!row || row.run_id !== runId) return null;
    return {
      book,
      resource,
      reason: row.reason as WithholdReason,
      count: row.count,
      occurredAt: row.occurred_at,
      runId: row.run_id,
    };
  } catch (e) {
    // Table not yet migrated, or a genuine D1 fault: either way, "no reason on
    // record" is the fail-safe read — staleSkipRemedy then says so honestly
    // instead of asserting a cause. This mirrors resourceSyncState's own
    // migration-lag fallback (bookReimport.ts) rather than throwing.
    console.error("sync withhold read failed", { book, resource, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

const REASON_TEXT: Record<WithholdReason, (n: string) => string> = {
  chapters_locked: (n) =>
    `The pre-export sync withheld the watermark: ${n}chapter(s) were held by an active AI pipeline job and ` +
    `skipped this run. It will catch up on its own once the job finishes and a later sync applies them — ` +
    `no action needed unless the job is stuck.`,
  prune_locked: (n) =>
    `The pre-export sync withheld the watermark: removing rows master no longer carries hit ${n}chapter(s) ` +
    `still held by an active AI pipeline job. It will catch up once the job finishes and a later sync prunes ` +
    `them — no action needed unless the job is stuck.`,
  conflict_skipped: (n) =>
    `The pre-export sync withheld the watermark: ${n}row(s) from master could not be inserted because their ` +
    `id is already held by a different row in the app. This needs a human to resolve the id collision — see ` +
    `the reimport_id_blocked alert for this book and resource.`,
  tombstone_blocked: (n) =>
    `The pre-export sync withheld the watermark: ${n}row(s) from master are blocked by a deleted row holding ` +
    `the same id at a different reference. This needs a human to resolve — see the reimport_id_blocked alert ` +
    `for this book and resource.`,
  counts_incomplete: () =>
    `The pre-export sync withheld the watermark: this run's measurement of what it applied was incomplete ` +
    `(a resumed/replayed run, or an aggregation failure), so it could not certify the app as caught up. A ` +
    `later full sync will re-measure and, if actually current, clear this on its own.`,
  structure_overlap: (n) =>
    `The pre-export sync withheld the watermark: ${n}chapter(s) were left with overlapping verse ranges after ` +
    `this run's merge, which the export cannot render. This needs a human to resolve the structural conflict.`,
  systemic_refusal: () =>
    `The pre-export sync withheld the watermark: this run declined to adopt master's edits at scale, to avoid ` +
    `reverting translator work in the app. This needs a human to review the flagged verses (see the ` +
    `verse_merge_conflict alerts for this book and resource) and either resolve or override them.`,
  merge_record_failed: () =>
    `The pre-export sync withheld the watermark: this run's write of its merge-conflict results failed, so ` +
    `nothing from this run was applied. A later sync will retry.`,
  apply_incomplete: () =>
    `The pre-export sync withheld the watermark: this run's write to the app failed partway through, so the ` +
    `app is not fully caught up with master. A later sync will retry.`,
};

/**
 * The export_stale banner's remedy sentence, derived from the persisted
 * reason. Extracted as a pure function (no D1) so the text is directly
 * testable against every reason, and so an ablation (call this with `null`)
 * demonstrates the fallback the issue asks for: "Only when no withhold row
 * exists for tonight may it say the sync did not run."
 */
export function staleSkipRemedy(withhold: SyncWithhold | null): string {
  if (!withhold) return `D1 is behind master; this run recorded no reason.`;
  const n = withhold.count > 0 ? `${withhold.count} ` : "";
  return REASON_TEXT[withhold.reason](n);
}
