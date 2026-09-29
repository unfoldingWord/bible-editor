// Tests for wsOpen.ts — the pure open-handling behind wsClient.ts. Run from web/:
//   node --experimental-strip-types --no-warnings src/sync/wsOpen.test.mjs
//
// WHAT FAILED BEFORE. wsClient.ts's open handler computed `isReconnect =
// everOpened` and invoked the reconciliation callback (`onReconnect`) only
// when it was true; useChapterRoom forwarded only that callback and Shell
// refetched only there. So the FIRST open produced no reconciliation signal
// at all, and a verse.bridged / verse.split committed between the mount GET's
// snapshot and the socket's first `open` was lost until a reload (review
// finding on PR #721). The cases marked (regression) below encode the
// property that was missing: a subscriber wired to `onOpen` alone is told
// about the first open, with `reconnect: false`.

import assert from "node:assert/strict";
import { describeOpen, notifyOpen } from "./wsOpen.ts";

// describeOpen: the flag is exactly "had an earlier socket opened".
assert.deepEqual(describeOpen(false), { reconnect: false }, "first open is not a reconnect");
assert.deepEqual(describeOpen(true), { reconnect: true }, "an open after an earlier open is a reconnect");

function recorder() {
  const calls = { open: [], reconnect: 0 };
  return {
    calls,
    handlers: {
      onOpen: (info) => calls.open.push(info),
      onReconnect: () => { calls.reconnect++; },
    },
  };
}

// (regression) First open: onOpen fires, onReconnect does not.
{
  const r = recorder();
  const info = notifyOpen(r.handlers, false);
  assert.deepEqual(info, { reconnect: false });
  assert.deepEqual(r.calls.open, [{ reconnect: false }], "onOpen fires on the FIRST open");
  assert.equal(r.calls.reconnect, 0, "onReconnect does not fire on the first open");
}

// Reconnect: both fire, onOpen carries reconnect: true.
{
  const r = recorder();
  const info = notifyOpen(r.handlers, true);
  assert.deepEqual(info, { reconnect: true });
  assert.deepEqual(r.calls.open, [{ reconnect: true }], "onOpen fires on a reconnect with the flag set");
  assert.equal(r.calls.reconnect, 1, "onReconnect fires exactly once on a reconnect");
}

// (regression) A subscriber that wires ONLY onOpen — the shape useChapterRoom
// now uses — is notified on every open across a socket's lifetime, so the
// merging refetch it issues covers the first-open gap as well as recoveries.
{
  const opens = [];
  const handlers = { onOpen: (info) => opens.push(info.reconnect) };
  let everOpened = false;
  for (let i = 0; i < 3; i++) {
    notifyOpen(handlers, everOpened);
    everOpened = true;
  }
  assert.deepEqual(opens, [false, true, true], "onOpen fires for the first open and each reconnect");
}

// A subscriber that wires only the legacy onReconnect still sees recoveries
// only — unchanged behavior for that consumer.
{
  let n = 0;
  const handlers = { onReconnect: () => { n++; } };
  notifyOpen(handlers, false);
  assert.equal(n, 0, "legacy onReconnect: silent on the first open");
  notifyOpen(handlers, true);
  assert.equal(n, 1, "legacy onReconnect: fires on a reconnect");
}

// No handlers at all must not throw (wsClient callers may omit both).
assert.deepEqual(notifyOpen({}, false), { reconnect: false });
assert.deepEqual(notifyOpen({}, true), { reconnect: true });

// ── The open refetch wired to useChapter's request sequencer (#902) ───────
// Shell wires `onOpen` to a merging refetch. Whichever lands first — the
// mount GET or the socket's first open — the tab must render the mount GET
// without waiting on the socket AND still get a merging GET issued after the
// open. The full ordering matrix lives in hooks/chapterFetchSequencer.test.mjs.
const { createChapterFetchSequencer } = await import("../hooks/chapterFetchSequencer.ts");

function chapterRig() {
  const requests = [];
  const landed = [];
  const seq = createChapterFetchSequencer({
    onStart: () => {},
    onAttempt: () => {},
    onLanded: (payload, merge) => landed.push({ payload, merge }),
    onError: () => {},
  });
  const load = (signal) => new Promise((resolve, reject) => {
    const req = { resolve, aborted: false, startedAfterOpen: false };
    signal.addEventListener("abort", () => { req.aborted = true; reject(new Error("abort")); });
    requests.push(req);
  });
  const handlers = { onOpen: () => { void seq.refetch(load, true); } };
  return { seq, load, requests, landed, handlers };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

// GET #1 lands before the socket opens: rendered at once, merge issued on open.
{
  const c = chapterRig();
  void c.seq.refetch(c.load, false);
  c.requests[0].resolve("get1");
  await flush();
  assert.deepEqual(c.landed, [{ payload: "get1", merge: false }], "first paint does not wait for the socket");
  notifyOpen(c.handlers, false);
  assert.equal(c.requests.length, 2, "the first open issues the merging GET");
  c.requests[1].resolve("get2");
  await flush();
  assert.deepEqual(c.landed.at(-1), { payload: "get2", merge: true });
}

// (regression) The socket opens first, while GET #1 is in flight: GET #1 is
// not aborted, lands, and the merging GET #2 is issued after it (#902).
{
  const c = chapterRig();
  void c.seq.refetch(c.load, false);
  notifyOpen(c.handlers, false);
  assert.equal(c.requests[0].aborted, false, "the first open must not abort the mount GET");
  assert.equal(c.requests.length, 1, "no second GET until the mount GET lands");
  c.requests[0].resolve("get1");
  await flush();
  assert.deepEqual(c.landed, [{ payload: "get1", merge: false }], "GET #1 renders");
  assert.equal(c.requests.length, 2, "the merging GET #2 follows (still after the open)");
  c.requests[1].resolve("get2");
  await flush();
  assert.deepEqual(c.landed.at(-1), { payload: "get2", merge: true }, "GET #2 merges over GET #1");
}

console.log("wsOpen.test.mjs: all assertions passed");
