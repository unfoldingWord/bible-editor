// Unit tests for rowHistoryBoundary.ts — the pure history-boundary filter
// that keeps a reissued tombstone's reclaim (issue #427 option 1) from
// leaking the dead row's history into the unrelated row now occupying its
// slot. Run from api/:
//   node --experimental-strip-types --no-warnings src/rowHistoryBoundary.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { boundHistoryToLastCreate } from "./rowHistoryBoundary.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const e = (version, action) => ({ version, action });

// No entries at all → unchanged (empty).
assert(boundHistoryToLastCreate([]).length === 0, "empty input stays empty");

// The overwhelmingly common shape: a real create at v1, no reclaim ever
// happened. Bounding must be a complete no-op.
{
  const entries = [e(1, "create"), e(2, "update"), e(3, "delete")];
  const bounded = boundHistoryToLastCreate(entries);
  assert(bounded.length === 3, "normal row (create at v1): nothing dropped");
  assert(bounded === entries || JSON.stringify(bounded) === JSON.stringify(entries), "normal row: same entries, in order");
}

// No create logged at all (legacy pre-migration row, or a row whose create
// predates edit_log auditing) → unchanged, matches pre-fix behavior exactly
// (the caller synthesizes a v1 "imported" entry in this case).
{
  const entries = [e(2, "update"), e(3, "update")];
  const bounded = boundHistoryToLastCreate(entries);
  assert(bounded.length === 2, "no create entry at all: nothing dropped");
}

// The reclaim shape this fix exists for: a tombstoned row's OLD history
// (imported/update/delete at v1-v3) followed by a reclaim 'create' at v4 and
// further edits after it. Everything before v4 must be dropped.
{
  const entries = [
    e(1, "create"), // old row's own original create
    e(2, "update"), // old row edited
    e(3, "delete"), // old row deleted (tombstoned)
    e(4, "create"), // reclaim: master's unrelated new row moves into the slot
    e(5, "update"), // new row edited after reclaim
  ];
  const bounded = boundHistoryToLastCreate(entries);
  assert(bounded.length === 2, "reclaimed row: only entries from the reclaim create onward survive");
  assert(bounded[0].version === 4 && bounded[0].action === "create", "reclaimed row: first surviving entry is the reclaim create");
  assert(bounded[1].version === 5, "reclaimed row: entries after the reclaim create are kept");
  assert(!bounded.some((x) => x.version < 4), "reclaimed row: no pre-reclaim (dead-row) entries leak through");
}

// A row reclaimed TWICE (tombstoned again after the first reclaim, then
// reissued again) — only the LATEST create's boundary should apply, not the
// first one.
{
  const entries = [e(1, "create"), e(2, "delete"), e(3, "create"), e(4, "delete"), e(7, "create"), e(8, "update")];
  const bounded = boundHistoryToLastCreate(entries);
  assert(bounded.length === 2, "twice-reclaimed row: bounds to the LAST create, not the first");
  assert(bounded[0].version === 7, "twice-reclaimed row: boundary is the highest-version create");
}
