// Unit tests for adminUserRoutes.ts — the admin-only user_roles CRUD API.
// Mirrors auth.test.mjs's harness: a real Hono app wired the same way the
// real app wires it (attachAuth + requireCsrf ahead of the route), a
// jose-signed JWT cookie to simulate callers of each role, a D1 stub that
// dispatches by substring match on the bound SQL text, and a stubbed
// globalThis.fetch for the DCS existence check (restored in a finally so it
// never leaks between tests).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/adminUsers.test.mjs

import { Hono } from "hono";
import { SignJWT } from "jose";
import { attachAuth, requireCsrf } from "./auth.ts";
import { adminUsers } from "./adminUserRoutes.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const SIGNING = "test-signing-key-that-is-at-least-32-bytes-long";
const KEY = new TextEncoder().encode(SIGNING);
const ISSUER = "bible-editor";

function baseEnv(db, dcsServiceToken) {
  return {
    JWT_SIGNING_KEY: SIGNING,
    JWT_ISSUER: ISSUER,
    DCS_BASE_URL: "https://git.door43.org",
    DCS_SERVICE_TOKEN: dcsServiceToken,
    DB: db,
  };
}

// D1 stub: the test hands in (sql, args, op) → result. run() defaults to
// one-changed, all() to empty, unless the handler says otherwise.
function fakeDb(handler = () => null) {
  const stmt = (sql, args) => ({
    first: async () => handler({ sql, args, op: "first" }),
    run: async () => handler({ sql, args, op: "run" }) ?? { meta: { changes: 1 } },
    all: async () => handler({ sql, args, op: "all" }) ?? { results: [] },
  });
  return {
    prepare(sql) {
      return { bind: (...args) => stmt(sql, args), ...stmt(sql, []) };
    },
  };
}

