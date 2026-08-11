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
//
// SHARPER LIMITATION, worth naming explicitly: the fake D1 never evaluates
// SQL, only matches its TEXT against a regex. A WHERE clause that reads as
// correct English but is semantically wrong under SQLite's three-valued
// NULL logic — exactly the F5 bug, where `NOT (state = 'failed' AND
// error_kind = 'force_stopped')` looks like the right guard but silently
// evaluates to NULL (skip the update) whenever error_kind IS NULL — would
// still pass every "guard text is present" assertion in this file. Those
// assertions prove the guard was not DELETED; they do not prove it is
// correct. The NULL-safety claim itself can only be checked against a real
// SQLite engine (see the `wrangler d1 execute --local` verification run
// alongside this PR), not this stub.

import { forceStopPhrase, forceFailJob, pollPipelineJob, dispatchNext, pollAllNonTerminal } from "./pipelines.ts";
import { IMPORT_CLAIM_STALE_SECONDS } from "./pipelineImportClaim.ts";

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
  usernames = null,
}) {
  const env = {
    BT_API_TOKEN: btApiToken,
    queries: [],
    // Execution-order trace (F6): pushed at RUN time, not prepare time, so it
    // records the actual order side effects happened in, not just the order
    // statements were constructed. withFetch() pushes 'fetch' into this same
    // array when a trace is passed to it, so the CAS UPDATE and the upstream
    // stop call can be ordered against each other.
    order: [],
    lastErrorMessage: undefined,
    DB: {
      prepare(sql) {
        env.queries.push(sql);
        // resolveUsernameFromDb's lookup for the audit trail. Default null so
        // the other cases exercise the "users row missing" fallback.
        //
        // forceFailJob now looks up TWO usernames when actor !== owner (the
        // acting editor, and the job's owner for the audit message) — both
        // hit this same query text, distinguished only by the bound user id.
        // `usernames` (keyed by user id) lets a test answer them differently;
        // `username` remains a flat fallback for single-actor tests that
        // don't care about the distinction.
        if (/SELECT dcs_username FROM users/.test(sql)) {
          return {
            bind: (id) => ({
              first: async () => {
                if (usernames) {
                  const name = usernames[id];
                  return name ? { dcs_username: name } : null;
                }
                return username ? { dcs_username: username } : null;
              },
            }),
          };
        }
        if (/SELECT user_id, state, upstream_job_id, book, start_chapter, end_chapter/.test(sql)) {
          return {
            bind: () => ({ first: async () => row }),
          };
        }
        // The force-fail CAS UPDATE (FIX F6: now runs BEFORE the upstream
        // stop call, with a placeholder error_message). Matched by requiring
        // both `SET state = 'failed'` and `error_kind = 'force_stopped'` in
        // the SET clause, which the later error_message-only UPDATE below
        // does not have.
        if (/SET state = 'failed'[\s\S]*error_kind = 'force_stopped'/.test(sql)) {
          return {
            bind: (...args) => ({
              run: async () => {
                env.lastErrorMessage = args[1];
                env.order.push("cas-update");
                return { meta: { changes: updateChanges } };
              },
            }),
          };
        }
        // The second, small UPDATE (FIX F6) that records the real upstream
        // outcome once it's known. Distinguished from the CAS UPDATE above by
        // NOT setting `state` — only `error_message`.
        if (/UPDATE pipeline_jobs\s*\n\s*SET error_message = \?2\s*\n\s*WHERE job_id = \?1 AND error_kind = 'force_stopped'/.test(sql)) {
          return {
            bind: (...args) => ({
              run: async () => {
                env.lastErrorMessage = args[1];
                env.order.push("final-update");
                return { meta: { changes: 1 } };
              },
            }),
          };
        }
        if (/SELECT state FROM pipeline_jobs WHERE job_id = \?1/.test(sql)) {
          return { bind: () => ({ first: async () => ({ state: rereadState }) }) };
        }
        // Anything else (dispatchNext's locked-books lookup/claim/select/fail
        // queries, the poll path's resume-budget reset, etc.) — inert, but
        // still logged above so callers can assert on *which* queries were
        // prepared. `.all` is exposed at both the top level (dispatchNext's
        // queued-books lookup has no placeholders, so it calls `.all()` with
        // no `.bind()` in between) and after `.bind()` (every other no-op
        // caller).
        return {
          all: async () => ({ results: [] }),
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

// Fake D1 for dispatchNext-focused tests (F2). Separate from fakeEnv above
// because dispatchNext's query shapes (claim → select dispatching row →
// promote-to-running) don't overlap with forceFailJob's.
function fakeDispatchEnv({ promoteChanges = 1, username = "translator" } = {}) {
  const env = {
    BT_API_TOKEN: "tok",
    queries: [],
    DB: {
      prepare(sql) {
        env.queries.push(sql);
        if (/SELECT dcs_username FROM users/.test(sql)) {
          return {
            bind: () => ({ first: async () => (username ? { dcs_username: username } : null) }),
          };
        }
        // dispatchNext's pre-claim lookup of currently-queued books (FIX 1:
        // excludes locked books' jobs from the claim SELECT). No placeholders
        // — dispatchNext calls `.all()` directly, no `.bind()` in between —
        // so `.all` must be exposed at the top level, same shape as the
        // no-bind `.first()` case below. Empty queue is fine for these
        // dispatch tests: none of them exercise book-lock exclusion.
        if (/SELECT DISTINCT book FROM pipeline_jobs WHERE state = 'queued'/.test(sql)) {
          return { all: async () => ({ results: [] }) };
        }
        // dispatchNext's claim UPDATE — always "succeeds" so the function
        // proceeds to the SELECT below.
        if (/SET state = 'dispatching', updated_at = unixepoch\(\)/.test(sql)) {
          return { bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) };
        }
        if (/SELECT job_id, user_id, pipeline_type, book, start_chapter, end_chapter,[\s\S]*session_key, options_json/.test(sql)) {
          // This query has no placeholders — dispatchNext calls `.first()`
          // directly on the prepared statement, with no `.bind()` in between
          // — so `.first` must be exposed at both levels.
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
          return {
            first: async () => dispatchingJob,
            bind: () => ({ first: async () => dispatchingJob }),
          };
        }
        // The promote-to-running UPDATE under test (F2).
        if (/SET state = 'running', upstream_job_id = \?2/.test(sql)) {
          return { bind: () => ({ run: async () => ({ meta: { changes: promoteChanges } }) }) };
        }
        // fail()'s UPDATE and anything else — inert.
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

// Fake D1 for pollPipelineJob's F3 test: the guarded final UPDATE's
// meta.changes gates the follow-up enqueue and dispatchNext calls.
//
// `liveState`, when passed, also answers the mid-poll re-read guard added for
// #398's "force-stop lands while the upstream fetch is in flight" case (the
// `SELECT state, error_kind FROM pipeline_jobs WHERE job_id = ?1` query in
// pollPipelineJob, just above `shouldImport`). Left undefined by default so
// the F3 tests below (which don't care about it) get the harmless `null`
// fallback from the catch-all branch, same as before this param existed.
function fakePollEnv({ pollChanges = 1, username = "translator", liveState } = {}) {
  const env = {
    BT_API_TOKEN: "tok",
    queries: [],
    DB: {
      prepare(sql) {
        env.queries.push(sql);
        if (/SELECT dcs_username FROM users/.test(sql)) {
          return {
            bind: () => ({ first: async () => (username ? { dcs_username: username } : null) }),
          };
        }
        // The mid-poll live-state re-read (#398). Distinguished from the
        // pre-existing forceFailJob re-read query (`SELECT state FROM
        // pipeline_jobs WHERE job_id = ?1`, no `error_kind` column) by
        // requiring both columns in the SELECT list — the two query strings
        // never overlap, so this can't accidentally answer the other query.
        if (/SELECT state, error_kind FROM pipeline_jobs WHERE job_id = \?1/.test(sql)) {
          return { bind: () => ({ first: async () => liveState ?? null }) };
        }
        // The poll's own guarded UPDATE under test (F3's changes-check).
        if (/UPDATE pipeline_jobs SET\s*\n\s*state = \?2,[\s\S]*last_polled_at = unixepoch\(\)/.test(sql)) {
          return { bind: () => ({ run: async () => ({ meta: { changes: pollChanges } }) }) };
        }
        // dispatchNext's pre-claim locked-books lookup (FIX 1) and everything
        // else — inert. This also covers importJobOutput's claim UPDATE (`SET
        // import_claimed_at = unixepoch()... RETURNING import_claimed_at`):
        // its meta.changes comes back 0, so if the guard test below fails to
        // skip the import, importJobOutput reports claimLost rather than
        // throwing — the query still gets recorded in env.queries either
        // way, which is what the guard tests assert on. `.all` is exposed at
        // both the top level (dispatchNext's queued-books lookup has no
        // placeholders, so it calls `.all()` with no `.bind()` in between)
        // and after `.bind()` (every other no-op caller).
        return {
          all: async () => ({ results: [] }),
          bind: () => ({
            run: async () => ({ meta: { changes: 0 } }),
            first: async () => null,
            all: async () => ({ results: [] }),
          }),
        };
      },
      // enqueueFollowUp uses env.DB.batch([...prepared statements]); the SQL
      // text is already captured by prepare() above by the time batch() is
      // called, so a no-op is enough for these assertions.
      batch: async () => [],
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

// `trace`, if passed, gets a 'fetch' entry pushed at the moment fetch is
// actually called — used by the F6 ordering test to prove the upstream stop
// call happens after the CAS UPDATE, not just that both happen somewhere.
async function withFetch(impl, fn, trace) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (trace) trace.push("fetch");
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

// ─── not found ──────────────────────────────────────────────────────────────
{
  console.log("\n[not found]");
  const notFoundEnv = fakeEnv({ row: null });
  const nf = await forceFailJob(notFoundEnv, {
    jobId: "missing",
    userId: 1,
    confirm: "anything",
  });
  assert(nf.kind === "not_found", "missing row -> not_found");
}

// ─── any editor (not just the owner) can force-stop ────────────────────────
// This is the point of the change: a wedged run holds a GLOBAL chapter lock
// and the single bot dispatch slot, so if only the owner could clear it and
// the owner is unreachable (asleep, gone), nobody can unwedge it — exactly
// the NUM 27 incident. The route stays behind requireEditor (authenticated
// editors only), but ownership of the job is no longer checked.
{
  console.log("\n[non-owner editor can force-stop]");
  // job owned by user 1 ("benjamin"); acting user is 99 ("translator99").
  const env = fakeEnv({
    row: { ...baseJob, user_id: 1, upstream_job_id: null },
    usernames: { 1: "benjamin", 99: "translator99" },
  });
  const result = await forceFailJob(env, {
    jobId: "job-3",
    userId: 99,
    confirm: "STOP THE AI FOR NUM 27",
  });
  assert(result.kind === "ok", "non-owner editor's force-stop succeeds");
  assert(
    env.lastErrorMessage ===
      "force-stopped by translator99 (owner: benjamin); upstream stop: not attempted (no upstream_job_id)",
    `audit message names both the acting editor and the owner (got: ${env.lastErrorMessage})`,
  );
}

// ─── the owner force-stopping their own job keeps the plain (no owner-suffix)
// message shape ──────────────────────────────────────────────────────────────
{
  console.log("\n[owner force-stopping their own job]");
  const env = fakeEnv({
    row: { ...baseJob, user_id: 1, upstream_job_id: null },
    username: "benjamin",
  });
  const result = await forceFailJob(env, {
    jobId: "job-3b",
    userId: 1,
    confirm: "STOP THE AI FOR NUM 27",
  });
  assert(result.kind === "ok", "owner's force-stop succeeds");
  assert(
    env.lastErrorMessage ===
      "force-stopped by benjamin; upstream stop: not attempted (no upstream_job_id)",
    `audit message has no owner-suffix when actor is the owner (got: ${env.lastErrorMessage})`,
  );
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

// ─── pollPipelineJob: FIX 1(b) / FIX 5 — a force-stopped job is not clobbered ──
// Drives the real pollPipelineJob() with a job whose upstream still honestly
// reports 'running' (the exact scenario force-fail exists to survive: the
// bot's stop contract doesn't exist yet, so it keeps grinding and reporting
// running for a while after force-fail lands locally).
//
// This only proves the guard TEXT is present in the WHERE clause, not that
// it is semantically correct — the fake D1 never evaluates SQL (see the
// file-header comment). The original guard,
// `NOT (state = 'failed' AND error_kind = 'force_stopped')`, passed this
// exact kind of text-presence check while being wrong under SQLite's NULL
// rules (F5: `NOT (x AND NULL)` is NULL, not TRUE, so the row silently never
// updates when error_kind IS NULL — the common case for an ordinary
// failure). The corrected, NULL-safe form is asserted below; its actual
// behavior against real SQLite is verified separately via
// `wrangler d1 execute --local`, not by this stub.
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
      /AND \(state <> 'failed' OR COALESCE\(error_kind, ''\) <> 'force_stopped'\)/.test(
        pollUpdate ?? "",
      ),
      "its WHERE clause uses the NULL-safe force_stopped exclusion (FIX 1(b) / F5) — text presence only, see comment above",
    );
  },
);

// ─── F2: dispatchNext's promote-to-running UPDATE is guarded on state ──────
// After the upstream POST accepts the job, dispatchNext must only flip the
// row to 'running' if it is STILL 'dispatching'. Without the guard, a
// force-fail landing while that POST is in flight (no timeout on it) would
// get silently resurrected back to 'running' once the POST returns — see the
// comment on the promote UPDATE in dispatchNext.
await withFetch(
  async () => new Response(JSON.stringify({ jobId: "upstream-1" }), { status: 200 }),
  async () => {
    console.log("\n[F2: promote guard — normal dispatch still promotes]");
    const env = fakeDispatchEnv({ promoteChanges: 1 });
    await dispatchNext(env);
    const promoteQuery = env.queries.find((q) =>
      /SET state = 'running', upstream_job_id/.test(q),
    );
    assert(Boolean(promoteQuery), "the promote UPDATE was prepared");
    assert(
      /WHERE job_id = \?1 AND state = 'dispatching'/.test(promoteQuery ?? ""),
      "the promote UPDATE's WHERE clause guards on state = 'dispatching' (F2)",
    );
  },
);

await withFetch(
  async () => new Response(JSON.stringify({ jobId: "upstream-2" }), { status: 200 }),
  async () => {
    console.log("\n[F2: promote guard — claim revoked underneath us (0 rows changed)]");
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      // 0 changed rows simulates a force-fail winning the race and flipping
      // this row out of 'dispatching' before the promote UPDATE runs.
      const env = fakeDispatchEnv({ promoteChanges: 0 });
      await dispatchNext(env); // must not throw, must not retry/overwrite
      assert(
        warnings.some((w) => w.includes("job-dispatch") && w.includes("upstream-2")),
        `logs a warning naming the job and the now-orphaned upstream job id (got: ${JSON.stringify(warnings)})`,
      );
    } finally {
      console.warn = originalWarn;
    }
  },
);

// ─── F3: a concurrent force-stop (0 changes on the poll's guarded UPDATE) ──
// suppresses the follow-up enqueue and dispatchNext, both of which run
// OUTSIDE that UPDATE and previously fired unconditionally. Uses a job with
// follow_up_options set (and follow_up_job_id null) so the follow-up branch
// is actually reachable, and data.state:'done' so both the follow-up gate
// and the dispatchNext gate are exercised by the same run.
//
// NOT covered here (stub limitation, noted honestly rather than faked):
// importJobOutput / broadcastChapter both require plumbing (a real apply
// pass, an env.CHAPTER_ROOM Durable Object stub) this fake D1 doesn't
// provide; this job is built with no_output_yet:0 so that whole branch is
// skipped and appliedChapters stays empty, keeping the broadcast loop a
// no-op regardless of pollWriteLanded. The follow-up-enqueue and
// dispatchNext gates below are the parts of F3 this stub can actually prove.
const followUpPolledJob = {
  job_id: "job-f3",
  upstream_job_id: "stream_f3_upstream",
  user_id: 1,
  pipeline_type: "notes",
  book: "NUM",
  start_chapter: 27,
  end_chapter: 27,
  session_key: "sess-f3",
  follow_up_options: '{"noIntro":true}',
  follow_up_chain: null,
  follow_up_job_id: null,
  no_output_yet: 0,
  error_kind: null,
  updated_at: Math.floor(Date.now() / 1000),
  resume_attempt_count: 0,
  last_resume_at: null,
  resume_accepted_at: null,
  options_json: null,
};

await withFetch(
  async () => new Response(JSON.stringify({ state: "done" }), { status: 200 }),
  async () => {
    console.log("\n[F3: guarded UPDATE lands -> follow-up + dispatchNext fire]");
    const env = fakePollEnv({ pollChanges: 1 });
    const result = await pollPipelineJob(env, followUpPolledJob);
    assert(result.kind === "ok", "poll completes");
    assert(
      env.queries.some((q) => /INSERT INTO pipeline_jobs/.test(q)),
      "the follow-up job was enqueued when the poll write landed",
    );
    assert(
      env.queries.some((q) => /SET state = 'dispatching', updated_at = unixepoch\(\)/.test(q)),
      "dispatchNext's claim query ran when the poll write landed",
    );
  },
);

await withFetch(
  async () => new Response(JSON.stringify({ state: "done" }), { status: 200 }),
  async () => {
    console.log("\n[F3: guarded UPDATE is a no-op (0 changes) -> both are skipped]");
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const env = fakePollEnv({ pollChanges: 0 });
      const result = await pollPipelineJob(env, { ...followUpPolledJob, job_id: "job-f3-race" });
      assert(result.kind === "ok", "poll still completes (no throw)");
      assert(
        !env.queries.some((q) => /INSERT INTO pipeline_jobs/.test(q)),
        "the follow-up job was NOT enqueued when the poll write was a no-op",
      );
      assert(
        !env.queries.some((q) => /SET state = 'dispatching', updated_at = unixepoch\(\)/.test(q)),
        "dispatchNext was NOT called when the poll write was a no-op",
      );
      assert(
        warnings.some((w) => w.includes("job-f3-race")),
        `logs a warning naming the job when skipping (got: ${JSON.stringify(warnings)})`,
      );
    } finally {
      console.warn = originalWarn;
    }
  },
);

// ─── #398 mid-poll re-read: a force-stop landing WHILE the upstream fetch was
// in flight must suppress the import even though `job` (the pre-fetch
// snapshot) still says the run is eligible ────────────────────────────────
// This is distinct from the existing "pollPipelineJob does not clobber a
// force-stopped job" case above, which drives the job's OWN error_kind ==
// 'force_stopped' snapshot through the guarded final UPDATE. This test
// instead exercises the NEW mid-poll re-read: `job.error_kind` is null (a
// perfectly healthy snapshot) and only the live D1 row — read fresh, after
// the upstream fetch resolves — reports the force-stop. Without the guard
// this poll would import upstream output into a chapter the force-stop just
// unlocked.
//
// Proving "the import did not happen": importJobOutput cannot be swapped out
// from this plain-node test (no module-mocking harness here — see the file
// header), so this asserts the OBSERVABLE CONSEQUENCE instead: importJobOutput's
// very first D1 statement is a distinctively-shaped claim UPDATE
// (`SET import_claimed_at = unixepoch() ... RETURNING import_claimed_at`) that
// exists nowhere else in this module. Its absence from env.queries proves
// importJobOutput was never entered. This is as strong a proof as this stub
// can offer; it does not exercise stageJobOutput/applyJobOutput themselves.
const forceStoppedMidPollJob = {
  job_id: "job-midpoll-stop",
  upstream_job_id: "stream_midpoll_upstream",
  user_id: 1,
  pipeline_type: "notes",
  book: "NUM",
  start_chapter: 27,
  end_chapter: 27,
  session_key: "sess-midpoll",
  follow_up_options: null,
  follow_up_chain: null,
  follow_up_job_id: "already-set", // keep this test scoped to the import guard
  no_output_yet: 1, // WOULD normally fire the import below
  error_kind: null, // the pre-fetch snapshot is healthy — only the live re-read says otherwise
  updated_at: Math.floor(Date.now() / 1000),
  resume_attempt_count: 0,
  last_resume_at: null,
  resume_accepted_at: null,
  options_json: null,
};

const doneWithOutput = JSON.stringify({
  state: "done",
  output: [
    {
      type: "tn",
      repo: "en_tn",
      branch: "live-snapshot",
      path: "tn_NUM.tsv",
      rawUrl: "https://example/raw",
      prNumber: 1,
      mergedAt: "2026-08-01T00:00:00Z",
      commitSha: "abc123",
    },
  ],
});

await withFetch(
  async () => new Response(doneWithOutput, { status: 200 }),
  async () => {
    console.log("\n[#398: live-state force-stop mid-poll skips the import]");
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const env = fakePollEnv({
        pollChanges: 1,
        liveState: { state: "failed", error_kind: "force_stopped" },
      });
      const result = await pollPipelineJob(env, forceStoppedMidPollJob);
      assert(result.kind === "ok", "poll completes");
      assert(
        !env.queries.some((q) => /import_claimed_at = unixepoch\(\)/.test(q)),
        "importJobOutput's claim UPDATE was NEVER prepared — the import was skipped",
      );
      assert(
        warnings.some(
          (w) => w.includes("job-midpoll-stop") && w.includes("force-stopped"),
        ),
        `logs a warning naming the job and the reason (got: ${JSON.stringify(warnings)})`,
      );
    } finally {
      console.warn = originalWarn;
    }
  },
);

// ─── #398 companion: the guard must NOT be over-eager — an ordinary live
// state (not force-stopped) still lets the import proceed ──────────────────
// Without this half, a guard that always skips the import (e.g. a stray
// `!forceStopped` that always evaluates false, or `shouldImport` accidentally
// hardcoded to false) would pass the test above too. This is the case that
// actually exercises the "should import" branch.
await withFetch(
  async () => new Response(doneWithOutput, { status: 200 }),
  async () => {
    console.log("\n[#398 companion: live-state running does not block the import]");
    const env = fakePollEnv({
      pollChanges: 1,
      liveState: { state: "running", error_kind: null },
    });
    const result = await pollPipelineJob(env, {
      ...forceStoppedMidPollJob,
      job_id: "job-midpoll-running",
    });
    assert(result.kind === "ok", "poll completes");
    assert(
      env.queries.some((q) => /import_claimed_at = unixepoch\(\)/.test(q)),
      "importJobOutput's claim UPDATE WAS prepared — the import path was taken",
    );
  },
);

// ─── #402/FIX (I.8): pollPipelineJob's `importResult.aborted` branch must NOT
// finalize, broadcast, or dispatch ──────────────────────────────────────────
// When importJobOutput reports aborted:true (the job went terminal mid-apply
// — see FIX B/maybeCheckCancelled's forced pre-delete checkpoint), the
// keep-and-record policy says nothing already applied is undone, but nothing
// past that point may run either: the poll's own guarded state UPDATE, the
// per-chapter broadcastChapter hint, the follow-up chain enqueue, and
// dispatchNext all assume a completed, landed poll. Drives the REAL
// pollPipelineJob -> importJobOutput -> stageJobOutput/applyJobOutput chain
// against a dedicated fake D1 (not the shared fakePollEnv, which has no way
// to make the SAME "SELECT state, error_kind" query answer differently on
// its two call sites — the outer pre-import re-read and the inner forced
// pre-delete checkpoint both need to be reachable and to answer differently).
// The output entry's repo is deliberately unrecognized (classify() ->
// "unknown") so parseOutputEntry never calls fetchText — that would route
// through this SAME mocked fetch and try to parse the upstream JSON body as a
// TSV, which is unrelated to what this test is proving.
const abortedMidApplyOutput = JSON.stringify({
  state: "done",
  output: [{ type: "unknown", repo: "unfoldingWord/en_unrecognized", rawUrl: "https://example/raw" }],
});
await withFetch(
  async () => new Response(abortedMidApplyOutput, { status: 200 }),
  async () => {
    console.log("\n[#402: pollPipelineJob's aborted branch skips finalize/broadcast/dispatch]");
    const queries = [];
    const batchCalls = [];
    const dbState = { claimedAt: 1000 };
    let stateReadCount = 0;

    function dispatch(sql, args) {
      if (/SELECT dcs_username FROM users/.test(sql)) {
        return { changes: 0, rows: [], single: { dcs_username: "translator" } };
      }
      if (/UPDATE pipeline_jobs SET import_claimed_at = unixepoch\(\)/.test(sql) && /IS NULL OR/.test(sql)) {
        return { changes: 1, rows: [{ import_claimed_at: dbState.claimedAt }], single: { import_claimed_at: dbState.claimedAt } };
      }
      if (/UPDATE pipeline_jobs SET import_claimed_at = unixepoch\(\)/.test(sql) && /import_claimed_at\s*=\s*\?2/.test(sql)) {
        const expected = args[1];
        if (dbState.claimedAt !== expected) return { changes: 0, rows: [], single: null };
        dbState.claimedAt += 1;
        return { changes: 1, rows: [{ import_claimed_at: dbState.claimedAt }], single: { import_claimed_at: dbState.claimedAt } };
      }
      if (/SELECT state, error_kind FROM pipeline_jobs WHERE job_id = \?1/.test(sql)) {
        stateReadCount += 1;
        // Call #1 is pollPipelineJob's OWN pre-import mid-poll re-read — must
        // be healthy, or shouldImport would be false and importJobOutput
        // would never even be entered (that's the #398 guard, tested above,
        // not this one). Call #2+ is the forced pre-delete checkpoint INSIDE
        // applyJobOutput — the job has gone terminal by the time it reads.
        return stateReadCount === 1
          ? { changes: 0, rows: [], single: { state: "running", error_kind: null } }
          : { changes: 0, rows: [], single: { state: "failed", error_kind: "force_stopped" } };
      }
      if (/SELECT staged_at FROM pipeline_jobs/.test(sql)) {
        return { changes: 0, rows: [], single: { staged_at: null } }; // fresh stage
      }
      if (/DELETE FROM pending_imports/.test(sql)) {
        return { changes: 0, rows: [], single: null };
      }
      if (/UPDATE pipeline_jobs SET staged_at = unixepoch\(\)/.test(sql)) {
        return { changes: 1, rows: [], single: null };
      }
      if (/SELECT user_id FROM pipeline_jobs/.test(sql)) {
        return { changes: 0, rows: [], single: { user_id: 1 } };
      }
      if (/ORDER BY kind, chapter, verse, id/.test(sql)) {
        return { changes: 0, rows: [], single: null }; // nothing staged (both outputs unrecognized)
      }
      if (/UPDATE pipeline_jobs SET import_aborted_at/.test(sql)) {
        return { changes: 1, rows: [], single: null };
      }
      if (/UPDATE pipeline_jobs SET import_claimed_at = NULL/.test(sql)) {
        return { changes: 1, rows: [], single: null };
      }
      // Anything else (dispatchNext's claim query, the poll's own guarded
      // UPDATE, follow-up enqueue INSERT, etc.) — inert, but its SQL is still
      // recorded in `queries` above by prepare(), which is what the
      // assertions below check for absence.
      return { changes: 0, rows: [], single: null };
    }

    const env = {
      BT_API_TOKEN: "tok",
      queries,
      DB: {
        prepare(sql) {
          queries.push(sql);
          return {
            bind(...args) {
              return {
                sql,
                args,
                async run() {
                  const res = dispatch(sql, args);
                  return { meta: { changes: res.changes }, results: res.rows };
                },
                async first() {
                  return dispatch(sql, args).single;
                },
                async all() {
                  return { results: dispatch(sql, args).rows };
                },
              };
            },
          };
        },
        async batch(stmts) {
          const results = [];
          for (const s of stmts) {
            const res = dispatch(s.sql, s.args);
            results.push({ meta: { changes: res.changes }, results: res.rows });
          }
          batchCalls.push(stmts.map((s) => s.sql));
          return results;
        },
      },
    };

    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    let result;
    try {
      result = await pollPipelineJob(env, {
        ...forceStoppedMidPollJob,
        job_id: "job-aborted-mid-apply",
        follow_up_job_id: null,
        follow_up_options: '{"noIntro":true}',
      });
    } finally {
      console.warn = originalWarn;
    }

    assert(result.kind === "ok", "poll completes without throwing");
    assert(stateReadCount >= 2, `both the outer and inner state reads happened (got ${stateReadCount})`);
    assert(
      batchCalls.some((sqls) => sqls.some((s) => /UPDATE pipeline_jobs SET import_aborted_at/.test(s))),
      "the abort was recorded (import_aborted_at batch UPDATE issued) even though nothing else finalized",
    );
    assert(
      !queries.some((q) => /SET state = \?2,[\s\S]*last_polled_at = unixepoch\(\)/.test(q)),
      "the poll's own guarded state UPDATE was NEVER issued — aborted branch returned before it",
    );
    assert(
      !queries.some((q) => /INSERT INTO pipeline_jobs/.test(q)),
      "the follow-up job was NEVER enqueued",
    );
    assert(
      !queries.some((q) => /SET state = 'dispatching', updated_at = unixepoch\(\)/.test(q)),
      "dispatchNext's claim query was NEVER issued",
    );
    assert(
      warnings.some((w) => w.includes("job-aborted-mid-apply") && w.includes("aborted")),
      `logs a warning naming the job and that the import aborted (got: ${JSON.stringify(warnings)})`,
    );
  },
);

// ─── F6: the CAS UPDATE runs before the upstream stop call, and the final
// error_message UPDATE runs after it ─────────────────────────────────────
// Order matters: the old code called upstream /stop BEFORE the CAS, so a CAS
// that loses the race (0 rows changed) would still have told the bot to
// stop — harmless today only because the bot's /stop endpoint doesn't exist
// yet. Traced via env.order, which is pushed to at RUN time (not prepare
// time), so this proves execution order, not just construction order.
await (async () => {
  console.log("\n[F6: CAS UPDATE executes before the upstream stop fetch]");
  // btApiToken set so the upstream /stop call is actually attempted (it's
  // gated on `owned.upstream_job_id && env.BT_API_TOKEN`) — otherwise no
  // 'fetch' entry would ever land in the trace to order against.
  // dispatchNext's own claim query still no-ops (this fake's default
  // fallback returns 0 changes), so it never issues a fetch of its own to
  // muddy the order.
  const env = fakeEnv({ row: baseJob, btApiToken: "tok" });
  await withFetch(
    async () => new Response("{}", { status: 200 }),
    async () => {
      const result = await forceFailJob(env, {
        jobId: "job-f6",
        userId: 1,
        confirm: "STOP THE AI FOR NUM 27",
      });
      assert(result.kind === "ok", "force-fail still succeeds");
    },
    env.order,
  );
  assert(
    env.order[0] === "cas-update",
    `the CAS UPDATE is the first thing to execute (order: ${env.order.join(",")})`,
  );
  assert(
    env.order.includes("fetch") && env.order.indexOf("fetch") > env.order.indexOf("cas-update"),
    `the upstream stop fetch happens after the CAS UPDATE (order: ${env.order.join(",")})`,
  );
  assert(
    env.order.indexOf("final-update") > env.order.indexOf("fetch"),
    `the final error_message UPDATE happens after the upstream fetch (order: ${env.order.join(",")})`,
  );
})();

// ─── F1: NOT independently testable from this file ─────────────────────────
// F1 (the GET /:jobId short-circuit now including a `current` object with
// errorKind/error/skill/status) lives inline in the Hono route handler in
// api/src/pipelines.ts, not in a standalone exported function the way
// forceFailJob/pollPipelineJob/dispatchNext are. Reaching it needs the real
// route wired up (method/path, requireEditor auth, c.req/c.json) — spinning
// that up is integration-test territory this file deliberately doesn't
// attempt (see the file-header comment). Saying so here rather than faking
// a fetch-shaped stub around a chunk of inline route code that was never
// designed to be called directly.

// ─── FIX 2b (#402): pollAllNonTerminal's backstop sweeps must exclude jobs
// with a LIVE import claim ──────────────────────────────────────────────────
// A live, heartbeating import claim (import_claimed_at fresher than
// IMPORT_CLAIM_STALE_SECONDS) is positive evidence an apply is in flight
// right now. Without excluding those jobs, a DAN-11-scale apply (~12
// minutes) outlives the */5 tick this function runs on and gets auto-failed
// by the very sweeps that exist to catch jobs where NOTHING is happening —
// and per FIX 2a, shouldAbortApply no longer treats that auto-fail as a stop
// signal, but the sweep itself must still not fire against a live apply.
// This test drives the REAL pollAllNonTerminal against a fake D1 that
// records every prepared SQL string and its bound args, generically no-oping
// everything (so the SELECT-jobs / dispatchNext paths that follow the sweeps
// don't need their own fixtures) — the assertions are purely about the three
// sweep UPDATEs' generated SQL and bindings, same pattern as
// pipelineImport.test.mjs's deleteUnkeptTns SQL-text tests.
function fakeSweepEnv() {
  const calls = [];
  const env = {
    BT_API_TOKEN: "tok",
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            calls.push({ sql, args });
            return {
              run: async () => ({ meta: { changes: 0 } }),
              first: async () => null,
              all: async () => ({ results: [] }),
            };
          },
          // A couple of pollAllNonTerminal/dispatchNext queries have no
          // placeholders and call .first()/.all()/.run() directly on the
          // prepared statement without an intervening .bind() — expose all
          // three shapes at the top level too.
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
      },
    },
  };
  return { env, calls };
}

await (async () => {
  console.log("\n[FIX 2b: backstop sweeps exclude jobs with a live import claim]");
  const { env, calls } = fakeSweepEnv();
  await pollAllNonTerminal(env);

  const sweepCalls = calls.filter((c) => /error_kind = 'interrupted'/.test(c.sql));
  assert(
    sweepCalls.length === 3,
    `pollAllNonTerminal issues exactly 3 backstop sweep UPDATEs (got ${sweepCalls.length})`,
  );

  // Sweeps 1 and 2 (48h-no-progress, poll-attempts-exhausted) target
  // state IN ('running', 'paused_for_outage', ...) — a state that CAN hold a
  // live import claim — so both must exclude it. Bind order and arity are
  // checked against the SQL's own placeholders, not just "the value appears
  // somewhere in args" (a swapped bind order would still pass an `includes`
  // check but bind the wrong value to the wrong placeholder).
  const liveClaimSweeps = sweepCalls.filter((c) => /state IN \(/.test(c.sql));
  assert(liveClaimSweeps.length === 2, `exactly 2 sweeps target state IN (...) rows (got ${liveClaimSweeps.length})`);
  for (const c of liveClaimSweeps) {
    const label = c.sql.match(/error_message = '([^']+)'/)?.[1] ?? c.sql.slice(0, 40);
    assert(
      /AND\s*\(\s*import_claimed_at IS NULL OR import_claimed_at < unixepoch\(\)\s*-\s*\?2\s*\)/.test(c.sql),
      `backstop sweep "${label}" excludes jobs with a live import claim, bound to placeholder ?2`,
    );
    assert(
      c.args.length === 2,
      `backstop sweep "${label}" binds exactly 2 args, matching its 2 placeholders (got ${c.args.length})`,
    );
    assert(
      c.args[1] === IMPORT_CLAIM_STALE_SECONDS,
      `backstop sweep "${label}" binds IMPORT_CLAIM_STALE_SECONDS at position 2 (?2), matching the SQL placeholder order`,
    );
  }

  // FIX H: sweep 3 (dispatch did not complete) targets state = 'dispatching',
  // which can NEVER hold an import claim (a row only gets polled to 'done'
  // after leaving 'dispatching') — the exclusion clause is dead weight there
  // and has been removed, along with its bind param.
  const dispatchSweep = sweepCalls.find((c) => /state = 'dispatching'/.test(c.sql));
  assert(dispatchSweep, "one backstop sweep targets state = 'dispatching'");
  assert(
    !/import_claimed_at/.test(dispatchSweep.sql),
    "FIX H: the dispatching-sweep SQL no longer references import_claimed_at at all",
  );
  assert(
    dispatchSweep.args.length === 1,
    `FIX H: the dispatching-sweep binds exactly 1 arg (its own threshold only), not the removed IMPORT_CLAIM_STALE_SECONDS param (got ${dispatchSweep.args.length})`,
  );
  assert(
    !dispatchSweep.args.includes(IMPORT_CLAIM_STALE_SECONDS),
    "FIX H: the dispatching-sweep no longer binds IMPORT_CLAIM_STALE_SECONDS at all",
  );
})();

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll pipelinesForceFail tests passed.");
