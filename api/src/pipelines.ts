// Thin proxy + queue + tracker for the bp-assistant pipeline endpoints (see
// docs/ai-pipeline-integration.md and the partner contract). State lives in
// D1 so polling survives a tab reload.
//
// Concurrency: the fly.io bot (uw-bt-bot) can only run ONE pipeline at a time.
// We enforce that globally here — POST /start enqueues a 'queued' row and a
// single dispatcher (dispatchNext) sends one job to the bot at a time, claiming
// the slot with an atomic D1 UPDATE...WHERE NOT EXISTS(active). Follow-up /
// macro-chain steps enqueue with priority=1 so they jump the line and a macro
// completes as one unit. Translators see their queue position and can cancel a
// job that hasn't reached the front yet. See migration 0026_pipeline_queue.sql.
//
// Auth: every route requires a JWT (requireEditor). The shared BT_API_TOKEN
// (same secret used by /api/tn-quick) authorizes us upstream. The translator's
// DCS username is injected from the JWT / DB — never from the request body — so
// a caller can't attribute runs to other users.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { currentUserId, requireEditor } from "./auth";
import { importJobOutput } from "./pipelineImport";

export const pipelines = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string };
}>();

const DEFAULT_BASE = "https://uw-bt-bot.fly.dev";

const PIPELINE_TYPES = ["generate", "notes", "tqs"] as const;
type PipelineType = (typeof PIPELINE_TYPES)[number];

// States that occupy the single bot slot. While any job is in one of these,
// dispatchNext refuses to send another job upstream. 'dispatching' is the
// transient "claimed the slot, upstream POST in flight" state.
const ACTIVE_STATES = [
  "running",
  "paused_for_outage",
  "paused_for_usage_limit",
  "dispatching",
] as const;

// States the list endpoint surfaces by default (non-terminal work plus the
// retry-able 'failed'). 'queued'/'dispatching' join the originals so the chip
// shows pending work; 'cancelled'/'done' are terminal and only surface via
// the unnotified-terminal path.
const NON_TERMINAL_STATES = new Set([
  "queued",
  "dispatching",
  "running",
  "paused_for_outage",
  "paused_for_usage_limit",
  "failed",
]);

// Mirrors the bp-assistant contract (docs/ai-pipeline-integration.md §3).
// .strict() rejects unknown keys so a typo here surfaces as a 400 rather
// than getting silently dropped on its way upstream. Mutual-exclusion of
// the align flags is checked client-side AND server-side here AND in
// bp-assistant — three layers of paranoia is appropriate for a 1h run.
const PipelineOptions = z
  .object({
    model: z.enum(["sonnet", "opus"]).optional(),
    fresh: z.boolean().optional(),
    // generate-only
    contentTypes: z.array(z.enum(["ult", "ust"])).min(1).max(2).optional(),
    noAlign: z.boolean().optional(),
    alignOnly: z.boolean().optional(),
    textOnly: z.boolean().optional(),
    // notes-only
    noIntro: z.boolean().optional(),
    pauseBeforeATs: z.boolean().optional(),
  })
  .strict()
  .refine(
    (o) => [o.noAlign, o.alignOnly, o.textOnly].filter(Boolean).length <= 1,
    { message: "align_flags_mutually_exclusive" },
  );

// One step of a cross-type follow-up chain (e.g. the "Generate everything"
// macro: generate -> notes -> tqs). Same scope as the parent; only the
// pipelineType + options differ. The chain is a linked list — each row
// stores its remainder, and on each done-transition the next step is
// enqueued with its own remainder.
const ChainStep = z
  .object({
    pipelineType: z.enum(PIPELINE_TYPES),
    options: PipelineOptions.optional(),
  })
  .strict();

const StartBody = z
  .object({
    pipelineType: z.enum(PIPELINE_TYPES),
    book: z.string().min(1).max(8),
    startChapter: z.number().int().positive(),
    endChapter: z.number().int().positive().optional(),
    sessionKey: z.string().min(1).max(120).regex(/^[A-Za-z0-9_\-/]+$/),
    options: PipelineOptions.optional(),
    // Optional second pipeline to fire on the parent's done-transition. Used
    // to express asymmetric ULT/UST alignment (e.g. ULT aligned + UST text-
    // only) since the upstream contract can't carry asymmetric flags in one
    // call. Same scope/pipelineType — only the options differ. See
    // docs/ai-pipeline-handoff.md.
    followUpOptions: PipelineOptions.optional(),
    // Optional cross-type chain. First entry fires on the parent's done-
    // transition; subsequent entries are stored on the new row's
    // follow_up_chain and fire in turn. Used by the chapter macro to chain
    // generate -> notes -> tqs. Mutually exclusive with followUpOptions
    // (we'd otherwise need to define an ordering between them).
    followUpChain: z.array(ChainStep).min(1).max(4).optional(),
  })
  .refine((b) => !(b.followUpOptions && b.followUpChain), {
    message: "follow_up_options_and_chain_mutually_exclusive",
  });

interface StartResponse {
  jobId: string;
  scope: { book: string; startChapter: number; endChapter: number };
  status: "running" | "queued" | "already_running";
  queuePosition?: number;
}

interface StatusResponse {
  jobId: string;
  pipelineType: string;
  scope: { book: string; startChapter: number; endChapter: number };
  state: string;
  current?: {
    chapter: number;
    skill: string;
    status: string;
    startedAt: string;
    errorKind?: string;
    error?: string;
  };
  updatedAt: string;
  createdAt: string;
  interrupted?: boolean;
  output?: Array<{
    type: string;
    repo: string;
    branch: string;
    path: string;
    rawUrl: string;
    prNumber: number;
    mergedAt: string;
    commitSha: string;
  }>;
}

