// Regression coverage for issue #493: dispatchNext's upstream POST used to
// have no timeout at all, so a slow POST (cold start / slow proxy) could
// outlive STUCK_DISPATCH_THRESHOLD_SECONDS (120s) — the */5 stale-dispatch
// sweep would fail the row and free the slot while the original POST was
// still in flight, and that same tick's dispatchNext safety net could then
// dispatch a SECOND job, double-occupying the single-slot bot.
//
// PROGRESSES #493; DOES NOT FULLY CLOSE IT — see issue #511. When
// dispatchNext's own DISPATCH_POST_TIMEOUT_MS fires, we cannot tell whether
// the upstream POST actually landed. Rather than free the slot immediately
// on that ambiguity (which would just relocate the double-dispatch race from
// "the sweep races a live POST" to "our own timeout races a POST that might
// still land"), the row is marked ambiguous (stays 'dispatching', still
// holds the slot) and only finally freed by a dedicated, longer-than-usual
// sweep in pollAllNonTerminal — see AMBIGUOUS_DISPATCH_GRACE_SECONDS's doc
// comment in pipelines.ts for the full reasoning and its documented limits.
//
// Mirrors pipelinesForceFail.test.mjs's fake-D1/fetch-stub pattern (same
// file that covers dispatchNext's F2 promote-guard) — see that file's header
// for what this style of test proves and doesn't prove.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/pipelineDispatchTimeout.test.mjs

import { dispatchNext, pollAllNonTerminal } from "./pipelines.ts";

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
// fakeDispatchEnv, plus bind-value capture on fail()'s and
// markDispatchAmbiguous's UPDATEs so these tests can assert error_kind/
// error_message and which one ran, not just that some query ran.
function fakeDispatchEnv() {
  const env = {
    BT_API_TOKEN: "tok",
    queries: [],
    failCalls: [],
    ambiguousCalls: [],
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
        // markDispatchAmbiguous's UPDATE — deliberately does NOT set `state`
        // (that's the whole point: the row stays 'dispatching', still
        // holding the slot). Distinguished from fail()'s UPDATE by the
        // absence of `state = 'failed'` in its SQL text.
        if (/SET error_kind = \?2, error_message = \?3, updated_at = unixepoch\(\)\s*\n\s*WHERE job_id = \?1 AND state = 'dispatching'/.test(sql)) {
          return {
            bind: (...args) => ({
              run: async () => {
                env.ambiguousCalls.push({ jobId: args[0], kind: args[1], message: args[2] });
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

console.log("\n[a timed-out dispatch POST is marked ambiguous, NOT failed immediately — the slot stays held]");
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
    assert(env.failCalls.length === 0, "fail() was NOT called — state must stay 'dispatching', not jump to 'failed'");
    assert(env.ambiguousCalls.length === 1, "markDispatchAmbiguous's UPDATE ran exactly once");
    assert(env.ambiguousCalls[0]?.kind === "transient_outage", "ambiguous marker uses transient_outage as its kind");
    assert(
      env.ambiguousCalls[0]?.message === "upstream_dispatch_timeout",
      `ambiguous marker names the timeout (got ${JSON.stringify(env.ambiguousCalls[0]?.message)})`,
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
    assert(env.failCalls.length === 0, "fail() was NOT called for a body-read timeout either");
    assert(env.ambiguousCalls.length === 1, "markDispatchAmbiguous's UPDATE ran exactly once for a body-read timeout");
    assert(
      env.ambiguousCalls[0]?.message === "upstream_dispatch_timeout",
      `body-read timeout marker names the timeout (got ${JSON.stringify(env.ambiguousCalls[0]?.message)})`,
    );
  },
);

console.log("\n[a plain network failure (not a timeout) is NOT ambiguous — still fails the row immediately]");
await withFetch(
  async () => {
    throw new TypeError("fetch failed");
  },
  async () => {
    const env = fakeDispatchEnv();
    await dispatchNext(env);
    assert(env.ambiguousCalls.length === 0, "a genuine connection failure is never marked ambiguous");
    assert(env.failCalls.length === 1, "fail() was called exactly once");
    assert(env.failCalls[0]?.kind === "transient_outage", "still classified as transient_outage");
    assert(
      env.failCalls[0]?.message === "upstream_unreachable",
      `non-timeout network errors keep the original message (got ${JSON.stringify(env.failCalls[0]?.message)})`,
    );
  },
);

// ─── The two backstop sweeps in pollAllNonTerminal (issue #511's mechanism) ─
// Fake D1 covering the full pollAllNonTerminal call: its three sweeps, the
// poll-batch SELECT (no rows), and the safety-net dispatchNext call at the
// end (claim UPDATE reports 0 changes, so dispatchNext no-ops immediately —
// this section only cares about the sweeps, not dispatch behavior, which the
// tests above already cover). Mirrors pipelinesForceFail.test.mjs's
// fakePollEnv catch-all shape (`.all` exposed at both the top level and
// after `.bind()`).
function fakeSweepEnv() {
  const env = {
    BT_API_TOKEN: "tok",
    genericSweepBinds: null,
    ambiguousSweepBinds: null,
    DB: {
      prepare(sql) {
        if (/error_message = 'auto-failed: dispatch did not complete'/.test(sql)) {
          return {
            bind: (...args) => {
              env.genericSweepBinds = args;
              return { run: async () => ({ meta: { changes: 0 } }) };
            },
          };
        }
        if (/error_message = 'auto-failed: dispatch POST timed out and never confirmed landing upstream/.test(sql)) {
          return {
            bind: (...args) => {
              env.ambiguousSweepBinds = args;
              return { run: async () => ({ meta: { changes: 0 } }) };
            },
          };
        }
        return {
          all: async () => ({ results: [] }),
          bind: () => ({
            run: async () => ({ meta: { changes: 0 } }),
            first: async () => null,
            all: async () => ({ results: [] }),
          }),
        };
      },
      batch: async () => [],
    },
  };
  return env;
}

console.log("\n[pollAllNonTerminal: the generic stuck-dispatch sweep excludes ambiguous-marked rows]");
{
  const env = fakeSweepEnv();
  await pollAllNonTerminal(env);
  assert(env.genericSweepBinds !== null, "the generic STUCK_DISPATCH_THRESHOLD_SECONDS sweep ran");
  assert(env.genericSweepBinds?.[0] === 120, `generic sweep still uses the 120s threshold (got ${env.genericSweepBinds?.[0]})`);
  assert(
    env.genericSweepBinds?.[1] === "transient_outage" && env.genericSweepBinds?.[2] === "upstream_dispatch_timeout",
    "generic sweep's exclusion clause is bound to the same marker markDispatchAmbiguous stamps",
  );
}

console.log("\n[pollAllNonTerminal: the ambiguous-dispatch grace-period sweep runs with its own, longer threshold]");
{
  const env = fakeSweepEnv();
  await pollAllNonTerminal(env);
  assert(env.ambiguousSweepBinds !== null, "the ambiguous-dispatch grace-period sweep ran");
  assert(
    env.ambiguousSweepBinds?.[0] === 300,
    `ambiguous sweep's grace period is longer than the generic 120s threshold — one extra */5 cron cycle (got ${env.ambiguousSweepBinds?.[0]})`,
  );
  assert(
    env.ambiguousSweepBinds?.[1] === "transient_outage" && env.ambiguousSweepBinds?.[2] === "upstream_dispatch_timeout",
    "ambiguous sweep targets exactly the marker markDispatchAmbiguous stamps",
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll pipelineDispatchTimeout assertions passed.");
