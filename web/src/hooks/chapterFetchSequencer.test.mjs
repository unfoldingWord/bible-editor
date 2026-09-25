// Tests for chapterFetchSequencer.ts — the request ordering behind
// useChapter.refetch. Run from web/:
//   node --experimental-strip-types --no-warnings src/hooks/chapterFetchSequencer.test.mjs
//
// WHAT FAILED BEFORE (#902). Shell's WS `onOpen` fires a merging refetch on
// the FIRST open too (sync/wsOpen.ts). useChapter.refetch aborted any
// in-flight request, so when the socket opened before the mount GET
// returned, the mount GET was thrown away and the loading screen lasted
// socket-open time plus a whole second GET. Cases marked (regression) encode
// the fix: the mount GET is not aborted, it lands and renders, and the
// merging GET is issued right after it.

import assert from "node:assert/strict";
import { createChapterFetchSequencer } from "./chapterFetchSequencer.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

// A fake chapter endpoint: each load() call is one request whose response
// the test resolves or rejects by hand. `snapshot` names the payload so the
// test can see which response was committed.
function harness() {
  const requests = [];
  const events = [];
  const seq = createChapterFetchSequencer({
    onStart: () => events.push("start"),
    onAttempt: (n) => events.push(`attempt:${n}`),
    onLanded: (payload, merge, queued) => events.push({ landed: payload, merge, queued: [...queued] }),
    onError: (e) => events.push({ error: String(e) }),
  });
  // `ignoreAbort`: the request keeps going after abort and can still resolve
  // late — the case the sequencer's stale-response guard exists for (a fetch
  // whose body was already read, or a loader that does not honor the signal).
  function loader(label, { ignoreAbort = false } = {}) {
    return (signal) => {
      const req = { label, signal, aborted: false };
      const p = new Promise((resolve, reject) => {
        req.resolve = resolve;
        req.reject = reject;
        signal.addEventListener("abort", () => {
          req.aborted = true;
          if (!ignoreAbort) reject(new Error("AbortError"));
        });
      });
      requests.push(req);
      return p;
    };
  }
  const landed = () => events.filter((e) => e && e.landed !== undefined);
  return { seq, requests, events, loader, landed };
}

// ── (regression) GET #1 still in flight when the socket opens ─────────────
{
  const h = harness();
  const load = h.loader("ch1");
  const mount = h.seq.refetch(load, false); // mount GET #1
  const open = h.seq.refetch(load, true); // WS first open → merging refetch
  await tick();
  assert.equal(h.requests.length, 1, "the open must not start a second GET while the mount GET is in flight");
  assert.equal(h.requests[0].aborted, false, "(regression) the mount GET must not be aborted by the first open");

  h.seq.record("step-during-get1"); // a WS step arriving before GET #1 lands
  h.requests[0].resolve("snap1");
  await mount;
  await tick();
  assert.deepEqual(h.landed()[0], { landed: "snap1", merge: false, queued: ["step-during-get1"] },
    "GET #1 renders (plain replace) with the queued step replayed over it");
  assert.equal(h.requests.length, 2, "the merging GET #2 is issued after GET #1 lands");
  assert.equal(h.requests[1].aborted, false);

  h.seq.record("step-during-get2");
  h.requests[1].resolve("snap2");
  await open;
  assert.deepEqual(h.landed()[1], { landed: "snap2", merge: true, queued: ["step-during-get1", "step-during-get2"] },
    "GET #2 merges and replays every step recorded since the open");
  assert.equal(h.landed().length, 2);
  h.seq.record("late"); // queue is cleared once the merge lands
  assert.equal(h.events.filter((e) => e.error).length, 0);
}

// ── GET #1 lands before the socket opens ──────────────────────────────────
{
  const h = harness();
  const load = h.loader("ch1");
  const mount = h.seq.refetch(load, false);
  h.requests[0].resolve("snap1");
  await mount;
  const open = h.seq.refetch(load, true);
  assert.equal(h.requests.length, 2, "an open after first paint issues its merging GET immediately");
  h.requests[1].resolve("snap2");
  await open;
  assert.deepEqual(h.landed(), [
    { landed: "snap1", merge: false, queued: [] },
    { landed: "snap2", merge: true, queued: [] },
  ]);
}

