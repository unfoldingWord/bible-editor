// Tests for web/src/sync/refusedTnMoves.ts (#1174): a note move PATCH refused
// as chapter_locked in the tab that drained it is relayed to the other tabs,
// and only the tab that queued the move hears it (to run its #1165 rollback).

import assert from "node:assert/strict";

// Missing-module fallback so the cases fail on the outcome, not on the import.
const mod = await import("./refusedTnMoves.ts").catch(() => ({}));

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

// An in-memory BroadcastChannel: delivered to every other channel, never the
// sender's, asynchronously and as a structured clone.
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
// One tab: its local outbox result announcements and the relay's feed.
function tab(h) {
  const results = new Set();
  const relay = mod.createRefusedTnMoveRelay?.({
    onResult: (fn) => (results.add(fn), () => results.delete(fn)),
    channel: h ? h.channel() : null,
  }) ?? { markOwn: () => {}, on: () => () => {}, close: () => {} };
  const heard = [];
  relay.on((op) => heard.push(op));
  return {
    relay,
    heard,
    result: (op, kind) => {
      for (const l of [...results]) l(op, { kind });
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 5));
const move = (id, verse = 12, opId = `op-${id}`) => ({
  id: opId,
  target: { kind: "row", rowKind: "tn", id, book: "ZEC" },
  action: "patch",
  patch: { verse, ref_raw: `1:${verse}`, sort_order: 5 },
  status: "in_flight",
});

{
  // The core case: tab A queued the move, tab B drained it and got the 409.
  // A hears it (with the move's verse and ref so the rollback plan can run);
  // B, which already rolled back through its local listener, does not hear it
  // again; C, which never made the move, does not hear it.
  const h = hub();
  const a = tab(h);
  const b = tab(h);
  const c = tab(h);
  a.relay.markOwn("op-n1");
  b.result(move("n1"), "locked");
  await settle();
  check(a.heard.length === 1, "the tab that queued a refused move hears it when another tab drained it");
  check(
    a.heard[0]?.id === "op-n1" && a.heard[0]?.target?.id === "n1" && a.heard[0]?.patch?.verse === 12 && a.heard[0]?.patch?.ref_raw === "1:12",
    "the relayed op carries its id, target and the move's verse / ref_raw",
  );
  check(b.heard.length === 0, "the draining tab does not hear its own relay (no double rollback)");
  check(c.heard.length === 0, "a tab that did not queue the move does not hear it");
}
{
  // A drains its own refused move: the local listener in Shell handles it, so
  // the relay announces nothing to A, and nobody else rolls back.
  const h = hub();
  const a = tab(h);
  const b = tab(h);
  a.relay.markOwn("op-n1");
  a.result(move("n1"), "locked");
  await settle();
  check(a.heard.length === 0 && b.heard.length === 0, "a move refused in the tab that queued it is not relayed back to anyone");
}
{
  // Only a refused tn MOVE is relayed: a committed move, a conflict, a text
  // PATCH, a tq patch with a verse, and a DELETE are not.
  const h = hub();
  const a = tab(h);
  const b = tab(h);
  for (const id of ["op-n1", "op-n2", "op-n3", "op-q1", "op-d1"]) a.relay.markOwn(id);
  b.result(move("n1"), "ok");
  b.result(move("n1"), "conflict");
  b.result({ ...move("n2", 12, "op-n2"), patch: { note: "text" } }, "locked");
  b.result({ ...move("q1", 12, "op-q1"), target: { kind: "row", rowKind: "tq", id: "q1", book: "ZEC" } }, "locked");
  b.result({ ...move("n3", 12, "op-d1"), action: "delete", patch: {} }, "locked");
  await settle();
  check(a.heard.length === 0, "only a chapter_locked refusal of a tn verse move is relayed");
}
{
  // #1174 review K1: A's own drain gets a non-final result (retry, conflict,
  // fatal) that leaves the op queued; B later drains it and is refused. A
  // must still hear B's relay.
  for (const kind of ["retry", "conflict", "fatal"]) {
    const h = hub();
    const a = tab(h);
    const b = tab(h);
    a.relay.markOwn("op-n1");
    a.result(move("n1"), kind);
    b.result(move("n1"), "locked");
    await settle();
    check(a.heard.length === 1, `a ${kind} in the queuing tab keeps the mark, so a later refusal in another tab is heard`);
  }
}
{
  // A final result in the queuing tab (ok) does clear the mark.
  const h = hub();
  const a = tab(h);
  const b = tab(h);
  a.relay.markOwn("op-n1");
  a.result(move("n1"), "ok");
  b.result(move("n1"), "locked");
  await settle();
  check(a.heard.length === 0, "a committed move's mark is cleared");
}
{
  // An outcome is heard once: a second relay of the same op id is ignored.
  const h = hub();
  const a = tab(h);
  const b = tab(h);
  a.relay.markOwn("op-n1");
  b.result(move("n1"), "locked");
  b.result(move("n1"), "locked");
  await settle();
  check(a.heard.length === 1, "the originating tab rolls back a relayed refusal once");
}
{
  // A malformed message on the channel is ignored rather than thrown.
  const h = hub();
  const a = tab(h);
  const raw = h.channel();
  a.relay.markOwn("op-n1");
  raw.postMessage(null);
  raw.postMessage({ op: { id: "op-n1" } });
  raw.postMessage({ op: { id: "op-n1", target: { kind: "row", rowKind: "tn", id: "n1", book: "ZEC" }, action: "patch", patch: {} } });
  await settle();
  check(a.heard.length === 0, "a malformed relay message is ignored");
}
{
  // close() stops both the outbox listener and the channel.
  const h = hub();
  const a = tab(h);
  const b = tab(h);
  a.relay.markOwn("op-n1");
  a.relay.close();
  b.result(move("n1"), "locked");
  await settle();
  check(a.heard.length === 0, "a closed relay hears nothing");
}

console.log(`refusedTnMoves: ${passed} passed`);
