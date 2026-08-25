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
  // effectiveVersion is 9 (no live marker); currentVersion is 9.
  // Immediately before v9 was v8 (content = v3), not v7.
  const versions = [v(7), v(8, 3), v(9)];
  const selected = defaultPreviousHistoryVersion(versions, 9, 9);
  check(selected === 8, `opens on v8 (got ${selected}) — diff: v8 → v9`);
}

console.log("[restore as last action: still skip the live phantom]");
{
  // v7 normal → restore v3 as v8. effectiveVersion is 3; currentVersion is 8.
  // Opening on v8 shows an empty diff; the useful previous is v7.
  const versions = [v(7), v(8, 3)];
  const selected = defaultPreviousHistoryVersion(versions, 8, 3);
  check(selected === 7, `opens on v7 (got ${selected}), not the live restore v8`);
}

console.log("[no restores: newest non-current entry]");
{
  const versions = [v(1), v(2), v(3)];
  const selected = defaultPreviousHistoryVersion(versions, 3, 3);
  check(selected === 2, `opens on v2 (got ${selected})`);
}

console.log("[older restore still eligible when a later normal edit is current]");
{
  // Two restores in history, then a normal edit: v5 restore, v6 restore, v7 edit.
  const versions = [v(4), v(5, 2), v(6, 4), v(7)];
  const selected = defaultPreviousHistoryVersion(versions, 7, 7);
  check(selected === 6, `opens on v6 (got ${selected}) — the immediately prior restore`);
}

console.log(`\n${passed} assertions passed`);