// ── Stale ordering: a response that lands after a newer request never commits
{
  const h = harness();
  const load = h.loader("ch1", { ignoreAbort: true });
  const mount = h.seq.refetch(load, false);
  h.requests[0].resolve("snap1");
  await mount;
  // Reconnect merge (GET A), then another reconnect merge (GET B) supersedes it.
  const a = h.seq.refetch(load, true);
  h.seq.record("s1");
  const b = h.seq.refetch(load, true);
  assert.equal(h.requests[1].aborted, true, "the superseded merge is aborted");
  h.requests[2].resolve("snapB");
  await b;
  assert.deepEqual(h.landed().at(-1), { landed: "snapB", merge: true, queued: ["s1"] },
    "the latest merge inherits the superseded one's queue");
  // The aborted request's response arrives late anyway: it must be ignored.
  h.requests[1].resolve("snapA-late");
  await a;
  await tick();
  assert.equal(h.landed().filter((e) => e.landed === "snapA-late").length, 0, "a stale response never overwrites a newer one");
}

// ── Deferred merge: GET #1 can never land after GET #2, because GET #2 only
//    starts once GET #1 has landed; a second open while deferred is deduped.
{
  const h = harness();
  const load = h.loader("ch1");
  h.seq.refetch(load, false);
  const o1 = h.seq.refetch(load, true);
  const o2 = h.seq.refetch(load, true);
  await tick();
  assert.equal(h.requests.length, 1, "two opens while GET #1 is in flight still start no request");
  h.requests[0].resolve("snap1");
  await tick();
  assert.equal(h.requests.length, 2, "exactly one merging GET follows");
  h.requests[1].resolve("snap2");
  await Promise.all([o1, o2]);
  assert.deepEqual(h.landed().map((e) => e.landed), ["snap1", "snap2"], "landing order is GET #1 then GET #2");
}

// ── Chapter change while GET #1 is in flight (and a merge is deferred) ────
{
  const h = harness();
  const load1 = h.loader("ch1", { ignoreAbort: true });
  const load2 = h.loader("ch2");
  const mount1 = h.seq.refetch(load1, false);
  const open1 = h.seq.refetch(load1, true); // deferred
  h.seq.record("ch1-step");
  h.seq.reset(); // useChapter's effect cleanup for (book, chapter) change
  await open1; // the deferred merge is dropped, its promise settles
  assert.equal(h.requests[0].aborted, true, "a chapter change aborts the old chapter's GET #1");
  const mount2 = h.seq.refetch(load2, false);
  // The old response resolving late (after abort) must never commit.
  h.requests[0].resolve("ch1-snap");
  await mount1;
  h.requests[1].resolve("ch2-snap");
  await mount2;
  await tick();
  assert.deepEqual(h.landed(), [{ landed: "ch2-snap", merge: false, queued: [] }],
    "only the new chapter lands; no queued step or deferred merge leaks across chapters");
  assert.equal(h.requests.length, 2, "the dropped deferred merge never issues a request");
  assert.equal(h.events.filter((e) => e.error).length, 0, "an abort is not an error");
}

// ── A new chapter's first open still defers (loaded resets with the chapter)
{
  const h = harness();
  const load1 = h.loader("ch1");
  const load2 = h.loader("ch2");
  const m1 = h.seq.refetch(load1, false);
  h.requests[0].resolve("ch1-snap");
  await m1;
  h.seq.reset();
  h.seq.refetch(load2, false);
  h.seq.refetch(load2, true);
  await tick();
  assert.equal(h.requests.length, 2, "the open defers behind the new chapter's mount GET");
  assert.equal(h.requests[1].aborted, false);
}