async function makeToken({ sub = "1", role = "admin", username = "ada" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ username, role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(KEY);
}

function buildApp() {
  const app = new Hono();
  app.use("*", attachAuth);
  app.use("*", requireCsrf);
  app.route("/api/admin/users", adminUsers);
  return app;
}

// Helper to fire requests with the auth + (for writes) CSRF cookies wired.
function req(app, env, method, path, { token, body } = {}) {
  const cookies = [];
  const headers = {};
  if (token) cookies.push(`be_access=${token}`);
  if (method !== "GET") {
    cookies.push("be_csrf=tok123");
    headers["x-csrf-token"] = "tok123";
  }
  if (cookies.length) headers.cookie = cookies.join("; ");
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return app.request(path, init, env);
}

// A DCS fetch stub that succeeds and echoes back the path-param username as
// the canonical login (same casing) unless the test overrides globalThis.fetch.
function stubDcsOk() {
  globalThis.fetch = async (url) => {
    const m = /\/api\/v1\/users\/([^/?]+)/.exec(String(url));
    const login = m ? decodeURIComponent(m[1]) : "unknown";
    return new Response(JSON.stringify({ login }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

// ── Auth gating: 401 no cookie, 403 editor, 200 admin ──────────────────────

console.log("[auth gating] GET/PUT/DELETE all require an authenticated admin");
{
  const realFetch = globalThis.fetch;
  stubDcsOk();
  try {
    const app = buildApp();
    const editorTok = await makeToken({ role: "editor", sub: "2", username: "eddie" });
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });

    const listDb = fakeDb(() => null); // GET / → all() → default {results:[]}
    assert((await req(app, baseEnv(listDb), "GET", "/api/admin/users")).status === 401, "GET no cookie → 401");
    assert(
      (await req(app, baseEnv(listDb), "GET", "/api/admin/users", { token: editorTok })).status === 403,
      "GET editor → 403",
    );
    assert(
      (await req(app, baseEnv(listDb), "GET", "/api/admin/users", { token: adminTok })).status === 200,
      "GET admin → 200",
    );

    // PUT: new editor, no current row, count irrelevant.
    const putDb = () =>
      fakeDb(({ sql }) => {
        if (sql.includes("SELECT role FROM user_roles")) return null; // no current role
        if (sql.includes("COUNT(*)")) return { n: 0 };
        if (sql.includes("FROM user_roles ur")) return { username: "newbie", role: "editor", addedAt: 1, addedBy: null };
        return null;
      });
    assert(
      (await req(app, baseEnv(putDb()), "PUT", "/api/admin/users/newbie", { body: { role: "editor" } })).status === 401,
      "PUT no cookie → 401",
    );
    assert(
      (await req(app, baseEnv(putDb()), "PUT", "/api/admin/users/newbie", { token: editorTok, body: { role: "editor" } }))
        .status === 403,
      "PUT editor → 403",
    );
    assert(
      (await req(app, baseEnv(putDb()), "PUT", "/api/admin/users/newbie", { token: adminTok, body: { role: "editor" } }))
        .status === 200,
      "PUT admin → 200",
    );

    // DELETE: existing editor row, count irrelevant (not admin).
    const delDb = () =>
      fakeDb(({ sql }) => {
        if (sql.includes("SELECT role FROM user_roles")) return { role: "editor" };
        return null;
      });
    assert((await req(app, baseEnv(delDb()), "DELETE", "/api/admin/users/newbie")).status === 401, "DELETE no cookie → 401");
    assert(
      (await req(app, baseEnv(delDb()), "DELETE", "/api/admin/users/newbie", { token: editorTok })).status === 403,
      "DELETE editor → 403",
    );
    assert(
      (await req(app, baseEnv(delDb()), "DELETE", "/api/admin/users/newbie", { token: adminTok })).status === 200,
      "DELETE admin → 200",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── Last-admin guard ────────────────────────────────────────────────────────

console.log("[last-admin guard] refuse to demote/remove the sole remaining admin");
{
  const realFetch = globalThis.fetch;
  stubDcsOk();
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });

    const putDemote = (adminCount) =>
      fakeDb(({ sql }) => {
        if (sql.includes("SELECT role FROM user_roles")) return { role: "admin" }; // target is currently admin
        if (sql.includes("COUNT(*)")) return { n: adminCount };
        if (sql.includes("FROM user_roles ur")) return { username: "target", role: "editor", addedAt: 1, addedBy: null };
        return null;
      });

    const blocked = await req(app, baseEnv(putDemote(1)), "PUT", "/api/admin/users/target", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(blocked.status === 409, "demote sole admin (count=1) → 409");
    assert((await blocked.json()).error === "last_admin", "409 body is last_admin");

    const allowed = await req(app, baseEnv(putDemote(2)), "PUT", "/api/admin/users/target", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(allowed.status === 200, "demote when another admin exists (count=2) → 200");

    const delDemote = (adminCount) =>
      fakeDb(({ sql }) => {
        if (sql.includes("SELECT role FROM user_roles")) return { role: "admin" };
        if (sql.includes("COUNT(*)")) return { n: adminCount };
        return null;
      });
    const delBlocked = await req(app, baseEnv(delDemote(1)), "DELETE", "/api/admin/users/target", { token: adminTok });
    assert(delBlocked.status === 409, "DELETE sole admin (count=1) → 409");
    const delAllowed = await req(app, baseEnv(delDemote(2)), "DELETE", "/api/admin/users/target", { token: adminTok });
    assert(delAllowed.status === 200, "DELETE admin when another admin exists (count=2) → 200");

    // Not a demotion (admin→admin) — guard must not trigger even at count=1.
    const putSameRole = fakeDb(({ sql }) => {
      if (sql.includes("SELECT role FROM user_roles")) return { role: "admin" };
      if (sql.includes("COUNT(*)")) return { n: 1 };
      if (sql.includes("FROM user_roles ur")) return { username: "target", role: "admin", addedAt: 1, addedBy: null };
      return null;
    });
    const sameRole = await req(app, baseEnv(putSameRole), "PUT", "/api/admin/users/target", {
      token: adminTok,
      body: { role: "admin" },
    });
    assert(sameRole.status === 200, "admin→admin at count=1 is not a demotion → 200");

    // Brand-new user (no current row) being added as editor must not trigger
    // the guard even if, hypothetically, admin count were low.
    const putNewUser = fakeDb(({ sql }) => {
      if (sql.includes("SELECT role FROM user_roles")) return null; // no current row
      if (sql.includes("COUNT(*)")) return { n: 1 };
      if (sql.includes("FROM user_roles ur")) return { username: "brandnew", role: "editor", addedAt: 1, addedBy: null };
      return null;
    });
    const newUser = await req(app, baseEnv(putNewUser), "PUT", "/api/admin/users/brandnew", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(newUser.status === 200, "new user added as editor never trips the last-admin guard → 200");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── PUT validation ordering ─────────────────────────────────────────────────

console.log("[PUT validation] body shape → username shape → DCS existence → canonical casing");
{
  const realFetch = globalThis.fetch;
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });

    // Invalid body: must 400 before the username regex or DCS fetch even run.
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("should not be called", { status: 500 });
    };
    const dbNeverTouched = fakeDb(() => {
      throw new Error("DB should not be touched for invalid_body");
    });
    const badBody = await req(app, baseEnv(dbNeverTouched), "PUT", "/api/admin/users/valid-name", {
      token: adminTok,
      body: { role: "viewer" },
    });
    assert(badBody.status === 400, "role:viewer → 400");
    assert((await badBody.json()).error === "invalid_body", "400 body is invalid_body");
    assert(fetchCalled === false, "DCS fetch never called for invalid_body");

    // Invalid username (contains a space) — valid role, so body passes; must
    // 400 before the DCS call.
    fetchCalled = false;
    const badUsername = await req(app, baseEnv(dbNeverTouched), "PUT", "/api/admin/users/bad%20name", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(badUsername.status === 400, "username with space → 400");
    assert((await badUsername.json()).error === "invalid_username", "400 body is invalid_username");
    assert(fetchCalled === false, "DCS fetch never called for invalid_username");

    // Invalid username (contains @).
    const badUsername2 = await req(app, baseEnv(dbNeverTouched), "PUT", "/api/admin/users/bad@name", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(badUsername2.status === 400, "username with @ → 400");
    assert((await badUsername2.json()).error === "invalid_username", "@ username → invalid_username");

    // DCS 404.
    globalThis.fetch = async () => new Response("not found", { status: 404 });
    const notFound = await req(app, baseEnv(dbNeverTouched), "PUT", "/api/admin/users/ghostuser", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(notFound.status === 404, "DCS 404 → 404");
    assert((await notFound.json()).error === "dcs_user_not_found", "404 body is dcs_user_not_found");

    // Happy path: DCS returns a different casing than the URL path; the
    // stored/returned row must use DCS's canonical casing.
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ login: "BCameron93" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const upserts = [];
    const casingDb = fakeDb(({ sql, args, op }) => {
      if (sql.includes("SELECT role FROM user_roles")) return null; // no current row
      if (sql.includes("COUNT(*)")) return { n: 5 };
      if (op === "run" && sql.includes("INSERT INTO user_roles")) upserts.push(args);
      if (sql.includes("FROM user_roles ur")) {
        return { username: "BCameron93", role: "editor", addedAt: 1, addedBy: null };
      }
      return null;
    });
    const casingRes = await req(app, baseEnv(casingDb), "PUT", "/api/admin/users/bcameron93", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(casingRes.status === 200, "happy-path PUT with casing mismatch → 200");
    const casingBody = await casingRes.json();
    assert(casingBody.user.username === "BCameron93", "response uses DCS-canonical casing, not URL casing");
    assert(casingBody.dcsVerified === true, "dcsVerified true when DCS responded 200");
    assert(upserts.length === 1 && upserts[0][0] === "BCameron93", "upsert bound the DCS-canonical login, not the URL param");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── Fail-open on DCS network error ──────────────────────────────────────────

console.log("[PUT DCS fail-open] network error still writes, using the path-param username");
{
  const realFetch = globalThis.fetch;
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    const db = fakeDb(({ sql }) => {
      if (sql.includes("SELECT role FROM user_roles")) return null;
      if (sql.includes("COUNT(*)")) return { n: 5 };
      if (sql.includes("FROM user_roles ur")) return { username: "offlineuser", role: "editor", addedAt: 1, addedBy: null };
      return null;
    });
    const res = await req(app, baseEnv(db), "PUT", "/api/admin/users/offlineuser", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(res.status === 200, "DCS fetch throws → still 200 (fail open)");
    const body = await res.json();
    assert(body.dcsVerified === false, "dcsVerified false when DCS fetch failed");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── DELETE not_found ─────────────────────────────────────────────────────────

console.log("[DELETE] missing row → 404");
{
  const realFetch = globalThis.fetch;
  stubDcsOk();
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    const db = fakeDb(({ sql }) => {
      if (sql.includes("SELECT role FROM user_roles")) return null;
      return null;
    });
    const res = await req(app, baseEnv(db), "DELETE", "/api/admin/users/nobody", { token: adminTok });
    assert(res.status === 404, "DELETE unknown username → 404");
    assert((await res.json()).error === "not_found", "404 body is not_found");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("adminUsers: all assertions passed");
