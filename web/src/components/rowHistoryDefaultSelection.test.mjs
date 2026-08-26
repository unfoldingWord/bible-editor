// Regression for issue #623: RowHistoryDialog's default "previous" selection
// must keep historical restores as candidates. The pre-fix filter dropped
// EVERY entry with restored_from_version != null, so restore-then-edit opened
// on a baseline the row never held as its prior content.

import assert from "node:assert/strict";
import { defaultPreviousHistoryVersion } from "./rowHistoryFields.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ok: ${msg}`);
};

const v = (version, restored_from_version = null) => ({
  version,
  restored_from_version,
});

console.log("[restore-then-edit: default must be the restore entry, not the pre-restore baseline]");
{
  // v7 normal → restore v3 as v8 → normal edit as v9.
  // effectiveVersion is 9 (no live marker).
  // Immediately before v9 was v8 (content = v3), not v7.
  const versions = [v(7), v(8, 3), v(9)];
  const selected = defaultPreviousHistoryVersion(versions, 9);
  check(selected === 8, `opens on v8 (got ${selected}) — diff: v8 → v9`);
}

console.log("[restore as last action: still skip the live phantom]");
{
  // v7 normal → restore v3 as v8. effectiveVersion is 3.
  // Opening on v8 shows an empty diff; the useful previous is v7.
  const versions = [v(7), v(8, 3)];
  const selected = defaultPreviousHistoryVersion(versions, 3);
  check(selected === 7, `opens on v7 (got ${selected}), not the live restore v8`);
}

console.log("[no restores: newest non-current entry]");
{
  const versions = [v(1), v(2), v(3)];
  const selected = defaultPreviousHistoryVersion(versions, 3);
  check(selected === 2, `opens on v2 (got ${selected})`);
}

console.log("[older restore still eligible when a later normal edit is current]");
{
  // Two restores in history, then a normal edit: v5 restore, v6 restore, v7 edit.
  const versions = [v(4), v(5, 2), v(6, 4), v(7)];
  const selected = defaultPreviousHistoryVersion(versions, 7);
  check(selected === 6, `opens on v6 (got ${selected}) — the immediately prior restore`);
}

console.log("[stale cached row.version must not re-admit the live restore]");
{
  // PR #632 review F1. Another translator restores v3 on a row this client
  // still has cached at v7; the server writes v8. Before the fanout lands, the
  // client's row.version is 7 while the fetched history already ends at v8.
  // The first fix keyed the exclusion on that cached number, so 8 !== 7 kept
  // the live restore eligible: the dialog opened on it, offered "Switch to v8",
  // and the click PATCHed with a stale If-Match for a 409 over identical
  // content. Reading "live" off the fetched list removes the disagreement.
  const versions = [v(6), v(7), v(8, 3)];
  const selected = defaultPreviousHistoryVersion(versions, 3);
  check(selected === 7, `opens on v7 (got ${selected}), not the live restore v8`);
}

console.log("[degenerate histories]");
{
  check(defaultPreviousHistoryVersion([], 1) === null, "empty history selects nothing rather than throwing");

  // One entry, and it is the live restore: excluding it would leave nothing to
  // show, so the last fallback deliberately hands back that same entry.
  const only = defaultPreviousHistoryVersion([v(2, 1)], 1);
  check(only === 2, `a lone live restore is still offered (got ${only}) rather than an empty dialog`);

  const single = defaultPreviousHistoryVersion([v(1)], 1);
  check(single === 1, `a single-entry history opens on that entry (got ${single}) — "Already current"`);
}

console.log(`\n${passed} assertions passed`);