function upstreamBase(env: Env): string {
  return env.PIPELINE_API_BASE || DEFAULT_BASE;
}

async function resolveUsernameFromDb(env: Env, userId: number): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT dcs_username FROM users WHERE id = ?1`,
  )
    .bind(userId)
    .first<{ dcs_username: string }>();
  return row?.dcs_username ?? null;
}

async function resolveUsername(c: {
  env: Env;
  get: (k: "username") => string | undefined;
}, userId: number): Promise<string | null> {
  const fromJwt = c.get("username");
  if (fromJwt) return fromJwt;
  return resolveUsernameFromDb(c.env, userId);
}

interface PolledJob {
  job_id: string;
  upstream_job_id: string | null;
  user_id: number;
  pipeline_type: string;
  book: string;
  start_chapter: number;
  end_chapter: number;
  session_key: string;
  follow_up_options: string | null;
  follow_up_chain: string | null;
  follow_up_job_id: string | null;
  no_output_yet: number;
  // Prior poll's error_kind. Lets us detect a *repeated* import failure so a
  // deterministically-bad apply force-fails instead of holding the slot/lock.
  error_kind: string | null;
}

interface ChainStepValue {
  pipelineType: PipelineType;
  options?: unknown;
}

// Public summary of a single job — same shape the menu's 409 conflict dialog
// already renders, reused for "what's running ahead of you" in the queue UI.
interface PublicJobSummary {
  job_id: string;
  pipeline_type: string;
  book: string;
  start_chapter: number;
  end_chapter: number;
  state: string;
  current_skill: string | null;
  current_status: string | null;
  created_at: number;
  updated_at: number;
  started_by_username: string | null;
}

// ── Queue helpers ──────────────────────────────────────────────────────────

const ACTIVE_PLACEHOLDERS = ACTIVE_STATES.map((_, i) => `?${i + 1}`).join(",");

// Snapshot of the global queue: the single active job (if any), the ordered
// list of queued job_ids, and a per-job position map. Position is 1-based and
// counts the active job — so the first queued job behind a running one is #2.
async function queueSnapshot(env: Env): Promise<{
  activeJob: PublicJobSummary | null;
  activeCount: number;
  queuedCount: number;
  positions: Map<string, { position: number; ahead: number }>;
}> {
  const activeRs = await env.DB.prepare(
    `SELECT j.job_id, j.pipeline_type, j.book, j.start_chapter, j.end_chapter,
            j.state, j.current_skill, j.current_status, j.created_at, j.updated_at,
            u.dcs_username AS started_by_username
       FROM pipeline_jobs j
       LEFT JOIN users u ON u.id = j.user_id
      WHERE j.state IN (${ACTIVE_PLACEHOLDERS})
      ORDER BY j.created_at ASC`,
  )
    .bind(...ACTIVE_STATES)
    .all<PublicJobSummary>();
  const active = activeRs.results ?? [];
  const activeCount = active.length;

  const queuedRs = await env.DB.prepare(
    `SELECT job_id FROM pipeline_jobs
      WHERE state = 'queued'
      ORDER BY priority DESC, created_at ASC`,
  ).all<{ job_id: string }>();
  const queued = queuedRs.results ?? [];

  const positions = new Map<string, { position: number; ahead: number }>();
  queued.forEach((row, i) => {
    positions.set(row.job_id, { position: activeCount + i + 1, ahead: activeCount + i });
  });

  return {
    activeJob: active[0] ?? null,
    activeCount,
    queuedCount: queued.length,
    positions,
  };
}

// Atomically claim the single bot slot for the highest-priority oldest queued
// job, then send it upstream. Safe under concurrent invocation: the claim is
// one UPDATE...WHERE NOT EXISTS(active) statement, which D1 serializes — only
// one caller can flip a row to 'dispatching' while no other job is active.
// No-op when the queue is empty or the slot is busy. On upstream failure the
// job is marked 'failed' (freeing the slot) rather than retried, so we never
// auto-launch a second concurrent run.
export async function dispatchNext(env: Env): Promise<void> {
  if (!env.BT_API_TOKEN) return;

  // Claim: promote the head queued row to 'dispatching' iff nothing is active.
  const claim = await env.DB.prepare(
    `UPDATE pipeline_jobs
        SET state = 'dispatching', updated_at = unixepoch()
      WHERE job_id = (
              SELECT job_id FROM pipeline_jobs
               WHERE state = 'queued'
               ORDER BY priority DESC, created_at ASC
               LIMIT 1
            )
        AND NOT EXISTS (
              SELECT 1 FROM pipeline_jobs WHERE state IN (${ACTIVE_PLACEHOLDERS})
            )`,
  )
    .bind(...ACTIVE_STATES)
    .run();
  if ((claim.meta?.changes ?? 0) === 0) return; // nothing to dispatch / slot busy

  // By invariant there is now exactly one 'dispatching' row — the one we just
  // claimed (the NOT EXISTS guard above prevents a second).
  const job = await env.DB.prepare(
    `SELECT job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
            session_key, options_json
       FROM pipeline_jobs WHERE state = 'dispatching' LIMIT 1`,
  ).first<{
    job_id: string;
    user_id: number;
    pipeline_type: string;
    book: string;
    start_chapter: number;
    end_chapter: number;
    session_key: string;
    options_json: string | null;
  }>();
  if (!job) return;

  const fail = async (kind: string, message: string) => {
    await env.DB.prepare(
      `UPDATE pipeline_jobs
          SET state = 'failed', error_kind = ?2, error_message = ?3,
              updated_at = unixepoch()
        WHERE job_id = ?1`,
    )
      .bind(job.job_id, kind, message.slice(0, 500))
      .run();
  };

  const username = await resolveUsernameFromDb(env, job.user_id);
  if (!username) {
    await fail("sdk_error", "username_missing");
    return;
  }

  let options: unknown;
  if (job.options_json) {
    try {
      options = JSON.parse(job.options_json);
    } catch {
      /* corrupt snapshot — dispatch without options rather than wedge */
    }
  }

  const upstreamBody = {
    pipelineType: job.pipeline_type,
    book: job.book,
    startChapter: job.start_chapter,
    endChapter: job.end_chapter,
    username,
    sessionKey: job.session_key,
    ...(options ? { options } : {}),
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${upstreamBase(env)}/api/pipeline/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.BT_API_TOKEN}`,
      },
      body: JSON.stringify(upstreamBody),
    });
  } catch {
    await fail("transient_outage", "upstream_unreachable");
    return;
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    await fail("sdk_error", `upstream ${upstream.status}: ${text.slice(0, 200)}`);
    return;
  }
  let parsed: { jobId?: string } | null = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* fall through to malformed handling */
  }
  if (!parsed || typeof parsed.jobId !== "string") {
    await fail("missing_output", `upstream missing jobId: ${text.slice(0, 200)}`);
    return;
  }

  // Slot is ours and upstream accepted — record the bot's id and go running.
  await env.DB.prepare(
    `UPDATE pipeline_jobs
        SET state = 'running', upstream_job_id = ?2, updated_at = unixepoch()
      WHERE job_id = ?1`,
  )
    .bind(job.job_id, parsed.jobId)
    .run();
}

