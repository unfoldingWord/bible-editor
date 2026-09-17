import assert from "node:assert/strict";
import { createLintRefreshQueue } from "./lintRefreshQueue.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const requests = [];
const queue = createLintRefreshQueue(() => new Promise((resolve, reject) => requests.push({ resolve, reject })));
const initial = queue.refresh();
let dismissed = false;
const a = queue.refresh().then(() => { dismissed = true; });
const b = queue.refresh();
assert.equal(requests.length, 1);
requests[0].resolve();
await initial;
await tick();
assert.equal(dismissed, false, "dismiss must await a request started after invalidation");
assert.equal(requests.length, 2, "burst produces only one follow-up");
const c = queue.refresh();
requests[1].reject(new Error("network"));
await Promise.all([a, b]);
await tick();
assert.equal(requests.length, 3, "failure does not strand the next invalidation");
requests[2].resolve();
await c;
const d = queue.refresh();
const pending = queue.refresh();
queue.dispose();
await pending;
requests[3].resolve();
await d;
await queue.refresh();
assert.equal(requests.length, 4, "disposal prevents old-book queued requests");
console.log("lint refresh queue: fresh dismiss, coalescing, failure, disposal passed");

// Regression for #808: useBookLint's `load()` used to read `queue.current`,
// which was only assigned inside the mount effect and reset to null on
// that effect's cleanup — so a refresh() issued in either gap (before
// mount, or between a book change's cleanup and its replacement effect)
// resolved via a `queue.current?.refresh() ?? Promise.resolve()` fallback
// that never touched the queue at all. The fix creates the queue eagerly,
// for the hook's whole lifetime, and swaps a runner ref inside the effects
// instead of recreating (and nulling) the queue. Prove the queue itself
// still enforces its contract once nothing stands between a caller and it:
// refresh() always resolves through a run() that the queue actually
// performed, never through a disconnected resolve.
{
  const requests2 = [];
  const q2 = createLintRefreshQueue(() => new Promise((resolve, reject) => requests2.push({ resolve, reject })));
  const early = q2.refresh();
  assert.equal(requests2.length, 1, "refresh() must always drive a real run(), never a disconnected resolve");
  let landed = false;
  const tracked = early.then(() => { landed = true; });
  await tick();
  assert.equal(landed, false, "must not resolve before the driven run() settles");
  requests2[0].resolve();
  await tracked;
  assert.equal(landed, true);
  console.log("lint refresh queue: refresh() always resolves through a real run() passed");
}
