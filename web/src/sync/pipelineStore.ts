// In-memory store for AI pipeline jobs (chapter-scale generation, ~1h runs).
// Mirrors the outbox.subscribe pattern so any component can render off it;
// jobs themselves are durably stored in D1 by the Worker, so we don't need
// IndexedDB here.
//
// Lifecycle:
//   1. init() loads non-terminal jobs from /api/pipelines (reconciliation
//      on tab open / reload).
//   2. While the tab is visible and there is at least one job in a
//      polling state (running / paused_*), tick every 2 minutes and call
//      /api/pipelines/{jobId} on each.
//   3. start(req) POSTs /api/pipelines/start; the returned jobId becomes
//      our local key. `already_running` is folded into the same flow.
//
// Phase 1 does not parse output[] back into D1 rows. On state=done we just
// retain the job record and emit a completion event so UI can toast.

import {
  api,
  ApiError,
  type PipelineErrorKind,
  type PipelineJobRow,
  type PipelineState,
  type PipelineStartRequest,
  type PipelineStartResponse,
  type PipelineStatusResponse,
  type PipelineType,
} from "./api";

const POLL_INTERVAL_MS = 120_000; // contract §5

const POLLING_STATES: ReadonlySet<PipelineState> = new Set([
  "running",
  "paused_for_outage",
  "paused_for_usage_limit",
]);
const NON_TERMINAL_STATES: ReadonlySet<PipelineState> = new Set([
  "running",
  "paused_for_outage",
  "paused_for_usage_limit",
  "failed",
]);

const SESSION_KEY_LS = "bible-editor.pipeline.sessionKey";

export type PipelineJob = PipelineJobRow;

type JobsListener = (jobs: PipelineJob[]) => void;
type CompletionListener = (job: PipelineJob, prev: PipelineState | null) => void;

const jobs = new Map<string, PipelineJob>();
const subscribers = new Set<JobsListener>();
const completionListeners = new Set<CompletionListener>();

let initStarted = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let visibilityBound = false;

function snapshot(): PipelineJob[] {
  return Array.from(jobs.values()).sort((a, b) => b.updated_at - a.updated_at);
}

function notify() {
  if (subscribers.size === 0) return;
  const list = snapshot();
  for (const s of subscribers) s(list);
}

function emitCompletion(job: PipelineJob, prev: PipelineState | null) {
  for (const l of completionListeners) l(job, prev);
}

// Read userId out of the JWT payload — same trick App.tsx uses elsewhere.
// We avoid /api/auth/me here so first-use isn't blocked on a round-trip.
function userIdFromToken(): number | null {
  try {
    const token = typeof localStorage !== "undefined"
      ? localStorage.getItem("bible-editor.auth.token")
      : null;
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(atob(parts[1]));
    const sub = parseInt(String(payload.sub), 10);
    return Number.isFinite(sub) ? sub : null;
  } catch {
    return null;
  }
}

export function getSessionKey(): string {
  try {
    const existing = localStorage.getItem(SESSION_KEY_LS);
    if (existing) return existing;
  } catch {
    /* private mode / no storage */
  }
  const userPart = userIdFromToken() ?? "anon";
  const fresh = `bible-editor/${userPart}/${crypto.randomUUID()}`;
  try {
    localStorage.setItem(SESSION_KEY_LS, fresh);
  } catch {
    /* ignore */
  }
  return fresh;
}

// Normalize the camelCase StatusResponse into the snake_case row shape so
// everything downstream renders from one type.
function rowFromStatus(prev: PipelineJob, status: PipelineStatusResponse): PipelineJob {
  const updatedTs = Date.parse(status.updatedAt);
  const createdTs = Date.parse(status.createdAt);
  return {
    ...prev,
    job_id: status.jobId ?? prev.job_id,
    pipeline_type: status.pipelineType ?? prev.pipeline_type,
    book: status.scope?.book ?? prev.book,
    start_chapter: status.scope?.startChapter ?? prev.start_chapter,
    end_chapter: status.scope?.endChapter ?? prev.end_chapter,
    state: status.state,
    current_skill: status.current?.skill ?? null,
    current_status: status.current?.status ?? null,
    error_kind: (status.current?.errorKind as PipelineErrorKind) ?? null,
    error_message: status.current?.error ?? null,
    output_json: status.output ? JSON.stringify(status.output) : prev.output_json,
    updated_at: Number.isFinite(updatedTs) ? Math.floor(updatedTs / 1000) : prev.updated_at,
    created_at: Number.isFinite(createdTs) ? Math.floor(createdTs / 1000) : prev.created_at,
    last_polled_at: Math.floor(Date.now() / 1000),
  };
}