// Shared "fetch upstream, run import, update DB, fire follow-up" body used
// by both the GET handler and the scheduled cron poller. Returns the raw
// upstream response so callers that need to pass it through can do so;
// scheduled callers discard.
async function pollPipelineJob(
  env: Env,
  job: PolledJob,
): Promise<
  | { kind: "unreachable" }
  | { kind: "non_ok"; text: string; status: number }
  | { kind: "malformed"; text: string }
  | { kind: "ok"; text: string; status: number; state: string }
> {
  // A job without an upstream id hasn't reached the bot yet (queued or being
  // dispatched). Nothing to poll — callers handle these via queueSnapshot.
  if (!job.upstream_job_id) {
    return { kind: "ok", text: "{}", status: 200, state: "queued" };
  }
  let upstream: Response;
  try {
    upstream = await fetch(
      `${upstreamBase(env)}/api/pipeline/${encodeURIComponent(job.upstream_job_id)}`,
      { headers: { Authorization: `Bearer ${env.BT_API_TOKEN}` } },
    );
  } catch {
    return { kind: "unreachable" };
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    return { kind: "non_ok", text, status: upstream.status };
  }

  let data: StatusResponse | null = null;
  try {
    data = JSON.parse(text) as StatusResponse;
  } catch {
    return { kind: "malformed", text };
  }

  const shouldImport =
    job.no_output_yet === 1 &&
    data.state === "done" &&
    Array.isArray(data.output) &&
    data.output.length > 0;
  let importFailed = false;
  let importErrMessage: string | null = null;
  if (shouldImport && data.output) {
    try {
      const importResult = await importJobOutput(
        env,
        {
          jobId: job.job_id,
          pipelineType: job.pipeline_type,
          book: job.book,
          startChapter: job.start_chapter,
          endChapter: job.end_chapter,
        },
        data.output,
      );
      if (importResult.claimLost) {
        // A concurrent poll (the other of cron / open-tab) owns this import and
        // may still be mid-apply. Do NOT fall through to the finalize+follow-up
        // block: writing output_json / state='done' here would mark the import
        // complete before the owning poll's apply finishes, and if that poll
        // then fails the set output_json would suppress the retry. Return the
        // upstream status unchanged; the owning poll finalizes when it's done,
        // and the next poll (or this client's next tick) sees the result.
        return { kind: "ok", text, status: upstream.status, state: data.state ?? "running" };
      }
    } catch (err) {
      importFailed = true;
      importErrMessage = err instanceof Error ? err.message : String(err);
      console.error(`[pipelineImport] job=${job.job_id} failed:`, err);
    }
  }

  // When the local apply fails, hold state at 'running' for ONE retry so the
  // */5 cron re-imports (upstream is idempotent — its 'done' state sticks, so
  // the next poll hits the same shouldImport branch). This recovers a transient
  // failure (e.g. a D1 write hiccup). But 'running' both occupies the single
  // bot dispatch slot and globally locks the chapter for writes — so a
  // *deterministically* bad apply (malformed output that throws identically
  // every time) must not ride the 8h MAX_POLL_ATTEMPTS / 48h guards. If the
  // prior poll already failed the import, give up now: force 'failed', which is
  // terminal and frees both the slot (dispatchNext below) and the chapter lock.
  // Surface the failure via error_kind either way so the UI can flag it.
  // The bot sets interrupted:true when its process died mid-run and the job
  // was not resumed (a crash during a skill). It then keeps returning the
  // frozen last-known state='running' on every poll, so without honoring this
  // flag we hold the bot slot AND the chapter write-lock until the blunt
  // MAX_POLL_ATTEMPTS backstop (~8h of polling; took ~26h in the wild). The bot
  // is telling us the run is dead — fail it now and free both. (justplainjane47
  // ISA 41 notes, 2026-06-20: bot EACCES'd writing notes.log, reported
  // interrupted:true for ~26h before the poll-count backstop caught it.) Healthy
  // jobs report interrupted:false, including on done, so this only fires on a
  // genuinely interrupted, still-non-terminal run.
  const upstreamInterrupted =
    data.interrupted === true &&
    data.state !== "done" &&
    data.state !== "failed" &&
    data.state !== "cancelled";

  const importFailedAgain = importFailed && job.error_kind === "import_failed";
  const effectiveState = importFailed
    ? importFailedAgain
      ? "failed"
      : "running"
    : upstreamInterrupted
      ? "failed"
      : (data.state ?? "running");
  const effectiveErrorKind = importFailed
    ? "import_failed"
    : upstreamInterrupted
      ? "interrupted"
      : (data.current?.errorKind ?? null);
  const effectiveErrorMessage = importFailed
    ? importErrMessage
    : upstreamInterrupted
      ? (data.current?.error ?? "upstream reported interrupted")
      : (data.current?.error ?? null);

  await env.DB.prepare(
    `UPDATE pipeline_jobs SET
       state = ?2,
       current_skill = ?3,
       current_status = ?4,
       error_kind = ?5,
       error_message = ?6,
       output_json = ?7,
       raw_status_json = ?8,
       updated_at = unixepoch(),
       last_polled_at = unixepoch()
     WHERE job_id = ?1`,
  )
    .bind(
      job.job_id,
      effectiveState,
      data.current?.skill ?? null,
      data.current?.status ?? null,
      effectiveErrorKind,
      effectiveErrorMessage,
      data.output && !importFailed ? JSON.stringify(data.output) : null,
      text,
    )
    .run();

  // Gate followups on !importFailed: the chain assumes the parent's rows
  // are in D1 (e.g. the next step's prompt builder reads them). Without
  // this, an upstream-done-but-import-failed run would still trigger
  // notes -> tqs against an unimported parent.
  if (data.state === "done" && !importFailed && !job.follow_up_job_id) {
    try {
      const username = await resolveUsernameFromDb(env, job.user_id);
      if (username && job.follow_up_chain) {
        await enqueueFollowUpFromChain(env, {
          parentJobId: job.job_id,
          parentSessionKey: job.session_key,
          book: job.book,
          startChapter: job.start_chapter,
          endChapter: job.end_chapter,
          chainJson: job.follow_up_chain,
          userId: job.user_id,
        });
      } else if (username && job.follow_up_options) {
        await enqueueFollowUp(env, {
          parentJobId: job.job_id,
          parentSessionKey: job.session_key,
          pipelineType: job.pipeline_type as PipelineType,
          book: job.book,
          startChapter: job.start_chapter,
          endChapter: job.end_chapter,
          followUpOptionsJson: job.follow_up_options,
          userId: job.user_id,
        });
      }
    } catch (err) {
      console.error(`[pipelineFollowUp] job=${job.job_id} failed:`, err);
    }
  }

  // On any terminal transition the bot slot is now free — pull the next job
  // (the priority=1 follow-up just enqueued, if any, wins). A first import
  // failure holds the job at 'running' (one retry) so it won't free the slot
  // here; a repeated one force-fails above and falls into this branch.
  if (effectiveState === "done" || effectiveState === "failed") {
    try {
      await dispatchNext(env);
    } catch (err) {
      console.error(`[dispatchNext] after job=${job.job_id}:`, err);
    }
  }

  // If the local apply failed, the upstream JSON still says state='done'.
  // The GET handler returns this text verbatim, so without adjustment the
  // client would mark the job complete and stop polling. Rewrite the
  // response to match what we actually stored.
  let responseText = text;
  if (importFailed) {
    const adjusted = {
      ...data,
      state: effectiveState,
      current: {
        ...(data.current ?? { chapter: 0, skill: "", status: "", startedAt: "" }),
        errorKind: "import_failed",
        error: importErrMessage ?? "import failed",
      },
    };
    responseText = JSON.stringify(adjusted);
  } else if (upstreamInterrupted) {
    // Upstream still says 'running'; we stored 'failed'. Rewrite so a tab
    // polling this job by id sees terminal and stops polling.
    responseText = JSON.stringify({
      ...data,
      state: "failed",
      current: {
        ...(data.current ?? { chapter: 0, skill: "", status: "", startedAt: "" }),
        errorKind: "interrupted",
        error: data.current?.error ?? "upstream reported interrupted",
      },
    });
  }

  return { kind: "ok", text: responseText, status: upstream.status, state: effectiveState };
}

