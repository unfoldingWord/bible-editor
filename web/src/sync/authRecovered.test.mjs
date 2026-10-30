// Tests for api.ts's "session works again" signal (issue #1251). Run from web/:
//   node --experimental-strip-types --no-warnings src/sync/authRecovered.test.mjs
//
// WHAT FAILED BEFORE. App.tsx cleared the "session expired" banner on every
// successful silent refresh (onAuthRefreshed). Since #1248 a request whose
// retry still fails auth raises the banner, so with every request failing
// auth the banner flipped false/true on each refresh. Every flip to false
// resumed useAlerts, which fetches at once, whose 401 refreshed again: about
// 550 GET /api/alerts/me a minute. A refresh alone is not evidence the session
// works. The banner now clears only on onAuthRecovered, which fires when a
// request succeeds on its retry after a refresh, or when a request that had
// raised the banner later succeeds.

import assert from "node:assert/strict";

// request() reads the be_csrf cookie for the X-CSRF-Token header.
globalThis.document = { cookie: "be_csrf=test-token" };

const { api, fetchAlerts, onAuthError, onAuthRefreshed, onAuthRecovered, refreshAuthOnce } = await import("./api.ts");

let ev;
onAuthError(() => { ev.authError++; });
onAuthRefreshed(() => { ev.refreshed++; });
onAuthRecovered(() => { ev.recovered++; });

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const patchUrl = "/api/verses/ZEC/1/1/ULT";
const alertsUrl = "/api/alerts/me";

// `respond(url, n)` answers every non-refresh request (n = per-URL call count);
// /api/auth/refresh always succeeds. Runs `fn` and returns the event counts.
async function run(respond, fn) {
  ev = { authError: 0, refreshed: 0, recovered: 0 };
  const n = {};
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === "/api/auth/refresh") return json(200, { ok: true });
    n[u] = (n[u] ?? 0) + 1;
    return respond(u, n[u]);
  };
  try {
    await fn();
  } catch {
    /* failures are expected in several cases */
  }
  // refreshAuthOnce() clears its shared promise on a 0ms timer.
  await new Promise((r) => setTimeout(r, 0));
  return { ...ev };
}

const save = () => api.patchVerse("ZEC", 1, 1, "ULT", 3, { content: {} });

// (regression) Every request fails auth even right after a successful refresh.
// The refresh fires (the outbox needs it), but nothing says the session works.
{
  const r = await run(() => json(401, {}), async () => {
    await fetchAlerts();
    await new Promise((r) => setTimeout(r, 0)); // let the shared refresh promise clear
    await save();
  });
  assert.equal(r.refreshed, 2, "each request still refreshes once");
  assert.equal(r.authError, 2, "each failed retry raises session expired");
  assert.equal(r.recovered, 0, "a refresh followed by a failed retry is not a recovery");
}

// (regression) The stuck save is still failing, but other GETs succeed on the
// first try (the #1248 case). Those GETs never went through a refresh and
// never raised the banner, so they must not clear it. Pins the rule against
// "clear on any 2xx".
{
  // A GET that has not failed before (the alerts GET failed in the case above,
  // so its success would rightly count).
  const r = await run((u) => (u === patchUrl ? json(401, {}) : json(200, {})), async () => {
    await save().catch(() => {}); // the stuck save throws; keep going
    await api.getChapter("ZEC", 1);
    await api.getChapter("ZEC", 1);
  });
  assert.equal(r.authError, 1);
  assert.equal(r.recovered, 0, "an unrelated plain 200 does not clear the banner");
}

// The request that raised the banner later succeeds on a plain 200 (the route
// recovered without a refresh): that is the evidence. The previous case left
// the save's key marked as failed.
{
  const r = await run(() => json(200, { version: 4 }), save);
  assert.equal(r.refreshed, 0);
  assert.equal(r.recovered, 1, "the stuck save finally saving clears the banner");
}
// ...once: the key is forgotten after it recovers.
{
  const r = await run(() => json(200, { version: 5 }), save);
  assert.equal(r.recovered, 0, "a later plain 200 on the same request is not a new recovery");
}

// With no banner up, a 401 → refresh → 200 has nothing to clear.
{
  const r = await run((u, i) => (i === 1 ? json(401, {}) : json(200, { alerts: [] })), fetchAlerts);
  assert.equal(r.refreshed, 1);
  assert.equal(r.authError, 0);
  assert.equal(r.recovered, 0, "no banner raised, so no recovery event");
}

