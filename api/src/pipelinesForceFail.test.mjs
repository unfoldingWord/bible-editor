// Unit tests for the force-stop path (issue #398): forceStopPhrase (the typed
// confirmation formula) and forceFailJob (the route's core logic, split out
// from the Hono handler so it's testable without spinning up the app — see
// api/src/pipelines.ts for why).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/pipelinesForceFail.test.mjs
//
// Not a test framework; a failed assert exits non-zero. Mirrors
// chapterLock.test.mjs's fake-D1-stub pattern.

import { forceStopPhrase, forceFailJob } from "./pipelines.ts";

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
// Minimal D1 stand-in. Recognizes the two queries forceFailJob issues
// (the ownership/state SELECT and the CAS UPDATE, plus its post-failure
// re-read) and falls back to inert no-ops for anything else (dispatchNext's
// own queries) — dispatchNext no-ops immediately when BT_API_TOKEN is unset,
// and forceFailJob wraps its call in try/catch regardless, so a generic
// fallback never needs to satisfy dispatchNext's real query shapes.
function fakeEnv({
  row,
  updateChanges = 1,
  rereadState = "done",
  btApiToken,
  fetchImpl,
  username = null,
}) {
  return {
    BT_API_TOKEN: btApiToken,
    DB: {
      prepare(sql) {
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
                fakeEnv.lastErrorMessage = args[1];
                return { meta: { changes: updateChanges } };
              },
            }),
          };
        }
        if (/SELECT state FROM pipeline_jobs WHERE job_id = \?1/.test(sql)) {
          return { bind: () => ({ first: async () => ({ state: rereadState }) }) };
        }
        // Anything else (dispatchNext's claim/select/fail queries) — inert.
        return {
          bind: () => ({
            run: async () => ({ meta: { changes: 0 } }),
            first: async () => null,
            all: async () => ({ results: [] }),
          }),
        };
      },
    },
    _fetchImpl: fetchImpl,
  };
}

const baseJob = {
  user_id: 1,
  state: "running",
  upstream_job_id: "stream_81_upstream",
  book: "NUM",
  start_chapter: 27,
  end_chapter: 27,
};

// Swap global fetch per-test; forceFailJob calls the module-level `fetch`.
const originalFetch = globalThis.fetch;

async function withFetch(impl, fn) {
  globalThis.fetch = impl;
  try {
    await fn();
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
await withFetch(
  async () => new Response("{}", { status: 200 }),
  async () => {
    console.log("\n[happy path]");
    const env = fakeEnv({ row: baseJob, btApiToken: "tok" });
    const result = await forceFailJob(env, {
      jobId: "job-4",
      userId: 1,
      confirm: "STOP THE AI FOR NUM 27",
    });
    assert(result.kind === "ok", "running job force-stops");
    assert(result.jobId === "job-4", "returns the job id");
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
    fakeEnv.lastErrorMessage ===
      "force-stopped by benjamin; upstream stop: not attempted (no upstream_job_id)",
    `names the acting user and the upstream outcome (got: ${fakeEnv.lastErrorMessage})`,
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
    fakeEnv.lastErrorMessage ===
      "force-stopped by user 1; upstream stop: not attempted (no upstream_job_id)",
    `falls back to the id when the users row is missing (got: ${fakeEnv.lastErrorMessage})`,
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll pipelinesForceFail tests passed.");
