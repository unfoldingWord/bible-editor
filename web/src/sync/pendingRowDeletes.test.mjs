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
    { watch: () => () => {} },
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
    { watch: () => () => {} },
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
  const load = wrap(() => new Promise((r) => (resolveGet = r)), async () => ops, { watch: () => () => {} });
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
  const watch = (on) => {
    listeners.add(on.abandoned);
    return () => listeners.delete(on.abandoned);
  };
  let resolveGet;
  const load = wrap(() => new Promise((r) => (resolveGet = r)), async () => ops, { watch });
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
// A controllable run: `step(snapshot)` lets the before-read happen, then the
// test changes `ops` / fires outcomes, then the GET resolves.
function run({ ops: initial, isOwn, track, failBefore = false, failWatch = false }) {
  const state = { ops: initial, on: null };
  let reads = 0;
  let resolveGet;
  const quiet = console.warn;
  const load = wrap(
    () => new Promise((r) => (resolveGet = r)),
    async () => {
      reads++;
      if (failBefore && reads === 1) throw new Error("IndexedDB hiccup");
      return state.ops;
    },
    {
      watch: (on) => {
        if (failWatch) throw new Error("listener registry broken");
        state.on = on;
        return () => (state.on = null);
      },
      ...(isOwn ? { isOwn } : {}),
      ...(track ? { trackOwnDeletes: track } : {}),
    },
  );
  console.warn = () => {};
  const p = load(new AbortController().signal, () => {});
  state.finish = async (snapshot = payload()) => {
    resolveGet(snapshot);
    try {
      return await p;
    } finally {
      console.warn = quiet;
    }
  };
  state.ready = () => new Promise((r) => setTimeout(r, 0));
  return state;
}
{
  // A failing subscription skips the before-set (an abandoned op could not be
  // told apart) but the after-read still hides a draining delete.
  const r = run({ ops: [del("tq", "q1")], failWatch: true });
  await r.ready();
  const out = await r.finish();
  check(ids(out.tq).join() === "q2", "a subscription failure still applies the after-read");
}
{
  // ...and a before-set op gone by the after-read is not hidden then.
  const r = run({ ops: [del("tq", "q1")], failWatch: true });
  await r.ready();
  r.ops = [];
  const out = await r.finish();
  check(ids(out.tq).join() === "q1,q2", "with no subscription a vanished op is not trusted as committed");
}
{
  // Cursor minor: a failed before-read still runs the after-read filter.
  const r = run({ ops: [del("tq", "q1")], failBefore: true });
  await r.ready();
  const out = await r.finish();
  check(ids(out.tq).join() === "q2", "a failed before-read still applies the after-read");
}
// B1: an op draining at the before-read that turns into a conflict or a
// refusal waiting on the user during the GET is judged by its later status:
// the row shows while the sync UI asks the user about it.
for (const status of ["conflict", "failed"]) {
  const r = run({ ops: [del("tq", "q1")] });
  await r.ready();
  r.ops = [{ ...r.ops[0], status }];
  const out = await r.finish();
  check(ids(out.tq).join() === "q1,q2", `a DELETE that became ${status} during the GET shows its row`);
}
// B2: deleted after the before-read and committed before the after-read:
// neither read sees it, its 200 does.
{
  const r = run({ ops: [] });
  await r.ready();
  r.on.committed(del("tq", "q1", "in_flight"));
  const out = await r.finish();
  check(ids(out.tq).join() === "q2", "a DELETE that committed during the GET, unseen by both reads, stays hidden");
}
// B3: only this tab's own deletes are hidden; another tab's refusal would
// never be announced here.
{
  const mine = (t) => t.id === "q1";
  const r = run({ ops: [del("tq", "q1"), del("tq", "q2"), del("twl", "w1")], isOwn: mine });
  await r.ready();
  r.ops = [del("tq", "q1"), del("twl", "w1")]; // the other tab's q2 op left
  const out = await r.finish();
  check(ids(out.tq).join() === "q2" && ids(out.twl).join() === "w1,w2", "another tab's DELETE (draining or gone) hides nothing here");
}
{
  // The registry Shell marks: a row is own only after markOwnRowDelete.
  check(mod.isOwnRowDelete?.({ rowKind: "tq", book: "ZEC", id: "zz" }) === false, "an unmarked delete is not own");
  mod.markOwnRowDelete?.("tq", "ZEC", "zz");
  check(mod.isOwnRowDelete?.({ rowKind: "tq", book: "ZEC", id: "zz" }) === true, "markOwnRowDelete makes it own");
  check(mod.isOwnRowDelete?.({ rowKind: "twl", book: "ZEC", id: "zz" }) === false, "own is per row kind");
}

