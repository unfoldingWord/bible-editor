// Unit tests for the force-stop path (issue #398): forceStopPhrase (the typed
// confirmation formula) and forceFailJob (the route's core logic, split out
// from the Hono handler so it's testable without spinning up the app — see
// api/src/pipelines.ts for why). Also covers pollPipelineJob's FIX 1(b) guard
// (a force-stopped job can't be clobbered back to 'running' by a poll).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/pipelinesForceFail.test.mjs
//
// Not a test framework; a failed assert exits non-zero. Mirrors
// chapterLock.test.mjs's fake-D1-stub pattern.
//
// What this stub proves vs. doesn't: every assertion below is a SQL-text or
// call-argument assertion against the fake D1/fetch stand-ins, which is
// enough to catch a regression that removes a WHERE clause, a dispatchNext()
// call, or mangles the upstream request shape. It does NOT prove the actual
// bind() *values* line up with the query's placeholders (the stub ignores
// bind() positionally in most branches), and it does not exercise the real
// Hono route mapping (method/path wiring, auth middleware) — that's
// integration-test territory this file doesn't attempt.

import { forceStopPhrase, forceFailJob, pollPipelineJob } from "./pipelines.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ─── forceStopPhrase ────────────────────────────────────────────────────────
{
  console.log("\n[forceStopPhrase]");
  assert(
    forceStopPhrase("NUM", 27, 27) === "STOP THE AI FOR NUM 27",
    "single chapter",
  );
  assert(
    forceStopPhrase("NUM", 27, 30) === "STOP THE AI FOR NUM 27-30",
    "chapter range",
  );
}

// ─── forceFailJob ───────────────────────────────────────────────────────────
// Minimal D1 stand-in. Recognizes the queries forceFailJob/pollPipelineJob/
// dispatchNext issue and falls back to inert no-ops for anything else.
// Every SQL string passed to prepare() is recorded on env.queries (in
// call order) so tests can assert *which* queries ran and inspect their text
// — this is what makes "was dispatchNext's claim query issued" and "does the
// CAS UPDATE still constrain state" provable instead of just trusted.
//
// lastErrorMessage lives on the returned env instance (not a function-level
// static) so parallel/sequential cases can't leak each other's value — the
// prior version had exactly that bug: a case whose UPDATE never ran would
// silently read the previous case's stamped message.
function fakeEnv({
  row,
  updateChanges = 1,
  rereadState = "done",
  btApiToken,
  username = null,
}) {
  const env = {
    BT_API_TOKEN: btApiToken,
    queries: [],
    lastErrorMessage: undefined,
    DB: {
      prepare(sql) {
        env.queries.push(sql);
        // resolveUsernameFromDb's lookup for the audit trail. Default null so
        // the other cases exercise the "users row missing" fallback.
        if (/SELECT dcs_username FROM users/.test(sql)) {
          return {
            bind: () => ({ first: async () => (username ? { dcs_username: username } : null) }),
          };
        }
        if (/SELECT user_id, state, upstream_job_id, book, start_chapter, end_chapter/.test(sql)) {
          return {
            bind: () => ({ first: async () => row }),
          };
        }
        if (/SET state = 'failed'[\s\S]*error_kind = 'force_stopped'/.test(sql)) {
          return {
            bind: (...args) => ({
              run: async () => {
                env.lastErrorMessage = args[1];
                return { meta: { changes: updateChanges } };
              },
            }),
          };
        }
        if (/SELECT state FROM pipeline_jobs WHERE job_id = \?1/.test(sql)) {
          return { bind: () => ({ first: async () => ({ state: rereadState }) }) };
        }
        // Anything else (dispatchNext's claim/select/fail queries, the poll
        // path's resume-budget reset, etc.) — inert, but still logged above so
        // callers can assert on *which* queries were prepared.
        return {
          bind: () => ({
            run: async () => ({ meta: { changes: 0 } }),
            first: async () => null,
            all: async () => ({ results: [] }),
          }),
        };
      },
    },
  };
  return env;
}

const baseJob = {
  user_id: 1,
  state: "running",
  upstream_job_id: "stream_81_upstream",
  book: "NUM",
  start_chapter: 27,
  end_chapter: 27,
};

// Swap global fetch per-test, capturing every call's (url, init) so request
// shape can be asserted. forceFailJob/dispatchNext/pollPipelineJob all call
// the module-level `fetch`, not anything injected via env — there is no
// env.fetch plumbing in production code, so this is the only real seam.
const originalFetch = globalThis.fetch;

async function withFetch(impl, fn) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return impl(url, init);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ─── confirm mismatch → 400-shaped result ──────────────────────────────────
{
  console.log("\n[confirm mismatch]");
  const env = fakeEnv({ row: baseJob });
  const result = await forceFailJob(env, {
    jobId: "job-1",
    userId: 1,
    confirm: "STOP THE AI FOR NUM 26", // wrong chapter
  });
  assert(result.kind === "confirm_mismatch", "wrong phrase is rejected");
}

