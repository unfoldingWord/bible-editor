// Issue #1139: isSelfLockCheckedRoute (bookLockGuard.ts) exempts editors from
// the global book-lock guard by PATH SHAPE alone, because three handlers check
// the lock themselves (issue #905). A future route with the same shape would be
// exempt from the guard AND have no lock check of its own. This test
// enumerates every route registered on the rows and verses routers and fails if
// any route the guard would exempt is not one of those three handlers.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --import ./src/tsResolveHook.mjs src/selfLockCheckedRoutes.test.mjs

import { rows } from "./rows.ts";
import { verses } from "./verses.ts";
import { isSelfLockCheckedRoute } from "./bookLockGuard.ts";

// The only handlers that read book_locks themselves. Add to this list only
// after the new handler checks the lock before any write.
const SELF_CHECKING = new Set([
  "PATCH /api/rows/:kind/:id",
  "POST /api/rows/:kind",
  "PATCH /api/verses/:book/:chapter/:verse/:bibleVersion",
]);

const MOUNTS = [
  ["/api/rows", rows],
  ["/api/verses", verses],
];

let failed = 0;
let checked = 0;
const exempt = [];

for (const [prefix, app] of MOUNTS) {
  for (const r of app.routes) {
    const full = prefix + (r.path === "/" ? "" : r.path);
    // Replace params and wildcards with a concrete segment, as a real request would have.
    const concrete = full.replace(/:[^/]+/g, "x").replace(/\*/g, "x");
    // Hono's ALL (from .use/.all) matches every method; test the ones the guard exempts.
    const methods = r.method === "ALL" ? ["PATCH", "POST"] : [r.method];
    for (const m of methods) {
      checked++;
      if (!isSelfLockCheckedRoute(m, concrete)) continue;
      exempt.push(`${m} ${full}`);
      if (!SELF_CHECKING.has(`${m} ${full}`)) {
        console.error(
          `FAIL: ${m} ${full} is exempt from the global book-lock guard (isSelfLockCheckedRoute) ` +
            `but is not a known self-checking handler. Make its handler check the lock, then add it to SELF_CHECKING, ` +
            `or change its path shape.`,
        );
        failed++;
      }
    }
  }
}

// Guard against the enumeration silently finding nothing, or a known handler vanishing.
if (checked < 10) {
  console.error(`FAIL: only ${checked} routes enumerated; router introspection broke`);
  failed++;
}
for (const k of SELF_CHECKING) {
  if (!exempt.includes(k)) {
    console.error(`FAIL: expected self-checking route "${k}" was not found among exempt routes`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log(`Checked ${checked} routes; exempt: ${exempt.join(", ")}`);
console.log("All self-lock-checked-route assertions passed.");
