// Centralized chapter-lock check. While a pipeline_jobs row is non-terminal
// for a given (book, chapter), the chapter is read-only for mutations on the
// resource that run will overwrite when it completes. See
// docs/ai-pipeline-handoff.md (Phase 2c) and the plan for the exemption rules
// (tn PATCH, /preserve, /hint, legacy /keep alias).

import type { Env } from "./index";

export interface ActiveLock {
  jobId: string;
  pipelineType: string;
  userId: number;
  startedAt: number; // unix seconds
}

// States that lock the chapter: a run that's actively on the bot (or being
// dispatched to it) will overwrite this chapter when it lands. A 'queued' job
// has NOT started — it doesn't lock, so translators can keep editing a chapter
// whose run is still waiting in line.
const NON_TERMINAL = [
  "running",
  "paused_for_outage",
  "paused_for_usage_limit",
  "dispatching",
] as const;

// Which pipeline writes which resource. A run only locks what it will
// overwrite: the questions run rewrites tq_rows and nothing else, so it must
// not lock notes, words or scripture. No pipeline of any type writes twl_rows
// (see api/src/pipelineImport.ts — it classifies output by repo, and there is
// no en_twl repo), so TWL editing is never locked.
export type LockedResource = "verse" | "tn" | "tq" | "twl";

const WRITERS: Record<LockedResource, readonly string[]> = {
  verse: ["generate"],
  tn: ["notes"],
  tq: ["tqs"],
  twl: [],
};

// Returns the first non-terminal job covering this (book, chapter) that writes
// `resource`, or null if that resource is unlocked. Omit `resource` to ask
// "is anything running here?" (book reimport, which rewrites everything).
// Locks are global across users — any translator's pipeline locks the resource
// for everyone, by design.
export async function activePipelineForChapter(
  env: Env,
  book: string,
  chapter: number,
  resource?: LockedResource,
): Promise<ActiveLock | null> {
  const types = resource ? WRITERS[resource] : null;
  if (types && types.length === 0) return null;
  const statePlaceholders = NON_TERMINAL.map((_, i) => `?${i + 3}`).join(", ");
  const typeClause = types
    ? ` AND pipeline_type IN (${types.map((_, i) => `?${i + 3 + NON_TERMINAL.length}`).join(", ")})`
    : "";
  const row = await env.DB.prepare(
    `SELECT job_id, pipeline_type, user_id, created_at
       FROM pipeline_jobs
      WHERE book = ?1
        AND start_chapter <= ?2 AND end_chapter >= ?2
        AND state IN (${statePlaceholders})${typeClause}
      ORDER BY created_at ASC
      LIMIT 1`,
  )
    .bind(book.toUpperCase(), chapter, ...NON_TERMINAL, ...(types ?? []))
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