// ---------- #1119 ----------

// 5. Without `watch` nothing tells a committed op from a refused one, so a
// vanished op must not be trusted as committed.
{
  let ops = [del("tq", "q1")];
  let resolveGet;
  const load = wrap(() => new Promise((r) => (resolveGet = r)), async () => ops);
  const p = load(new AbortController().signal, () => {});
  await new Promise((r) => setTimeout(r, 0));
  ops = [];
  resolveGet(payload());
  check(ids((await p).tq).join() === "q1,q2", "#1119: with no watch a vanished op is not trusted as committed");
}

// 2. A delete clicked while the after-read is pending: Shell marks the row at
// the click, but the read's transaction started before the op was written.
const mark = (id) => mod.markOwnRowDelete?.("tq", "ZEC", id);
const unmark = (id) => mod.clearOwnRowDelete?.({ rowKind: "tq", book: "ZEC", id });
const tracked = () => ({ isOwn: mod.isOwnRowDelete, track: mod.trackOwnRowDeletes });
{
  const r = run({ ops: [], ...tracked() });
  await r.ready();
  mark("q1"); // the after-read below misses its op
  check(ids((await r.finish()).tq).join() === "q2", "#1119: a row marked deleted during the load, unseen by the after-read, stays hidden");
  unmark("q1");
}
{
  // ...but an op the after-read does see is judged by its status.
  const r = run({ ops: [], ...tracked() });
  await r.ready();
  mark("q1");
  r.ops = [del("tq", "q1", "conflict")];
  check(ids((await r.finish()).tq).join() === "q1,q2", "#1119: a row marked during the load whose DELETE is now a conflict shows");
  unmark("q1");
}
{
  // ...and a mark cleared (refused / discarded) during the load hides nothing.
  const r = run({ ops: [], ...tracked() });
  await r.ready();
  mark("q1");
  unmark("q1");
  check(ids((await r.finish()).tq).join() === "q1,q2", "#1119: a mark cleared during the load hides nothing");
}
{
  // A mark from before the load whose op is in neither read hides nothing.
  mark("q1");
  const r = run({ ops: [], ...tracked() });
  await r.ready();
  check(ids((await r.finish()).tq).join() === "q1,q2", "#1119: a mark from before the load with no op hides nothing");
  unmark("q1");
}

// 1, 3, 4. The cross-tab outcome channel and the adapter useChapter uses.
// A fake BroadcastChannel hub: a message reaches every other tab's channel,
// asynchronously and as a structured clone, never the sender's.
function hub() {
  const chans = new Set();
  const posted = [];
  return {
    posted,
    channel() {
      const ch = {
        listeners: new Set(),
        postMessage(m) {
          posted.push(m);
          const data = structuredClone(m);
          for (const o of chans) if (o !== ch) for (const l of o.listeners) setTimeout(() => l({ data }), 0);
        },
        addEventListener(type, fn) {
          if (type === "message") ch.listeners.add(fn);
        },
        removeEventListener(type, fn) {
          if (type === "message") ch.listeners.delete(fn);
        },
      };
      chans.add(ch);
      return ch;
    },
  };
}
const key = (t) => `${t.rowKind}:${t.book}:${t.id}`;
// One tab: its local outbox announcements, its own marks, its outcome feed.
function tab(h, own = null) {
  const results = new Set();
  const discards = new Set();
  const marks = new Set();
  const outcomes = mod.createRowDeleteOutcomes?.({
    onResult: (fn) => (results.add(fn), () => results.delete(fn)),
    onDiscard: (fn) => (discards.add(fn), () => discards.delete(fn)),
    channel: h ? h.channel() : null,
    isOwn: own?.isOwn ?? ((op) => marks.has(key(op.target))),
    clearOwn: own?.clearOwn ?? ((op) => marks.delete(key(op.target))),
    ...(own?.settleOwn ? { settleOwn: own.settleOwn } : {}),
  }) ?? { on: () => () => {} };
  const seen = [];
  outcomes.on((o) => seen.push(o));
  return {
    outcomes,
    marks,
    seen,
    result: (op, kind) => { for (const l of [...results]) l(op, { kind }); },
    discard: (op) => { for (const l of [...discards]) l(op); },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 5));