// Two days. A non-terminal job that hasn't moved in this long is almost
// certainly orphaned (bot crashed mid-run, infra wedge, etc) — auto-fail it
// so the cron stops re-polling indefinitely. Translator can still re-trigger
// from the UI; the failed row will be replaced on the next start.
const STUCK_JOB_THRESHOLD_SECONDS = 86400 * 2;

// Belt-and-suspenders for jobs that keep returning state="running" forever
// (some upstream failure modes refresh updated_at on every poll). ~100 polls
// at the */5 cron cadence ≈ 8 hours; well past any legitimate slow run.
const MAX_POLL_ATTEMPTS = 100;

// A 'dispatching' row is mid-flight on the upstream POST, which returns in
// seconds. Anything stuck this long is a Worker that died between claiming the
// slot and recording the result — fail it (don't auto-re-dispatch) so we never
// risk launching a second concurrent run, and free the slot for the queue.
const STUCK_DISPATCH_THRESHOLD_SECONDS = 120;

// Polls every non-terminal pipeline_job. Designed for the scheduled
// handler — runs in parallel with per-job error isolation so one stuck
// upstream call doesn't drag the batch down.
export async function pollAllNonTerminal(env: Env): Promise<void> {
  if (!env.BT_API_TOKEN) return;
  await env.DB.prepare(
    `UPDATE pipeline_jobs
        SET state = 'failed',
            error_kind = 'interrupted',
            error_message = 'auto-failed: no progress for 48h',
            updated_at = unixepoch()
      WHERE state IN ('running', 'paused_for_outage', 'paused_for_usage_limit')
        AND updated_at < unixepoch() - ?1`,
  )
    .bind(STUCK_JOB_THRESHOLD_SECONDS)
    .run();
  // Auto-fail anything that has been polled more than MAX_POLL_ATTEMPTS times
  // without reaching a terminal state. Independent backstop from the time-
  // based one above — catches the "fresh updated_at but never done" case.
  await env.DB.prepare(
    `UPDATE pipeline_jobs
        SET state = 'failed',
            error_kind = 'interrupted',
            error_message = 'auto-failed: poll attempts exhausted',
            updated_at = unixepoch()
      WHERE state IN ('running', 'paused_for_outage', 'paused_for_usage_limit')
        AND attempt_count > ?1`,
  )
    .bind(MAX_POLL_ATTEMPTS)
    .run();
  // Recover wedged dispatches so a dead-mid-POST Worker can't hold the slot
  // forever.
  await env.DB.prepare(
    `UPDATE pipeline_jobs
        SET state = 'failed',
            error_kind = 'interrupted',
            error_message = 'auto-failed: dispatch did not complete',
            updated_at = unixepoch()
      WHERE state = 'dispatching'
        AND updated_at < unixepoch() - ?1`,
  )
    .bind(STUCK_DISPATCH_THRESHOLD_SECONDS)
    .run();
  const rs = await env.DB.prepare(
    `SELECT job_id, upstream_job_id, user_id, pipeline_type, book, start_chapter,
            end_chapter, session_key, follow_up_options, follow_up_chain,
            follow_up_job_id, error_kind, (output_json IS NULL) AS no_output_yet
       FROM pipeline_jobs
      WHERE state IN ('running', 'paused_for_outage', 'paused_for_usage_limit')
      ORDER BY updated_at ASC
      LIMIT 50`,
  ).all<PolledJob>();
  const jobs = rs.results ?? [];
  if (jobs.length > 0) {
    // Bump attempt_count for everything we're about to poll, in one batch. We
    // do this BEFORE the upstream calls so a Worker crash doesn't undo the
    // increment — the cap is the whole point of this column.
    await env.DB.prepare(
      `UPDATE pipeline_jobs
          SET attempt_count = attempt_count + 1
        WHERE job_id IN (${jobs.map((_, i) => `?${i + 1}`).join(",")})`,
    )
      .bind(...jobs.map((j) => j.job_id))
      .run();
    await Promise.allSettled(
      jobs.map((j) =>
        pollPipelineJob(env, j).catch((err) => {
          console.error(`[scheduled.pipelinePoll] job=${j.job_id}:`, err);
        }),
      ),
    );
  }

  // Safety net: if the slot is free and something is queued, dispatch it. This
  // covers a terminal transition whose inline dispatchNext was missed (e.g. a
  // Worker crash) and the first job after the bot was idle.
  try {
    await dispatchNext(env);
  } catch (err) {
    console.error("[scheduled.dispatchNext]:", err);
  }
}

