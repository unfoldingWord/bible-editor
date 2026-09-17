import type { Env } from "./index";

/** Versioned, deterministic identity for a measured review condition. */
export function reviewConditionKey(
  family: string,
  identity: Record<string, unknown>,
  state: unknown,
): string {
  return `review:v1:${family}:${stableJson(identity)}:${stableJson(state)}`;
}

/** Stable per-recipient merge condition; unrelated editors never share an episode. */
export function verseMergeEditorConditionKey(
  book: string,
  resource: string,
  username: string,
  refs: string[],
): string {
  return reviewConditionKey("verse_merge_conflict_editor", { book, resource, username }, { refs: [...refs].sort() });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

export interface ReviewAlertInput {
  username: string;
  source: string;
  conditionKey: string;
  message: string;
  severity?: string;
  linkUrl?: string | null;
  /** False means the run could not measure this condition; leave state alone. */
  measured?: boolean;
  now?: number;
  /** Ordering token from the run; older observations may not overwrite newer ones. */
  observedAt?: number;
}

/**
 * Reconcile one standing review condition without delete/reinsert churn.
 * D1's partial unique index is the last line of defence when two workflows
 * observe the same condition concurrently; INSERT OR IGNORE makes the losing
 * writer harmless.
 */
export async function reconcileReviewAlert(env: Env, input: ReviewAlertInput): Promise<void> {
  if (input.measured === false) return;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  // Ordering tokens are milliseconds everywhere; `now` is the user-facing
  // epoch-seconds resolution stamp and must never be reused for ordering.
  const observedAt = input.observedAt ?? Date.now();
  let rows: {
    results?: Array<{
      id: number;
      condition_key: string | null;
      dismissed_at: number | null;
      resolved_at: number | null;
      condition_observed_at: number | null;
    }>;
  };
  try {
    rows = await env.DB.prepare(
      `SELECT id, condition_key, dismissed_at, resolved_at, condition_observed_at
         FROM system_alerts
        WHERE username = ?1 AND source = ?2
        ORDER BY id DESC`,
    )
      .bind(input.username, input.source)
      .all();
  } catch (error) {
    if (!isTransitionSchemaMissing(error)) throw error;
    // Deploys can briefly run code before 0066 has reached D1. Retain the
    // pre-migration behavior for that window rather than losing the banner.
    const legacy = await env.DB.prepare(
      `SELECT id, message, dismissed_at FROM system_alerts WHERE username = ?1 AND source = ?2 ORDER BY id DESC`,
    )
      .bind(input.username, input.source)
      .all<{ id: number; message: string; dismissed_at: number | null }>();
    const same = (legacy.results ?? []).find((row) => row.message === input.message);
    if (same?.dismissed_at != null) return;
    await env.DB.prepare(`DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`)
      .bind(input.username, input.source)
      .run();
    await env.DB.prepare(
      `INSERT INTO system_alerts (username, severity, source, message, link_url) VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(input.username, input.severity ?? "warning", input.source, input.message, input.linkUrl ?? null)
      .run();
    return;
  }
  const sameCondition = (rows.results ?? []).filter(
    (row) => row.condition_key === input.conditionKey && row.resolved_at == null,
  );
  const matching = sameCondition.find((row) => row.dismissed_at == null) ?? sameCondition[0];
  if ((rows.results ?? []).some((row) => row.condition_observed_at != null && row.condition_observed_at > observedAt)) {
    // A newer observation remains authoritative even after it has resolved.
    // Otherwise a delayed older workflow could see no standing newer row and
    // resurrect a condition that the newer clean measurement already closed.
    return;
  }

  if (matching?.dismissed_at != null && matching.resolved_at == null) {
    // A human dismissed this exact condition. Keep it dismissed, and retire
    // any stale active predecessor that might coexist from a legacy race.
    // Refresh its observation generation so a delayed, different condition
    // from between the original alert and this remeasurement cannot reopen it.
    await env.DB.prepare(
      `UPDATE system_alerts SET condition_observed_at = ?1
        WHERE id = ?2 AND dismissed_at IS NOT NULL AND resolved_at IS NULL
          AND (condition_observed_at IS NULL OR condition_observed_at <= ?1)`,
    )
      .bind(observedAt, matching.id)
      .run();
    await env.DB.prepare(
      `UPDATE system_alerts SET resolved_at = ?1
        WHERE username = ?2 AND source = ?3 AND dismissed_at IS NULL AND resolved_at IS NULL
          AND (condition_observed_at IS NULL OR condition_observed_at <= ?4)`,
    )
      .bind(now, input.username, input.source, observedAt)
      .run();
    return;
  }

  if (matching != null && matching.dismissed_at == null && matching.resolved_at == null) {
    await env.DB.prepare(
      `UPDATE system_alerts
          SET severity = ?1, message = ?2, link_url = ?3, condition_observed_at = ?5
        WHERE id = ?4 AND dismissed_at IS NULL AND resolved_at IS NULL
          AND (condition_observed_at IS NULL OR condition_observed_at <= ?5)`,
    )
      .bind(input.severity ?? "warning", input.message, input.linkUrl ?? null, matching.id, observedAt)
      .run();
    return;
  }

  // A different condition is a real transition. Preserve the old row for
  // history, then attempt to mint exactly one new standing row.
  await env.DB.prepare(
    `UPDATE system_alerts SET resolved_at = ?1
      WHERE username = ?2 AND source = ?3 AND resolved_at IS NULL
        AND (condition_observed_at IS NULL OR condition_observed_at <= ?4)`,
  )
    .bind(now, input.username, input.source, observedAt)
    .run();
  // A read followed by INSERT OR IGNORE alone is not enough: two different
  // conditions can both read an empty source, and the older insert might win
  // the unique-index race. Re-read after the insert and converge on the newer
  // observation. The losing writer either sees newer history and retires its
  // stale row, or retires the older standing row and retries once.
  for (let attempt = 0; attempt < 2; attempt++) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO system_alerts
        (username, severity, source, message, link_url, kind, condition_key, condition_observed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'review', ?6, ?7)`,
    )
      .bind(input.username, input.severity ?? "warning", input.source, input.message, input.linkUrl ?? null, input.conditionKey, observedAt)
      .run();

    const settled = await env.DB.prepare(
      `SELECT id, condition_key, dismissed_at, resolved_at, condition_observed_at
         FROM system_alerts
        WHERE username = ?1 AND source = ?2
        ORDER BY id DESC`,
    )
      .bind(input.username, input.source)
      .all<{
        id: number;
        condition_key: string | null;
        dismissed_at: number | null;
        resolved_at: number | null;
        condition_observed_at: number | null;
      }>();
    const settledRows = settled.results ?? [];
    if (settledRows.some((row) => row.condition_observed_at != null && row.condition_observed_at > observedAt)) {
      await env.DB.prepare(
        `UPDATE system_alerts SET resolved_at = ?1
          WHERE username = ?2 AND source = ?3 AND condition_key = ?4
            AND resolved_at IS NULL AND (condition_observed_at IS NULL OR condition_observed_at <= ?5)`,
      )
        .bind(now, input.username, input.source, input.conditionKey, observedAt)
        .run();
      return;
    }
    const standing = settledRows.find((row) => row.dismissed_at == null && row.resolved_at == null);
    if (standing?.condition_key === input.conditionKey) {
      await env.DB.prepare(
        `UPDATE system_alerts
            SET severity = ?1, message = ?2, link_url = ?3, condition_observed_at = ?5
          WHERE id = ?4 AND dismissed_at IS NULL AND resolved_at IS NULL
            AND (condition_observed_at IS NULL OR condition_observed_at <= ?5)`,
      )
        .bind(input.severity ?? "warning", input.message, input.linkUrl ?? null, standing.id, observedAt)
        .run();
      return;
    }
    if (standing == null) continue;
    await env.DB.prepare(
      `UPDATE system_alerts SET resolved_at = ?1
        WHERE id = ?2 AND dismissed_at IS NULL AND resolved_at IS NULL
          AND (condition_observed_at IS NULL OR condition_observed_at <= ?3)`,
    )
      .bind(now, standing.id, observedAt)
      .run();
  }
}

/** Resolve a measured-clean condition while retaining the alert history. */
export async function resolveReviewAlert(
  env: Env,
  source: string,
  now = Math.floor(Date.now() / 1000),
  username?: string,
  observedAt = Date.now(),
): Promise<void> {
  const predicate = username == null ? "source = ?2" : "source = ?2 AND username = ?3";
  const args = username == null ? [now, source, observedAt] : [now, source, username, observedAt];
  try {
    await env.DB.prepare(
      `UPDATE system_alerts SET resolved_at = ?1
         WHERE ${predicate} AND resolved_at IS NULL AND kind = 'review'
           AND (condition_observed_at IS NULL OR condition_observed_at <= ?${username == null ? "3" : "4"})`,
    )
      .bind(...args)
      .run();
  } catch (error) {
    if (!isTransitionSchemaMissing(error)) throw error;
    const legacyPredicate = username == null ? "source = ?1" : "source = ?1 AND username = ?2";
    const legacyArgs = username == null ? [source] : [source, username];
    await env.DB.prepare(`DELETE FROM system_alerts WHERE ${legacyPredicate} AND dismissed_at IS NULL`)
      .bind(...legacyArgs)
      .run();
  }
}

/** Return active usernames so callers can retire fan-out recipients omitted by a clean run. */
export async function activeReviewAlertUsernames(env: Env, source: string): Promise<string[]> {
  let rs: { results?: Array<{ username: string }> };
  try {
    rs = await env.DB.prepare(
      `SELECT DISTINCT username FROM system_alerts
        WHERE source = ?1 AND resolved_at IS NULL AND kind = 'review'`,
    )
      .bind(source)
      .all();
  } catch (error) {
    if (!isTransitionSchemaMissing(error)) throw error;
    rs = await env.DB.prepare(`SELECT DISTINCT username FROM system_alerts WHERE source = ?1 AND dismissed_at IS NULL`)
      .bind(source)
      .all();
  }
  return (rs.results ?? []).map((row) => row.username);
}

function isTransitionSchemaMissing(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /no such column|has no column named|no such table/i.test(text) && /condition_key|resolved_at|condition_observed_at|kind/i.test(text);
}