const sig = (o) => `${o.kind}:${o.op.target.id}:${o.remote ? "remote" : "local"}:${o.own ? "own" : "other"}`;
{
  // 4. The adapter's mapping in the tab that drained: ok → committed,
  // locked / discard → abandoned, everything else (and non-row-deletes) nothing.
  const a = tab(null);
  a.result(del("tq", "q1", "in_flight"), "ok");
  a.result(del("tq", "q2", "in_flight"), "locked");
  a.discard(del("twl", "w1", "failed"));
  for (const kind of ["conflict", "retry", "fatal"]) a.result(del("twl", "w2", "pending"), kind);
  a.result({ ...del("tq", "q1"), action: "patch" }, "ok");
  a.discard({ ...del("tq", "q1"), action: "patch" });
  a.result({ id: "v", target: { kind: "verse", book: "ZEC", chapter: 1, verse: 1, bibleVersion: "ult" }, action: "patch", status: "in_flight" }, "ok");
  check(
    a.seen.map(sig).join() === "committed:q1:local:other,abandoned:q2:local:other,abandoned:w1:local:other",
    "#1119: row-delete outcomes map ok→committed, locked/discard→abandoned, and ignore the rest",
  );
}
{
  // 1. Tab B drains tab A's delete: A hears it (remote), own by A's mark.
  const h = hub();
  const a = tab(h);
  const b = tab(h);
  a.marks.add("tq:ZEC:q1");
  b.result(del("tq", "q1", "in_flight"), "ok");
  await settle();
  check(a.seen.map(sig).join() === "committed:q1:remote:own", "#1119: a commit drained in another tab reaches this tab, as its own delete");
  check(b.seen.map(sig).join() === "committed:q1:local:other", "the draining tab hears it locally");
  check(h.posted.length === 1, "a remote outcome is not re-broadcast");
  check(a.marks.has("tq:ZEC:q1"), "a committed delete keeps its mark");
}
{
  // 3. A refusal or discard in another tab clears this tab's mark after its
  // listeners saw it as own; a later delete of the row elsewhere is not own.
  const h = hub();
  const a = tab(h);
  const b = tab(h);
  a.marks.add("tq:ZEC:q1");
  a.marks.add("twl:ZEC:w1");
  b.result(del("tq", "q1", "in_flight"), "locked");
  b.discard(del("twl", "w1", "conflict"));
  await settle();
  check(a.seen.map(sig).join() === "abandoned:q1:remote:own,abandoned:w1:remote:own", "#1119: a refusal / discard in another tab reaches this tab as its own abandoned delete");
  check(a.marks.size === 0, "#1119: an abandoned delete clears this tab's own mark");
  a.result(del("tq", "q1", "in_flight"), "locked");
  check(sig(a.seen.at(-1)) === "abandoned:q1:local:other", "a later delete of the row from elsewhere is then not treated as own");
}
{
  const h = hub();
  const a = tab(h);
  const raw = h.channel();
  for (const m of [null, "x", { kind: "committed" }, { kind: "boom", op: del("tq", "q1") }, { kind: "committed", op: { ...del("tq", "q1"), action: "patch" } }]) raw.postMessage(m);
  await settle();
  check(a.seen.length === 0, "#1119: a malformed cross-tab message is ignored");
}
{
  // The hooks useChapter passes (rowDeleteHooks): tab B commits another tab's
  // delete during A's plain refetch. Before #1119 the stale snapshot put the
  // row back until the next reload.
  const h = hub();
  const a = tab(h);
  const b = tab(h);
  let resolveGet;
  const load = wrap(() => new Promise((res) => (resolveGet = res)), async () => [], mod.rowDeleteHooks?.(a.outcomes) ?? {});
  const p = load(new AbortController().signal, () => {});
  await new Promise((res) => setTimeout(res, 0));
  b.result(del("tq", "q2", "in_flight"), "ok");
  await settle();
  resolveGet(payload());
  check(ids((await p).tq).join() === "q1", "#1119: a delete committed in another tab during the plain refetch stays hidden");
}
{
  // ...and this tab's own delete refused in tab B during A's plain refetch
  // shows its row (A's rollback restores it; hiding it here would undo that).
  const h = hub();
  const a = tab(h, { isOwn: mod.isOwnRowDeleteOp, clearOwn: mod.forgetOwnRowDeleteOp });
  const b = tab(h);
  mark("q1");
  mod.recordOwnRowDeleteOp?.(del("tq", "q1"));
  let ops = [del("tq", "q1")];
  let resolveGet;
  const load = wrap(() => new Promise((res) => (resolveGet = res)), async () => ops, mod.rowDeleteHooks?.(a.outcomes) ?? {});
  const p = load(new AbortController().signal, () => {});
  await new Promise((res) => setTimeout(res, 0));
  ops = [];
  b.result({ ...del("tq", "q1"), status: "in_flight" }, "locked");
  await settle();
  resolveGet(payload());
  check(ids((await p).tq).join() === "q1,q2", "#1119: this tab's delete refused in another tab during the plain refetch shows its row");
  check(mod.isOwnRowDelete?.({ rowKind: "tq", book: "ZEC", id: "q1" }) === false, "#1119: and its own mark is cleared");
}

