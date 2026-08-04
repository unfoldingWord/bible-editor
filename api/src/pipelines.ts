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
import { currentUserId, requireEditor } from "./auth.ts";
import { importJobOutput } from "./pipelineImport.ts";
import { IMPORT_CLAIM_STALE_SECONDS } from "./pipelineImportClaim.ts";
import { resourcesLockedByJob } from "./chapterLock.ts";
import { broadcastChapter } from "./wsEvents.ts";

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
    // OPTIONAL, verified against the real bot: serializeCheckpoint
    // (bp-assistant/src/api/pipeline.js) only spreads startedAt when the
    // checkpoint carries one, so a run that parked before its first timing
    // stamp omits the key entirely.
    startedAt?: string;
    errorKind?: string;
    error?: string;
  };
  updatedAt: string;
  createdAt: string;
  interrupted?: boolean;
  // Both additive, and both may be absent — the bot ships them only from the
  // resume-contract release onwards, so every read must tolerate undefined.
  // resume: what a resume would pick back up (chapter + skill). pausedAt: when
  // the bot parked the run, used to time-box auto-resume.
  //
  // `skill` is NULLABLE, verified against the real bot: it serializes
  // `skill: cp.resume.skill ?? null`, so a checkpoint that knows the chapter to
  // resume but not the step reports an explicit null.
  resume?: { chapter: number; skill: string | null } | null;
  pausedAt?: string;
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
  // Auto-resume budget for 'paused_for_outage' (migration 0038). updated_at is
  // the fallback pause clock when the bot doesn't report pausedAt.
  updated_at: number;
  resume_attempt_count: number;
  last_resume_at: number | null;
  // Set when the bot ACCEPTED a resume. Suppresses every fail-fast verdict for
  // RESUME_ACCEPTED_GRACE_SECONDS — see attemptOutageResume.
  resume_accepted_at: number | null;
  // The original /start options, replayed on resume so a resumed run keeps the
  // flags the translator actually asked for. TEXT column: may be NULL or (in
  // principle) malformed, so every read goes through resumeOptionsFromJson.
  options_json: string | null;
}

// Options to replay on a resume call, parsed from pipeline_jobs.options_json.
//
// The distinction between "this run had no options" and "we don't know what its
// options were" is load-bearing, so this returns `{}` for the former and
// `undefined` for the latter. The bot cannot recover options from its own
// checkpoint, so a resume that sends nothing runs with DEFAULTS — silently
// re-enabling intros or dropping the editor's hints, producing output that
// differs from what was originally asked for. The bot therefore refuses a resume
// whose options are unknown, and we must not disguise "unknown" as "empty".
//
// `fresh` is stripped: it is a valid /start option (and so legitimately lives in
// options_json), but the bot's resume schema omits it AND rejects unknown keys,
// because on the resume path `fresh` would destroy the very checkpoint being
// resumed. Sending it would 400 the whole resume.
function resumeOptionsFromJson(
  optionsJson: string | null,
  jobId: string,
): Record<string, unknown> | undefined {
  // No stored options at all is authoritative: the run genuinely had none.
  if (!optionsJson) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(optionsJson);
  } catch {
    // Genuinely unknown — let the bot refuse rather than resume on defaults.
    console.error(
      `[pipelineResume] job=${jobId} options_json unparseable — cannot replay options`,
    );
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`[pipelineResume] job=${jobId} options_json is not an object — cannot replay`);
    return undefined;
  }
  const { fresh: _fresh, ...rest } = parsed as Record<string, unknown>;
  return rest;
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
  //
  // FIX (F2): guard on `state = 'dispatching'`. This upstream POST has no
  // timeout, so a force-fail can land on this same row WHILE the POST is
  // still in flight: force-fail accepts 'dispatching', flips this row to
  // failed/force_stopped, frees the slot, and its own dispatchNext claims a
  // different job. If this UPDATE then ran unconditionally, the original
  // POST finally returning would flip THIS row back to 'running' with a live
  // upstream_job_id — resurrecting a force-stopped job alongside the new
  // claim and permanently wedging the single-slot invariant (two rows both
  // "active" forever after). `state = 'dispatching'` is the narrowest guard
  // that closes this: it is also sufficient for the force_stopped case
  // specifically, because force-fail always moves the row OUT of
  // 'dispatching' (to 'failed') before this UPDATE could run again — there is
  // no path back to 'dispatching' for a row once force-failed. No other
  // caller transitions a row out of 'dispatching' except this function
  // (to 'running') and forceFailJob (to 'failed'), so a non-'dispatching'
  // state reaching here is always someone else having already resolved it.
  const promote = await env.DB.prepare(
    `UPDATE pipeline_jobs
        SET state = 'running', upstream_job_id = ?2, updated_at = unixepoch()
      WHERE job_id = ?1 AND state = 'dispatching'`,
  )
    .bind(job.job_id, parsed.jobId)
    .run();
  if ((promote.meta?.changes ?? 0) === 0) {
    // The claim was revoked underneath us (most likely: force-failed while
    // the upstream POST was in flight). The bot already has a live run under
    // parsed.jobId with no local row tracking it — that is an orphaned
    // upstream run, not a bug to paper over here, so just log it for
    // traceability and stop. Do not write any further state for this job_id.
    console.warn(
      `[dispatchNext] job=${job.job_id} lost its 'dispatching' claim before the upstream POST returned; ` +
        `upstream job ${parsed.jobId} is now orphaned (no local row will track it)`,
    );
    return;
  }
}

// ── Resume (transient-outage recovery) ─────────────────────────────────────

// Outcome of one upstream resume call.
//
// 'accepted' = the bot took it and the job stays non-terminal. TWO upstream
// answers mean accepted, not one: HTTP 202 (resume launched) and HTTP 200
// {status:'already_running'} (the bot refused to double-start because the run is
// already alive — see bp-assistant/src/api/pipeline.js). The 200 is the
// strongest possible evidence the run is fine; classifying it as 'retryable'
// burned an attempt on it and, after three, failed a healthy job (and surfaced
// on the manual route as a 502 "Resume failed" for a resume that succeeded).
//
// 'refused' = the bot says this pause can't be resumed (404 / 409) —
// non-retryable, so the caller should stop rather than burn the remaining
// attempts. 'retryable' = transport/429/5xx, or a 200 with a body we don't
// recognise; try again later.
type ResumeCall =
  | { kind: "accepted"; body: unknown }
  // `reason` is human-facing (error code plus the bot's message); `code` is the
  // bare machine code, for callers that branch on it (e.g. stale_pause).
  | { kind: "refused"; status: number; reason: string; code?: string; pausedAgeSeconds?: number }
  | { kind: "retryable"; reason: string };