function mergeAndNotify(jobId: string, next: PipelineJob) {
  const prev = jobs.get(jobId);
  jobs.set(jobId, next);
  if (prev && prev.state !== next.state && !NON_TERMINAL_STATES.has(next.state)) {
    // transitioned to a terminal state (done)
    emitCompletion(next, prev.state);
  } else if (prev && prev.state !== next.state && next.state === "failed") {
    emitCompletion(next, prev.state);
  }
  notify();
}

async function pollOne(jobId: string) {
  try {
    const status = await api.pipelineStatus(jobId);
    const prev = jobs.get(jobId);
    if (!prev) return;
    mergeAndNotify(jobId, rowFromStatus(prev, status));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      jobs.delete(jobId);
      notify();
      return;
    }
    // transient network / 5xx — leave the job as-is; next tick will retry.
  }
}

async function pollTick() {
  if (typeof document !== "undefined" && document.hidden) return;
  const active = Array.from(jobs.values()).filter((j) => POLLING_STATES.has(j.state));
  if (active.length === 0) return;
  await Promise.all(active.map((j) => pollOne(j.job_id)));
}

function ensurePolling() {
  if (pollTimer) return;
  if (typeof window === "undefined") return;
  pollTimer = setInterval(() => void pollTick(), POLL_INTERVAL_MS);
  if (!visibilityBound) {
    visibilityBound = true;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) void pollTick();
    });
  }
}

async function loadFromServer() {
  try {
    const res = await api.pipelineList();
    for (const row of res.jobs) {
      jobs.set(row.job_id, row);
    }
    notify();
    // After reconciling, immediately refresh each polling job from upstream
    // so the user sees the latest state without waiting for the 2-min tick.
    await pollTick();
  } catch {
    // 401 (no auth yet) or network — try again next time someone subscribes.
    initStarted = false;
  }
}

export const pipelineStore = {
  subscribe(fn: JobsListener): () => void {
    subscribers.add(fn);
    fn(snapshot());
    if (!initStarted) {
      initStarted = true;
      void loadFromServer().then(() => ensurePolling());
    } else {
      ensurePolling();
    }
    return () => {
      subscribers.delete(fn);
    };
  },

  onComplete(fn: CompletionListener): () => void {
    completionListeners.add(fn);
    return () => {
      completionListeners.delete(fn);
    };
  },

  get(jobId: string): PipelineJob | undefined {
    return jobs.get(jobId);
  },

  findActive(
    pipelineType: PipelineType,
    book: string,
    chapter: number,
  ): PipelineJob | undefined {
    for (const j of jobs.values()) {
      if (
        j.pipeline_type === pipelineType &&
        j.book === book &&
        j.start_chapter <= chapter &&
        j.end_chapter >= chapter &&
        NON_TERMINAL_STATES.has(j.state)
      ) {
        return j;
      }
    }
    return undefined;
  },

  async start(req: PipelineStartRequest): Promise<PipelineStartResponse> {
    const res = await api.pipelineStart(req);
    // Seed an optimistic row so the UI renders immediately. The next poll
    // will replace it with the canonical upstream shape.
    const now = Math.floor(Date.now() / 1000);
    const seeded: PipelineJob = {
      job_id: res.jobId,
      user_id: userIdFromToken() ?? 0,
      pipeline_type: req.pipelineType,
      book: res.scope.book,
      start_chapter: res.scope.startChapter,
      end_chapter: res.scope.endChapter,
      session_key: req.sessionKey,
      state: "running",
      current_skill: null,
      current_status: null,
      error_kind: null,
      error_message: null,
      output_json: null,
      created_at: now,
      updated_at: now,
      last_polled_at: null,
    };
    jobs.set(res.jobId, jobs.get(res.jobId) ?? seeded);
    notify();
    ensurePolling();
    // Eagerly fetch the canonical status so the UI doesn't sit on the
    // seed shape for 2 minutes.
    void pollOne(res.jobId);
    return res;
  },

  async refresh(jobId: string) {
    await pollOne(jobId);
  },
};
