// Centralized chapter-lock check. While a pipeline_jobs row is non-terminal
// for a given (book, chapter), the chapter is read-only for mutations on
// tn / tq / twl / verses — the AI run will overwrite anything edited mid-flight
// when it completes. See docs/ai-pipeline-handoff.md (Phase 2c) and the plan
// for the exemption rules (tn PATCH, /preserve, /hint, legacy /keep alias).

import type { Env } from "./index";

export interface ActiveLock {
  jobId: string;
  pipelineType: string;
  userId: number;
  startedAt: number; // unix seconds
}

const NON_TERMINAL = [
  "running",
  "paused_for_outage",
  "paused_for_usage_limit",
] as const;

// Returns the first non-terminal job covering this (book, chapter), or null
// if the chapter is unlocked. Locks are global — any translator's pipeline
// locks the chapter for everyone, by design.
export async function activePipelineForChapter(
  env: Env,
  book: string,
  chapter: number,
): Promise<ActiveLock | null> {
  const row = await env.DB.prepare(
    `SELECT job_id, pipeline_type, user_id, created_at
       FROM pipeline_jobs
      WHERE book = ?1
        AND start_chapter <= ?2 AND end_chapter >= ?2
        AND state IN (?3, ?4, ?5)
      ORDER BY created_at ASC
      LIMIT 1`,
  )
    .bind(book.toUpperCase(), chapter, NON_TERMINAL[0], NON_TERMINAL[1], NON_TERMINAL[2])
    .first<{
      job_id: string;
      pipeline_type: string;
      user_id: number;
      created_at: number;
    }>();
  if (!row) return null;
  return {
    jobId: row.job_id,
    pipelineType: row.pipeline_type,
    userId: row.user_id,
    startedAt: row.created_at,
  };
}

// Shape of the 409 body when a write is rejected due to an active lock.
// The client uses this to render "AI run in progress (started X min ago)"
// without a second request.
export interface ChapterLockedError {
  error: "chapter_locked";
  jobId: string;
  pipelineType: string;
  startedAt: number;
}

export function lockedResponseBody(lock: ActiveLock): ChapterLockedError {
  return {
    error: "chapter_locked",
    jobId: lock.jobId,
    pipelineType: lock.pipelineType,
    startedAt: lock.startedAt,
  };
}