// Calls the bot's POST /api/pipeline/{id}/resume. Shared by the automatic
// poller path and the manual route so both classify responses identically.
//
// `force` bypasses the bot's OWN 90-minute pause time-box. The bot enforces that
// box independently of ours (belt and braces: it owns the checkpoint timestamp,
// we only see what it reports), so without force a human clicking Resume on an
// old pause would be refused with 'stale_pause' no matter how permissive this
// side is. Only the manual, human-initiated route may set it — the automatic
// poller must never force, because the time-box is what keeps auto-resume from
// re-pushing content generated before a proofreader's edits (see
// bp-bot/STALE-SOURCE-DIAGNOSIS.md).
//
// `username` and `options` are things the bot cannot recover from its own
// checkpoint, so we are the authority for both: without a username it credits
// Door43 commits to a literal 'bible-editor' instead of the translator, and
// without the original options a resumed run silently reverts to default flags
// (dropping e.g. noIntro / contentTypes) — doing something other than what was
// asked. Both keys are OMITTED entirely when we don't have them, never sent as
// null: the bot's resume schema is `.strict()`.
async function callUpstreamResume(
  env: Env,
  upstreamJobId: string,
  opts: { force: boolean; username?: string; options?: unknown },
): Promise<ResumeCall> {
  const payload: Record<string, unknown> = { force: opts.force };
  if (opts.username) payload.username = opts.username;
  if (opts.options !== undefined && opts.options !== null) payload.options = opts.options;
  let upstream: Response;
  try {
    upstream = await fetch(
      `${upstreamBase(env)}/api/pipeline/${encodeURIComponent(upstreamJobId)}/resume`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.BT_API_TOKEN}`,
        },
        body: JSON.stringify(payload),
      },
    );
  } catch {
    return { kind: "retryable", reason: "upstream_unreachable" };
  }
  const text = await upstream.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON body — keep the raw text in the reason instead */
  }
  const err =
    body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : null;
  // The bot sends a human-readable `message` alongside the error code, and it is
  // often the only actionable part — "checkpoint belongs to a different session
  // … resume it from Zulip instead" tells the user exactly what to do, whereas
  // the bare code 'not_resumable' actively misleads. Carry both.
  const msg =
    body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
      ? (body as { message: string }).message
      : null;
  const detail = msg ? `${err ?? "refused"}: ${msg}` : err;

  if (upstream.status === 202) return { kind: "accepted", body };
  // 200 {status:'already_running'} — the bot won't double-start a live run. That
  // is acceptance, not failure (see the ResumeCall comment). A 200 with any
  // other body is unexpected; fall through to 'retryable'.
  const upstreamStatusField =
    body && typeof body === "object" && typeof (body as { status?: unknown }).status === "string"
      ? (body as { status: string }).status
      : null;
  if (upstream.status === 200 && upstreamStatusField === "already_running") {
    return { kind: "accepted", body };
  }
  // 400 (validation_failed), 404 (no checkpoint) and 409 (not_resumable /
  // stale_pause / options_unknown) are the bot's definitive "this will never
  // work" answers — non-retryable. 400 belongs here because the bot's resume
  // body and options schemas are both strict: a rejected payload is rejected
  // deterministically, so retrying it burns all three attempts and ~15 minutes
  // of spacing before the job fails, and shows the user "try again" for a
  // request that cannot ever succeed.
  if (upstream.status === 400 || upstream.status === 404 || upstream.status === 409) {
    // The bot reports the real pause age alongside 'stale_pause'. Pass it
    // through so the manual route can name it in the confirmation prompt.
    const age =
      body && typeof body === "object" &&
      typeof (body as { pausedAgeSeconds?: unknown }).pausedAgeSeconds === "number"
        ? (body as { pausedAgeSeconds: number }).pausedAgeSeconds
        : undefined;
    return {
      kind: "refused",
      status: upstream.status,
      reason: detail ?? `upstream ${upstream.status}: ${text.slice(0, 120)}`,
      code: err ?? undefined,
      ...(age !== undefined ? { pausedAgeSeconds: age } : {}),
    };
  }
  return {
    kind: "retryable",
    reason: detail ?? `upstream ${upstream.status}: ${text.slice(0, 120)}`,
  };
}

// `resume_accepted_at` marks a resume that is IN FLIGHT OR ACCEPTED — those two
// states are deliberately not distinguished, because they need identical
// treatment: in both, the bot may be running the chapter while our row still
// reads `paused_for_outage`. Anything that would free the bot slot or the chapter
// lock (a fail-fast verdict, a cancel) must refuse while it is set.
//
// Always set it BEFORE calling upstream. Setting it after the answer leaves a
// window in which the bot has launched the run but our row looks abandonable.
//
// This is a CLAIM, not a blind write, and the return value is load-bearing: it
// is true only when this caller actually acquired the marker (it was unset, or
// an expired leftover). A caller that finds a live marker gets false and must
// NOT clear it later — that marker belongs to another in-flight-or-accepted
// resume. Two resumes on one job are reachable without any exotic timing: the
// */5 poller auto-resumes and the translator clicks Resume in a tab, or two tabs
// both click. Without this, the SECOND call being refused clears the FIRST
// call's acceptance and re-opens the cancel door underneath a live run. The
// mutual exclusion is the WHERE clause — D1 serializes the UPDATE, so exactly
// one concurrent caller can match.
async function markResumeInFlight(env: Env, jobId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE pipeline_jobs
        SET resume_accepted_at = unixepoch()
      WHERE job_id = ?1
        AND (resume_accepted_at IS NULL
             OR resume_accepted_at < unixepoch() - ?2)`,
  )
    .bind(jobId, RESUME_ACCEPTED_GRACE_SECONDS)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// Clear it when the bot definitively did NOT take the resume, so the job is
// cancellable again and GATE 0 doesn't sit on it for the full grace window.
// Only ever call this when the matching markResumeInFlight returned true.
//
// KNOWN RESIDUAL, deliberately not closed here. The claim makes the marker
// single-owner, which covers same-instant collisions (the WHERE cannot match
// twice) and covers a second caller clearing a first caller's marker. What it
// does not cover: the OWNER's call being refused while a concurrent non-owner
// call was accepted — the owner then legitimately clears a marker that now
// stands over a live run. It needs the bot to answer one caller 'accepted' and
// the other a refusal in the same window, which is why it is narrow.
//
// Closing it properly needs an ownership token (a per-attempt id compared on
// clear), i.e. a new column and a migration. That is a schema decision, and the
// alternative — never clearing on refusal and letting the 15-minute grace expire
// — would delay cancel and fail-fast on the MOST COMMON refusal path (a stale
// pause), trading the queue-drain guarantee this whole change exists to provide
// against a much narrower race. Left as-is on purpose; revisit with the token if
// concurrent resumes on one job ever stop being rare.
async function clearResumeInFlight(env: Env, jobId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE pipeline_jobs SET resume_accepted_at = NULL WHERE job_id = ?1`,
  )
    .bind(jobId)
    .run();
}

// Auto-resume a job the bot parked on a transient Claude outage. Returns a
// reason string when the job is NOT resumable and must be failed fast (so the
// bot slot frees and the queue drains), or null to leave it non-terminal —
// either because a resume was accepted, because we're spacing attempts out, or
// because the failure was transient and a later poll can retry.
//
// Deliberately scoped to 'paused_for_outage'. 'paused_for_usage_limit' means the
// daily budget is spent; resuming would re-fail immediately, so that state keeps
// its existing behavior untouched.
async function attemptOutageResume(
  env: Env,
  job: PolledJob,
  data: StatusResponse,
): Promise<string | null> {
  if (!job.upstream_job_id) return null;
  const now = Math.floor(Date.now() / 1000);

  // GATE 0 — an accepted resume is still starting. This runs BEFORE every other
  // gate, and the ordering is the whole point: returning a fail-fast reason here
  // would free the bot slot and the chapter lock underneath a run that is
  // actively writing (see RESUME_ACCEPTED_GRACE_SECONDS). Leave it strictly
  // alone: don't fail it, don't resume it again.
  if (job.resume_accepted_at !== null) {
    if (now - job.resume_accepted_at < RESUME_ACCEPTED_GRACE_SECONDS) return null;
    // Past the grace window and the bot still says 'paused_for_outage' — the
    // resume was accepted but never actually started. Clear the marker so the
    // normal gates below apply and this eventually fails fast, rather than
    // hanging paused forever behind a stale acceptance.
    await env.DB.prepare(
      `UPDATE pipeline_jobs SET resume_accepted_at = NULL WHERE job_id = ?1`,
    )
      .bind(job.job_id)
      .run();
  }

  // Pause clock. `pausedAt` is AUTHORITATIVE when present: it is the bot's
  // write-once `pauseAnchorAt`, stamped on the first pause and never refreshed,
  // so our 90-minute box genuinely binds. (It used to be a resetting timestamp,
  // which is why the fallback below carried the whole safety argument; the bot
  // was fixed to report the anchor.)
  //
  // The `updated_at` fallback is a LOWER BOUND, not an approximation: our poller
  // refreshes updated_at on every */5 poll, so a computed age can understate a
  // pause that is in fact far older than 90 minutes — the unsafe direction for
  // content freshness. It is tolerable only because the bot independently
  // enforces the same box against its own anchor and refuses with 'stale_pause'
  // (we never send force from this path). The fallback is therefore not
  // load-bearing; don't drop the bot-side box on the grounds that we check here.
  let pausedAtSec: number = job.updated_at;
  if (data.pausedAt) {
    const parsed = Date.parse(data.pausedAt);
    if (Number.isFinite(parsed)) pausedAtSec = Math.floor(parsed / 1000);
  }
  // Spacing comes FIRST, ahead of the age and cap gates, and that ordering is
  // load-bearing. A resume attempt inside the spacing window means this job is
  // already being retried — by an earlier poll, or by a human who just clicked
  // Resume. The manual route deliberately ignores the time-box, but the bot
  // keeps reporting `paused_for_outage` until the resumed run actually starts,
  // so a poll landing in that gap would see "3 hours old" and fail the job the
  // translator just rescued. Checking spacing first leaves it alone.
  //
  // This costs nothing in the auto case: a genuinely too-old pause is failed on
  // the next poll instead of this one, and it can never be *resumed* meanwhile,
  // because the age gate below still guards every actual resume call.
  //
  // (The original reason for spacing still holds: the poll cron is */5 and the
  // window is 5m, so one attempt per poll. This read is only a cheap early exit
  // — the actual mutual exclusion between two concurrent pollers is the
  // conditional UPDATE below, not this check.)
  if (job.last_resume_at !== null && now - job.last_resume_at < RESUME_RETRY_SPACING_SECONDS) {
    return null;
  }
  // Fail closed on an unknown pause time. If neither source gave us a finite
  // number (a future PolledJob producer omitting updated_at would do it), every
  // `age > limit` comparison against NaN is false and the age gate silently
  // stops existing. Treat an unknown pause time as too old instead.
  if (!Number.isFinite(pausedAtSec)) {
    return "pause timestamp unknown — refusing to auto-resume without a verifiable age";
  }
  const ageSeconds = Math.max(0, now - pausedAtSec);
  if (ageSeconds > RESUME_MAX_PAUSE_AGE_SECONDS) {
    return `paused ${Math.floor(ageSeconds / 60)}m ago — too old to auto-resume safely (limit ${
      RESUME_MAX_PAUSE_AGE_SECONDS / 60
    }m)`;
  }
  if (job.resume_attempt_count >= MAX_RESUME_ATTEMPTS) {
    return `auto-resume exhausted after ${job.resume_attempt_count} attempts`;
  }

  // Count the attempt BEFORE the call so a Worker crash mid-flight can't give
  // us unlimited retries — same reasoning as attempt_count in pollAllNonTerminal.
  //
  // The WHERE clause re-checks the spacing window inside the write, making this
  // the real concurrency guard: the cron poller and an open tab's GET can both
  // read the same stale last_resume_at and both pass the check above, but only
  // one UPDATE can match. 0 changes means the other poller won — return null and
  // do NOT call upstream, rather than double-attempting a resume.
  const claim = await env.DB.prepare(
    `UPDATE pipeline_jobs
        SET resume_attempt_count = resume_attempt_count + 1,
            last_resume_at = unixepoch()
      WHERE job_id = ?1
        AND (last_resume_at IS NULL OR last_resume_at < unixepoch() - ?2)`,
  )
    .bind(job.job_id, RESUME_RETRY_SPACING_SECONDS)
    .run();
  if ((claim.meta?.changes ?? 0) === 0) return null;

  // The bot can't recover either of these from its checkpoint, so we supply
  // them (see callUpstreamResume). A missing username is not fatal — better a
  // mis-attributed commit than a job stuck paused — so we just omit it.
  const username = await resolveUsernameFromDb(env, job.user_id);
  const options = resumeOptionsFromJson(job.options_json, job.job_id);

  // Mark IN FLIGHT before the call, not after the answer. The window between
  // issuing a resume and learning it was accepted is real: during it the bot may
  // already have launched the run, while our row still reads paused_for_outage
  // with no acceptance marker — so a cancel arriving in that window would pass
  // the cancel guard, release the chapter lock, and dispatch a second job
  // against a live run. Setting the marker first closes the window; a refusal
  // clears it below, so a genuinely unresumable job stays cancellable.
  //
  // `owned` gates the clears: if some other resume already holds a live marker,
  // this call must not wipe it on its own refusal (see markResumeInFlight).
  const owned = await markResumeInFlight(env, job.job_id);

  // Never force from the automatic path — the bot's time-box is a safety gate here.
  const call = await callUpstreamResume(env, job.upstream_job_id, {
    force: false,
    ...(username ? { username } : {}),
    ...(options ? { options } : {}),
  });
  if (call.kind === "accepted") {
    // Keep the marker: GATE 0 above now suppresses every fail-fast verdict while
    // the resumed run starts up. Without it the next poll past the spacing
    // window fails a job the bot is actively running.
    return null;
  }
  if (call.kind === "refused") {
    if (owned) await clearResumeInFlight(env, job.job_id);
    return `auto-resume refused by bot: ${call.reason}`;
  }
  // Retryable: the attempt is spent but the job stays paused. A later poll
  // retries until the cap or the time-box catches it. Clear the in-flight marker
  // so this job is cancellable again and GATE 0 doesn't sit on it for 15 minutes
  // over a transport blip.
  if (owned) await clearResumeInFlight(env, job.job_id);
  console.error(`[pipelineResume] job=${job.job_id} retryable: ${call.reason}`);
  return null;
}

// Shared "fetch upstream, run import, update DB, fire follow-up" body used
// by both the GET handler and the scheduled cron poller. Returns the raw
// upstream response so callers that need to pass it through can do so;
// scheduled callers discard.
// Exported so pipelinesForceFail.test.mjs can drive FIX 1(b) directly (the
// poll-side guard against clobbering a force-stopped job) without spinning up
// the Hono route — same rationale as forceFailJob being split out below.
export async function pollPipelineJob(
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

  // `job` is a snapshot taken when this poll started, and the upstream fetch
  // above can take a while — long enough for the owner to force-stop the run in
  // between. Re-read the live state before importing: applying AI output into a
  // chapter we have just told everyone is unlocked is the one irreversible
  // thing this function does, and the guarded UPDATE further down is too late
  // to prevent it. Narrow but real — this is exactly the window a merge review
  // flagged as High severity.
  //
  // GAP CLOSED (#402): a force-stop (or any terminal transition) landing
  // *during* importJobOutput now stops the apply at the next batch boundary —
  // see maybeCheckCancelled / CancelWatch in pipelineImport.ts, threaded
  // through the stage and apply loops. The re-read here remains worthwhile as
  // the cheap fast path: it catches a stop that already landed BEFORE this
  // point and skips starting an apply at all, which is strictly cheaper than
  // starting one only to have it stop a few batches in.
  const liveState = await env.DB.prepare(
    `SELECT state, error_kind FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(job.job_id)
    .first<{ state: string; error_kind: string | null }>();
  const forceStopped =
    liveState?.state === "failed" && liveState?.error_kind === "force_stopped";
  if (forceStopped) {
    console.warn(
      `[pollPipelineJob] job=${job.job_id} was force-stopped while this poll was in flight; ` +
        `skipping import of upstream output`,
    );
  }

  const shouldImport =
    !forceStopped &&
    job.no_output_yet === 1 &&
    data.state === "done" &&
    Array.isArray(data.output) &&
    data.output.length > 0;
  let importFailed = false;
  let importErrMessage: string | null = null;
  // Chapters this apply actually wrote to — used below to hint open tabs once
  // the finalize commit lands. Empty unless a successful import populated it.
  let appliedChapters: number[] = [];
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
      if (importResult.aborted) {
        // #402: the job was deliberately stopped (force-stop or cancel, or
        // another poll finalized it) while this apply was in flight, and the
        // apply stopped at a batch boundary per the keep-and-record policy —
        // everything already applied stays, nothing here rolls it back.
        // Return the upstream status unchanged, same as claimLost below: do
        // NOT finalize, broadcast, or enqueue the follow-up chain for a job
        // that just went terminal mid-apply.
        console.warn(`[pollPipelineJob] job=${job.job_id} import aborted mid-apply`, {
          jobId: job.job_id,
          abortState: importResult.abortState,
          abortErrorKind: importResult.abortErrorKind,
          affectedChapters: importResult.applied?.affectedChapters,
        });
        return { kind: "ok", text, status: upstream.status, state: data.state ?? "running" };
      }
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
      appliedChapters = importResult.applied?.affectedChapters ?? [];
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

  // Transient-outage pause: try to resume it automatically (time-boxed and
  // capped — see attemptOutageResume). If it can't be resumed, we get a reason
  // back and fail the job now so the single bot slot frees and everything queued
  // behind it dispatches within minutes instead of waiting ~8h for the blunt
  // MAX_POLL_ATTEMPTS backstop.
  let unresumableReason: string | null = null;
  if (!importFailed && !upstreamInterrupted && data.state === "paused_for_outage") {
    try {
      unresumableReason = await attemptOutageResume(env, job, data);
    } catch (err) {
      console.error(`[pipelineResume] job=${job.job_id} threw:`, err);
    }
  } else if (
    data.state &&
    data.state !== "paused_for_outage" &&
    data.state !== "paused_for_usage_limit" &&
    (job.resume_attempt_count > 0 || job.last_resume_at !== null || job.resume_accepted_at !== null)
  ) {
    // The resume budget is per PAUSE CYCLE, not per job. One job row can span a
    // multi-chapter run and pause several times; observing any non-paused
    // upstream state means the previous cycle is over (the run is moving again,
    // or finished). Without this reset, a job that spent its three attempts on
    // an early pause is failed on the FIRST poll of a later pause — no resume
    // attempted at all — throwing away every already-completed chapter.
    try {
      await env.DB.prepare(
        `UPDATE pipeline_jobs
            SET resume_attempt_count = 0,
                last_resume_at = NULL,
                resume_accepted_at = NULL
          WHERE job_id = ?1`,
      )
        .bind(job.job_id)
        .run();
    } catch (err) {
      console.error(`[pipelineResume] job=${job.job_id} budget reset failed:`, err);
    }
  }

  const importFailedAgain = importFailed && job.error_kind === "import_failed";
  const effectiveState = importFailed
    ? importFailedAgain
      ? "failed"
      : "running"
    : upstreamInterrupted || unresumableReason
      ? "failed"
      : (data.state ?? "running");
  const effectiveErrorKind = importFailed
    ? "import_failed"
    : upstreamInterrupted
      ? "interrupted"
      : unresumableReason
        ? "paused_unresumable"
        : (data.current?.errorKind ?? null);
  const effectiveErrorMessage = importFailed
    ? importErrMessage
    : upstreamInterrupted
      ? (data.current?.error ?? "upstream reported interrupted")
      : unresumableReason
        ? `paused for outage and not resumable: ${unresumableReason}`
        : (data.current?.error ?? null);

  // Defense in depth against a deliberate force-stop (see forceFailJob):
  // even though the GET handler already short-circuits force-stopped jobs
  // before calling this function, no caller of pollPipelineJob should be
  // able to clobber that terminal state back to 'running' — the bot can
  // still be reporting 'running' honestly for a while after force-fail.
  //
  // NULL-SAFETY IS LOAD-BEARING HERE. `error_kind` is nullable (an ordinary
  // failure can reach this row with state='failed' and error_kind IS NULL —
  // see effectiveErrorKind's `data.current?.errorKind ?? null` fallback
  // above), and SQLite's three-valued logic makes `NOT (a AND NULL)`
  // evaluate to NULL rather than TRUE, which reads as "don't update" as far
  // as the WHERE clause is concerned. A `state = 'failed' AND error_kind =
  // 'force_stopped'` guard written the "obvious" way therefore silently
  // no-ops the UPDATE for EVERY ordinary failed/NULL row, not just the
  // force-stopped one — the opposite of this comment's intent. Do not
  // "simplify" this back to `NOT (state = 'failed' AND error_kind =
  // 'force_stopped')`; the COALESCE below is what makes the comparison
  // NULL-safe.
  const guardedUpdate = await env.DB.prepare(
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
     WHERE job_id = ?1
       AND (state <> 'failed' OR COALESCE(error_kind, '') <> 'force_stopped')`,
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

  // FIX (F3): if the guarded UPDATE above matched 0 rows, this row was force-
  // stopped underneath us (the only reason the WHERE clause can refuse a
  // match — see the NULL-safety comment above it) between when we read `job`
  // and when we wrote. Every side effect below assumes the write actually
  // landed, so none of them may run: importJobOutput can take minutes, and a
  // force-stop landing mid-apply must not have the poll that started it turn
  // around and broadcast the chapter as updated, enqueue the next stage of a
  // follow-up chain, or hand the freed slot to a new job on this job's
  // behalf. (Mid-flight cancellation of an apply already in progress is
  // handled separately — see maybeCheckCancelled / CancelWatch in
  // pipelineImport.ts, #402 — which stops the apply itself at the next batch
  // boundary. This guard only stops what happens AFTER a write that DID land,
  // once we reach this point.)
  const pollWriteLanded = (guardedUpdate.meta?.changes ?? 0) > 0;
  if (!pollWriteLanded) {
    console.warn(
      `[pollPipelineJob] job=${job.job_id} force-stopped concurrently — skipping broadcast/follow-up/dispatch`,
    );
  }

  // The apply wrote rows outside the HTTP path, so no per-row row.upserted
  // events fired — open tabs on these chapters are now silently stale. Send one
  // coalesced hint per changed chapter (not per row) so a whole-book apply stays
  // cheap against the subrequest budget. The client shows a "save & refresh"
  // prompt rather than refetching silently, so an in-progress edit is never
  // clobbered. Best-effort: broadcastChapter swallows its own errors.
  if (!importFailed && pollWriteLanded) {
    for (const ch of appliedChapters) {
      await broadcastChapter(env, job.book, ch, {
        type: "chapter.pipeline_applied",
        book: job.book,
        chapter: ch,
        pipeline_type: job.pipeline_type,
      });
    }
  }

  // Gate followups on !importFailed: the chain assumes the parent's rows
  // are in D1 (e.g. the next step's prompt builder reads them). Without
  // this, an upstream-done-but-import-failed run would still trigger
  // notes -> tqs against an unimported parent.
  if (data.state === "done" && !importFailed && !job.follow_up_job_id && pollWriteLanded) {
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
  if ((effectiveState === "done" || effectiveState === "failed") && pollWriteLanded) {
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
  } else if (unresumableReason) {
    // Same reasoning as the interrupted branch: upstream still reports
    // 'paused_for_outage', we stored 'failed'. Rewrite so a tab polling this
    // job by id sees terminal and stops.
    responseText = JSON.stringify({
      ...data,
      state: "failed",
      current: {
        ...(data.current ?? { chapter: 0, skill: "", status: "", startedAt: "" }),
        errorKind: "paused_unresumable",
        error: `paused for outage and not resumable: ${unresumableReason}`,
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

// Auto-resume time-box. A pause older than this is not resumed automatically:
// the bot's checkpoint may no longer match the repo state, and a stale resume is
// worse than a clean re-run. A human can still resume an old pause explicitly
// via POST /api/pipelines/:jobId/resume, which skips this and the attempt cap.
const RESUME_MAX_PAUSE_AGE_SECONDS = 90 * 60;

// How many automatic resume attempts one job gets before we fail it.
const MAX_RESUME_ATTEMPTS = 3;

// Minimum gap between resume attempts, so a bot that is still down isn't
// hammered. Enforced by a conditional UPDATE (not a read-then-write), so two
// concurrent pollers genuinely cannot both attempt inside one window.
const RESUME_RETRY_SPACING_SECONDS = 5 * 60;

// How long after the bot accepts a resume we leave the job completely alone.
//
// THIS IS A SAFETY GATE, NOT A CONVENIENCE. The bot's checkpoint keeps reporting
// 'paused_for_outage' until the resumed run reaches its first checkpoint write,
// which can be minutes. If a poll inside that gap applied the age gate or the
// attempt cap it would mark the job 'failed' and call dispatchNext() — handing a
// second job to the single-slot bot AND releasing the chapter write-lock while
// the resumed run is still writing D1 and Door43. That is the double-write class
// this whole queue exists to prevent, and it is reachable with no human
// involved: a resume accepted at pause age 88m, next */5 poll at 94m.
const RESUME_ACCEPTED_GRACE_SECONDS = 15 * 60;
// Polls every non-terminal pipeline_job. Designed for the scheduled
// handler — runs in parallel with per-job error isolation so one stuck
// upstream call doesn't drag the batch down.
export async function pollAllNonTerminal(env: Env): Promise<void> {
  if (!env.BT_API_TOKEN) return;
  // The backstop sweeps are isolated for the same reason as the poll batch
  // below: nothing in this function may prevent dispatchNext from running. They
  // touch only long-standing columns today, but that was equally true of the
  // poll SELECT until migrations 0038/0039 added three to it — and an unguarded
  // throw HERE reproduces the EZK 40 freeze exactly, sweeps and poll and
  // dispatch all skipped together. Guarding both is what makes
  // pollAllNonTerminal non-throwing, which also protects the stale-lock and
  // edit_log sweeps that run after it in index.ts's POLL_CRON branch.
  try {
    // Each sweep below excludes jobs with a LIVE import claim
    // (import_claimed_at newer than IMPORT_CLAIM_STALE_SECONDS). A live,
    // heartbeating import claim is positive evidence an apply is in flight
    // right now — these sweeps exist to catch jobs where NOTHING is
    // happening, and a DAN-11-scale apply (~12 minutes) outlives the */5 tick
    // that runs this function, so without this exclusion a healthy, actively-
    // progressing apply gets auto-failed out from under itself. That is also
    // why shouldAbortApply (pipelineImportClaim.ts) deliberately does NOT
    // treat error_kind='interrupted' as a stop signal: fixing the sentinel's
    // blindness here is the right layer, and honouring it there would have
    // permanently discarded a completed run's output. The stale
    // window is the same one the claim mechanism itself uses for crash
    // recovery, so a genuinely dead claim (the importer's Worker died with no
    // further heartbeat) is still swept on schedule.
    await env.DB.prepare(
      `UPDATE pipeline_jobs
          SET state = 'failed',
              error_kind = 'interrupted',
              error_message = 'auto-failed: no progress for 48h',
              updated_at = unixepoch()
        WHERE state IN ('running', 'paused_for_outage', 'paused_for_usage_limit')
          AND updated_at < unixepoch() - ?1
          AND (import_claimed_at IS NULL OR import_claimed_at < unixepoch() - ?2)`,
    )
      .bind(STUCK_JOB_THRESHOLD_SECONDS, IMPORT_CLAIM_STALE_SECONDS)
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
          AND attempt_count > ?1
          AND (import_claimed_at IS NULL OR import_claimed_at < unixepoch() - ?2)`,
    )
      .bind(MAX_POLL_ATTEMPTS, IMPORT_CLAIM_STALE_SECONDS)
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
          AND updated_at < unixepoch() - ?1
          AND (import_claimed_at IS NULL OR import_claimed_at < unixepoch() - ?2)`,
    )
      .bind(STUCK_DISPATCH_THRESHOLD_SECONDS, IMPORT_CLAIM_STALE_SECONDS)
      .run();
  } catch (err) {
    console.error("[scheduled.pipelinePoll] backstop sweeps failed:", err);
  }
  // The whole poll batch is isolated from the dispatchNext below. A throw here
  // is not hypothetical: a deploy that ships code referencing a column whose
  // migration hasn't been applied to prod makes this SELECT throw on EVERY */5
  // tick, and an unguarded throw took dispatchNext down with it — so the running
  // job never advanced AND nothing queued behind it ever dispatched. (EZK 40
  // generate, 2026-08-01: migrations 0038/0039 unapplied in prod, job frozen at
  // attempt_count=0 with a queue behind it for the whole weekend.) The migration
  // gap is fixed at its source in api/package.json's deploy script; this keeps
  // the queue draining even when some future poll path is broken.
  try {
    const rs = await env.DB.prepare(
      `SELECT job_id, upstream_job_id, user_id, pipeline_type, book, start_chapter,
              end_chapter, session_key, follow_up_options, follow_up_chain,
              follow_up_job_id, error_kind, updated_at, resume_attempt_count,
              last_resume_at, resume_accepted_at, options_json,
              (output_json IS NULL) AS no_output_yet
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
  } catch (err) {
    console.error("[scheduled.pipelinePoll] batch failed:", err);
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
            follow_up_job_id, error_kind, error_message, state, current_skill,
            current_status, created_at, updated_at, resume_attempt_count,
            last_resume_at, resume_accepted_at, options_json,
            (output_json IS NULL) AS no_output_yet
       FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(jobId)
    .first<PolledJob & {
      state: string;
      current_skill: string | null;
      current_status: string | null;
      error_message: string | null;
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
  //
  // A force-stopped job (state='failed', error_kind='force_stopped') joins
  // this short-circuit too: it's the one 'failed' outcome that can CONTRADICT
  // a bot that is still honestly reporting 'running' (its stop endpoint is a
  // no-op today — see forceFailJob's comment), so falling through to
  // pollPipelineJob would resurrect it. Every other 'failed' producer
  // (interrupted, import_failed) is self-stable on re-poll because the bot
  // reports the same terminal thing back, so this check must stay narrow to
  // force_stopped and not swallow ordinarily-failed jobs, which may
  // legitimately be re-polled/retried.
  if (
    owned.state === "cancelled" ||
    owned.state === "done" ||
    (owned.state === "failed" && owned.error_kind === "force_stopped")
  ) {
    // FIX (F1): the force_stopped branch of this short-circuit must include a
    // `current` object carrying errorKind/error (plus skill/status, which the
    // non-short-circuited response also carries — see rowFromStatus in
    // web/src/sync/pipelineStore.ts, which reads current?.skill/.status/
    // .errorKind/.error). Without it, the client's merged row gets
    // error_kind: null, its "don't toast the user's own force-stop" predicate
    // (`next.error_kind !== "force_stopped"`) passes, and the user gets a red
    // "failed" toast for the stop they just requested. It also blanked the
    // "force-stopped by <actor>" audit message on every subsequent per-job
    // poll (a later loadFromServer happened to restore it, masking the gap).
    // `chapter` is required by PipelineStatusResponse's `current` type but
    // pipeline_jobs has no per-poll chapter column to report here — 0 is the
    // same placeholder pollPipelineJob's own synthesized-response branches use
    // (see the importFailed/upstreamInterrupted/unresumableReason rewrites
    // above) for exactly this reason, and the client never reads .chapter.
    return c.json({
      jobId: owned.job_id,
      pipelineType: owned.pipeline_type,
      scope: {
        book: owned.book,
        startChapter: owned.start_chapter,
        endChapter: owned.end_chapter,
      },
      state: owned.state,
      current:
        owned.state === "failed" && owned.error_kind === "force_stopped"
          ? {
              chapter: 0,
              skill: owned.current_skill ?? "",
              status: owned.current_status ?? "",
              errorKind: owned.error_kind,
              error: owned.error_message ?? undefined,
            }
          : undefined,
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
            output_json, follow_up_job_id, follow_up_chain, created_at, updated_at,
            last_polled_at, notified_user_at`;

  if (stateList === null) {
    // Default: the live queue is visible to everyone (active + waiting jobs,
    // regardless of owner) so the whole team can see what's running and lined
    // up. Terminal jobs (done/failed/cancelled) stay owner-scoped — a finished
    // run only shows for the person who requested it, which also drives the
    // "completed while you were away" toast via the unnotified-terminal clause.
    // Capped 100. Columns are table-qualified (j.) because of the users JOIN.
    const jCols = columns
      .split(",")
      .map((s) => `j.${s.trim()}`)
      .join(", ");
    const nonTerminal = Array.from(NON_TERMINAL_STATES);
    const ntPlace = nonTerminal.map((_, i) => `?${i + 2}`).join(",");
    // Active + queued: the shared, everyone-can-see set.
    const queueVisible = ["queued", ...ACTIVE_STATES];
    const qvPlace = queueVisible
      .map((_, i) => `?${i + 2 + nonTerminal.length}`)
      .join(",");
    rs = await c.env.DB.prepare(
      `SELECT ${jCols}, u.dcs_username AS started_by_username
         FROM pipeline_jobs j
         LEFT JOIN users u ON u.id = j.user_id
        WHERE (j.user_id = ?1
                 AND (j.state IN (${ntPlace}) OR j.notified_user_at IS NULL))
           OR j.state IN (${qvPlace})
        ORDER BY j.updated_at DESC
        LIMIT 100`,
    )
      .bind(userId, ...nonTerminal, ...queueVisible)
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
    // Another user's row rides the shared-queue clause. Strip the internal
    // fields the UI never renders for a foreign job (session key, the bot's
    // upstream id, produced output, error detail) so the shared queue only
    // discloses display metadata — book/chapter/type/state/who — not the
    // operational innards of someone else's run.
    const sanitized =
      row.user_id !== userId
        ? {
            ...row,
            session_key: "",
            upstream_job_id: null,
            output_json: null,
            error_kind: null,
            error_message: null,
          }
        : row;
    // Tell the client which resources this run will overwrite (its own type
    // plus any pending chain steps) so the editor can lock exactly those lanes
    // without re-implementing the map. follow_up_chain itself stays server-side
    // — it carries upstream options the UI has no business seeing.
    const { follow_up_chain, ...rest } = sanitized;
    const withLocks = {
      ...rest,
      locks_resources: Array.from(resourcesLockedByJob(row.pipeline_type, follow_up_chain)),
    };
    if (withLocks.state === "queued") {
      const pos = snap.positions.get(withLocks.job_id);
      return { ...withLocks, queue_position: pos?.position ?? null, queue_ahead: pos?.ahead ?? null };
    }
    return withLocks;
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
  // Pending chain steps (JSON). Never returned to the client — it gets the
  // derived locks_resources instead.
  follow_up_chain: string | null;
  created_at: number;
  updated_at: number;
  last_polled_at: number | null;
  notified_user_at: number | null;
  // Present only on the default (shared-queue) list where we JOIN users, so the
  // UI can attribute another user's run. Absent on the explicit-state branch.
  started_by_username?: string | null;
}

// POST /api/pipelines/:jobId/cancel  — withdraw a job that hasn't reached the
// front of the line yet, or abandon one the bot has parked. Cancellable states:
// 'queued' (never touched the bot) and the two paused states — a paused job
// holds the single bot slot and isn't progressing, so the owner must be able to
// give up on it instead of waiting for the 48h backstop. 'dispatching' /
// 'running' and terminal states still return 409. Sets notified_user_at so the
// cancelled row doesn't resurface as a "while you were away" item on the next
// reload.
pipelines.post("/:jobId/cancel", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  if (!jobId) return c.json({ error: "missing_job_id" }, 400);

  const owned = await c.env.DB.prepare(
    `SELECT user_id, state, resume_accepted_at FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(jobId)
    .first<{ user_id: number; state: string; resume_accepted_at: number | null }>();
  if (!owned) return c.json({ error: "not_found" }, 404);
  if (owned.user_id !== userId) return c.json({ error: "forbidden" }, 403);
  const CANCELLABLE = ["queued", "paused_for_outage", "paused_for_usage_limit"];
  if (!CANCELLABLE.includes(owned.state)) {
    return c.json({ error: "cannot_cancel", state: owned.state }, 409);
  }

  // Refuse while an accepted resume is still starting up. This is the same
  // hazard GATE 0 closes in attemptOutageResume, reached through the cancel door
  // instead of the poll door: after the bot accepts, our row keeps displaying
  // 'paused_for_outage' for up to the grace window (the bot reports that state
  // until the resumed run writes its first checkpoint), so the Cancel button
  // stays enabled. Cancelling then releases the chapter lock and dispatches a
  // second job to the single-slot bot while the resumed run is actively writing
  // D1 and Door43. There is no upstream cancel to call — cancel here is purely
  // local bookkeeping — so refusing is the only correct answer.
  if (
    owned.state !== "queued" &&
    owned.resume_accepted_at !== null &&
    Math.floor(Date.now() / 1000) - owned.resume_accepted_at < RESUME_ACCEPTED_GRACE_SECONDS
  ) {
    return c.json(
      {
        error: "resume_in_progress",
        state: owned.state,
        message:
          "the bot accepted a resume for this run and it is still starting — " +
          "cancelling now would run a second job against it",
      },
      409,
    );
  }

  // Guard on the cancellable set again in the UPDATE so a concurrent dispatch
  // that just claimed this row (queued -> dispatching) can't be cancelled out
  // from under the bot. NOTE: this does NOT protect against cancelling a job
  // whose resume was just accepted — a successful resume deliberately leaves the
  // state at 'paused_for_outage' (that is GATE 0's premise), so such a row stays
  // inside CANCELLABLE. The resume_accepted_at check above is what covers that.
  const res = await c.env.DB.prepare(
    `UPDATE pipeline_jobs
        SET state = 'cancelled', notified_user_at = unixepoch(), updated_at = unixepoch()
      WHERE job_id = ?1 AND state IN (?2, ?3, ?4)`,
  )
    .bind(jobId, ...CANCELLABLE)
    .run();
  if ((res.meta?.changes ?? 0) === 0) {
    const now = await c.env.DB.prepare(
      `SELECT state FROM pipeline_jobs WHERE job_id = ?1`,
    )
      .bind(jobId)
      .first<{ state: string }>();
    return c.json({ error: "cannot_cancel", state: now?.state ?? "unknown" }, 409);
  }
  // Cancelling a paused job frees the single bot slot it was holding — pull the
  // next queued job right away rather than waiting for the */5 cron.
  if (owned.state !== "queued") {
    try {
      await dispatchNext(c.env);
    } catch (err) {
      console.error(`[cancel.dispatchNext] job=${jobId}:`, err);
    }
  }
  return c.json({ ok: true, jobId, state: "cancelled" });
});

// States a force-fail will act on — deliberately the mirror image of /cancel's
// CANCELLABLE set above. /cancel refuses 'running' and 'dispatching' because
// there is nothing to cancel: the bot already has the work, so "cancel" would
// just orphan our row while the bot keeps grinding. Force-fail exists for
// exactly the opposite reason: those two states are the ONLY ones that can
// wedge (see issue #398 / NUM 27) — a queued job has never touched the bot,
// and every other state is already terminal or already has its own recovery
// path (resume). 'dispatching' is included because the single bot slot is
// already claimed the moment we flip to it (before the upstream POST even
// lands), so a wedge in that narrow window would otherwise have no exit
// either.
const FORCE_FAILABLE = ["running", "dispatching"];
// Generated from FORCE_FAILABLE.length rather than hand-written ("?3, ?4")
// so a future third state can't silently desync the CAS UPDATE's bind list
// from its placeholder count (a D1 bind-count mismatch is a runtime error,
// not a type error, so this class of bug is otherwise invisible until it
// ships). Placeholders start at ?3 because ?1/?2 are jobId/errorMessage.
const FORCE_FAILABLE_PLACEHOLDERS = FORCE_FAILABLE.map((_, i) => `?${i + 3}`).join(", ");

// Derives the typed confirmation phrase from the job's own book/chapter
// range. Exported so it's unit-testable and so the frontend can mirror the
// exact formula (see the comment at its web/src/sync/api.ts call site) — the
// server is always the source of truth; the client only recomputes it so the
// dialog can show it and gate its own confirm button without a round trip.
export function forceStopPhrase(
  book: string,
  startChapter: number,
  endChapter: number,
): string {
  const range =
    startChapter === endChapter ? `${startChapter}` : `${startChapter}-${endChapter}`;
  return `STOP THE AI FOR ${book} ${range}`;
}

const ForceFailBody = z.object({ confirm: z.string() }).strict();

export type ForceFailResult =
  | { kind: "not_found" }
  | { kind: "cannot_force_fail"; state: string }
  | { kind: "confirm_mismatch" }
  | { kind: "ok"; jobId: string };

// Core force-fail logic, split out from the route below so it's testable
// without spinning up Hono (mirrors how pollPipelineJob/dispatchNext are
// standalone functions the routes call into). Does everything except turn
// the result into an HTTP response.
export async function forceFailJob(
  env: Env,
  params: { jobId: string; userId: number; confirm: string },
): Promise<ForceFailResult> {
  const { jobId, userId, confirm } = params;

  const owned = await env.DB.prepare(
    `SELECT user_id, state, upstream_job_id, book, start_chapter, end_chapter
       FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(jobId)
    .first<{
      user_id: number;
      state: string;
      upstream_job_id: string | null;
      book: string;
      start_chapter: number;
      end_chapter: number;
    }>();
  if (!owned) return { kind: "not_found" };
  if (!FORCE_FAILABLE.includes(owned.state)) {
    return { kind: "cannot_force_fail", state: owned.state };
  }

  const expected = forceStopPhrase(owned.book, owned.start_chapter, owned.end_chapter);
  if (confirm.trim() !== expected) {
    return { kind: "confirm_mismatch" };
  }

  // Prefer the DCS username over the bare id: this message is read by a human
  // debugging "why did this run die?", and `force-stopped by user 1` makes them
  // go do a second lookup. Fall back to the id if the users row is missing.
  const actor = (await resolveUsernameFromDb(env, userId)) ?? `user ${userId}`;
  // Any editor can force-stop now (see the route comment below), so the actor
  // is frequently NOT the job's owner. Resolve the owner's username too, so
  // the audit trail names both — omitted only when actor === owner.
  const isOwner = owned.user_id === userId;
  const ownerName = isOwner
    ? null
    : ((await resolveUsernameFromDb(env, owned.user_id)) ?? `user ${owned.user_id}`);

  // FIX (F6): the CAS UPDATE now runs FIRST, with a placeholder outcome, and
  // the upstream /stop call happens only after it lands. The original order
  // (upstream call, then CAS) meant that if the CAS matched 0 rows — the job
  // had just gone 'done' via a concurrent poll, or another tab's force-fail
  // already won — the caller was told "cannot_force_fail" even though the bot
  // had already been told to stop. That's harmless while the bot's /stop
  // contract is a no-op, but the moment it ships it becomes "the UI said the
  // stop failed, and the run was killed anyway" — able to kill a run that was
  // legitimately finishing. Doing the CAS first means we only ever call
  // upstream once we've genuinely won the local state transition.
  const placeholderMessage = ownerName
    ? `force-stopped by ${actor} (owner: ${ownerName}); upstream stop: pending`
    : `force-stopped by ${actor}; upstream stop: pending`;

  // CAS-guarded local UPDATE so a concurrent transition (e.g. the bot finally
  // reporting 'done'/'failed' via a poll landing at the same moment) can't be
  // clobbered by this write. notified_user_at is set for the same reason
  // /cancel sets it: the acting user just did this themselves, so it must
  // never resurface as a "while you were away" item.
  const res = await env.DB.prepare(
    `UPDATE pipeline_jobs
        SET state = 'failed',
            error_kind = 'force_stopped',
            error_message = ?2,
            notified_user_at = unixepoch(),
            updated_at = unixepoch()
      WHERE job_id = ?1 AND state IN (${FORCE_FAILABLE_PLACEHOLDERS})`,
  )
    .bind(jobId, placeholderMessage, ...FORCE_FAILABLE)
    .run();
  if ((res.meta?.changes ?? 0) === 0) {
    const now = await env.DB.prepare(`SELECT state FROM pipeline_jobs WHERE job_id = ?1`)
      .bind(jobId)
      .first<{ state: string }>();
    return { kind: "cannot_force_fail", state: now?.state ?? "unknown" };
  }

  // Best-effort upstream stop, explicitly non-fatal: the bot-side
  // `/api/pipeline/:jobId/stop` contract (issue #398 §2) does not exist yet —
  // this route must fully work with it absent, since that is the current
  // production reality and the primary case this code will hit for a while.
  // Any failure (network, non-2xx, or the endpoint simply 404ing) is
  // swallowed and folded into the error_message as an audit trail, never
  // thrown — a translator watching a wedged, locked chapter must be able to
  // get unstuck locally even if the bot can't be reached at all. Time-boxed
  // to 5s: a hung/black-holed bot is exactly the "wedged" case this feature
  // exists for, and an un-timeboxed fetch here would stall this whole
  // request until the Workers wall-clock limit.
  let upstreamOutcome = "upstream stop: not attempted (no upstream_job_id)";
  if (owned.upstream_job_id && env.BT_API_TOKEN) {
    try {
      const stopRes = await fetch(
        `${upstreamBase(env)}/api/pipeline/${encodeURIComponent(owned.upstream_job_id)}/stop`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${env.BT_API_TOKEN}` },
          signal: AbortSignal.timeout(5000),
        },
      );
      upstreamOutcome = stopRes.ok
        ? "upstream stop: ok"
        : `upstream stop: ${stopRes.status}`;
    } catch (err) {
      upstreamOutcome =
        (err as { name?: string } | undefined)?.name === "TimeoutError"
          ? "upstream stop: timed out"
          : "upstream stop: unreachable";
    }
  } else if (owned.upstream_job_id) {
    upstreamOutcome = "upstream stop: not attempted (pipeline API disabled)";
  }

  const errorMessage = ownerName
    ? `force-stopped by ${actor} (owner: ${ownerName}); ${upstreamOutcome}`
    : `force-stopped by ${actor}; ${upstreamOutcome}`;

  // Second, small UPDATE to record the real upstream outcome now that we know
  // it — guarded so it only ever touches the row this call itself just force-
  // stopped (never some other terminal transition that happened to land in
  // between).
  await env.DB.prepare(
    `UPDATE pipeline_jobs
        SET error_message = ?2
      WHERE job_id = ?1 AND error_kind = 'force_stopped'`,
  )
    .bind(jobId, errorMessage)
    .run();

  // Freeing the single bot slot is the whole point (see issue #398 — two tqs
  // jobs sat starved behind a wedged 'running' row for ~3 hours). Mirrors
  // /cancel's dispatchNext call, but deliberately LAST: handing the bot a new
  // job before asking it to stop the old one would, once the stop contract
  // ships, mean two runs briefly overlap on a single-slot bot for no reason.
  // The stop call above is time-boxed to 5s, so the queue never waits long.
  try {
    await dispatchNext(env);
  } catch (err) {
    console.error(`[force-fail.dispatchNext] job=${jobId}:`, err);
  }

  return { kind: "ok", jobId };
}