// With a banner up, any request that succeeds on its retry after a refresh is
// a recovery: that request needed auth, and the session now serves it.
{
  const r1 = await run(() => json(401, {}), save);
  assert.equal(r1.authError, 1);
  const r2 = await run((u, i) => (i === 1 ? json(401, {}) : json(200, { alerts: [] })), fetchAlerts);
  assert.equal(r2.refreshed, 1);
  assert.equal(r2.recovered, 1, "a retry that succeeds after a refresh is a recovery");
}

// csrf_mismatch on the save, refresh succeeds, retry csrf again → banner; the
// same save then succeeding clears it.
{
  const r1 = await run(() => json(403, { error: "csrf_mismatch" }), save);
  assert.equal(r1.authError, 1);
  assert.equal(r1.recovered, 0);
  const r2 = await run(() => json(200, { version: 6 }), save);
  assert.equal(r2.recovered, 1);
}

// The refresh itself fails: banner raised (unchanged), no recovery. A later
// 401 → refresh OK → retry 200 on any request clears it, which keeps the
// reason App.tsx used to clear on onAuthRefreshed: one transient refresh
// failure must not leave the banner up for good.
{
  ev = { authError: 0, refreshed: 0, recovered: 0 };
  globalThis.fetch = async (url) =>
    String(url) === "/api/auth/refresh" ? json(503, {}) : json(401, {});
  await fetchAlerts();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ev.authError, 1);
  assert.equal(ev.recovered, 0);
  const r = await run((u, i) => (i === 1 ? json(401, {}) : json(200, { version: 7 })), save);
  assert.equal(r.recovered, 1, "the session working again clears the banner");
}

// Review of #1251: a refresh that failed raised the banner, and the session
// then recovers through a refresh outside request() (the WebSocket's reconnect
// refresh). The paused alerts poll never retries, and reads are
// unauthenticated, so their plain 200s prove nothing. The refresh itself must
// clear it.
{
  ev = { authError: 0, refreshed: 0, recovered: 0 };
  globalThis.fetch = async (url) =>
    String(url) === "/api/auth/refresh" ? json(503, {}) : json(401, {});
  await fetchAlerts();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ev.authError, 1);
  // A plain 200 on an unauthenticated read is not evidence.
  const r1 = await run(() => json(200, {}), () => api.getChapter("ZEC", 1));
  assert.equal(r1.recovered, 0, "a plain read 200 does not clear a refresh-failed banner");
  const r2 = await run(() => json(200, {}), () => refreshAuthOnce());
  assert.equal(r2.refreshed, 1);
  assert.equal(r2.recovered, 1, "a later successful refresh clears a refresh-failed banner");
}

// ...but a refresh does not clear a banner raised by a retry that failed after
// a successful refresh (the #1251 rule), even from outside request().
{
  const r1 = await run(() => json(401, {}), save);
  assert.equal(r1.authError, 1);
  const r2 = await run(() => json(200, {}), () => refreshAuthOnce());
  assert.equal(r2.recovered, 0, "a refresh alone does not clear a stuck save's banner");
  const r3 = await run(() => json(200, { version: 8 }), save);
  assert.equal(r3.recovered, 1);
}

// A recovery forgets every recorded failure, so a stale key cannot clear a
// later banner: alerts and the save both fail after refresh, the save
// recovers, then a later save gets stuck again and an alerts 200 must not
// clear that new banner.
{
  await run(() => json(401, {}), async () => {
    await fetchAlerts();
    await new Promise((r) => setTimeout(r, 0));
    await save();
  });
  const r1 = await run(() => json(200, { version: 9 }), save);
  assert.equal(r1.recovered, 1);
  const r2 = await run((u) => (u === patchUrl ? json(401, {}) : json(200, { alerts: [] })), async () => {
    await save().catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    await fetchAlerts();
  });
  assert.equal(r2.authError, 1);
  assert.equal(r2.recovered, 0, "a stale alerts key does not clear the new stuck-save banner");
}

// Re-review of #1251 (Codex): a save is stuck after a refresh, then another
// request's refresh fails, then a refresh succeeds (e.g. the WebSocket's).
// The failed refresh is resolved, but the save is still stuck, so the banner
// stays until the save itself succeeds.
{
  const r1 = await run(() => json(401, {}), save);
  assert.equal(r1.authError, 1);
  ev = { authError: 0, refreshed: 0, recovered: 0 };
  globalThis.fetch = async (url) =>
    String(url) === "/api/auth/refresh" ? json(503, {}) : json(401, {});
  await fetchAlerts();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ev.authError, 1);
  const r2 = await run(() => json(200, {}), () => refreshAuthOnce());
  assert.equal(r2.recovered, 0, "a refresh does not clear the banner while a save is stuck after a refresh");
  const r3 = await run(() => json(200, { version: 10 }), save);
  assert.equal(r3.recovered, 1);
}

console.log("authRecovered.test.mjs: all assertions passed");