// ─── wrong state → 409-shaped result ───────────────────────────────────────
{
  console.log("\n[wrong state]");
  const env = fakeEnv({ row: { ...baseJob, state: "queued" } });
  const result = await forceFailJob(env, {
    jobId: "job-2",
    userId: 1,
    confirm: "STOP THE AI FOR NUM 27",
  });
  assert(result.kind === "cannot_force_fail", "queued is refused");
  assert(result.state === "queued", "reports the actual state");
}

// ─── not found / forbidden ──────────────────────────────────────────────────
{
  console.log("\n[not found / forbidden]");
  const notFoundEnv = fakeEnv({ row: null });
  const nf = await forceFailJob(notFoundEnv, {
    jobId: "missing",
    userId: 1,
    confirm: "anything",
  });
  assert(nf.kind === "not_found", "missing row -> not_found");

  const forbiddenEnv = fakeEnv({ row: { ...baseJob, user_id: 99 } });
  const fb = await forceFailJob(forbiddenEnv, {
    jobId: "job-3",
    userId: 1,
    confirm: "STOP THE AI FOR NUM 27",
  });
  assert(fb.kind === "forbidden", "not the owner -> forbidden");
}

// ─── happy path: running -> failed, upstream stop succeeds ────────────────
// btApiToken is set so dispatchNext (which no-ops immediately without one)
// actually proceeds past its BT_API_TOKEN guard and issues its claim query.
await withFetch(
  async () => new Response("{}", { status: 200 }),
  async (calls) => {
    console.log("\n[happy path]");
    const env = fakeEnv({ row: baseJob, btApiToken: "tok" });
    const result = await forceFailJob(env, {
      jobId: "job-4",
      userId: 1,
      confirm: "STOP THE AI FOR NUM 27",
    });
    assert(result.kind === "ok", "running job force-stops");
    assert(result.jobId === "job-4", "returns the job id");

    // Proves dispatchNext(env) actually ran: its claim query (the UPDATE that
    // promotes a queued row to 'dispatching') must have been prepared. If the
    // `await dispatchNext(env)` call were deleted, this query never fires and
    // this assertion catches it.
    assert(
      env.queries.some((q) => /UPDATE pipeline_jobs[\s\S]*state = 'dispatching'/.test(q)),
      "dispatchNext's claim query was issued (proves dispatchNext(env) ran)",
    );

    // Proves the upstream stop request is well-formed.
    assert(calls.length === 1, "exactly one upstream fetch call");
    const [call] = calls;
    assert(
      call.url.includes(encodeURIComponent(baseJob.upstream_job_id)) &&
        call.url.endsWith("/stop"),
      `URL carries the encoded upstream_job_id and ends with /stop (got: ${call.url})`,
    );
    assert(call.init?.method === "POST", "method is POST");
    assert(
      call.init?.headers?.Authorization === "Bearer tok",
      "Authorization header is Bearer <token>",
    );
  },
);

// ─── upstream stop 404s (bot endpoint doesn't exist yet) — local fail still lands ─
await withFetch(
  async () => new Response("not found", { status: 404 }),
  async () => {
    console.log("\n[upstream 404 is non-fatal]");
    const env = fakeEnv({ row: baseJob, btApiToken: "tok" });
    const result = await forceFailJob(env, {
      jobId: "job-5",
      userId: 1,
      confirm: "STOP THE AI FOR NUM 27",
    });
    assert(result.kind === "ok", "local fail lands even though upstream 404s");
  },
);

// ─── upstream stop unreachable (network error) — local fail still lands ───
await withFetch(
  async () => {
    throw new Error("ECONNREFUSED");
  },
  async () => {
    console.log("\n[upstream unreachable is non-fatal]");
    const env = fakeEnv({ row: baseJob, btApiToken: "tok" });
    const result = await forceFailJob(env, {
      jobId: "job-6",
      userId: 1,
      confirm: "STOP THE AI FOR NUM 27",
    });
    assert(result.kind === "ok", "local fail lands even though upstream is unreachable");
  },
);

// ─── dispatching is also force-failable ────────────────────────────────────
{
  console.log("\n[dispatching is force-failable]");
  const env = fakeEnv({ row: { ...baseJob, state: "dispatching" } });
  const result = await forceFailJob(env, {
    jobId: "job-7",
    userId: 1,
    confirm: "STOP THE AI FOR NUM 27",
  });
  assert(result.kind === "ok", "dispatching job force-stops");
}

