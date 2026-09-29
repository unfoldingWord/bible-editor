// Structural guard for the edit_log retention sweep against a D1 limit that
// node:sqlite does not share (issue #918).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/editLogSweepD1Limits.test.mjs
//
// Not a test framework; failures exit non-zero.
//
// D1 caps compound-SELECT terms at 5 (SQLITE_LIMIT_COMPOUND_SELECT; measured
// 2026-09-23 on local workerd D1 and remote D1: a 5-term UNION ALL runs, a
// 6-term one fails with "too many terms in compound SELECT"). node:sqlite
// keeps SQLite's default of 500, so editLogSweep.test.mjs happily ran the
// 8-term UNION ALL version of EDIT_LOG_SWEEP_SQL while prod D1 rejected it on
// every hourly tick. CI never runs wrangler, so the only CI-visible check is
// on the SQL text itself: the sweep must contain no compound SELECT at all.

import assert from "node:assert/strict";
import { EDIT_LOG_SWEEP_SQL } from "./editLogSweep.ts";

// Strip `--` comments so prose mentioning UNION can't trip or mask the check.
const code = EDIT_LOG_SWEEP_SQL.replace(/--[^\n]*/g, "");

for (const op of ["UNION", "INTERSECT", "EXCEPT"]) {
  assert.ok(
    !new RegExp(`\\b${op}\\b`, "i").test(code),
    `EDIT_LOG_SWEEP_SQL must not use ${op}: D1 caps compound-SELECT terms at 5 (#918)`,
  );
}

console.log("editLogSweepD1Limits: ok");
