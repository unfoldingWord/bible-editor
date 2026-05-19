// Thin proxy + tracker for the bp-assistant pipeline endpoints (see
// docs/ai-pipeline-integration.md and the partner contract). Phase 1 keeps
// state in D1 so polling survives a tab reload; we don't parse output yet.
//
// Auth: every route requires a JWT (requireEditor). The shared BT_API_TOKEN
// (same secret used by /api/tn-quick) authorizes us upstream. The translator's
// DCS username is injected from the JWT — never from the request body — so a
// caller can't attribute runs to other users.

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

const NON_TERMINAL_STATES = new Set([
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
// fired with its own remainder.
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
  status: "running" | "already_running";
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
}

interface ChainStepValue {
  pipelineType: PipelineType;
  options?: unknown;
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
  let upstream: Response;
  try {
    upstream = await fetch(
      `${upstreamBase(env)}/api/pipeline/${encodeURIComponent(job.job_id)}`,
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
  if (shouldImport && data.output) {
    try {
      await importJobOutput(
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
    } catch (err) {
      importFailed = true;
      console.error(`[pipelineImport] job=${job.job_id} failed:`, err);
    }
  }

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
      data.state ?? "running",
      data.current?.skill ?? null,
      data.current?.status ?? null,
      data.current?.errorKind ?? null,
      data.current?.error ?? null,
      data.output && !importFailed ? JSON.stringify(data.output) : null,
      text,
    )
    .run();

  if (data.state === "done" && !job.follow_up_job_id) {
    try {
      const username = await resolveUsernameFromDb(env, job.user_id);
      if (username && job.follow_up_chain) {
        await fireFollowUpFromChain(env, {
          parentJobId: job.job_id,
          parentSessionKey: job.session_key,
          book: job.book,
          startChapter: job.start_chapter,
          endChapter: job.end_chapter,
          chainJson: job.follow_up_chain,
          userId: job.user_id,
          username,
        });
      } else if (username && job.follow_up_options) {
        await fireFollowUp(env, {
          parentJobId: job.job_id,
          parentSessionKey: job.session_key,
          pipelineType: job.pipeline_type as PipelineType,
          book: job.book,
          startChapter: job.start_chapter,
          endChapter: job.end_chapter,
          followUpOptionsJson: job.follow_up_options,
          userId: job.user_id,
          username,
        });
      }
    } catch (err) {
      console.error(`[pipelineFollowUp] job=${job.job_id} failed:`, err);
    }
  }

  return { kind: "ok", text, status: upstream.status, state: data.state ?? "running" };
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
  const rs = await env.DB.prepare(
    `SELECT job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
            session_key, follow_up_options, follow_up_chain, follow_up_job_id,
            (output_json IS NULL) AS no_output_yet
       FROM pipeline_jobs
      WHERE state IN ('running', 'paused_for_outage', 'paused_for_usage_limit')
      ORDER BY updated_at ASC
      LIMIT 50`,
  ).all<PolledJob>();
  const jobs = rs.results ?? [];
  if (jobs.length === 0) return;
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
      quote: r.quote,
      supportReference: r.support_reference,
      seed: r.note,
    }));
    if (hints.length > 0) {
      mergedOptions = { ...(parsed.data.options ?? {}), hints };
    }
  }

  const upstreamBody = {
    pipelineType: parsed.data.pipelineType,
    book,
    startChapter,
    endChapter,
    username,
    sessionKey: parsed.data.sessionKey,
    ...(mergedOptions ? { options: mergedOptions } : {}),
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${upstreamBase(c.env)}/api/pipeline/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${c.env.BT_API_TOKEN}`,
      },
      body: JSON.stringify(upstreamBody),
    });
  } catch {
    return c.json({ error: "upstream_unreachable" }, 502);
  }

  const text = await upstream.text();
  let parsedUpstream: unknown = null;
  try {
    parsedUpstream = JSON.parse(text);
  } catch {
    /* keep as null; non-JSON upstream is a bug we want to surface */
  }

  // Pass non-2xx through verbatim (matches the contract's error shapes).
  if (!upstream.ok) {
    // 409 conflict means another sessionKey already has this (pipelineType,
    // scope) running upstream. The conflicting jobId is usually in our D1
    // already because every editor-triggered start inserts a row. Enrich the
    // response so translator B can see who's running it and how long ago
    // without a second round-trip or an ownership-bumping endpoint.
    if (upstream.status === 409 && parsedUpstream) {
      const conflict = parsedUpstream as { error?: string; jobId?: string };
      if (conflict.error === "conflict" && typeof conflict.jobId === "string") {
        const existing = await c.env.DB.prepare(
          `SELECT j.job_id, j.pipeline_type, j.book, j.start_chapter, j.end_chapter,
                  j.state, j.current_skill, j.current_status, j.created_at,
                  j.updated_at, u.dcs_username AS started_by_username
             FROM pipeline_jobs j
             LEFT JOIN users u ON u.id = j.user_id
            WHERE j.job_id = ?1`,
        )
          .bind(conflict.jobId)
          .first();
        if (existing) {
          return c.json({ ...conflict, existing }, 409);
        }
      }
    }
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const data = parsedUpstream as StartResponse | null;
  if (!data || typeof data.jobId !== "string") {
    return c.json({ error: "upstream_malformed" }, 502);
  }

  // INSERT OR REPLACE: a same-key re-POST (already_running) refreshes our
  // row's updated_at without colliding. The jobId is durably stable per
  // (sessionKey, pipelineType, scope) on the upstream side.
  const followUpJson = parsed.data.followUpOptions
    ? JSON.stringify(parsed.data.followUpOptions)
    : null;
  const followUpChainJson = parsed.data.followUpChain
    ? JSON.stringify(parsed.data.followUpChain)
    : null;
  await c.env.DB.prepare(
    `INSERT INTO pipeline_jobs (
       job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
       session_key, state, follow_up_options, follow_up_chain, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', ?8, ?9, unixepoch(), unixepoch())
     ON CONFLICT(job_id) DO UPDATE SET
       state = excluded.state,
       follow_up_options = COALESCE(excluded.follow_up_options, pipeline_jobs.follow_up_options),
       follow_up_chain = COALESCE(excluded.follow_up_chain, pipeline_jobs.follow_up_chain),
       updated_at = unixepoch()`,
  )
    .bind(
      data.jobId,
      userId,
      parsed.data.pipelineType,
      book,
      startChapter,
      endChapter,
      parsed.data.sessionKey,
      followUpJson,
      followUpChainJson,
    )
    .run();

  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
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
    `SELECT job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
            session_key, follow_up_options, follow_up_chain, follow_up_job_id,
            (output_json IS NULL) AS no_output_yet
       FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(jobId)
    .first<PolledJob>();
  if (!owned) return c.json({ error: "not_found" }, 404);
  if (owned.user_id !== userId) return c.json({ error: "forbidden" }, 403);

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
  username: string;
}

// Fires the parent's queued follow-up as a fresh upstream call + new
// pipeline_jobs row. Uses a derived sessionKey so upstream's
// (sessionKey, pipelineType, scope) dedup doesn't collide with the parent.
// Atomic against concurrent polls via the WHERE follow_up_job_id IS NULL
// guard on the parent UPDATE.
async function fireFollowUp(env: Env, input: FollowUpInput): Promise<void> {
  const followUpOptions = JSON.parse(input.followUpOptionsJson);
  // Derive a sessionKey that fits the same character class as the parent's
  // (POST validator: ^[A-Za-z0-9_\-/]+$). The "/followup" suffix avoids
  // colliding with the parent on the upstream dedup key.
  const childSessionKey = `${input.parentSessionKey}/followup`;
  const upstreamBody = {
    pipelineType: input.pipelineType,
    book: input.book,
    startChapter: input.startChapter,
    endChapter: input.endChapter,
    username: input.username,
    sessionKey: childSessionKey,
    options: followUpOptions,
  };

  const upstream = await fetch(`${upstreamBase(env)}/api/pipeline/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.BT_API_TOKEN}`,
    },
    body: JSON.stringify(upstreamBody),
  });
  const text = await upstream.text();
  if (!upstream.ok) {
    throw new Error(`upstream ${upstream.status}: ${text.slice(0, 200)}`);
  }
  let parsed: StartResponse | null = null;
  try {
    parsed = JSON.parse(text) as StartResponse;
  } catch {
    throw new Error(`upstream returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!parsed || typeof parsed.jobId !== "string") {
    throw new Error(`upstream missing jobId: ${text.slice(0, 200)}`);
  }

  // Claim + insert as one batch so a crash between them can't orphan the
  // upstream-running follow-up. Upstream is idempotent on (sessionKey,
  // pipelineType, scope), so a retry returns the same jobId; ON CONFLICT
  // DO NOTHING then collapses the second attempt into a no-op.
  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE pipeline_jobs SET follow_up_job_id = ?1
          WHERE job_id = ?2 AND follow_up_job_id IS NULL`,
      )
      .bind(parsed.jobId, input.parentJobId),
    env.DB
      .prepare(
        `INSERT INTO pipeline_jobs (
           job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
           session_key, state, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', unixepoch(), unixepoch())
         ON CONFLICT(job_id) DO NOTHING`,
      )
      .bind(
        parsed.jobId,
        input.userId,
        input.pipelineType,
        input.book,
        input.startChapter,
        input.endChapter,
        childSessionKey,
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
  username: string;
}

// Fires the next step of a cross-type chain (e.g. generate -> notes -> tqs)
// on a parent done-transition. Pops the first chain element, uses it as the
// child's pipelineType + options, and stores the remainder on the child row
// so the same logic fires the next step when this child completes.
//
// Idempotent against concurrent polls via the WHERE follow_up_job_id IS NULL
// guard on the parent UPDATE. Same atomicity story as fireFollowUp.
async function fireFollowUpFromChain(env: Env, input: FollowUpChainInput): Promise<void> {
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
  const childChainJson = rest.length > 0 ? JSON.stringify(rest) : null;

  const upstreamBody = {
    pipelineType: next.pipelineType,
    book: input.book,
    startChapter: input.startChapter,
    endChapter: input.endChapter,
    username: input.username,
    sessionKey: childSessionKey,
    ...(next.options ? { options: next.options } : {}),
  };

  const upstream = await fetch(`${upstreamBase(env)}/api/pipeline/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.BT_API_TOKEN}`,
    },
    body: JSON.stringify(upstreamBody),
  });
  const text = await upstream.text();
  if (!upstream.ok) {
    throw new Error(`upstream ${upstream.status}: ${text.slice(0, 200)}`);
  }
  let parsed: StartResponse | null = null;
  try {
    parsed = JSON.parse(text) as StartResponse;
  } catch {
    throw new Error(`upstream returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!parsed || typeof parsed.jobId !== "string") {
    throw new Error(`upstream missing jobId: ${text.slice(0, 200)}`);
  }

  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE pipeline_jobs SET follow_up_job_id = ?1
          WHERE job_id = ?2 AND follow_up_job_id IS NULL`,
      )
      .bind(parsed.jobId, input.parentJobId),
    env.DB
      .prepare(
        `INSERT INTO pipeline_jobs (
           job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
           session_key, state, follow_up_chain, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', ?8, unixepoch(), unixepoch())
         ON CONFLICT(job_id) DO NOTHING`,
      )
      .bind(
        parsed.jobId,
        input.userId,
        next.pipelineType,
        input.book,
        input.startChapter,
        input.endChapter,
        childSessionKey,
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
//   - non-terminal jobs (running, paused_*, failed — the failure case is
//     listed here even though it's terminal because the user might still
//     retry it), AND
//   - terminal jobs that haven't been "notified" yet, so the browser can
//     fire a "while you were away" toast on first load after the server's
//     cron finished a job in the user's absence.
//
// An explicit ?state= filter overrides this and returns exactly that set.
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
  const columns = `job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
            session_key, state, current_skill, current_status, error_kind,
            error_message, output_json, follow_up_job_id, created_at, updated_at,
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
    return c.json({ jobs: [] });
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

  return c.json({ jobs: rs.results });
});

interface PipelineRowSelect {
  job_id: string;
  user_id: number;
  pipeline_type: PipelineType;
  book: string;
  start_chapter: number;
  end_chapter: number;
  session_key: string;
  state: string;
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