// Review A1: only a DELETE op in the after-read counts as "seen". A queued
// PATCH of the row (edited offline, then deleted while the after-read ran)
// must not make the unseen-mark path skip the row.
{
  const r = run({ ops: [], ...tracked() });
  await r.ready();
  mark("q1");
  r.ops = [{ ...del("tq", "q1"), id: "patch-q1", action: "patch" }]; // the read sees the PATCH, not the new DELETE
  check(ids((await r.finish()).tq).join() === "q2", "#1119 A1: a queued PATCH of the row does not count as its DELETE being seen");
  unmark("q1");
}

// Review A2: own-ness and clearing are per op, not per row.
{
  // (a) Tabs A and C both delete q1. C's DELETE is refused: in A it is not
  // own (A's rollback must not run for it) and A's mark stays while A's own
  // DELETE is pending.
  const h = hub();
  const a = tab(h, { isOwn: mod.isOwnRowDeleteOp, clearOwn: mod.forgetOwnRowDeleteOp });
  const c = tab(h);
  mark("q1");
  mod.recordOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "opA" });
  c.result({ ...del("tq", "q1", "in_flight"), id: "opC" }, "locked");
  await settle();
  check(a.seen.map(sig).join() === "abandoned:q1:remote:other", "#1119 A2: another tab's refused DELETE of a row this tab also deleted is not own");
  check(mod.isOwnRowDelete?.({ rowKind: "tq", book: "ZEC", id: "q1" }) === true, "#1119 A2: and it leaves this tab's mark while its own DELETE is pending");
  // A's own op refused: own, and now the mark goes.
  c.result({ ...del("tq", "q1", "in_flight"), id: "opA" }, "locked");
  await settle();
  check(sig(a.seen.at(-1)) === "abandoned:q1:remote:own", "#1119 A2: this tab's own op refused elsewhere is own");
  check(mod.isOwnRowDelete?.({ rowKind: "tq", book: "ZEC", id: "q1" }) === false, "#1119 A2: and clears the mark");
}
{
  // (b) A delayed refusal of an older DELETE does not clear the mark of the
  // row's newer DELETE (deleted again after it came back).
  const h = hub();
  const a = tab(h, { isOwn: mod.isOwnRowDeleteOp, clearOwn: mod.forgetOwnRowDeleteOp });
  const b = tab(h);
  mark("q1");
  mod.recordOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "old" });
  mark("q1");
  mod.recordOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "new" });
  b.result({ ...del("tq", "q1", "in_flight"), id: "old" }, "locked");
  await settle();
  check(sig(a.seen.at(-1)) === "abandoned:q1:remote:own", "#1119 A2: the older own op's refusal is own");
  check(mod.isOwnRowDelete?.({ rowKind: "tq", book: "ZEC", id: "q1" }) === true, "#1119 A2: but keeps the mark of the newer DELETE");
  unmark("q1");
}

