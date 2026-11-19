// Issue #1418: planLockedMirror, the pure plan behind the locked-book mirror.
// The journey (lockedMirrorJourney.test.mjs) drives it end to end; these pin
// the edge cases one by one.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/lockedMirror.test.mjs

import { planLockedMirror, MIRROR_KEPT } from "./lockedMirror.ts";
import { reviewFlagTitle } from "./lint.ts";

let failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL: ${msg}\n    expected ${e}\n    got      ${a}`);
    failed++;
  } else console.log(`  ok: ${msg}`);
}

const m = (id, ref, sig = id) => {
  const [chapter, verse] = ref.split(":").map(Number);
  return { id, chapter, verse, sig };
};
const s = (id, ref, sort, extra = {}) => {
  const [chapter, verse] = ref.split(":").map(Number);
  return { id, chapter, verse, sig: id, sort_order: sort, removed: false, pending: false, review_kind: null, ...extra };
};
const orders = (plan) => Object.fromEntries([...plan.sortOrder].sort());

console.log("\n[equal: nothing to do]");
{
  const p = planLockedMirror([m("a", "1:1"), m("b", "1:1")], [s("a", "1:1", 100), s("b", "1:1", 200)], true);
  eq([p.write, p.insert, p.remove, p.keep, p.clearFlag, orders(p)], [[], [], [], [], [], {}], "an identical file plans nothing");
}

console.log("\n[order only (#1411)]");
{
  const p = planLockedMirror([m("b", "1:1"), m("a", "1:1")], [s("a", "1:1", 100), s("b", "1:1", 200)], true);
  eq(p.write, [], "no content write");
  eq(orders(p), { a: 200, b: 100 }, "the verse is renumbered in master's order");
}

console.log("\n[order: a verse holding a pending row keeps D1's order]");
{
  const p = planLockedMirror(
    [m("b", "1:1"), m("a", "1:1"), m("n", "1:1")],
    [s("a", "1:1", 100), s("b", "1:1", 200, { pending: true })],
    true,
  );
  eq(orders(p), { n: 300 }, "only master's new row is numbered, after the verse's last");
  eq(p.insert, ["n"], "the new row is inserted");
}

console.log("\n[twl: order is not mirrored]");
{
  const p = planLockedMirror([m("b", "1:1"), m("a", "1:1")], [s("a", "1:1", 100), s("b", "1:1", 200)], false);
  eq(orders(p), {}, "twl keeps its numbers");
}

console.log("\n[deletions (#1415)]");
{
  const p = planLockedMirror(
    [m("a", "1:1")],
    [s("a", "1:1", 100), s("gone", "1:1", 200), s("mine", "1:2", 100, { pending: true }), s("dead", "1:3", 100, { removed: true })],
    true,
  );
  eq(p.remove, ["gone"], "a non-pending row master dropped is removed");
  eq(p.keep, [{ id: "mine", reason: "not_on_door43" }], "a pending row master lacks is kept");
}

console.log("\n[tombstones]");
{
  const p = planLockedMirror(
    [m("t1", "1:1"), m("t2", "1:1")],
    [s("t1", "1:1", 100, { removed: true }), s("t2", "1:1", 200, { removed: true, pending: true })],
    true,
  );
  eq(p.write, ["t1"], "a row master still carries and the app did not delete is brought back");
  eq(p.keep, [{ id: "t2", reason: "deleted_in_app" }], "an in-app delete after the push stays deleted");
}

console.log("\n[content]");
{
  const p = planLockedMirror(
    [m("a", "1:1", "new"), m("b", "1:1", "new")],
    [s("a", "1:1", 100), s("b", "1:1", 200, { pending: true })],
    true,
  );
  eq(p.write, ["a"], "a differing non-pending row takes master's content");
  eq(p.keep, [{ id: "b", reason: "edited" }], "a differing pending row is kept");
}

console.log("\n[flags]");
{
  const p = planLockedMirror(
    [m("a", "1:1"), m("b", "1:1")],
    [s("a", "1:1", 100, { review_kind: MIRROR_KEPT }), s("b", "1:1", 200, { review_kind: MIRROR_KEPT, pending: true })],
    true,
  );
  eq(p.clearFlag, ["a", "b"], "a mirror_kept flag on a row that now agrees with master is cleared");
  const q = planLockedMirror([m("a", "1:1")], [s("a", "1:1", 100, { review_kind: "merge_conflict" })], true);
  eq(q.clearFlag, [], "another kind of flag is left alone");
}

console.log("\n[master carries an id twice: the first one wins]");
{
  const p = planLockedMirror([m("a", "1:1"), m("a", "1:2", "other")], [], true);
  eq(p.insert, ["a"], "inserted once");
  eq(orders(p), { a: 100 }, "numbered in its first verse");
}

console.log("\n[master moves a row to another verse]");
{
  const p = planLockedMirror(
    [m("a", "1:2", "moved"), m("b", "1:2")],
    [s("a", "1:1", 100), s("b", "1:2", 100)],
    true,
  );
  eq(p.write, ["a"], "the moved row is written");
  eq(orders(p), { b: 200 }, "its new verse is renumbered in master's order (a keeps 100, already right)");
}

console.log("\n[the cleanup chip says the app's version was kept]");
eq(reviewFlagTitle(MIRROR_KEPT, "Adapted note — verify"), "Kept over Door43 — verify", "mirror_kept titles as kept over Door43");

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall planLockedMirror checks passed");