// POST /api/pipelines/:jobId/force-fail  — the manual escape hatch /cancel
// deliberately doesn't provide: it accepts 'running' and 'dispatching', the
// exact two states /cancel refuses, because those are the only states that
// can actually wedge (see FORCE_FAILABLE's comment above and issue #398 for
// the NUM 27 incident this was built from — a fly.io restart orphaned a
// checkpoint mid-run, and the only exits were automatic backstops 6-10 hours
// out, during which the job held both the chapter lock and the single bot
// dispatch slot).
//
// Any authenticated editor may force-stop, not just the job's owner: the
// resource being freed (the chapter lock + the single bot dispatch slot) is
// shared across every translator, not owned by whoever happened to start the
// run, and GET /api/pipelines already shows every user's active/queued jobs
// (queueVisible/ACTIVE_STATES) — so another editor's running job is already
// visible in the client before they'd ever reach for this button. Restricting
// the escape hatch to the owner was exactly the NUM 27 failure mode: the
// owner was asleep, the job was wedged holding the only bot slot, and nobody
// else could clear it (issue #398).
//
// The typed confirmation (`{confirm: string}`, matched exactly against a
// phrase the SERVER derives from the job's own book/chapter — never trust a
// client-supplied phrase) is a deliberate speed bump, not a security control,
// same reasoning as the force-resume comment above: the exposure being
// defended against is "an editor clicks through a destructive action without
// reading it," not privilege escalation — every force-stop is attributed in
// the job's error_message (actor, and the owner too when the actor isn't the
// owner), so misuse is traceable after the fact. Making the phrase name the
// book and chapter range means the blast radius is legible in the same box
// the user types into, rather than trusting a generic "are you sure?" to have
// been read.
//
// The upstream stop call is best-effort (see forceFailJob above) because the
// bot-side kill contract is a follow-up landing in a separate repo/PR — this
// route must degrade gracefully to "local-only" until that ships.
pipelines.post("/:jobId/force-fail", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  if (!jobId) return c.json({ error: "missing_job_id" }, 400);

  let confirm: string;
  try {
    const body = ForceFailBody.parse(await c.req.json());
    confirm = body.confirm;
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }

  const result = await forceFailJob(c.env, { jobId, userId, confirm });
  switch (result.kind) {
    case "not_found":
      return c.json({ error: "not_found" }, 404);
    case "cannot_force_fail":
      return c.json({ error: "cannot_force_fail", state: result.state }, 409);
    case "confirm_mismatch":
      return c.json({ error: "confirm_mismatch" }, 400);
    case "ok":
      return c.json({ ok: true, jobId: result.jobId, state: "failed" });
  }
});