// POST /api/pipelines/start
pipelines.post("/start", requireEditor, async (c) => {
  if (!c.env.BT_API_TOKEN) {
    return c.json({ error: "pipeline_api_disabled" }, 503);
  }
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = StartBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  }

  const username = await resolveUsername(c, userId);
  if (!username) return c.json({ error: "username_missing" }, 400);

  const startChapter = parsed.data.startChapter;
  const endChapter = parsed.data.endChapter ?? startChapter;
  const book = parsed.data.book.toUpperCase();

  // De-dup against our own queue/active set before enqueueing (replaces
  // relying on the bot's same-scope 409, which can't see our queue). Same
  // user + same scope/type → focus the existing job. Different user → the
  // enriched 409 the menu renders as an "Already running / queued" dialog.
  const dup = await c.env.DB.prepare(
    `SELECT j.job_id, j.user_id, j.pipeline_type, j.book, j.start_chapter,
            j.end_chapter, j.state, j.current_skill, j.current_status,
            j.created_at, j.updated_at, u.dcs_username AS started_by_username
       FROM pipeline_jobs j
       LEFT JOIN users u ON u.id = j.user_id
      WHERE j.book = ?1 AND j.start_chapter = ?2 AND j.end_chapter = ?3
        AND j.pipeline_type = ?4
        AND j.state IN ('queued', 'dispatching', 'running',
                        'paused_for_outage', 'paused_for_usage_limit')
      ORDER BY j.created_at ASC
      LIMIT 1`,
  )
    .bind(book, startChapter, endChapter, parsed.data.pipelineType)
    .first<PublicJobSummary & { user_id: number }>();
  if (dup) {
    if (dup.user_id === userId) {
      const resp: StartResponse = {
        jobId: dup.job_id,
        scope: { book, startChapter, endChapter },
        status: "already_running",
      };
      return c.json(resp);
    }
    return c.json(
      {
        error: "conflict",
        jobId: dup.job_id,
        existing: {
          job_id: dup.job_id,
          pipeline_type: dup.pipeline_type,
          book: dup.book,
          start_chapter: dup.start_chapter,
          end_chapter: dup.end_chapter,
          state: dup.state,
          current_skill: dup.current_skill,
          current_status: dup.current_status,
          created_at: dup.created_at,
          updated_at: dup.updated_at,
          started_by_username: dup.started_by_username,
        },
      },
      409,
    );
  }

  // For notes pipelines, gather any hint=1 stubs the editor has queued in
  // the chapter range and fold them into options.hints. The proxy is the
  // authoritative source (not the client) so D1 state at start time wins
  // over any stale local cache. bp-assistant echoes each hint's rowId back
  // as the TSV ID column for the expanded row, which is how the apply
  // phase correlates expansion → stub. See docs/bp-assistant-tn-hints-
  // contract.md for the full design.
  // Wider type for mergedOptions: hints is a server-added field, not part of
  // the client-validated PipelineOptions schema (clients never send it).
  let mergedOptions: Record<string, unknown> | undefined = parsed.data.options;
  if (parsed.data.pipelineType === "notes") {
    const hintRows = await c.env.DB.prepare(
      `SELECT id, verse, quote, support_reference, note
         FROM tn_rows
        WHERE book = ?1 AND chapter BETWEEN ?2 AND ?3
          AND hint = 1 AND deleted_at IS NULL
        ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
    )
      .bind(book, startChapter, endChapter)
      .all<{
        id: string;
        verse: number;
        quote: string | null;
        support_reference: string | null;
        note: string | null;
      }>();
    const hints = (hintRows.results ?? []).map((r) => ({
      rowId: r.id,
      verse: r.verse,
      // Contract requires quote to be a string ("may be Hebrew, Greek, or
      // empty") — general-information hints have a null quote in D1, so coerce
      // to "" rather than sending null (upstream 400s on null). See
      // docs/bp-assistant-tn-hints-contract.md.
      quote: r.quote ?? "",
      supportReference: r.support_reference,
      seed: r.note,
    }));
    if (hints.length > 0) {
      mergedOptions = { ...(parsed.data.options ?? {}), hints };
    }
  }

  // Enqueue. The job goes to the bot only when dispatchNext claims the slot.
  const jobId = crypto.randomUUID();
  const optionsJson = mergedOptions ? JSON.stringify(mergedOptions) : null;
  const followUpJson = parsed.data.followUpOptions
    ? JSON.stringify(parsed.data.followUpOptions)
    : null;
  const followUpChainJson = parsed.data.followUpChain
    ? JSON.stringify(parsed.data.followUpChain)
    : null;
  await c.env.DB.prepare(
    `INSERT INTO pipeline_jobs (
       job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
       session_key, state, priority, options_json, follow_up_options,
       follow_up_chain, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', 0, ?8, ?9, ?10,
               unixepoch(), unixepoch())`,
  )
    .bind(
      jobId,
      userId,
      parsed.data.pipelineType,
      book,
      startChapter,
      endChapter,
      parsed.data.sessionKey,
      optionsJson,
      followUpJson,
      followUpChainJson,
    )
    .run();

  // Try to dispatch immediately — the common case (empty queue) goes straight
  // to running. dispatchNext claims the head of the queue, which may be a
  // higher-priority job than this one, so re-read this job's resulting state.
  try {
    await dispatchNext(c.env);
  } catch (err) {
    console.error("[start.dispatchNext]:", err);
  }

  const after = await c.env.DB.prepare(
    `SELECT state, error_message FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(jobId)
    .first<{ state: string; error_message: string | null }>();
  const state = after?.state ?? "queued";

  if (state === "running" || state === "dispatching") {
    const resp: StartResponse = {
      jobId,
      scope: { book, startChapter, endChapter },
      status: "running",
    };
    return c.json(resp);
  }
  if (state === "failed") {
    // This job won the slot but the upstream POST failed during its own
    // dispatch. Surface it so the menu toasts instead of pretending success.
    return c.json({ error: "upstream_error", message: after?.error_message ?? "dispatch failed" }, 502);
  }
  // Still queued — something else holds the slot or is ahead by priority.
  const snap = await queueSnapshot(c.env);
  const resp: StartResponse = {
    jobId,
    scope: { book, startChapter, endChapter },
    status: "queued",
    queuePosition: snap.positions.get(jobId)?.position,
  };
  return c.json(resp);
});

// GET /api/pipelines/:jobId
pipelines.get("/:jobId", requireEditor, async (c) => {
  if (!c.env.BT_API_TOKEN) {
    return c.json({ error: "pipeline_api_disabled" }, 503);
  }
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  if (!jobId) return c.json({ error: "missing_job_id" }, 400);

  // Ownership check before any upstream call — prevents jobId enumeration.
  // pollPipelineJob() handles fetch/import/update/follow-up; we just gate
  // it on the requester owning the job.
  const owned = await c.env.DB.prepare(
    `SELECT job_id, upstream_job_id, user_id, pipeline_type, book, start_chapter,
            end_chapter, session_key, follow_up_options, follow_up_chain,
            follow_up_job_id, error_kind, state, current_skill, current_status,
            created_at, updated_at, (output_json IS NULL) AS no_output_yet
       FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(jobId)
    .first<PolledJob & {
      state: string;
      current_skill: string | null;
      current_status: string | null;
      created_at: number;
      updated_at: number;
    }>();
  if (!owned) return c.json({ error: "not_found" }, 404);
  if (owned.user_id !== userId) return c.json({ error: "forbidden" }, 403);

  // Queued / dispatching jobs aren't on the bot yet — synthesize a status
  // payload from D1 plus the live queue position, no upstream round-trip.
  if (!owned.upstream_job_id) {
    const snap = await queueSnapshot(c.env);
    const pos = snap.positions.get(owned.job_id);
    return c.json({
      jobId: owned.job_id,
      pipelineType: owned.pipeline_type,
      scope: {
        book: owned.book,
        startChapter: owned.start_chapter,
        endChapter: owned.end_chapter,
      },
      state: owned.state,
      updatedAt: new Date(owned.updated_at * 1000).toISOString(),
      createdAt: new Date(owned.created_at * 1000).toISOString(),
      queuePosition: pos?.position,
      queueAhead: pos?.ahead,
    });
  }

  // A locally-terminal job is authoritative: once it's cancelled (by the user)
  // or done, don't re-poll upstream. A stale upstream 'running' would otherwise
  // clobber the terminal state back to 'running' on every poll — an open tab
  // polling this job_id by id resurrects a just-cancelled job each tick. Return
  // the stored state so the client sees terminal and stops polling.
  if (owned.state === "cancelled" || owned.state === "done") {
    return c.json({
      jobId: owned.job_id,
      pipelineType: owned.pipeline_type,
      scope: {
        book: owned.book,
        startChapter: owned.start_chapter,
        endChapter: owned.end_chapter,
      },
      state: owned.state,
      updatedAt: new Date(owned.updated_at * 1000).toISOString(),
      createdAt: new Date(owned.created_at * 1000).toISOString(),
    });
  }

  const result = await pollPipelineJob(c.env, owned);
  if (result.kind === "unreachable") return c.json({ error: "upstream_unreachable" }, 502);
  if (result.kind === "malformed") return c.json({ error: "upstream_malformed" }, 502);
  return new Response(result.text, {
    status: result.status,
    headers: { "Content-Type": "application/json" },
  });
});

interface FollowUpInput {
  parentJobId: string;
  parentSessionKey: string;
  pipelineType: PipelineType;
  book: string;
  startChapter: number;
  endChapter: number;
  followUpOptionsJson: string;
  userId: number;
}

// Enqueues the parent's queued same-type follow-up as a fresh priority=1
// pipeline_jobs row (asymmetric ULT/UST alignment). It does NOT call the bot —
// dispatchNext sends it upstream when the slot frees, which (priority=1) is
// ahead of other users' queued jobs so the pair stays together. The child's
// job_id is derived deterministically from the parent so two concurrent polls
// collapse via ON CONFLICT DO NOTHING; the parent claim guard makes the whole
// thing idempotent.
async function enqueueFollowUp(env: Env, input: FollowUpInput): Promise<void> {
  const followUpOptions = input.followUpOptionsJson; // already JSON text
  // Derive a sessionKey that fits the same character class as the parent's
  // (POST validator: ^[A-Za-z0-9_\-/]+$). The "/followup" suffix avoids
  // colliding with the parent on the upstream dedup key.
  const childSessionKey = `${input.parentSessionKey}/followup`;
  const childJobId = `${input.parentJobId}:followup`;

  // Claim + insert as one atomic batch so a crash between them can't orphan
  // the child or lose the follow-up. The parent guard (follow_up_job_id IS
  // NULL) means only the first poll wins; the deterministic childJobId means a
  // racing second poll's INSERT collapses via ON CONFLICT DO NOTHING.
  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE pipeline_jobs SET follow_up_job_id = ?1
          WHERE job_id = ?2 AND follow_up_job_id IS NULL`,
      )
      .bind(childJobId, input.parentJobId),
    env.DB
      .prepare(
        `INSERT INTO pipeline_jobs (
           job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
           session_key, state, priority, options_json, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', 1, ?8, unixepoch(), unixepoch())
         ON CONFLICT(job_id) DO NOTHING`,
      )
      .bind(
        childJobId,
        input.userId,
        input.pipelineType,
        input.book,
        input.startChapter,
        input.endChapter,
        childSessionKey,
        followUpOptions,
      ),
  ]);
}

