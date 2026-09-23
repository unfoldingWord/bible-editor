import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";

// Issue #885: nothing recorded how long a request took, so none of the
// other #884 perf-audit fixes could be measured before/after. Pulled out of
// index.ts (which re-exports ExportWorkflow, dragging in a real
// cloudflare:workers import) so this middleware stays testable against a
// plain Hono app under plain node — see requestTiming.test.mjs.
//
// WS upgrades are skipped: a 101 response has no meaningful duration, and
// mutating headers on it would fight the DO's own handshake response.
// routePath(c, -1) reads the eventual handler's registered pattern (e.g.
// "/api/rows/:kind/:id") rather than the raw URL, so logs group by endpoint
// and no ids leak into them — matchedRoutes() is resolved for the whole
// chain up front, so this is safe to read before calling next().
export function requestTiming(log: (line: string) => void = console.log): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      await next();
      return;
    }
    const pattern = routePath(c, -1) || c.req.path;
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    c.res.headers.set("Server-Timing", `total;dur=${ms}`);
    log(JSON.stringify({ m: c.req.method, p: pattern, s: c.res.status, ms }));
  };
}
