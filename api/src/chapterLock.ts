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
//
// The single source of truth for this map. web/src/lib/pipelineWrites.ts is a
// verbatim mirror for the client — change both together.
export type LockedResource = "verse" | "tn" | "tq" | "twl";

export const ALL_LOCKED_RESOURCES: readonly LockedResource[] = ["verse", "tn", "tq", "twl"];

const PIPELINE_WRITES: Record<string, readonly LockedResource[]> = {
  generate: ["verse"],
  notes: ["tn"],
  tqs: ["tq"],
};

// Fail CLOSED on anything we don't recognize: a pipeline type added to
// api/src/pipelines.ts without a PIPELINE_WRITES entry locks everything, which
// is the old behavior. Silently locking nothing would let a translator edit
// straight into an overwrite.
export function resourcesWrittenBy(pipelineType: string): readonly LockedResource[] {
  return PIPELINE_WRITES[pipelineType] ?? ALL_LOCKED_RESOURCES;
}

// A chained run ("Generate everything for this chapter" = generate → notes →
// tqs) fires its steps one after another, each as its own job row, with the
// remaining steps parked on the running row's follow_up_chain. The lock has to
// cover the whole chain — otherwise a translator edits questions during the
// generate step and the chained tqs step overwrites them an hour later, which
// is exactly what migration 0012 means by "chapter lock holds across the full
// run". Unparseable chain JSON fails closed.
export function resourcesLockedByJob(
  pipelineType: string,
  followUpChain: string | null,
): Set<LockedResource> {
  const locked = new Set<LockedResource>(resourcesWrittenBy(pipelineType));
  if (!followUpChain) return locked;
  let steps: unknown;
  try {
    steps = JSON.parse(followUpChain);
  } catch {
    for (const r of ALL_LOCKED_RESOURCES) locked.add(r);
    return locked;
  }
  if (!Array.isArray(steps)) return locked;
  for (const step of steps) {
    const type = (step as { pipelineType?: unknown })?.pipelineType;
    for (const r of resourcesWrittenBy(typeof type === "string" ? type : "")) locked.add(r);
  }
  return locked;
}

// Returns the first non-terminal job covering this (book, chapter) that will
// write `resource` (itself or via a pending chain step), or null if that
// resource is unlocked. Omit `resource` to ask "is anything running here?"
// (book reimport, which rewrites everything). Locks are global across users —
// any translator's pipeline locks the resource for everyone, by design.
//
// The chain filter can't be expressed in SQL (it lives in a JSON column), so
// the query fetches the chapter's non-terminal jobs and the match runs here.
// The bot has one slot, so this is a handful of rows at most.
export async function activePipelineForChapter(
  env: Env,
  book: string,
  chapter: number,
  resource?: LockedResource,
): Promise<ActiveLock | null> {
  const statePlaceholders = NON_TERMINAL.map((_, i) => `?${i + 3}`).join(", ");
  const rs = await env.DB.prepare(
    `SELECT job_id, pipeline_type, user_id, created_at, follow_up_chain
       FROM pipeline_jobs
      WHERE book = ?1
        AND start_chapter <= ?2 AND end_chapter >= ?2
        AND state IN (${statePlaceholders})
      ORDER BY created_at ASC`,
  )
    .bind(book.toUpperCase(), chapter, ...NON_TERMINAL)
    .all<{
      job_id: string;
      pipeline_type: string;
      user_id: number;
      created_at: number;
      follow_up_chain: string | null;
    }>();
  for (const row of rs.results ?? []) {
    if (resource && !resourcesLockedByJob(row.pipeline_type, row.follow_up_chain).has(resource)) {
      continue;
    }
    return {
      jobId: row.job_id,
      pipelineType: row.pipeline_type,
      userId: row.user_id,
      startedAt: row.created_at,
    };
  }
  return null;
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
