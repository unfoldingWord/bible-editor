// Tests for classifyRowPatchConflict (web/src/sync/rowConflict.ts) — the pure
// decision behind auto-healing spurious row 409s vs prompting on genuine ones.
// Regression coverage for the "TQ conflict on almost every edit, resolves by
// just clicking" report: a version bump from an unrelated concurrent change (or
// our own edit already landing) must NOT surface a conflict prompt, while a real
// same-field conflict still must.

import assert from "node:assert/strict";
import { classifyRowPatchConflict, rowThreadDecision } from "./rowConflict.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

// (a) Idempotent — the server already has exactly what we're setting (our edit
// already landed / an echo). Safe even with no baseline.
check(
  classifyRowPatchConflict(
    { question: "Who is Zechariah?" },
    undefined,
    { version: 3, question: "Who is Zechariah?", response: "A prophet." },
  ) === "auto_heal",
  "idempotent patch (server already has our value) auto-heals without a baseline",
);

// (b) Unrelated field changed — the version advanced because the server's
// RESPONSE changed, but our patch only touches QUESTION and the server's
// question still equals our baseline. Applying our edit clobbers nothing.
check(
  classifyRowPatchConflict(
    { question: "Who was Zechariah?" },
    { question: "Who is Zechariah?" },
    { version: 4, question: "Who is Zechariah?", response: "EDITED ELSEWHERE" },
  ) === "auto_heal",
  "unrelated field changed on server, our field untouched vs baseline -> auto-heal",
);

// Genuine conflict — the server changed the SAME field we're editing, to a
// different value than both our target and our baseline. Must prompt.
check(
  classifyRowPatchConflict(
    { question: "MY VERSION" },
    { question: "original" },
    { version: 4, question: "THEIR VERSION", response: "x" },
  ) === "conflict",
  "server changed the same field to a different value -> conflict",
);

// No baseline + server value differs from ours -> conservative conflict (we
// can't prove the server didn't intentionally set that value).
check(
  classifyRowPatchConflict(
    { question: "MY VERSION" },
    undefined,
    { version: 4, question: "SOMETHING ELSE" },
  ) === "conflict",
  "no baseline and server differs -> conflict (conservative)",
);

// Multi-field: one field is idempotent, the other untouched vs baseline -> heal.
check(
  classifyRowPatchConflict(
    { question: "new Q", response: "same R" },
    { question: "old Q", response: "same R" },
    { version: 5, question: "old Q", response: "same R" },
  ) === "auto_heal",
  "multi-field: idempotent + untouched -> auto-heal",
);

// Multi-field: any single genuinely-conflicting field forces a conflict.
check(
  classifyRowPatchConflict(
    { question: "new Q", response: "new R" },
    { question: "old Q", response: "old R" },
    { version: 5, question: "old Q", response: "THEIR R" },
  ) === "conflict",
  "multi-field: one conflicting field -> conflict",
);

// null (server) vs undefined (our unset optimistic field) are the same absent
// value — occurrence heal / empty column shouldn't read as a conflict.
check(
  classifyRowPatchConflict(
    { occurrence: undefined, question: "q" },
    { occurrence: null, question: "q0" },
    { version: 2, occurrence: null, question: "q0" },
  ) === "auto_heal",
  "null server value equals undefined patch value -> auto-heal",
);

// Both tabs set the SAME new value for the same field — idempotent branch wins
// over the differing baseline; no data is lost, so no prompt.
check(
  classifyRowPatchConflict(
    { question: "agreed value" },
    { question: "old A" },
    { version: 6, question: "agreed value" },
  ) === "auto_heal",
  "both writers converged on the same value -> auto-heal (idempotent)",
);

// Missing / non-object server row (409 body carried no `current`) — can't prove
// safety, so leave it to the user.
check(
  classifyRowPatchConflict({ question: "q" }, { question: "q0" }, null) === "conflict",
  "missing server row -> conflict",
);

// occurrence as a real second-occurrence change that the server also moved
// differently is a genuine numeric conflict.
check(
  classifyRowPatchConflict(
    { occurrence: 2 },
    { occurrence: 1 },
    { version: 3, occurrence: 3 },
  ) === "conflict",
  "numeric field changed on both sides to different values -> conflict",
);

// ---- rowThreadDecision (#1213) --------------------------------------------
// After this user's own op on a row lands, the outbox threads the new version
// into queued sibling ops. A sibling pinned to an older server version must not
// be re-armed past another user's change to one of its fields.

// Issue #1213 example: kept typing pinned at v1 (question "orig"); another user
// changes question at v2; this user's reorder lands at v3; then the offline
// Save drains. Threading must refuse, and the Save's 409 must prompt.
{
  const save = { patch: { question: "mine" }, baseline: { question: "orig" } };
  const reorder = { patch: { sort_order: 5 } };
  const afterReorder = { version: 3, question: "THEIRS", sort_order: 5 };
  check(
    rowThreadDecision(save.patch, save.baseline, reorder.patch, afterReorder) === "refuse_thread",
    "#1213: pinned Save is not threaded past another user's change to its field",
  );
  // Not threaded -> dispatches with If-Match 1 -> 409 with current v3.
  check(
    classifyRowPatchConflict(save.patch, save.baseline, afterReorder) === "conflict",
    "#1213: the un-threaded Save's 409 classifies as conflict (prompt), not auto-heal",
  );
}

// Own-op chaining: two saves of the same field, the second typed on top of the
// first (baseline = first save's value). Must still thread.
check(
  rowThreadDecision(
    { question: "AB" },
    { question: "A" },
    { question: "A" },
    { version: 2, question: "A" },
  ) === "thread",
  "own chained save (baseline = landed value) threads",
);

// Own chain whose second save's baseline was captured before the first landed
// locally: the server value is exactly what our own landed op wrote.
check(
  rowThreadDecision(
    { question: "AB" },
    { question: "orig" },
    { question: "A" },
    { version: 2, question: "A" },
  ) === "thread",
  "own chained save whose baseline predates the first save still threads",
);

// Sibling edits a different field than the landed op; server untouched there.
check(
  rowThreadDecision(
    { response: "R2" },
    { response: "R1" },
    { question: "Q2" },
    { version: 2, question: "Q2", response: "R1" },
  ) === "thread",
  "sibling on an untouched field threads",
);

// Pre-baseline ops keep the old behaviour (thread).
check(
  rowThreadDecision({ question: "x" }, undefined, { sort_order: 1 }, { version: 2, question: "y" }) ===
    "thread",
  "op without a baseline keeps threading (old behaviour)",
);

console.log(`\nrowConflict.test.mjs: ${passed} checks passed`);
