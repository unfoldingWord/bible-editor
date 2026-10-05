// Tests for web/src/sync/pendingRowDeletes.ts (#1107): a chapter GET that
// lands while this tab's own tq/twl DELETE is still draining in the outbox
// must not show the deleted row again.

import assert from "node:assert/strict";

// Missing-module fallback so the cases fail on the rows, not on the import,
// against the pre-#1107 code.
const mod = await import("./pendingRowDeletes.ts").catch(() => ({}));
const hide = mod.hidePendingRowDeletes ?? ((payload) => payload);
const wrap = mod.hidingPendingRowDeletes ?? ((load) => load);

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

const row = (id) => ({ id, version: 1, book: "ZEC", chapter: 1, verse: 1, sort_order: 1, updated_at: 100 });
const payload = () => ({
  book: "ZEC",
  chapter: 1,
  verses: {},
  tn: [row("n1")],
  tq: [row("q1"), row("q2")],
  twl: [row("w1"), row("w2")],
  verseStatuses: [],
  verseLaneChecks: [],
});
const del = (rowKind, id, status = "pending", book = "ZEC") => ({
  id: `op-${rowKind}-${id}-${status}`,
  target: { kind: "row", rowKind, id, book },
  action: "delete",
  status,
});
const ids = (rows) => rows.map((r) => r.id);

{
  const out = hide(payload(), [del("tq", "q1")]);
  check(ids(out.tq).join() === "q2", "a pending tq DELETE hides its row from the fetched snapshot");
}
{
  const out = hide(payload(), [del("twl", "w2", "in_flight")]);
  check(ids(out.twl).join() === "w1", "an in-flight twl DELETE hides its row");
}
{
  const p = payload();
  const out = hide(p, [del("tq", "q1", "conflict"), del("tq", "q2", "failed")]);
  check(ids(out.tq).join() === "q1,q2", "a DELETE waiting on the user (conflict / failed) does not hide the row");
}
{
  const p = payload();
  const patch = { ...del("tq", "q1"), action: "patch" };
  check(ids(hide(p, [patch]).tq).join() === "q1,q2", "a pending PATCH hides nothing");
}
{
  const p = payload();
  check(ids(hide(p, [del("tq", "q1", "pending", "HAG")]).tq).join() === "q1,q2", "a DELETE for another book hides nothing");
}
{
  const p = payload();
  const verseOp = { id: "v", target: { kind: "verse", book: "ZEC", chapter: 1, verse: 1, bibleVersion: "ult" }, action: "patch", status: "pending" };
  check(hide(p, [verseOp, del("tq", "gone")]) === p, "nothing to hide returns the payload itself");
}
{
  const out = hide(payload(), [del("tq", "q1"), del("twl", "w1", "in_flight")]);
  check(ids(out.tq).join() === "q2" && ids(out.twl).join() === "w2" && ids(out.tn).join() === "n1", "deletes of several kinds apply at once, other lists untouched");
}

// The loader wrapper useChapter passes to the sequencer.
{
  const load = wrap(async () => payload(), async () => [del("tq", "q2")]);
  const out = await load(new AbortController().signal, () => {});
  check(ids(out.tq).join() === "q1", "the wrapped loader hides the row whose DELETE is draining");
}
{
  const p = payload();
  const load = wrap(async () => p, async () => {
    throw new Error("IndexedDB unavailable");
  });
  check((await load(new AbortController().signal, () => {})) === p, "an outbox read failure lands the snapshot unchanged");
}
{
  // A malformed persisted op (a row DELETE with no rowKind) must not make the
  // chapter GET reject: the snapshot lands unchanged.
  const p = payload();
  const bad = { id: "bad", target: { kind: "row", id: "q1", book: "ZEC" }, action: "delete", status: "pending" };
  const load = wrap(async () => p, async () => [bad]);
  const warn = console.warn;
  console.warn = () => {};
  let out;
  try {
    out = await load(new AbortController().signal, () => {});
  } finally {
    console.warn = warn;
  }
  check(out === p, "a malformed outbox op lands the snapshot unchanged instead of failing the GET");
}
{
  const order = [];
  const load = wrap(
    async () => {
      order.push("get");
      return payload();
    },
    async () => {
      order.push("outbox");
      return [];
    },
  );
  await load(new AbortController().signal, () => {});
  check(order.join() === "outbox,get,outbox", "the outbox is read before the GET starts and again after it resolves");
}
{
  let listed = 0;
  const load = wrap(
    async () => {
      throw new Error("HTTP 500");
    },
    async () => {
      listed++;
      return [];
    },
  );
  await assert.rejects(load(new AbortController().signal, () => {}), /HTTP 500/);
  check(listed === 1, "a failed GET still fails, without the after-read");
}

// The race the after-read alone missed: the DELETE is draining when the GET
// starts, its small 200 lands and removes the op while the chapter body is
// still downloading, and the snapshot predates the commit.
{
  let ops = [del("tq", "q1", "in_flight")];
  let resolveGet;
  const load = wrap(() => new Promise((r) => (resolveGet = r)), async () => ops, () => () => {});
  const p = load(new AbortController().signal, () => {});
  await new Promise((r) => setTimeout(r, 0)); // the before-read has run
  ops = []; // DELETE 200: op removed
  resolveGet(payload()); // snapshot taken before the commit still holds q1
  const out = await p;
  check(ids(out.tq).join() === "q2", "#1107: a DELETE committed while the GET downloads stays hidden (op gone by the after-read)");
}
// The same window, but the DELETE is refused (chapter_locked) or discarded:
// Shell's #1108 rollback restores the row from its own GET, which may land
// first, so the before-set must not hide it.
{
  let ops = [del("tq", "q1")];
  const listeners = new Set();
  const onAbandoned = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  let resolveGet;
  const load = wrap(() => new Promise((r) => (resolveGet = r)), async () => ops, onAbandoned);
  const p = load(new AbortController().signal, () => {});
  await new Promise((r) => setTimeout(r, 0));
  const refused = ops[0];
  ops = [];
  for (const l of listeners) l(refused); // the refusal / discard announcement
  resolveGet(payload());
  const out = await p;
  check(ids(out.tq).join() === "q1,q2", "#1108: a DELETE refused or discarded during the GET is not hidden by the before-read");
  check(listeners.size === 0, "the abandon subscription is released when the load settles");
}
{
  // A failing subscription is fail-safe too.
  const p = payload();
  const warn = console.warn;
  console.warn = () => {};
  let out;
  try {
    const load = wrap(async () => p, async () => [del("tq", "q1")], () => {
      throw new Error("listener registry broken");
    });
    out = await load(new AbortController().signal, () => {});
  } finally {
    console.warn = warn;
  }
  check(out === p, "a subscription failure lands the snapshot unchanged");
}

console.log(`pendingRowDeletes: ${passed} passed`);
