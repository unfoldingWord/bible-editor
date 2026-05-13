// Thin proxy + tracker for the bp-assistant pipeline endpoints (see
// docs/ai-pipeline-integration.md and the partner contract). Phase 1 keeps
// state in D1 so polling survives a tab reload; we don't parse output yet.
//
// Auth: every route requires a JWT (requireAuth). The shared BT_API_TOKEN
// (same secret used by /api/tn-quick) authorizes us upstream. The translator's
// DCS username is injected from the JWT — never from the request body — so a
// caller can't attribute runs to other users.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { currentUserId, requireAuth } from "./auth";

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

const StartBody = z.object({
  pipelineType: z.enum(PIPELINE_TYPES),
  book: z.string().min(1).max(8),
  startChapter: z.number().int().positive(),
  endChapter: z.number().int().positive().optional(),
  sessionKey: z.string().min(1).max(120).regex(/^[A-Za-z0-9_\-/]+$/),
  options: z.object({ model: z.enum(["sonnet", "opus"]).optional() }).optional(),
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

async function resolveUsername(c: {
  env: Env;
  get: (k: "username") => string | undefined;
}, userId: number): Promise<string | null> {
  const fromJwt = c.get("username");
  if (fromJwt) return fromJwt;
  const row = await c.env.DB.prepare(
    `SELECT dcs_username FROM users WHERE id = ?1`,
  )
    .bind(userId)
    .first<{ dcs_username: string }>();
  return row?.dcs_username ?? null;
}

// POST /api/pipelines/start
pipelines.post("/start", requireAuth, async (c) => {
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

  const upstreamBody = {
    pipelineType: parsed.data.pipelineType,
    book,
    startChapter,
    endChapter,
    username,
    sessionKey: parsed.data.sessionKey,
    ...(parsed.data.options ? { options: parsed.data.options } : {}),
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
  await c.env.DB.prepare(
    `INSERT INTO pipeline_jobs (
       job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
       session_key, state, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', unixepoch(), unixepoch())
     ON CONFLICT(job_id) DO UPDATE SET
       state = excluded.state,
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
    )
    .run();

  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
});

// GET /api/pipelines/:jobId
pipelines.get("/:jobId", requireAuth, async (c) => {
  if (!c.env.BT_API_TOKEN) {
    return c.json({ error: "pipeline_api_disabled" }, 503);
  }
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  if (!jobId) return c.json({ error: "missing_job_id" }, 400);

  // Ownership check before any upstream call — prevents jobId enumeration.
  const owned = await c.env.DB.prepare(
    `SELECT user_id FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(jobId)
    .first<{ user_id: number }>();
  if (!owned) return c.json({ error: "not_found" }, 404);
  if (owned.user_id !== userId) return c.json({ error: "forbidden" }, 403);

  let upstream: Response;
  try {
    upstream = await fetch(
      `${upstreamBase(c.env)}/api/pipeline/${encodeURIComponent(jobId)}`,
      { headers: { Authorization: `Bearer ${c.env.BT_API_TOKEN}` } },
    );
  } catch {
    return c.json({ error: "upstream_unreachable" }, 502);
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  let data: StatusResponse | null = null;
  try {
    data = JSON.parse(text) as StatusResponse;
  } catch {
    return c.json({ error: "upstream_malformed" }, 502);
  }

  await c.env.DB.prepare(
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
      jobId,
      data.state ?? "running",
      data.current?.skill ?? null,
      data.current?.status ?? null,
      data.current?.errorKind ?? null,
      data.current?.error ?? null,
      data.output ? JSON.stringify(data.output) : null,
      text,
    )
    .run();

  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
});

// GET /api/pipelines  — list current user's jobs from D1 (no upstream call).
// Reconciliation surface for the browser when a tab opens/reloads.
pipelines.get("/", requireAuth, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const stateFilter = c.req.query("state");
  const stateList = stateFilter
    ? stateFilter
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : Array.from(NON_TERMINAL_STATES);

  if (stateList.length === 0) {
    return c.json({ jobs: [] });
  }

  const placeholders = stateList.map((_, i) => `?${i + 2}`).join(",");
  const rs = await c.env.DB.prepare(
    `SELECT job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
            session_key, state, current_skill, current_status, error_kind,
            error_message, output_json, created_at, updated_at, last_polled_at
       FROM pipeline_jobs
      WHERE user_id = ?1 AND state IN (${placeholders})
      ORDER BY updated_at DESC
      LIMIT 100`,
  )
    .bind(userId, ...stateList)
    .all<{
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
      created_at: number;
      updated_at: number;
      last_polled_at: number | null;
    }>();

  return c.json({ jobs: rs.results });
});
