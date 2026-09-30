// pipelineStore refocus and notify behavior (#897). Run from repo root:
//   node --experimental-strip-types --no-warnings web/src/sync/pipelineStoreRefocus.test.mjs
//
// 1. A list load that runs while the tab is hidden skips pollTick(), so it
//    never fetched the user's own running jobs' upstream status. It must not
//    stamp the refocus throttle, or coming back to the tab skips the reload
//    and a finished AI run keeps its lagging D1 state (still "running",
//    chapter still locked).
// 2. A subscriber that joins after a zero-subscriber window must still be
//    notified when the jobs change back to what was last notified.

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// pipelineStore imports "./api" (extensionless, and api.ts uses TypeScript
// syntax that --experimental-strip-types cannot load). Point that import at a
// stub whose calls are answered by globalThis.__pipelineApi below; resolve
// the store's other extensionless imports to their .ts files.
const API_STUB =
  "data:text/javascript," +
  encodeURIComponent(
    "export class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }\n" +
      "export const api = new Proxy({}, { get: (_t, k) => (...a) => globalThis.__pipelineApi[k](...a) });",
  );
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./api" && context.parentURL?.endsWith("/sync/pipelineStore.ts")) {
      return { url: API_STUB, shortCircuit: true };
    }
    if (
      specifier.startsWith(".") &&
      !/\.[a-zA-Z0-9]+$/.test(specifier) &&
      context.parentURL?.startsWith("file:")
    ) {
      const target = fileURLToPath(new URL(specifier, context.parentURL)) + ".ts";
      if (existsSync(target)) return { url: pathToFileURL(target).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const doc = new EventTarget();
doc.hidden = true;
Object.defineProperty(doc, "visibilityState", { get: () => (doc.hidden ? "hidden" : "visible") });
globalThis.document = doc;
globalThis.window = globalThis;

const now = Math.floor(Date.now() / 1000);
let row = {
  job_id: "j1",
  upstream_job_id: "up1",
  user_id: 7,
  pipeline_type: "generate",
  book: "ZEC",
  start_chapter: 1,
  end_chapter: 1,
  session_key: "s",
  state: "running",
  priority: 0,
  current_skill: null,
  current_status: null,
  error_kind: null,
  error_message: null,
  output_json: null,
  follow_up_job_id: null,
  updated_at: now,
  created_at: now,
  last_polled_at: null,
  notified_user_at: null,
  locks_resources: ["verse"],
};
let statusState = "done";
let statusSkill = null;
const calls = [];
globalThis.__pipelineApi = {
  async pipelineList() {
    calls.push("list");
    return { jobs: [row], queue: null };
  },
  async pipelineStatus(jobId) {
    calls.push(`status:${jobId}`);
    return {
      jobId: "up1",
      state: statusState,
      current: statusSkill ? { skill: statusSkill, status: null } : undefined,
      pipelineType: "generate",
      scope: { book: "ZEC", startChapter: 1, endChapter: 1 },
      createdAt: new Date(now * 1000).toISOString(),
      updatedAt: new Date((now + 5) * 1000).toISOString(),
    };
  },
  async pipelineNotified() {
    calls.push("notified");
  },
};

const { pipelineStore } = await import("./pipelineStore.ts");
const flush = () => new Promise((r) => setTimeout(r, 20));

console.log("hidden-tab load does not stamp the refocus throttle");
let latest = [];
let unsubscribe = pipelineStore.subscribe((jobs) => {
  latest = jobs;
});
await flush();
assert(calls.includes("list"), "hidden-tab load fetched the list");
assert(!calls.includes("status:j1"), "hidden-tab load skipped the per-job status poll");
assert(latest[0]?.state === "running", "job still shows the lagging D1 state");

// The user comes back to the tab right away.
calls.length = 0;
doc.hidden = false;
doc.dispatchEvent(new Event("visibilitychange"));
await flush();
assert(calls.includes("list"), "refocus after a hidden-only load reloads the list");
assert(calls.includes("status:j1"), "refocus polls the own running job's status");
assert(latest[0]?.state === "done", "finished run reaches subscribers on refocus");

// A visible load did run pollTick, so an immediate second refocus is throttled.
calls.length = 0;
doc.dispatchEvent(new Event("visibilitychange"));
await flush();
assert(!calls.includes("list"), "a second refocus right after a visible load is throttled");

console.log("notify after a zero-subscriber window");
// Notify jobs content A while subscribed, change to B with no subscribers
// (no notify), let a new subscriber join (it gets B directly), then change
// back to exactly A. The new subscriber must be told.
row = { ...row, state: "running" };
statusState = "running";
statusSkill = "skill-a";
await pipelineStore.reload();
await flush();
assert(latest[0]?.current_skill === "skill-a", "subscriber was notified of content A");
unsubscribe();
statusSkill = "skill-b";
await pipelineStore.refresh("j1");
const seen = [];
unsubscribe = pipelineStore.subscribe((jobs) => {
  seen.push(jobs[0]?.current_skill);
});
await flush();
assert(seen.at(-1) === "skill-b", "new subscriber gets the current content B");
statusSkill = "skill-a";
await pipelineStore.refresh("j1");
await flush();
assert(seen.at(-1) === "skill-a", "an exact revert to the last-notified content A still notifies");
unsubscribe();

console.log("all pipelineStore refocus tests passed");
process.exit(0);