// ---------- #1126 ----------

// Item 1: an abandoned outcome says why (locked or discarded), locally and
// across tabs, so the deleting tab can show the draining tab's toast.
{
  const h = hub();
  const a = tab(h);
  const b = tab(h);
  b.result(del("tq", "q1", "in_flight"), "locked");
  b.discard(del("twl", "w1", "conflict"));
  b.result(del("tq", "q2", "in_flight"), "ok");
  await settle();
  const why = (o) => `${o.kind}:${o.op.target.id}:${o.reason ?? "-"}`;
  check(b.seen.map(why).join() === "abandoned:q1:locked,abandoned:w1:discarded,committed:q2:-", "#1126 item 1: an abandoned outcome carries its reason in the draining tab");
  check(a.seen.map(why).join() === "abandoned:q1:locked,abandoned:w1:discarded,committed:q2:-", "#1126 item 1: and the reason crosses to the other tabs");
}

// Item 4: close() (a dev hot reload's dispose) stops relaying and hearing.
{
  const h = hub();
  const a = tab(h);
  const b = tab(h);
  b.outcomes.close?.();
  b.result(del("tq", "q1", "in_flight"), "ok");
  b.discard(del("tq", "q2", "conflict"));
  a.result(del("twl", "w1", "in_flight"), "ok");
  await settle();
  check(b.seen.length === 0 && a.seen.length === 1 && h.posted.length === 1, "#1126 item 4: a closed outcome feed neither relays nor hears");
}

// Item 9: the DELETE's enqueue failed, so no op will ever settle the click's
// mark. Dropping the click must stop a load spanning it from hiding the row.
{
  const r = run({ ops: [], ...tracked() });
  await r.ready();
  const click = mod.markOwnRowDelete?.("tq", "ZEC", "q1");
  mod.dropOwnRowDeleteClick?.({ rowKind: "tq", book: "ZEC", id: "q1" }, click);
  check(ids((await r.finish()).tq).join() === "q1,q2", "#1126 item 9: a click whose enqueue failed hides nothing in a load spanning it");
  check(mod.isOwnRowDelete?.({ rowKind: "tq", book: "ZEC", id: "q1" }) === false, "#1126 item 9: and its mark is gone");
  unmark("q1");
}
{
  // ...and with an older own DELETE of the row still queued, the mark stays
  // for that op but the failed click is not a click.
  mark("q1");
  mod.recordOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "older9" });
  const r = run({ ops: [], ...tracked() });
  await r.ready();
  const click = mod.markOwnRowDelete?.("tq", "ZEC", "q1");
  mod.dropOwnRowDeleteClick?.({ rowKind: "tq", book: "ZEC", id: "q1" }, click);
  check(ids((await r.finish()).tq).join() === "q1,q2", "#1126 item 9: a failed re-delete click hides nothing in a load spanning it");
  check(mod.isOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "older9" }) === true, "#1126 item 9: the older own op is still own");
  unmark("q1");
}

