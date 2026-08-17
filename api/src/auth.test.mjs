// Regression test for issue #492: the documented "Bearer-Authorization is
// still honored as a fallback" claim was false for writes — requireCsrf
// demanded the be_csrf cookie pair unconditionally, so a Bearer-only caller
// (no cookies at all) got 403 csrf_mismatch on every POST/PATCH/DELETE. A
// present-but-expired Access cookie also shadowed a valid Bearer header in
// attachAuth, since it never fell through.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/auth.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors sortOrder.test.mjs.

import { Hono } from "hono";
import { SignJWT } from "jose";
import { attachAuth, requireCsrf, currentUserId } from "./auth.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const SIGNING_SECRET = "test-signing-key-at-least-32-bytes-long";
const key = new TextEncoder().encode(SIGNING_SECRET);
const env = { JWT_SIGNING_KEY: SIGNING_SECRET, JWT_ISSUER: "bible-editor" };

async function mintValidToken(userId = 42) {
  return new SignJWT({ role: "editor" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(env.JWT_ISSUER)
    .setSubject(String(userId))
    .setExpirationTime("1h")
    .sign(key);
}

async function mintExpiredToken(userId = 42) {
  return new SignJWT({ role: "editor" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(env.JWT_ISSUER)
    .setSubject(String(userId))
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(key);
}

function buildApp() {
  const app = new Hono();
  app.use("*", attachAuth);
  app.post("/write", requireCsrf, (c) => c.json({ ok: true, userId: currentUserId(c) }));
  return app;
}

async function run() {
  // ─── Bearer-only caller can write with no CSRF cookies at all ───────────
  {
    console.log("\n[requireCsrf] Bearer-authenticated write, no cookies");
    const token = await mintValidToken(7);
    const res = await buildApp().request("/write", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }, env);
    assert(res.status === 200, `Bearer caller with no CSRF cookie is not blocked (got ${res.status})`);
    const body = await res.json();
    assert(body.userId === 7, "userId from the Bearer token is attached to the request");
  }

  // ─── Cookie session still requires the double-submit CSRF pair ──────────
  {
    console.log("\n[requireCsrf] cookie-authenticated write still enforces CSRF");
    const token = await mintValidToken(8);
    const res = await buildApp().request("/write", {
      method: "POST",
      headers: { cookie: `be_access=${token}` },
    }, env);
    assert(res.status === 403, `cookie caller without X-CSRF-Token is still blocked (got ${res.status})`);
  }

  // ─── Cookie session with a matching CSRF pair still works ───────────────
  {
    console.log("\n[requireCsrf] cookie-authenticated write with matching CSRF pair");
    const token = await mintValidToken(9);
    const res = await buildApp().request("/write", {
      method: "POST",
      headers: {
        cookie: `be_access=${token}; be_csrf=abc123`,
        "x-csrf-token": "abc123",
      },
    }, env);
    assert(res.status === 200, `matching CSRF pair still passes (got ${res.status})`);
  }

  // ─── Expired Access cookie falls through to a valid Bearer header ───────
  {
    console.log("\n[attachAuth] expired cookie falls through to a valid Bearer header");
    const expiredCookie = await mintExpiredToken(10);
    const validBearer = await mintValidToken(11);
    const res = await buildApp().request("/write", {
      method: "POST",
      headers: {
        cookie: `be_access=${expiredCookie}`,
        authorization: `Bearer ${validBearer}`,
      },
    }, env);
    assert(res.status === 200, `expired cookie no longer shadows a valid Bearer header (got ${res.status})`);
    const body = await res.json();
    assert(body.userId === 11, "the Bearer token's userId wins once the cookie is rejected");
  }

  console.log(failed === 0 ? "\nAll auth.test.mjs checks passed." : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