interface FollowUpChainInput {
  parentJobId: string;
  parentSessionKey: string;
  book: string;
  startChapter: number;
  endChapter: number;
  chainJson: string;
  userId: number;
}

// Enqueues the next step of a cross-type chain (e.g. generate -> notes -> tqs)
// on a parent done-transition. Pops the first chain element, uses it as the
// child's pipelineType + options, and stores the remainder on the child row
// so the same logic fires the next step when this child completes. Same
// priority=1 + atomic-batch + deterministic-id idempotency as enqueueFollowUp.
async function enqueueFollowUpFromChain(env: Env, input: FollowUpChainInput): Promise<void> {
  let chain: ChainStepValue[];
  try {
    chain = JSON.parse(input.chainJson) as ChainStepValue[];
  } catch {
    throw new Error(`invalid follow_up_chain JSON on ${input.parentJobId}`);
  }
  if (!Array.isArray(chain) || chain.length === 0) {
    return; // nothing to fire
  }
  const [next, ...rest] = chain;
  if (!next || !next.pipelineType) {
    throw new Error(`malformed chain head on ${input.parentJobId}`);
  }

  // Each chain link gets its own sessionKey suffix. Counting the depth keeps
  // upstream's (sessionKey, pipelineType, scope) dedup buckets distinct even
  // if two adjacent links happen to share a pipelineType.
  const depth = countChainSuffixes(input.parentSessionKey);
  const childSessionKey = `${input.parentSessionKey}/chain${depth + 1}`;
  const childJobId = `${input.parentJobId}:chain${depth + 1}`;
  const childChainJson = rest.length > 0 ? JSON.stringify(rest) : null;
  const childOptionsJson = next.options ? JSON.stringify(next.options) : null;

  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE pipeline_jobs SET follow_up_job_id = ?1
          WHERE job_id = ?2 AND follow_up_job_id IS NULL`,
      )
      .bind(childJobId, input.parentJobId),
    env.DB
      .prepare(
        `INSERT INTO pipeline_jobs (
           job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
           session_key, state, priority, options_json, follow_up_chain,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', 1, ?8, ?9, unixepoch(), unixepoch())
         ON CONFLICT(job_id) DO NOTHING`,
      )
      .bind(
        childJobId,
        input.userId,
        next.pipelineType,
        input.book,
        input.startChapter,
        input.endChapter,
        childSessionKey,
        childOptionsJson,
        childChainJson,
      ),
  ]);
}

function countChainSuffixes(sessionKey: string): number {
  const m = sessionKey.match(/\/chain(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

// GET /api/pipelines  — list current user's jobs from D1 (no upstream call).
// Reconciliation surface for the browser when a tab opens/reloads.
//
// Default behavior (no ?state= filter) returns:
//   - non-terminal jobs (queued, dispatching, running, paused_*, failed — the
//     failure case is listed even though terminal because the user might retry
//     it), AND
//   - terminal jobs that haven't been "notified" yet, so the browser can
//     fire a "while you were away" toast on first load after the server's
//     cron finished a job in the user's absence.
//
// Queued rows are annotated with their global queue position, and the response
// carries a `queue` summary (what's running, total queued) so the UI can show
// "what's ahead of you". An explicit ?state= filter overrides the default set.
pipelines.get("/", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const stateFilter = c.req.query("state");
  const stateList = stateFilter
    ? stateFilter
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  let rs;
  const columns = `job_id, upstream_job_id, user_id, pipeline_type, book,
            start_chapter, end_chapter, session_key, state, priority,
            current_skill, current_status, error_kind, error_message,
            output_json, follow_up_job_id, created_at, updated_at,
            last_polled_at, notified_user_at`;

  if (stateList === null) {
    // Default: non-terminal OR unnotified terminal. Keeps the "running set"
    // small (capped 100) while still surfacing any completed-while-away job
    // exactly once.
    const nonTerminal = Array.from(NON_TERMINAL_STATES);
    const placeholders = nonTerminal.map((_, i) => `?${i + 2}`).join(",");
    rs = await c.env.DB.prepare(
      `SELECT ${columns}
         FROM pipeline_jobs
        WHERE user_id = ?1
          AND (state IN (${placeholders}) OR notified_user_at IS NULL)
        ORDER BY updated_at DESC
        LIMIT 100`,
    )
      .bind(userId, ...nonTerminal)
      .all<PipelineRowSelect>();
  } else if (stateList.length === 0) {
    return c.json({ jobs: [], queue: { activeJob: null, queuedCount: 0 } });
  } else {
    const placeholders = stateList.map((_, i) => `?${i + 2}`).join(",");
    rs = await c.env.DB.prepare(
      `SELECT ${columns}
         FROM pipeline_jobs
        WHERE user_id = ?1 AND state IN (${placeholders})
        ORDER BY updated_at DESC
        LIMIT 100`,
    )
      .bind(userId, ...stateList)
      .all<PipelineRowSelect>();
  }

  const snap = await queueSnapshot(c.env);
  const jobs = (rs.results ?? []).map((row) => {
    if (row.state === "queued") {
      const pos = snap.positions.get(row.job_id);
      return { ...row, queue_position: pos?.position ?? null, queue_ahead: pos?.ahead ?? null };
    }
    return row;
  });

  return c.json({
    jobs,
    queue: { activeJob: snap.activeJob, queuedCount: snap.queuedCount },
  });
});

interface PipelineRowSelect {
  job_id: string;
  upstream_job_id: string | null;
  user_id: number;
  pipeline_type: PipelineType;
  book: string;
  start_chapter: number;
  end_chapter: number;
  session_key: string;
  state: string;
  priority: number;
  current_skill: string | null;
  current_status: string | null;
  error_kind: string | null;
  error_message: string | null;
  output_json: string | null;
  follow_up_job_id: string | null;
  created_at: number;
  updated_at: number;
  last_polled_at: number | null;
  notified_user_at: number | null;
}

// POST /api/pipelines/:jobId/cancel  — withdraw a job that hasn't reached the
// front of the line yet. Only 'queued' jobs are cancellable (they never
// touched the bot); a job that's already 'dispatching'/'running' or terminal
// returns 409. Sets notified_user_at so the cancelled row doesn't resurface as
// a "while you were away" item on the next reload.
pipelines.post("/:jobId/cancel", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  if (!jobId) return c.json({ error: "missing_job_id" }, 400);

  const owned = await c.env.DB.prepare(
    `SELECT user_id, state FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(jobId)
    .first<{ user_id: number; state: string }>();
  if (!owned) return c.json({ error: "not_found" }, 404);
  if (owned.user_id !== userId) return c.json({ error: "forbidden" }, 403);
  if (owned.state !== "queued") {
    return c.json({ error: "cannot_cancel", state: owned.state }, 409);
  }

  // Guard on state='queued' again in the UPDATE so a concurrent dispatch that
  // just claimed this row (queued -> dispatching) can't be cancelled out from
  // under the bot.
  const res = await c.env.DB.prepare(
    `UPDATE pipeline_jobs
        SET state = 'cancelled', notified_user_at = unixepoch(), updated_at = unixepoch()
      WHERE job_id = ?1 AND state = 'queued'`,
  )
    .bind(jobId)
    .run();
  if ((res.meta?.changes ?? 0) === 0) {
    const now = await c.env.DB.prepare(
      `SELECT state FROM pipeline_jobs WHERE job_id = ?1`,
    )
      .bind(jobId)
      .first<{ state: string }>();
    return c.json({ error: "cannot_cancel", state: now?.state ?? "unknown" }, 409);
  }
  return c.json({ ok: true, jobId, state: "cancelled" });
});

// POST /api/pipelines/:jobId/notified  — mark a terminal job as having
// surfaced a toast in the user's UI, so the next page load doesn't re-toast
// the same completion. Idempotent: setting notified_user_at on an already-
// notified job is a no-op (we only write where it's currently NULL).
pipelines.post("/:jobId/notified", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  if (!jobId) return c.json({ error: "missing_job_id" }, 400);

  const res = await c.env.DB.prepare(
    `UPDATE pipeline_jobs
        SET notified_user_at = unixepoch()
      WHERE job_id = ?1
        AND user_id = ?2
        AND notified_user_at IS NULL`,
  )
    .bind(jobId, userId)
    .run();

  // res.meta.changes is 0 if the row didn't exist, didn't belong to this
  // user, or was already notified. None of these are errors — the client
  // doesn't care.
  return c.json({ ok: true, changed: res.meta?.changes ?? 0 });
});
