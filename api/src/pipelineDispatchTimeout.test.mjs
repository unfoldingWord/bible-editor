// Regression coverage for issue #493: dispatchNext's upstream POST used to
// have no timeout at all, so a slow POST (cold start / slow proxy) could
// outlive STUCK_DISPATCH_THRESHOLD_SECONDS (120s) — the */5 stale-dispatch
// sweep would fail the row and free the slot while the original POST was
// still in flight, and that same tick's dispatchNext safety net could then
// dispatch a SECOND job, double-occupying the single-slot bot.
//
// Mirrors pipelinesForceFail.test.mjs's fake-D1/fetch-stub pattern (same
// file that covers dispatchNext's F2 promote-guard) — see that file's header
// for what this style of test proves and doesn't prove.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/pipelineDispatchTimeout.test.mjs

import { dispatchNext } from "./pipelines.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Fake D1 for dispatchNext, same shape as pipelinesForceFail.test.mjs's
// fakeDispatchEnv, plus bind-value capture on fail()'s UPDATE so these tests
// can assert error_kind/error_message, not just that the query ran.
function fakeDispatchEnv() {
  const env = {
    BT_API_TOKEN: "tok",
    queries: [],
    failCalls: [],
    DB: {
      prepare(sql) {
        env.queries.push(sql);
        if (/SELECT dcs_username FROM users/.test(sql)) {
          return { bind: () => ({ first: async () => ({ dcs_username: "translator" }) }) };
        }
        if (/SELECT DISTINCT book FROM pipeline_jobs WHERE state = 'queued'/.test(sql)) {
          return { all: async () => ({ results: [] }) };
        }
        if (/SET state = 'dispatching', updated_at = unixepoch\(\)/.test(sql)) {
          return { bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) };
        }
        if (/SELECT job_id, user_id, pipeline_type, book, start_chapter, end_chapter,[\s\S]*session_key, options_json/.test(sql)) {
          const dispatchingJob = {
            job_id: "job-dispatch",
            user_id: 1,
            pipeline_type: "notes",
            book: "NUM",
            start_chapter: 27,
            end_chapter: 27,
            session_key: "sess-dispatch",
            options_json: null,
          };
          return { first: async () => dispatchingJob, bind: () => ({ first: async () => dispatchingJob }) };
        }
        // fail()'s UPDATE (api/src/pipelines.ts's `const fail = async (kind,
        // message) => ...`) — capture the bound (kind, message) so the
        // timeout-vs-network-error distinction is provable, not just trusted.
        if (/SET state = 'failed', error_kind = \?2, error_message = \?3/.test(sql)) {
          return {
            bind: (...args) => ({
              run: async () => {
                env.failCalls.push({ jobId: args[0], kind: args[1], message: args[2] });
                return { meta: { changes: 1 } };
              },
            }),
          };
        }
        // The promote-to-running UPDATE — succeeds, so the happy-path test
        // below doesn't spuriously log an orphaned-upstream-job warning.
        if (/SET state = 'running', upstream_job_id = \?2/.test(sql)) {
          return { bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) };
        }
        // Anything else — inert.
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

console.log("\n[dispatchNext's upstream POST carries a timeout signal]");
await withFetch(
  async () => new Response(JSON.stringify({ jobId: "bot-job-1" }), { status: 200 }),
  async (calls) => {
    const env = fakeDispatchEnv();
    await dispatchNext(env);
    assert(calls.length === 1, "the upstream POST was issued");
    assert(
      calls[0]?.init?.signal instanceof AbortSignal,
      "the fetch init carries an AbortSignal — the #493 fix was not silently dropped",
    );
  },
);

console.log("\n[a timed-out dispatch POST fails the row locally, distinctly from a plain network error]");
await withFetch(
  async () => {
    // What Node's fetch/undici actually throws when an AbortSignal.timeout()
    // signal fires mid-request.
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  },
  async () => {
    const env = fakeDispatchEnv();
    await dispatchNext(env);
    assert(env.failCalls.length === 1, "fail() was called exactly once");
    assert(env.failCalls[0]?.kind === "transient_outage", "timeout is classified as transient_outage");
    assert(
      /timeout/i.test(env.failCalls[0]?.message ?? ""),
      `timeout failure message names the timeout, not a generic unreachable message (got ${JSON.stringify(env.failCalls[0]?.message)})`,
    );
  },
);

console.log("\n[a timeout during the response BODY read (not just connect/headers) is caught the same way]");
await withFetch(
  async () => ({
    // fetch() itself resolves fine (headers arrived) — the AbortSignal fires
    // later, while streaming the body, which is exactly what dispatchNext's
    // `await upstream.text()` call exercises. This must be caught by the
    // SAME try/catch as the fetch() call itself, not escape past it.
    ok: true,
    status: 200,
    text: async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    },
  }),
  async () => {
    const env = fakeDispatchEnv();
    await dispatchNext(env); // must not throw/reject
    assert(env.failCalls.length === 1, "fail() was called exactly once for a body-read timeout");
    assert(env.failCalls[0]?.kind === "transient_outage", "body-read timeout is classified as transient_outage");
    assert(
      /timeout/i.test(env.failCalls[0]?.message ?? ""),
      `body-read timeout message names the timeout (got ${JSON.stringify(env.failCalls[0]?.message)})`,
    );
  },
);

console.log("\n[a plain network failure (not a timeout) still reports the pre-existing unreachable message]");
await withFetch(
  async () => {
    throw new TypeError("fetch failed");
  },
  async () => {
    const env = fakeDispatchEnv();
    await dispatchNext(env);
    assert(env.failCalls.length === 1, "fail() was called exactly once");
    assert(env.failCalls[0]?.kind === "transient_outage", "still classified as transient_outage");
    assert(
      env.failCalls[0]?.message === "upstream_unreachable",
      `non-timeout network errors keep the original message (got ${JSON.stringify(env.failCalls[0]?.message)})`,
    );
  },
);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll pipelineDispatchTimeout assertions passed.");
