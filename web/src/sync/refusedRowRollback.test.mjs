// Tests for web/src/sync/refusedRowRollback.ts (#1108): after a tq/twl row
// DELETE is refused (409 chapter_locked) or discarded, how Shell decides to put
// the server's row back into a chapter cache that still hides it.

import assert from "node:assert/strict";
import { planRefusedRowDeleteRollback } from "./refusedRowRollback.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

const q = (id, version = 1) => ({ id, version, book: "ZEC", chapter: 1, verse: 1, sort_order: 1, updated_at: 100 });
const server = [q("A"), q("B"), q("C")];
// The optimistic delete hid B; the server still has it.
const hidden = [q("A"), q("C")];
const plan = (overrides) =>
  planRefusedRowDeleteRollback({
    id: "B",
    serverRows: server,
    cachedRows: hidden,
    stillQueuedForTarget: false,
    ...overrides,
  });

{
  const p = plan({});
  check(p.kind === "restore" && p.row === server[1], "a refused delete restores the server's row");
  check(p.kind === "restore" && p.afterId === "A", "the row goes back after its server-order neighbour");
}
{
  const p = plan({ id: "A", cachedRows: [q("B"), q("C")] });
  check(p.kind === "restore" && p.afterId === undefined, "the first row has no neighbour to follow");
}
{
  // A and B both hidden (two refused deletes): B follows the nearest row the
  // cache still has, not a hidden one.
  const p = plan({ id: "B", cachedRows: [q("C")] });
  check(p.kind === "restore" && p.afterId === undefined, "a hidden neighbour is skipped when picking the anchor");
}
check(plan({ stillQueuedForTarget: true }).kind === "skip", "another DELETE of the row still draining settles it itself");
check(plan({ serverRows: [q("A"), q("C")] }).kind === "skip", "a row the server no longer has stays gone");
check(plan({ cachedRows: server }).kind === "skip", "a row already back in the cache is left alone");
check(plan({ cachedRows: undefined }).kind === "skip", "no chapter cache to restore into");
check(plan({ serverRows: undefined }).kind === "skip", "no server list to restore from");

console.log(`refusedRowRollback: ${passed} passed`);
