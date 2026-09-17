import type { Env } from "./index";

export type SyncRunEventType = "run_started" | "item_terminal" | "run_completed";
export type SyncRunItemStatus = "success" | "skip" | "failure";

export interface SyncRunEventInput {
  runId: string;
  eventKey: string;
  eventType: SyncRunEventType;
  occurredAt: number;
  status?: string;
  book?: string | null;
  resource?: string | null;
  details?: Record<string, unknown>;
}

export function syncRunEventKey(
  runId: string,
  eventType: SyncRunEventType,
  book?: string,
  resource?: string,
): string {
  if (eventType === "run_started") return `${runId}:run_started`;
  if (eventType === "run_completed") return `${runId}:run_completed`;
  return `${runId}:item:${book ?? ""}:${resource ?? ""}`;
}

/** Best-effort append-only workflow telemetry. INSERT OR IGNORE makes replay idempotent. */
export async function appendSyncRunEvent(env: Env, input: SyncRunEventInput): Promise<boolean> {
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO sync_run_log
        (run_id, event_key, event_type, status, book, resource, details_json, occurred_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        input.runId,
        input.eventKey,
        input.eventType,
        input.status ?? null,
        input.book ?? null,
        input.resource ?? null,
        input.details ? JSON.stringify(input.details) : null,
        input.occurredAt,
      )
      .run();
    return true;
  } catch (error) {
    console.error("sync run log append failed", {
      runId: input.runId,
      eventKey: input.eventKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