// ── Unmount while GET #1 is in flight ─────────────────────────────────────
{
  const h = harness();
  const load = h.loader("ch1");
  h.seq.refetch(load, false);
  const open = h.seq.refetch(load, true);
  h.seq.reset(); // unmount cleanup
  await open;
  await tick();
  assert.equal(h.requests[0].aborted, true, "unmount aborts GET #1");
  assert.equal(h.landed().length, 0, "nothing lands after unmount");
  assert.equal(h.requests.length, 1, "the deferred merge is never issued");
}

// ── GET #1 fails for good while a merge is deferred ───────────────────────
{
  const h = harness();
  const load = h.loader("ch1");
  const mount = h.seq.refetch(load, false);
  const open = h.seq.refetch(load, true);
  h.requests[0].reject(new Error("HTTP 404"));
  await mount;
  await open;
  assert.deepEqual(h.events.filter((e) => e.error), [{ error: "Error: HTTP 404" }]);
  assert.equal(h.requests.length, 1, "no merge after a failed mount GET — the Retry GET postdates the open anyway");
  h.seq.record("x");
  // Retry (plain) then lands with no stale queue.
  const retry = h.seq.refetch(load, false);
  h.requests[1].resolve("snap");
  await retry;
  assert.deepEqual(h.landed(), [{ landed: "snap", merge: false, queued: [] }]);
}

// ── A plain refetch while a merge is deferred supersedes both ─────────────
{
  const h = harness();
  const load = h.loader("ch1");
  h.seq.refetch(load, false);
  const open = h.seq.refetch(load, true);
  const plain = h.seq.refetch(load, false); // e.g. Door43 import refresh
  await open; // settled: the plain GET, issued after the open, satisfies it
  assert.equal(h.requests[0].aborted, true, "a plain refetch keeps the old abort-and-replace behavior");
  h.requests[1].resolve("snap");
  await plain;
  await tick();
  assert.deepEqual(h.landed(), [{ landed: "snap", merge: false, queued: [] }]);
  assert.equal(h.requests.length, 2);
}

// ── Once data has landed, a merge still aborts an in-flight plain refetch
//    (unchanged behavior: no first paint to protect).
{
  const h = harness();
  const load = h.loader("ch1");
  const m = h.seq.refetch(load, false);
  h.requests[0].resolve("snap1");
  await m;
  h.seq.refetch(load, false); // Refresh button
  const open = h.seq.refetch(load, true); // reconnect
  assert.equal(h.requests[1].aborted, true);
  h.requests[2].resolve("snap3");
  await open;
  assert.deepEqual(h.landed().at(-1), { landed: "snap3", merge: true, queued: [] });
}

// ── onAttempt only reports for the latest request ─────────────────────────
{
  const events = [];
  let attemptFns = [];
  const seq = createChapterFetchSequencer({
    onStart: () => {},
    onAttempt: (n) => events.push(n),
    onLanded: () => {},
    onError: () => {},
  });
  const load = (signal, onAttempt) => {
    attemptFns.push(onAttempt);
    return new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("abort"))));
  };
  seq.refetch(load, false);
  attemptFns[0](1);
  seq.reset();
  attemptFns[0](2);
  assert.deepEqual(events, [1], "a reset request's retries are not reported");
}

// ── A deferred merge that throws still settles its caller (no hang, no
//    unhandled rejection).
{
  const reqs = [];
  const seq = createChapterFetchSequencer({
    onStart: () => {},
    onAttempt: () => {},
    onLanded: (_p, merge) => { if (merge) throw new Error("commit failed"); },
    onError: () => {},
  });
  const load = () => new Promise((resolve) => reqs.push(resolve));
  const mount = seq.refetch(load, false);
  const open = seq.refetch(load, true);
  reqs[0]("snap1");
  await mount;
  await tick();
  reqs[1]("snap2");
  const settled = await Promise.race([open.then(() => "settled"), new Promise((r) => setTimeout(() => r("hung"), 50))]);
  assert.equal(settled, "settled", "the deferring caller settles even when the merge throws");
}

console.log("chapterFetchSequencer: all cases passed");