// Item 6: the older op is discarded while the re-delete's put is running;
// the mark is gone by the time the new op id is recorded.
{
  mark("q1");
  mod.recordOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "op6a" });
  mark("q1"); // re-delete clicked
  mod.forgetOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "op6a" }); // op6a discarded
  mod.recordOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "op6b" }); // the put resolves
  check(mod.isOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "op6b" }) === true, "#1126 item 6: an op recorded after its mark was emptied is still own");
  unmark("q1");
}

// Item 7: an older own DELETE of the row sitting in conflict must not make
// a newly clicked DELETE count as seen by the after-read.
{
  mark("q1");
  mod.recordOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "op7old" });
  const r = run({ ops: [], ...tracked() });
  await r.ready();
  mark("q1"); // clicked again during the load; its put lands after the read
  r.ops = [{ ...del("tq", "q1", "conflict"), id: "op7old" }];
  const out = await r.finish();
  mod.recordOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "op7new" });
  check(ids(out.tq).join() === "q2", "#1126 item 7: an older conflict DELETE does not make a new click count as seen");
  unmark("q1");
}
{
  // ...while the new op itself, once recorded and seen, is judged by its status.
  mark("q1");
  mod.recordOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "op7b-old" });
  const r = run({ ops: [], ...tracked() });
  await r.ready();
  mark("q1");
  mod.recordOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "op7b-new" });
  r.ops = [{ ...del("tq", "q1", "conflict"), id: "op7b-old" }, { ...del("tq", "q1", "conflict"), id: "op7b-new" }];
  check(ids((await r.finish()).tq).join() === "q1,q2", "#1126 item 7: the recorded new op, seen in conflict, shows its row");
  unmark("q1");
}
{
  // ...and the new op abandoned during the load hides nothing, though an
  // older own op keeps the mark.
  mark("q1");
  mod.recordOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "op7c-old" });
  const r = run({ ops: [], ...tracked() });
  await r.ready();
  mark("q1");
  mod.recordOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "op7c-new" });
  r.on.abandoned({ ...del("tq", "q1", "in_flight"), id: "op7c-new" });
  mod.forgetOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "op7c-new" });
  r.ops = [{ ...del("tq", "q1", "conflict"), id: "op7c-old" }];
  check(ids((await r.finish()).tq).join() === "q1,q2", "#1126 item 7: a new op abandoned during the load hides nothing");
  unmark("q1");
}

// Items 2 / 8: another tab's DELETE left the outbox during the load, and its
// commit message arrives only after the after-read. The load waits briefly
// for that outcome instead of landing the stale row.
{
  const notMine = () => false;
  const r = run({ ops: [del("tq", "q2")], isOwn: notMine });
  await r.ready();
  r.ops = [];
  const out = r.finish();
  setTimeout(() => r.on?.committed(del("tq", "q2", "in_flight")), 20);
  check(ids((await out).tq).join() === "q1", "#1126 item 2: another tab's commit heard just after the after-read still hides its row");
}
{
  // ...and a late refusal of it shows the row.
  const notMine = () => false;
  const r = run({ ops: [del("tq", "q2")], isOwn: notMine });
  await r.ready();
  r.ops = [];
  const out = r.finish();
  setTimeout(() => r.on?.abandoned(del("tq", "q2", "in_flight")), 20);
  check(ids((await out).tq).join() === "q1,q2", "#1126 item 2: another tab's late refusal shows its row");
}

// Review A1: an own DELETE abandoned during the load (its rollback may
// already have restored the row) hides nothing, though the after-read still
// listed it as pending.
{
  const r = run({ ops: [del("tq", "q1")] });
  await r.ready();
  r.on.abandoned({ ...del("tq", "q1"), status: "in_flight" }); // same op id as the after-read's
  check(ids((await r.finish()).tq).join() === "q1,q2", "#1126 A1: an own DELETE abandoned during the load hides nothing, whatever the after-read says");
}