// POST /api/pipelines/:jobId/resume  — ask the bot to pick a paused run back
// up. Body: optional {force?: boolean}, DEFAULT FALSE.
//
// Two-step, but ENFORCED BY THE UI ONLY — be precise about this, because the
// step is load-bearing. `force` bypasses the bot's 90-minute pause box, which is
// the only real containment we have against republishing stale content: a
// resumed run reuses its cached artifacts and skips the live-ULT freshness check
// (bp-bot/STALE-SOURCE-DIAGNOSIS.md §3.1). So a one-click force would let an
// editor silently republish text generated before three days of edits. The UI's
// first click sends force=false and is allowed to be refused with 409
// 'stale_pause'; only after it has shown the pause age and the user has confirmed
// does a second call arrive with force=true.
//
// Nothing here records that step one happened, so any other client — a script,
// curl, a second frontend — can send force=true on its first call and skip the
// confirmation entirely. That is a deliberate limit, not an oversight: this is an
// authenticated editor-only route and the caller is the job's own owner, so the
// exposure is "an editor bypasses a warning about their own run", not privilege
// escalation. If a non-UI client ever calls this route, enforce the step
// server-side (e.g. honor force only when this job has a recent recorded
// refusal) rather than trusting the comment.
//
// Otherwise deliberately more permissive than the automatic path in
// attemptOutageResume: no time-box of our own and no attempt cap, and it does
// NOT increment resume_attempt_count — three human clicks must not exhaust the
// automatic budget. It does set last_resume_at, so spacing still applies and a
// */5 poll landing right after a click doesn't stack a second attempt. Also covers
// 'paused_for_usage_limit', which auto-resume never touches (the daily budget
// resets, so a manual resume the next day is exactly the right move).
// Same auth + ownership shape as /cancel above.
pipelines.post("/:jobId/resume", requireEditor, async (c) => {
  if (!c.env.BT_API_TOKEN) {
    return c.json({ error: "pipeline_api_disabled" }, 503);
  }
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  if (!jobId) return c.json({ error: "missing_job_id" }, 400);

  const owned = await c.env.DB.prepare(
    `SELECT user_id, state, upstream_job_id, options_json
       FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(jobId)
    .first<{
      user_id: number;
      state: string;
      upstream_job_id: string | null;
      options_json: string | null;
    }>();
  if (!owned) return c.json({ error: "not_found" }, 404);
  if (owned.user_id !== userId) return c.json({ error: "forbidden" }, 403);
  if (owned.state !== "paused_for_outage" && owned.state !== "paused_for_usage_limit") {
    return c.json({ error: "cannot_resume", state: owned.state }, 409);
  }
  if (!owned.upstream_job_id) {
    // Paused implies it reached the bot, so this shouldn't happen; be explicit
    // rather than calling the bot with an empty id.
    return c.json({ error: "cannot_resume", state: owned.state }, 409);
  }

  // Same as the automatic path: the bot can't recover the requesting username or
  // the original options from its checkpoint, so send both (see callUpstreamResume).
  const username = await resolveUsername(c, owned.user_id);
  const options = resumeOptionsFromJson(owned.options_json, jobId);

  // Opt-in force only. An absent, empty or non-JSON body means force=false —
  // the safe default (see the route comment).
  let force = false;
  try {
    const body = (await c.req.json()) as { force?: unknown } | null;
    force = body?.force === true;
  } catch {
    /* no body / not JSON — force stays false */
  }

  // Open the spacing window BEFORE the call, and regardless of outcome. This is
  // what keeps the two-step usable: the client re-polls immediately after a 409
  // 'stale_pause', and without this the automatic path would see an untouched
  // last_resume_at, apply the age gate, and fail the job — leaving the user
  // staring at a "Resume anyway?" prompt for a job that is already failed. A
  // human is mid-decision on this job; the poller must leave it alone.
  // Deliberately does NOT touch resume_attempt_count — see the route comment.
  //
  // It does NOT extend an already-open window, and that bound matters: the
  // automatic path checks spacing ahead of the age gate and the fail-fast
  // verdicts, so a client clicking Resume more often than the spacing interval
  // could otherwise suppress automatic recovery AND automatic fail-fast
  // indefinitely — re-creating the ~8h queue wedge this whole change exists to
  // remove. Refreshing only a closed window caps the suppression at one interval.
  await c.env.DB.prepare(
    `UPDATE pipeline_jobs
        SET last_resume_at = unixepoch()
      WHERE job_id = ?1
        AND (last_resume_at IS NULL OR last_resume_at < unixepoch() - ?2)`,
  )
    .bind(jobId, RESUME_RETRY_SPACING_SECONDS)
    .run();

  // In flight from here — set before the call, same reasoning as the automatic
  // path: the bot may launch the run before we learn it accepted, and a cancel
  // landing in that window would abandon a live run. `owned` is false when the
  // poller (or another tab) already holds a live marker — then this call must not
  // clear it on its own refusal (see markResumeInFlight).
  const ownedMarker = await markResumeInFlight(c.env, jobId);

  const call = await callUpstreamResume(c.env, owned.upstream_job_id, {
    force,
    ...(username ? { username } : {}),
    ...(options ? { options } : {}),
  });
  if (call.kind === "accepted") {
    // Marker already set; refresh updated_at so the panel reflects the action.
    // Leave `state` alone — the next poll observes real progress.
    await c.env.DB.prepare(
      `UPDATE pipeline_jobs SET updated_at = unixepoch() WHERE job_id = ?1`,
    )
      .bind(jobId)
      .run();
    return c.json({ ok: true, jobId, state: "resumed", upstream: call.body });
  }
  // Not taken: clear the marker so the job stays cancellable and the poller is
  // not blocked on a resume that never happened. Must precede both returns
  // below — a refused stale_pause is the expected first half of the two-step,
  // and leaving the marker set there would block the Cancel button as well.
  if (ownedMarker) await clearResumeInFlight(c.env, jobId);
  if (call.kind === "refused") {
    // pausedAgeSeconds accompanies the bot's 'stale_pause' refusal; the client
    // needs it to name the age in the "resume anyway?" confirmation.
    return c.json(
      {
        error: "resume_refused",
        state: owned.state,
        // `code` is the bare machine code — the client branches on this to
        // decide whether to offer "resume anyway" (it looks for 'stale_pause').
        // `message` is prose and includes the bot's own explanation appended, so
        // it must never be compared for equality. Keeping them separate is what
        // lets us surface the bot's actually-useful text (e.g. "resume it from
        // Zulip instead") without breaking that branch.
        code: call.code,
        message: call.reason,
        ...(call.pausedAgeSeconds !== undefined
          ? { pausedAgeSeconds: call.pausedAgeSeconds }
          : {}),
      },
      409,
    );
  }
  return c.json({ error: "upstream_error", message: call.reason }, 502);
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