// ─── a concurrent transition beat us to it (CAS UPDATE affects 0 rows) ─────
{
  console.log("\n[lost the CAS race]");
  const env = fakeEnv({ row: baseJob, updateChanges: 0, rereadState: "done" });
  const result = await forceFailJob(env, {
    jobId: "job-8",
    userId: 1,
    confirm: "STOP THE AI FOR NUM 27",
  });
  assert(result.kind === "cannot_force_fail", "0 rows changed -> refused");
  assert(result.state === "done", "reports the state it actually landed in");
}

// ─── the CAS guard is still present in the UPDATE's WHERE ─────────────────
// If FIX 6/the state guard were ever deleted from the CAS UPDATE's WHERE
// clause, this fails — proving the guard exists rather than just trusting it.
{
  console.log("\n[CAS guard present in SQL text]");
  const env = fakeEnv({ row: baseJob });
  await forceFailJob(env, {
    jobId: "job-11",
    userId: 1,
    confirm: "STOP THE AI FOR NUM 27",
  });
  const casQuery = env.queries.find((q) => /SET state = 'failed'/.test(q));
  assert(Boolean(casQuery), "the force-fail CAS UPDATE was prepared");
  assert(
    /WHERE job_id = \?1 AND state IN/.test(casQuery ?? ""),
    "its WHERE clause still constrains on state (the CAS guard)",
  );
}

// ─── the audit trail ────────────────────────────────────────────────────────
// error_message is the only record of who killed a run and whether the bot
// was told, so assert its shape rather than trusting it by inspection.
{
  console.log("\n[audit trail]");
  // No upstream_job_id keeps this case off the network so it asserts the
  // actor half only; the upstream half is covered by the 404/unreachable cases.
  const localOnly = { ...baseJob, upstream_job_id: null };

  const env = fakeEnv({ row: localOnly, username: "benjamin" });
  await forceFailJob(env, {
    jobId: "job-9",
    userId: 1,
    confirm: "STOP THE AI FOR NUM 27",
  });
  assert(
    env.lastErrorMessage ===
      "force-stopped by benjamin; upstream stop: not attempted (no upstream_job_id)",
    `names the acting user and the upstream outcome (got: ${env.lastErrorMessage})`,
  );

  // Same owner (user_id 1) so we reach the UPDATE — this asserts the username
  // fallback, not the ownership check, which has its own case above.
  const anon = fakeEnv({ row: localOnly });
  await forceFailJob(anon, {
    jobId: "job-10",
    userId: 1,
    confirm: "STOP THE AI FOR NUM 27",
  });
  assert(
    anon.lastErrorMessage ===
      "force-stopped by user 1; upstream stop: not attempted (no upstream_job_id)",
    `falls back to the id when the users row is missing (got: ${anon.lastErrorMessage})`,
  );
}

// ─── pollPipelineJob: FIX 1(b) — a force-stopped job is not clobbered ──────
// Drives the real pollPipelineJob() with a job whose upstream still honestly
// reports 'running' (the exact scenario force-fail exists to survive: the
// bot's stop contract doesn't exist yet, so it keeps grinding and reporting
// running for a while after force-fail lands locally). Asserts the final
// UPDATE's WHERE clause still excludes a force-stopped row — if that guard
// were deleted, this fails.
await withFetch(
  async () => new Response(JSON.stringify({ state: "running" }), { status: 200 }),
  async () => {
    console.log("\n[pollPipelineJob does not clobber a force-stopped job]");
    const env = fakeEnv({ row: baseJob });
    const polledJob = {
      job_id: "job-12",
      upstream_job_id: "stream_12_upstream",
      user_id: 1,
      pipeline_type: "notes",
      book: "NUM",
      start_chapter: 27,
      end_chapter: 27,
      session_key: "sess-12",
      follow_up_options: null,
      follow_up_chain: null,
      follow_up_job_id: "already-set", // suppresses the follow-up-enqueue branch
      no_output_yet: 0, // no output import path — keeps this test to the poll UPDATE
      error_kind: "force_stopped",
      updated_at: Math.floor(Date.now() / 1000),
      resume_attempt_count: 0,
      last_resume_at: null,
      resume_accepted_at: null,
      options_json: null,
    };
    const result = await pollPipelineJob(env, polledJob);
    assert(result.kind === "ok", "poll completes");

    const pollUpdate = env.queries.find(
      (q) => /UPDATE pipeline_jobs SET[\s\S]*last_polled_at = unixepoch\(\)/.test(q),
    );
    assert(Boolean(pollUpdate), "the poll's final UPDATE was prepared");
    assert(
      /AND NOT \(state = 'failed' AND error_kind = 'force_stopped'\)/.test(pollUpdate ?? ""),
      "its WHERE clause excludes an already force-stopped row (FIX 1(b))",
    );
  },
);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll pipelinesForceFail tests passed.");
