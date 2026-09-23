// Issue #885: GET /api/* should carry a Server-Timing header and log one
// JSON line per request, so the other #884 perf-audit fixes have something
// to measure before/after. Driven against a bare Hono app (no D1, no
// cloudflare:workers import) since requestTiming.ts has neither.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/requestTiming.test.mjs

import { Hono } from "hono";
import { requestTiming } from "./requestTiming.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}
function ok(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function freshApp(log) {
  const app = new Hono();
  app.use("/api/*", requestTiming(log));
  app.get("/api/rows/:kind/:id", (c) => c.json({ id: c.req.param("id") }));
  // A real WS upgrade never constructs a Response through Hono at all (the
  // handler forwards the raw request to the DO, which produces the 101
  // itself) — the Fetch API's Response constructor rejects a bare 101
  // anyway. This route only needs *some* handler so the skip branch's
  // `next()` has something to resolve.
  app.post("/api/ws/chapter/:book/:chapter", (c) => c.text("upgrade handled"));
  return app;
}

console.log("\n[a normal request gets a Server-Timing header and one log line]");
{
  const lines = [];
  const app = freshApp((line) => lines.push(line));
  const res = await app.request("/api/rows/tn/abc123");
  eq(res.status, 200, "the request still succeeds");
  const timing = res.headers.get("Server-Timing");
  ok(timing != null, "Server-Timing header is set");
  ok(/^total;dur=\d+$/.test(timing ?? ""), `Server-Timing has the expected shape (got ${JSON.stringify(timing)})`);
  eq(lines.length, 1, "exactly one log line is written");
  const parsed = JSON.parse(lines[0]);
  eq(parsed.m, "GET", "logs the method");
  eq(parsed.p, "/api/rows/:kind/:id", "logs the registered route pattern, not the raw URL with the id in it");
  eq(parsed.s, 200, "logs the response status");
  ok(typeof parsed.ms === "number" && parsed.ms >= 0, "logs a non-negative duration");
}

console.log("\n[a websocket upgrade is left alone — no header, no log line]");
{
  const lines = [];
  const app = freshApp((line) => lines.push(line));
  const res = await app.request("/api/ws/chapter/ZEC/1", {
    method: "POST",
    headers: { upgrade: "websocket" },
  });
  eq(res.status, 200, "the handler's own response is untouched");
  eq(res.headers.get("Server-Timing"), null, "no Server-Timing header on a WS upgrade");
  eq(lines.length, 0, "no log line for a WS upgrade");
}

console.log("\n[a 404 under /api/* still gets timed]");
{
  const lines = [];
  const app = freshApp((line) => lines.push(line));
  const res = await app.request("/api/nope");
  eq(res.status, 404, "falls through to Hono's default 404");
  ok(res.headers.get("Server-Timing") != null, "still timed even on a miss");
  eq(lines.length, 1, "still logged even on a miss");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll requestTiming assertions passed.");