// Review A2: an aborted load does not sit out the grace.
{
  const ctl = new AbortController();
  let ops = [del("tq", "q2")];
  let resolveGet;
  let watched;
  const load = wrap(() => new Promise((res) => (resolveGet = res)), async () => ops, {
    watch: (on) => ((watched = on), () => (watched = null)),
    isOwn: () => false,
  });
  const p = load(ctl.signal, () => {});
  await new Promise((res) => setTimeout(res, 0));
  ops = [];
  resolveGet(payload());
  await new Promise((res) => setTimeout(res, 10));
  const t0 = Date.now();
  ctl.abort();
  await p.catch(() => {});
  check(Date.now() - t0 < 100, "#1126 A2: an abort ends the grace wait at once");
  check(watched === null, "#1126 A2: and the load unsubscribes");
}

// Review A3: a viewer's delete is a read-only no-op, never queued: the click
// is dropped as if the enqueue had failed.
{
  const r = run({ ops: [], ...tracked() });
  await r.ready();
  const click = mod.markOwnRowDelete?.("tq", "ZEC", "q1");
  mod.recordOwnRowDeleteClickOp?.({ ...del("tq", "q1"), id: "readonly-noop" }, click);
  check(ids((await r.finish()).tq).join() === "q1,q2", "#1126 A3: a read-only no-op delete hides nothing in a load spanning it");
  check(mod.isOwnRowDelete?.({ rowKind: "tq", book: "ZEC", id: "q1" }) === false, "#1126 A3: and leaves no mark");
  unmark("q1");
}
{
  // ...while a real op is recorded as before.
  const click = mod.markOwnRowDelete?.("tq", "ZEC", "q1");
  mod.recordOwnRowDeleteClickOp?.({ ...del("tq", "q1"), id: "opA3" }, click);
  check(mod.isOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "opA3" }) === true, "#1126 A3: a queued op is recorded");
  unmark("q1");
}

// Review A5: once the click's op is forgotten (refused / discarded), the
// click is dead even while an older own op keeps the mark.
{
  mark("q1");
  mod.recordOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "opA5-old" });
  const track = mod.trackOwnRowDeletes?.() ?? (() => []);
  mark("q1");
  mod.recordOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "opA5-new" });
  mod.forgetOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "opA5-new" });
  check(track().length === 0, "#1126 A5: a click whose op was forgotten is no longer reported as clicked");
  check(mod.isOwnRowDelete?.({ rowKind: "tq", book: "ZEC", id: "q1" }) === true, "#1126 A5: the older op keeps the mark");
  unmark("q1");
}

// Item 5: a committed own op no longer keeps the mark alive once a later
// DELETE of the (re-created) row is refused.
{
  const h = hub();
  const a = tab(h, { isOwn: mod.isOwnRowDeleteOp, clearOwn: mod.forgetOwnRowDeleteOp, settleOwn: mod.settleOwnRowDeleteOp });
  const b = tab(h);
  mark("q1");
  mod.recordOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "op5a" });
  b.result({ ...del("tq", "q1", "in_flight"), id: "op5a" }, "ok");
  await settle();
  check(sig(a.seen.at(-1)) === "committed:q1:remote:own", "#1126 item 5: the commit is heard as own");
  check(mod.isOwnRowDelete?.({ rowKind: "tq", book: "ZEC", id: "q1" }) === true, "#1126 item 5: a committed delete keeps its mark");
  mark("q1"); // the row came back (reimport) and is deleted again
  mod.recordOwnRowDeleteOp?.({ ...del("tq", "q1"), id: "op5b" });
  b.result({ ...del("tq", "q1", "in_flight"), id: "op5b" }, "locked");
  await settle();
  check(mod.isOwnRowDelete?.({ rowKind: "tq", book: "ZEC", id: "q1" }) === false, "#1126 item 5: the later refusal clears the mark despite the earlier commit");
  unmark("q1");
}

console.log(`pendingRowDeletes: ${passed} passed`);
