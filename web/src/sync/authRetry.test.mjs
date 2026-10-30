// Tests for api.ts request()'s refresh-and-retry path (issue #1248). Run from web/:
//   node --experimental-strip-types --no-warnings src/sync/authRetry.test.mjs
//
// WHAT FAILED BEFORE. A 401, or a 403 csrf_mismatch, makes request() refresh
// the session once and retry. When the refresh succeeded but the retry failed
// on auth again, neither branch ran (both are gated on !_retriedAfterRefresh)
// and request() threw a plain ApiError without emitAuthError(). The outbox
// classifies both failures as `retry`, so the save stayed queued with no
// banner at all, and the successful refresh had already cleared any earlier
// "session expired" banner. A translator's EZK 12:3 UST edit sat unsaved that
// way. The (regression) cases below encode the missing signal.

import assert from "node:assert/strict";

// request() reads the be_csrf cookie for the X-CSRF-Token header.
globalThis.document = { cookie: "be_csrf=test-token" };

const { api, ApiError, onAuthError } = await import("./api.ts");

let authErrors = 0;
onAuthError(() => { authErrors++; });

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Every verse PATCH answers with `patchResponse()`; /api/auth/refresh succeeds.
async function run(patchResponse) {
  authErrors = 0;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url) === "/api/auth/refresh") return json(200, { ok: true });
    return patchResponse();
  };
  let thrown = null;
  try {
    await api.patchVerse("ZEC", 1, 1, "ULT", 3, { content: {} });
  } catch (e) {
    thrown = e;
  }
  // refreshAuthOnce() clears its shared promise on a 0ms timer; let it run so
  // the next case gets a fresh refresh call.
  await new Promise((r) => setTimeout(r, 0));
  return { thrown, calls, authErrors };
}

const patchUrl = "/api/verses/ZEC/1/1/ULT";

// (regression) csrf_mismatch, refresh succeeds, retry gets csrf_mismatch again.
{
  const r = await run(() => json(403, { error: "csrf_mismatch" }));
  assert.deepEqual(r.calls, [patchUrl, "/api/auth/refresh", patchUrl], "one refresh, one retry");
  assert.ok(r.thrown instanceof ApiError, "the retry failure still throws ApiError");
  assert.equal(r.thrown.status, 403, "status is kept so the outbox still classifies it as retry");
  assert.deepEqual(r.thrown.body, { error: "csrf_mismatch" });
  assert.equal(r.authErrors, 1, "a retry that still fails csrf raises the session-expired banner");
}

// (regression) 401, refresh succeeds, retry gets 401 again.
{
  const r = await run(() => json(401, { error: "unauthorized" }));
  assert.deepEqual(r.calls, [patchUrl, "/api/auth/refresh", patchUrl], "one refresh, one retry");
  assert.ok(r.thrown instanceof ApiError);
  assert.equal(r.thrown.status, 401);
  assert.equal(r.authErrors, 1, "a retry that still 401s raises the session-expired banner");
}

// csrf_mismatch first, then a 403 for another reason on the retry: not an
// auth failure, so no "session expired" banner.
{
  let n = 0;
  const r = await run(() =>
    n++ === 0 ? json(403, { error: "csrf_mismatch" }) : json(403, { error: "forbidden" }),
  );
  assert.ok(r.thrown instanceof ApiError);
  assert.equal(r.thrown.status, 403);
  assert.deepEqual(r.thrown.body, { error: "forbidden" });
  assert.equal(r.authErrors, 0, "a non-csrf 403 on the retry must not raise session expired");
}

// A plain non-csrf 403 with no retry: unchanged, no refresh, no banner.
{
  const r = await run(() => json(403, { error: "source_text_is_read_only" }));
  assert.deepEqual(r.calls, [patchUrl], "no refresh for a non-csrf 403");
  assert.equal(r.authErrors, 0);
}

// Refresh succeeds and the retry succeeds: no banner (unchanged).
{
  let n = 0;
  const r = await run(() => (n++ === 0 ? json(401, {}) : json(200, { version: 4 })));
  assert.equal(r.thrown, null, "a retry that succeeds resolves");
  assert.equal(r.authErrors, 0);
}

console.log("authRetry.test.mjs: all assertions passed");
